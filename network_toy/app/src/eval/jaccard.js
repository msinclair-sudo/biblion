// Jaccard similarity helpers.
//
// jaccardSimilarity(A, B) = |A ∩ B| / |A ∪ B|, range [0, 1].
//
// bipartiteMatchJaccard(refLabels, candLabels, idMask?) — for each
// reference cluster, returns the Jaccard against its bipartite-matched
// candidate cluster (each candidate matched to at most one reference,
// maximising total Jaccard via the Hungarian algorithm). This is the
// scientifically correct scoring used by the bootstrap (§6.18.7).
//
// bestMatchJaccard(refLabels, candLabels, idMask?) — DEPRECATED legacy
// greedy scoring (each ref takes its single best candidate, ignoring
// matching constraints). Kept exported for any external caller; new
// code should use bipartiteMatchJaccard. The greedy form double-counts
// when the candidate clustering is coarser than the reference: two ref
// clusters can both best-match the same candidate, inflating
// meanJaccard. Spec / audit: doc/plan.md §6.18 audit B3.
//
// Both functions accept an optional `idMask` (Set<int>) that restricts
// the comparison to a subset of node ids — used by the bootstrap so the
// reference cluster's "members" are the ones that survived subsampling,
// not all members.

export function jaccardSimilarity(setA, setB) {
  const A = setA instanceof Set ? setA : new Set(setA);
  const B = setB instanceof Set ? setB : new Set(setB);
  if (A.size === 0 && B.size === 0) return 1;   // convention: both-empty match
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

// ── DEPRECATED — use bipartiteMatchJaccard for new code ──
//
// Returns Map<refLabel, {bestCandLabel, jaccard}>.
export function bestMatchJaccard(refLabels, candLabels, idMask = null) {
  const { refIds, candIds, refGroups, candGroups } = buildGroups(refLabels, candLabels, idMask);

  const out = new Map();
  for (const refLabel of refIds) {
    let bestJ = 0;
    let bestC = -1;
    for (const candLabel of candIds) {
      const j = jaccardSimilarity(refGroups.get(refLabel), candGroups.get(candLabel));
      if (j > bestJ) { bestJ = j; bestC = candLabel; }
    }
    out.set(refLabel, { bestCandLabel: bestC, jaccard: bestJ });
  }
  return out;
}

// Bipartite-matched Jaccard scoring (B3 fix). Each candidate cluster is
// matched to at most one reference cluster; the matching maximises
// total Jaccard across all references. Unmatched reference clusters
// score 0 (happens when refClusters > candClusters).
//
// Returns Map<refLabel, {bestCandLabel: int, jaccard: float}>. Same
// output shape as bestMatchJaccard so consumers swap one for the other.
//
// Complexity: O(R × C × n + R²C) where R, C are the cluster counts in
// the (masked) reference and candidate. Hungarian is the R²C term;
// pairwise Jaccard fill is the R×C×n term. Both are typically dwarfed
// by the surrounding bootstrap's algo.infer cost.
//
// opts.minMembers (B9, §6.18.9): drop reference clusters with fewer
// than `minMembers` in-mask members from the matching entirely — they
// won't appear in the output map. Per Hennig 2007 §3.2: a cluster
// with 1 in-subsample member scores Jaccard = 1.0 against any singleton
// candidate, which is meaningless. Default 0 (no filter) preserves
// legacy behaviour for direct callers; bootstrap.js sets minMembers=3.
export function bipartiteMatchJaccard(refLabels, candLabels, idMask = null, opts = {}) {
  const { refIds, candIds, refGroups, candGroups } = buildGroups(refLabels, candLabels, idMask);

  const minMembers = Math.max(0, opts.minMembers | 0);

  // Drop tiny ref clusters early so they don't waste matching capacity.
  const refIdsFiltered = minMembers > 0
    ? refIds.filter(id => refGroups.get(id).size >= minMembers)
    : refIds;

  const R = refIdsFiltered.length;
  const C = candIds.length;
  if (R === 0) return new Map();

  // Pairwise Jaccard matrix W[i][j] = jaccard(ref_i, cand_j).
  const W = new Array(R);
  for (let i = 0; i < R; i++) {
    const row = new Array(C);
    const refSet = refGroups.get(refIdsFiltered[i]);
    for (let j = 0; j < C; j++) {
      row[j] = jaccardSimilarity(refSet, candGroups.get(candIds[j]));
    }
    W[i] = row;
  }

  // Solve max-weight bipartite matching. assignment[i] = j matched
  // to reference i, or -1 if unmatched.
  const assignment = maxWeightMatch(W);

  const out = new Map();
  for (let i = 0; i < R; i++) {
    const j = assignment[i];
    if (j >= 0) {
      out.set(refIdsFiltered[i], { bestCandLabel: candIds[j], jaccard: W[i][j] });
    } else {
      out.set(refIdsFiltered[i], { bestCandLabel: -1, jaccard: 0 });
    }
  }
  return out;
}

// Shared group-builder for both scoring functions. Returns the ordered
// id lists + member-set Maps, restricted to idMask if supplied.
function buildGroups(refLabels, candLabels, idMask) {
  if (refLabels.length !== candLabels.length) {
    throw new Error("[jaccard] refLabels.length must equal candLabels.length");
  }
  const n = refLabels.length;
  const refGroups  = new Map();
  const candGroups = new Map();
  for (let i = 0; i < n; i++) {
    if (idMask && !idMask.has(i)) continue;
    const r = refLabels[i];
    const c = candLabels[i];
    if (r >= 0) {
      if (!refGroups.has(r)) refGroups.set(r, new Set());
      refGroups.get(r).add(i);
    }
    if (c >= 0) {
      if (!candGroups.has(c)) candGroups.set(c, new Set());
      candGroups.get(c).add(i);
    }
  }
  // Deterministic id order so assignment[i] is reproducible across runs.
  const refIds  = [...refGroups.keys()].sort((a, b) => a - b);
  const candIds = [...candGroups.keys()].sort((a, b) => a - b);
  return { refIds, candIds, refGroups, candGroups };
}

// Maximum-weight rectangular bipartite matching via the Hungarian /
// Munkres algorithm. Given an R×C non-negative weight matrix W, returns
// an Int32Array(R) where assignment[i] is the column j matched to row i,
// or -1 if row i is unmatched (only happens when R > C).
//
// Implementation: classic O(n³) Munkres on a square padded matrix.
// We negate for min-cost form, pad to max(R, C) × max(R, C) with zeros
// (which become a large positive cost after negation), solve, then map
// back. For our scale (cluster counts in the tens or low hundreds) the
// constant factors don't matter; correctness + readability does.
export function maxWeightMatch(W) {
  const R = W.length;
  if (R === 0) return new Int32Array(0);
  const C = W[0].length;
  const N = Math.max(R, C);

  // Build N×N cost matrix in min-cost form: cost = MAX_W - W. Padding
  // entries (beyond R rows or C cols) get cost = MAX_W (i.e. weight 0).
  // MAX_W is the max weight in the matrix; this keeps costs ≥ 0 which
  // Munkres requires.
  let maxW = 0;
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      if (W[i][j] > maxW) maxW = W[i][j];
    }
  }
  const cost = new Array(N);
  for (let i = 0; i < N; i++) {
    const row = new Array(N);
    for (let j = 0; j < N; j++) {
      const w = (i < R && j < C) ? W[i][j] : 0;
      row[j] = maxW - w;
    }
    cost[i] = row;
  }

  const rowAssign = munkres(cost);  // length N; rowAssign[i] = column j matched to row i

  // Translate back: rows ≥ R are padding (ignore); cols ≥ C mean the
  // row was matched to a padding column (i.e. unmatched in the
  // rectangular problem).
  const out = new Int32Array(R);
  for (let i = 0; i < R; i++) {
    const j = rowAssign[i];
    out[i] = (j >= 0 && j < C) ? j : -1;
  }
  return out;
}

// Munkres assignment for an n×n non-negative cost matrix. Returns an
// array where result[i] is the column assigned to row i. Standard
// O(n³) implementation; cf. Kuhn 1955 / Munkres 1957.
function munkres(cost) {
  const n = cost.length;
  // u, v: dual potentials for rows / cols (index 0..n; element 0 is a
  // sentinel used by the augmenting-path bookkeeping).
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);  // p[j] = row assigned to column j (1-indexed; 0 = unassigned)
  const way = new Int32Array(n + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minV = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minV[j]) {
            minV[j] = cur;
            way[j] = j0;
          }
          if (minV[j] < delta) {
            delta = minV[j];
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j]    -= delta;
        } else {
          minV[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    // Walk the augmenting path back, updating assignments.
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  // Convert column-keyed p[j] = row to row-keyed assignment[i] = col.
  const assignment = new Int32Array(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) assignment[p[j] - 1] = j - 1;
  }
  return assignment;
}
