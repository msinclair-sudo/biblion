// Node displacement — how far each node moved between the pre- and
// post-fusion embeddings (the fusion fork's two branches). Citation-aware
// fusion (graph-diffusion) pulls papers toward their citation neighbours, so
// papers whose citation context disagrees with their semantic position move
// the most — these are the topology-shifting papers the analysis is after.
//
// The two embeddings live in independent frames (each is its own UMAP fit), so
// a raw coordinate diff is meaningless. We first align the pre layout onto the
// post layout with a global Procrustes similarity transform (alignGlobal —
// the same one the blend slider uses), then take the per-node Euclidean
// distance in the shared frame.
//
// Caveat: the alignment is a single GLOBAL rigid similarity transform, so
// displacement is measured relative to the best whole-cloud fit. A handful of
// extreme movers can tilt that fit and smear residual onto otherwise-stable
// nodes; the `correlation` field reports fit quality (low = the two layouts
// disagree globally, so per-node distances are less trustworthy). On real
// fusion shifts (papers move modestly) this is well-behaved.
//
// Pure: no state, no DOM. Reuses blend/align.js.

import { alignGlobal } from "../blend/align.js";

/**
 * @param {Float32Array} preBasePos   n×3 pre-fusion positions (source).
 * @param {Float32Array} postBasePos  n×3 post-fusion positions (target).
 * @param {number} n
 * @returns {null | {
 *   dist:        Float32Array(n),   // per-node displacement (post-frame units)
 *   correlation: number,           // global pre↔post alignment quality [0,1]
 *   max:         number,
 *   mean:        number,
 *   ranked:      Array<{id, dist}>, // descending by dist
 * }}
 * Returns null when either layout is missing / wrong length.
 */
export function computeDisplacement(preBasePos, postBasePos, n) {
  if (!(preBasePos instanceof Float32Array) || !(postBasePos instanceof Float32Array)) return null;
  if (preBasePos.length !== n * 3 || postBasePos.length !== n * 3 || n === 0) return null;

  // Align pre (source) onto post (target) — same-frame comparison.
  const { aligned, correlation } = alignGlobal({ target: postBasePos, source: preBasePos, n });

  const dist = new Float32Array(n);
  let max = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const dx = aligned[i * 3]     - postBasePos[i * 3];
    const dy = aligned[i * 3 + 1] - postBasePos[i * 3 + 1];
    const dz = aligned[i * 3 + 2] - postBasePos[i * 3 + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    dist[i] = d;
    if (d > max) max = d;
    sum += d;
  }

  const ranked = Array.from({ length: n }, (_, id) => ({ id, dist: dist[id] }))
    .sort((a, b) => b.dist - a.dist);

  return { dist, correlation, max, mean: n ? sum / n : 0, ranked };
}
