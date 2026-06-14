// Multi-level clustering — extract a small ladder of partitions from ONE
// HDBSCAN run's condensed tree (doc/plan.md §9 / §4).
//
// The condensed tree (surfaced by clustering-hdbscan.js, MLC-0) is a
// hierarchy of clusters, each born at a stability level λ. A horizontal
// cut at λ yields a partition: every point joins the deepest cluster on
// its root→home chain that has already been born (birthLambda ≤ λ). Lower
// λ = coarser (fewer, bigger clusters); higher λ = finer.
//
// This module is PURE and tree-only (no distances, no DOM): it
//   1. discovers the natural λ-shelves (discoverLayers), and
//   2. produces the frontier-ancestor labels for a given λ (flattenFrontier).
//
// The *absorption* of noise-stripped points into the nearest live cluster
// — which is what lets a fine cluster straddle two coarse parents and
// become a BRIDGE (§6) — needs point distances, so it lives in
// clustering-hdbscan.js's inferHdbscanMultiLevel where the distance matrix
// is already in scope. This split keeps the tree maths unit-testable
// without a worker.

const DEFAULT_OPTS = {
  capLayers:   5,    // hard cap on discovered layers (§3, user-decided)
  minClusters: 2,    // a layer must have ≥ 2 clusters to be meaningful
};

// Per-node "first child birth" — the λ at which a cluster first splits.
// A cluster occupies the cut for λ ∈ [birthLambda, firstChildBirth); after
// that it has split and its children take over the frontier. Leaves never
// split → firstChildBirth = +∞ (capped to maxLambda by callers).
function firstChildBirthLambda(tree) {
  const { numNodes, parent, birthLambda } = tree;
  const out = new Float64Array(numNodes).fill(Infinity);
  for (let i = 1; i < numNodes; i++) {
    const p = parent[i];
    if (p >= 0 && birthLambda[i] < out[p]) out[p] = birthLambda[i];
  }
  return out;
}

// discoverLayers — find the ordered list of natural λ-cuts.
//
// Each non-root cluster contributes an interval [birth, firstChildBirth)
// to the "how many clusters are alive at λ" step function. We sweep that
// function, find the bands where the count is constant, and rank distinct
// counts by their total *log-λ persistence* (scale-invariant, so a wide
// coarse band and a wide fine band compete fairly). The top `capLayers`
// distinct counts, ordered coarse→fine, are the layers.
//
// Returns: [{ layer, lambda, clusterCount, persistence, rationale }]
//   coarsest first. `lambda` is the geometric-mean λ of the count's widest
//   band — a stable place to cut. Empty array for a degenerate tree.
export function discoverLayers(tree, opts = {}) {
  // Nullish-coalesce, NOT spread — an explicit `{capLayers: undefined}` from
  // a caller that didn't set it must not clobber the default (that bug let
  // the ladder grow uncapped).
  const capLayers   = opts.capLayers   ?? DEFAULT_OPTS.capLayers;
  const minClusters = opts.minClusters ?? DEFAULT_OPTS.minClusters;
  if (!tree || tree.numNodes < 2) return [];

  const { numNodes, parent, birthLambda, leafLambda } = tree;
  // Cap open-ended (leaf) intervals at the finest density observed — the
  // max over both node births AND where points finally fall out. Without
  // the leafLambda term, clusters born at the deepest split would get a
  // zero-width interval and the finest layer would never form.
  let maxLambda = 0;
  for (let i = 0; i < numNodes; i++) {
    if (Number.isFinite(birthLambda[i]) && birthLambda[i] > maxLambda) {
      maxLambda = birthLambda[i];
    }
  }
  if (leafLambda) {
    for (let p = 0; p < leafLambda.length; p++) {
      if (Number.isFinite(leafLambda[p]) && leafLambda[p] > maxLambda) {
        maxLambda = leafLambda[p];
      }
    }
  }
  if (maxLambda <= 0) return [];

  const firstChild = firstChildBirthLambda(tree);

  // Build the +1 / −1 events for each non-root cluster's [birth, end) span.
  const events = [];   // { lambda, delta }
  for (let i = 0; i < numNodes; i++) {
    if (parent[i] < 0) continue;                       // skip root
    const lo = birthLambda[i];
    const hi = Math.min(firstChild[i], maxLambda);
    if (!(hi > lo)) continue;                          // zero-width
    events.push({ lambda: lo, delta: +1 });
    events.push({ lambda: hi, delta: -1 });
  }
  if (events.length === 0) return [];
  events.sort((a, b) => a.lambda - b.lambda);

  // Sweep to piecewise-constant segments (λa, λb, count).
  const segments = [];
  let count = 0;
  let prev = events[0].lambda;
  let ei = 0;
  while (ei < events.length) {
    const lam = events[ei].lambda;
    if (lam > prev && count > 0) segments.push({ lo: prev, hi: lam, count });
    // apply all deltas at this λ
    while (ei < events.length && events[ei].lambda === lam) {
      count += events[ei].delta;
      ei++;
    }
    prev = lam;
  }

  // Aggregate per distinct count: total log-persistence + widest band.
  const byCount = new Map();   // count → { total, bestPersist, bestLambda }
  for (const seg of segments) {
    if (seg.count < minClusters) continue;
    if (seg.lo <= 0) continue;                         // log undefined at 0
    const persist = Math.log(seg.hi) - Math.log(seg.lo);
    if (!(persist > 0)) continue;
    const cur = byCount.get(seg.count) || { total: 0, bestPersist: 0, bestLambda: 0 };
    cur.total += persist;
    if (persist > cur.bestPersist) {
      cur.bestPersist = persist;
      cur.bestLambda  = Math.sqrt(seg.lo * seg.hi);     // geometric mean
    }
    byCount.set(seg.count, cur);
  }
  if (byCount.size === 0) return [];

  // Rank by total persistence, keep the top capLayers distinct counts,
  // then order coarse→fine (ascending cluster count).
  const ranked = [...byCount.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, capLayers)
    .sort((a, b) => a[0] - b[0]);

  return ranked.map(([clusterCount, agg], layer) => ({
    layer,
    lambda:       agg.bestLambda,
    clusterCount,
    persistence:  agg.total,
    rationale:    `stable @ λ≈${agg.bestLambda.toFixed(3)} ` +
                  `(${clusterCount} clusters, Δlog-λ=${agg.total.toFixed(2)})`,
  }));
}

// flattenFrontier — partition labels for a horizontal cut at `lambda`.
//
// For each point p:
//   - if p has already fallen out of its home cluster at this density
//     (leafLambda[p] < lambda) it is STRIPPED → -1 (a caller absorbs it).
//   - otherwise p joins the deepest ancestor of its home whose cluster has
//     been born (birthLambda ≤ lambda) — the frontier node.
//
// Returns an Int32Array(n) of *condensed-node ids* (or -1 for stripped).
// Callers relabel the distinct node ids to contiguous [0, k) cluster ids.
export function flattenFrontier(tree, lambda) {
  const { n, numNodes, parent, birthLambda, leafHome, leafLambda } = tree;
  const labels = new Int32Array(n).fill(-1);
  if (numNodes === 0) return labels;
  for (let p = 0; p < n; p++) {
    if (leafLambda[p] < lambda) continue;              // stripped → noise
    let cur = leafHome[p];
    // walk up while this node is born too late (finer than the cut)
    while (cur >= 0 && birthLambda[cur] > lambda && parent[cur] >= 0) {
      cur = parent[cur];
    }
    labels[p] = cur;
  }
  return labels;
}

// Relabel an array of condensed-node ids (with -1 = stripped) to
// contiguous cluster ids [0, k), preserving -1. Returns
// { labels: Int32Array, nodeByCluster: int[] } where nodeByCluster[c] is
// the condensed-node id cluster c came from (so callers can look up its
// stability). Frontier-node order of first appearance defines the ids.
export function relabelFrontier(frontier, n) {
  const labels = new Int32Array(n).fill(-1);
  const idByNode = new Map();
  const nodeByCluster = [];
  for (let p = 0; p < n; p++) {
    const node = frontier[p];
    if (node < 0) continue;
    let cid = idByNode.get(node);
    if (cid === undefined) {
      cid = nodeByCluster.length;
      idByNode.set(node, cid);
      nodeByCluster.push(node);
    }
    labels[p] = cid;
  }
  return { labels, nodeByCluster };
}

// ── Bridge-producing absorption (§9 / user decision: "absorbed cuts") ───
//
// Stripped points (label -1) are absorbed into the cluster of the nearest
// STILL-CLUSTERED point, measured by shortest weighted path over the MST
// (the structural backbone HDBSCAN reasoned over). Because the MST is
// global, a stripped boundary point can attach to a sibling branch's
// cluster — so a fine cluster ends up drawing members from two coarse
// parents → a genuine bridge. Multi-source Dijkstra: O(n log n) per layer,
// vs O(n²) for nearest-point-over-the-distance-matrix. This is what keeps
// the 5 layers nearly free on top of one HDBSCAN run.

// Adjacency list (weighted) from MST edges [{i,j,w}], length n.
export function buildMstAdjacency(mstEdges, n) {
  const adj = Array.from({ length: n }, () => []);
  for (const e of mstEdges) {
    adj[e.i].push({ to: e.j, w: e.w });
    adj[e.j].push({ to: e.i, w: e.w });
  }
  return adj;
}

// Multi-source Dijkstra over the MST, seeded by every already-labelled
// point. Mutates `labels` in place: each -1 entry gets the label of its
// nearest labelled point by MST path length. Connected MST + ≥1 seed ⇒
// every point ends labelled.
export function absorbViaMST(labels, adj, n) {
  // Count seeds; if none (degenerate), nothing to absorb into.
  let seeds = 0;
  for (let i = 0; i < n; i++) if (labels[i] >= 0) seeds++;
  if (seeds === 0 || seeds === n) return labels;

  const dist = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap();
  for (let i = 0; i < n; i++) {
    if (labels[i] >= 0) { dist[i] = 0; heap.push(0, i); }
  }
  while (heap.size > 0) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;                 // stale entry
    const edges = adj[u];
    for (let e = 0; e < edges.length; e++) {
      const v = edges[e].to;
      const nd = d + edges[e].w;
      if (nd < dist[v]) {
        dist[v] = nd;
        labels[v] = labels[u];                 // inherit nearest seed's label
        heap.push(nd, v);
      }
    }
  }
  return labels;
}

// Minimal binary min-heap over (key, value) pairs. Avoids an O(n²)
// linear-scan Dijkstra at n=5000.
class MinHeap {
  constructor() { this.keys = []; this.vals = []; this.size = 0; }
  push(key, val) {
    let i = this.size++;
    this.keys.push(key); this.vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this._swap(i, p); i = p;
    }
  }
  pop() {
    const topK = this.keys[0], topV = this.vals[0];
    const lastK = this.keys.pop(), lastV = this.vals.pop();
    this.size--;
    if (this.size > 0) {
      this.keys[0] = lastK; this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.keys[l] < this.keys[m]) m = l;
        if (r < this.size && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this._swap(i, m); i = m;
      }
    }
    return [topK, topV];
  }
  _swap(a, b) {
    const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k;
    const v = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = v;
  }
}

// ── Full multi-level extraction (pure) ──────────────────────────────────
//
// Given a condensed tree, the weighted MST, and the node positions, build
// the complete clusterLevels[] ladder: discover λ-shelves, then for each
// (coarse→fine) flatten + absorb into a proper global ClusterResult that
// satisfies the cluster-output contract.
//
//   tree      serialized condensedTree (MLC-0)
//   mstEdges  [{i,j,w}] weighted MST (clustering-hdbscan)
//   nodes     [{ id, basePos:[x,y,z] }] — for cluster centroid/spread/count
//   opts      { capLayers?, minClusters?, uidPrefix? }
//
// Returns { layers, levels } where layers is discoverLayers' output and
// levels is [{ uid, scope:"global", clusterResult }] coarse→fine. Returns
// empty levels for a degenerate tree (caller decides the fallback).
const TABLEAU10 = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ab",
];
const ZERO3 = [0, 0, 0];

export function buildMultiLevel(tree, mstEdges, nodes, opts = {}) {
  const uidPrefix = opts.uidPrefix || "ml";
  const layers = discoverLayers(tree, opts);
  if (layers.length === 0) return { layers: [], levels: [] };

  const n = tree.n;
  const adj = buildMstAdjacency(mstEdges, n);
  const structureEdges = mstEdges.map(e =>
    [Math.min(e.i, e.j), Math.max(e.i, e.j)]);

  const builtLevels = [];
  const builtLayers = [];
  let prevCount = 0;
  for (const ly of layers) {
    const frontier = flattenFrontier(tree, ly.lambda);
    const { labels, nodeByCluster } = relabelFrontier(frontier, n);
    absorbViaMST(labels, adj, n);
    // Keep a layer only if it REFINES the previous kept one (strictly more
    // realised clusters). At high λ most points strip and absorption
    // collapses them into a few cores, so a structurally-fine cut can
    // realise FEWER clusters than a coarser one — that's not a refinement,
    // it's noise. Enforcing strict growth gives a clean coarse→fine ladder
    // (and subsumes the identical-partition dedup).
    const realised = nodeByCluster.length;
    if (realised <= prevCount) continue;
    prevCount = realised;
    const clusters = buildClusterEntries(nodes, labels, nodeByCluster, tree, n);
    builtLayers.push({ ...ly, realisedCount: realised });
    builtLevels.push({
      uid:   `${uidPrefix}-${ly.layer}`,
      scope: "global",
      clusterResult: {
        method: "hdbscan",
        params: {
          multiLevel:   true,
          layer:        ly.layer,
          lambda:       ly.lambda,
          clusterCount: nodeByCluster.length,
        },
        clusters,
        nodeCluster: labels,
        structureEdges,
      },
    });
  }
  return { layers: builtLayers, levels: builtLevels };
}

// Per-cluster centroid / RMS spread / count / colour / stability, matching
// the trivialCluster shape the cluster contract expects. Stability is the
// frontier condensed node's stability (NaN-safe).
function buildClusterEntries(nodes, labels, nodeByCluster, tree, n) {
  const k = nodeByCluster.length;
  const cx = new Float64Array(k), cy = new Float64Array(k), cz = new Float64Array(k);
  const count = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    if (c < 0) continue;
    const p = (nodes[i] && nodes[i].basePos) || ZERO3;
    cx[c] += p[0]; cy[c] += p[1]; cz[c] += p[2]; count[c]++;
  }
  for (let c = 0; c < k; c++) {
    if (count[c] > 0) { cx[c] /= count[c]; cy[c] /= count[c]; cz[c] /= count[c]; }
  }
  const sq = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    if (c < 0) continue;
    const p = (nodes[i] && nodes[i].basePos) || ZERO3;
    const dx = p[0] - cx[c], dy = p[1] - cy[c], dz = p[2] - cz[c];
    sq[c] += dx * dx + dy * dy + dz * dz;
  }
  const clusters = [];
  for (let c = 0; c < k; c++) {
    const node = nodeByCluster[c];
    const stab = tree.stability ? tree.stability[node] : NaN;
    clusters.push({
      id:     c,
      centre: [cx[c], cy[c], cz[c]],
      spread: count[c] > 0 ? Math.sqrt(sq[c] / count[c]) : 0,
      count:  count[c],
      colour: TABLEAU10[((c % TABLEAU10.length) + TABLEAU10.length) % TABLEAU10.length],
      stability: Number.isFinite(stab) ? stab : NaN,
    });
  }
  return clusters;
}
