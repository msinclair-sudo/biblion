// Graph-diffusion fusion: citation-aware re-embedding.
//
// Citation-aware embedding refinement using anchored graph
// diffusion (APPNP — Klicpera, Bojchevski, Günnemann, ICLR 2019).
// Pulls papers that cite each other closer in feature space while
// keeping each paper anchored to its original SPECTER2 vector, so
// no paper "drifts away" entirely. The iteration:
//
//   X'⁽⁰⁾ = X                               (input embedding, n × d)
//   X'⁽ᵏ⁺¹⁾ = (1 − α)·X + α·(D⁻¹A)·X'⁽ᵏ⁾    (anchored diffusion)
//
// Has a closed-form fixed point X'∞ = (1−α)(I − αD⁻¹A)⁻¹X for α < 1.
// Numerically stable; values stay bounded by min/max of original X
// (each iteration is a convex combination).
//
// Convention note: we use α as "mixing strength" (higher → more
// citation influence). The APPNP paper uses α as "teleport
// probability" with the opposite sense (higher → stay at X).
// Mathematically equivalent under (α_ours = 1 − α_APPNP); chosen
// here so sliders read intuitively (right = more fusion).
//
// Input citation edges live in `params.adjacency` — a flat
// number[] of length 2|E| in [src, dst, src, dst, …] form. Symmetric
// fusion is the default: we treat A ∨ Aᵀ so direction doesn't matter.
// The 5000-paper BFS subset has 100% coverage (no isolates); for
// safety we handle isolated rows by adding a self-loop so D⁻¹ doesn't
// divide by zero.
//
// ── Ghost nodes (ghost-node spec §4.3) ──────────────────────────────
// Structural ("ghost") nodes are external citation endpoints that have
// citation edges but NO semantic embedding (no SPECTER2 / PCA row). They
// are positioned here by topology alone, via a MASKED, NO-SELF-ANCHOR
// variant of the operator above:
//
//   for each node i:
//     s = invDeg[i] · Σ_{j∈N(i)} cur[j]          # D⁻¹A cur
//     if ghost(i):  next[i] = s                   # α_eff = 1, NO teleport
//     else:         next[i] = (1−α)·anchor[i] + α·s
//
// A ghost never injects a fabricated or zero anchor (which would either
// wash out the bridge to low variance or pull its real neighbours toward
// the origin); it simply carries the K-step-diffused boundary value of
// its real neighbourhood. At convergence this is the FP-style steady
// state — invariant to the ghost's (unknown) initial value. Real nodes
// are unchanged except that their neighbour sum now includes ghost
// conduits, which transmit the A→ghost→B co-citation bridge.
//
// Input shape with ghosts: `input.data` is the dense m×d block over the
// m EMBEDDED nodes only (the noise stage's output). `params.ghostMask`
// is a Uint8Array(n), 1 = ghost. By the ghosts-last contract invariant
// (contract.js §4.1) the embedded nodes are indices 0..m-1 and ghosts
// m..n-1, so `input.data` maps row-for-row onto node indices 0..m-1 and
// the operator expands the working matrix up to all n rows. Output is a
// dense n×d block (embedded + ghost positions). Ghost-free callers pass
// no mask (or an all-zero one) and the operator collapses to the
// classic anchored APPNP above.
//
// Family: ["fusion"] — sits between Layer 1.5's noise stage and the
// downstream sibling triple (compression / viz / viz2d). Input and
// output have the same dimensionality (lateral stage, not a
// reduction).

import { mulberry32 as _mulberry32 } from "../rng.js";

export const ID = "graph-diffusion";

export const defaultParams = () => ({
  // Mixing strength per iteration. 0 = identity (no fusion); higher
  // = more citation influence. Recommended 0.3 — mild fusion that
  // preserves SPECTER2's semantic content while letting citation
  // structure refine the topic map.
  alpha: 0.3,
  // Diffusion depth. Each iteration moves information one hop along
  // the citation graph. k=4 covers most short-path influence on a
  // giant component; higher values reach further but also dilute
  // the original signal more.
  iterations: 4,
  // Adjacency injected by the engine at compute() time. Empty by
  // default — fusion behaves as identity until citation edges arrive.
  // Flat number[] of length 2|E|: [src0, dst0, src1, dst1, …].
  adjacency: [],
  // Ghost mask injected by the engine: Uint8Array(n), 1 = ghost
  // (structural node with no embedding row). Omitted / all-zero for
  // ghost-free sources → operator is the classic anchored APPNP.
  ghostMask: null,
  // Whether ghosts count toward the degree D used in D⁻¹ normalisation.
  // Default true: ghost edges are real edges, so a real node citing a
  // ghost has that ghost in its neighbour average (the conduit carries
  // signal). Toggle false for the Q3 ablation ("in-degree-but-not-in-
  // aggregation"): ghosts are dropped from BOTH the degree count and the
  // neighbour aggregation of every node (i.e. ghost edges are ignored).
  countGhostsInDegree: true,
});

export function compute(input, params = {}) {
  const p = { ...defaultParams(), ...params };
  const d = input.d;
  const X = input.data;        // Float32Array(m*d), embedded-node anchors

  // Ghost mask (spec §4.3). When present it spans all n nodes (embedded +
  // ghost); n is taken from its length. By the ghosts-last contract
  // invariant the first m entries are 0 (embedded) and the rest 1
  // (ghost), and `input.data` holds exactly those m embedded rows. When
  // absent (ghost-free source) every node is embedded: n = m = input.n.
  const ghostMask = (p.ghostMask instanceof Uint8Array) ? p.ghostMask : null;
  const n = ghostMask ? ghostMask.length : input.n;

  // m = embedded count. With a mask it's the number of zero entries (and
  // must match the X block's row count); without, it's the whole input.
  let m = n;
  if (ghostMask) {
    m = 0;
    for (let i = 0; i < n; i++) if (ghostMask[i] === 0) m++;
    if (X.length !== m * d) {
      throw new Error(
        `graph-diffusion: embedded block has ${X.length} entries; expected m*d = ${m}*${d} = ${m * d}`,
      );
    }
    // Ghosts-last invariant: embedded indices must be a contiguous prefix
    // 0..m-1. The operator copies X row r → node row r, which is only
    // correct under this invariant (it's enforced upstream in contract.js,
    // re-checked here so a malformed mask fails loudly rather than silently
    // mis-homing anchors).
    for (let i = 0; i < m; i++) {
      if (ghostMask[i] !== 0) {
        throw new Error(
          `graph-diffusion: ghostMask violates ghosts-last invariant at index ${i} (embedded node after a ghost)`,
        );
      }
    }
  }

  // No edges supplied or n < 2 → identity. Common for toy mode where
  // citations don't exist before clustering; redimred runs fusion
  // anyway but it's a no-op. With ghosts present but no edges, ghosts
  // have nowhere to propagate from, so they fall through as zeros (the
  // engine still gets a dense n×d block; an edgeless ghost is degenerate
  // and is handled the same as an isolated ghost below).
  if (!p.adjacency || p.adjacency.length === 0 || n < 2) {
    const out = new Float32Array(n * d);
    out.set(X.subarray(0, Math.min(X.length, n * d)));  // embedded rows; ghosts stay 0
    return {
      method: ID,
      params: echoParams(p),
      n, d,
      data:   out,
    };
  }

  const isGhost = (i) => ghostMask ? ghostMask[i] === 1 : false;
  // Whether an edge endpoint participates: under countGhostsInDegree=false
  // ghost edges are ignored entirely (dropped from degree AND aggregation).
  const dropGhostEdges = ghostMask && !p.countGhostsInDegree;

  // 1. Build CSR sparse adjacency. Symmetrise (A ∨ Aᵀ) by adding
  //    both directions for every edge. Dedupe with a hash set so we
  //    don't double-count parallel listings.
  const seen = new Set();
  const rowsTmp = new Array(n);
  for (let i = 0; i < n; i++) rowsTmp[i] = [];
  for (let k = 0; k < p.adjacency.length; k += 2) {
    const u = p.adjacency[k]     | 0;
    const v = p.adjacency[k + 1] | 0;
    if (u === v) continue;
    if (u < 0 || u >= n || v < 0 || v >= n) continue;
    // Q3 ablation: ignore any edge touching a ghost (degree + aggregation).
    if (dropGhostEdges && (isGhost(u) || isGhost(v))) continue;
    const fwdKey = u * n + v;
    const revKey = v * n + u;
    if (!seen.has(fwdKey)) { seen.add(fwdKey); rowsTmp[u].push(v); }
    if (!seen.has(revKey)) { seen.add(revKey); rowsTmp[v].push(u); }
  }
  // CSR: rowPtr[i+1] − rowPtr[i] = degree(i); colIdx is concatenated
  // neighbour lists.
  const rowPtr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowPtr[i + 1] = rowPtr[i] + rowsTmp[i].length;
  const nnz = rowPtr[n];
  const colIdx = new Int32Array(nnz);
  for (let i = 0, off = 0; i < n; i++) {
    const r = rowsTmp[i];
    for (let j = 0; j < r.length; j++) colIdx[off++] = r[j];
  }
  // Pre-compute inverse degree per row. Isolated rows (degree 0)
  // get inverse-degree 0 — combined with the (1−α)X·1 anchor term,
  // the propagation row simply contributes nothing for these nodes,
  // leaving X' = X for isolated REAL nodes. An isolated GHOST has no
  // anchor either, so it stays at its (zero) init — there is nothing to
  // diffuse from; this is the "isolated masked ghost" degenerate case
  // the spec flags (§6), handled here as a stable zero rather than NaN.
  const invDeg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const deg = rowPtr[i + 1] - rowPtr[i];
    invDeg[i] = deg > 0 ? 1 / deg : 0;
  }

  // 2. Working matrices over all n nodes. Embedded rows 0..m-1 seed from
  //    the X block; ghost rows m..n-1 are warm-started to the mean of
  //    their embedded neighbours (a transient init, NOT an anchor — it is
  //    overwritten every iteration). The anchor term below reads X (m rows)
  //    only for embedded nodes, so ghosts never inject a teleport vector.
  const alpha = clampFloat(p.alpha, 0, 0.999);   // clamp at <1 to guarantee fixed point
  const oneMinusAlpha = 1 - alpha;
  const iters = clampInt(p.iterations, 0, 50);
  let cur  = new Float32Array(n * d);
  let next = new Float32Array(n * d);
  // Embedded rows: copy anchors in (rows 0..m-1, by the ghosts-last invariant).
  cur.set(X.subarray(0, m * d));
  // Ghost warm start: mean of embedded neighbours' current (= anchor) vectors.
  // Ghosts with no embedded neighbour stay at zero; they'll pick up signal
  // through ghost-ghost edges over subsequent iterations if connected, or
  // remain at the stable zero init if fully isolated from embedded nodes.
  if (ghostMask) {
    for (let i = m; i < n; i++) {
      const start = rowPtr[i];
      const end   = rowPtr[i + 1];
      const offI  = i * d;
      let cnt = 0;
      for (let k = start; k < end; k++) {
        const j = colIdx[k];
        if (isGhost(j)) continue;            // embedded neighbours only for the warm start
        const offJ = j * d;
        for (let f = 0; f < d; f++) cur[offI + f] += cur[offJ + f];
        cnt++;
      }
      if (cnt > 0) {
        const invCnt = 1 / cnt;
        for (let f = 0; f < d; f++) cur[offI + f] *= invCnt;
      }
    }
  }

  // 3. Iterate. Real nodes: next[i] = (1−α)·anchor[i] + α·(D⁻¹A·cur)[i].
  //    Ghost nodes: next[i] = (D⁻¹A·cur)[i]   (α_eff = 1, no teleport).
  for (let iter = 0; iter < iters; iter++) {
    next.fill(0);
    for (let i = 0; i < n; i++) {
      const start = rowPtr[i];
      const end   = rowPtr[i + 1];
      const offI  = i * d;
      const ghost = isGhost(i);
      // Neighbour aggregation (D⁻¹A·cur)[i]. For ghosts the weight is the
      // full inverse degree (α_eff = 1); for real nodes it's α/deg.
      const inv   = ghost ? invDeg[i] : invDeg[i] * alpha;
      // Loop order (neighbour outer, dim inner) preserves cache
      // locality on the cur buffer.
      for (let k = start; k < end; k++) {
        const offJ = colIdx[k] * d;
        for (let f = 0; f < d; f++) next[offI + f] += inv * cur[offJ + f];
      }
      if (!ghost) {
        // Anchor (1−α)·X[i]. Embedded rows are 0..m-1, aligned with X.
        // inv==0 (isolated real node) skips the neighbour sum above, so it
        // falls through as pure anchor X[i].
        for (let f = 0; f < d; f++) next[offI + f] += oneMinusAlpha * X[offI + f];
      }
      // Ghost with no neighbours (inv==0): next[i] stays 0 from the fill —
      // a stable, NaN-free degenerate value (see invDeg note above).
    }
    // Swap buffers for the next iteration.
    const tmp = cur; cur = next; next = tmp;
  }

  return {
    method: ID,
    params: echoParams(p),
    n, d,
    data: cur,
  };
}

function echoParams(p) {
  // Echo only the user-facing knobs, not the injected adjacency / mask
  // (recomputable from state, large, and noisy in saved JSON).
  const ghostCount = p.ghostMask instanceof Uint8Array
    ? p.ghostMask.reduce((a, b) => a + (b === 1 ? 1 : 0), 0)
    : 0;
  return {
    alpha:      p.alpha,
    iterations: p.iterations,
    edgeCount:  p.adjacency ? Math.floor(p.adjacency.length / 2) : 0,
    ghostCount,
    countGhostsInDegree: p.countGhostsInDegree,
  };
}

function clampInt(x, lo, hi) {
  const v = Math.round(+x || 0);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function clampFloat(x, lo, hi) {
  const v = +x || 0;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
