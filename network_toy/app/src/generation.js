// Generation layer.
//
// Pure data producer — given inputs (seed, nodeCount, pointsOfOrigin), emits
// origins and nodes. No DOM, no rendering, no clustering, no citations.
//
// Math reference: doc/dynamics.md §1.
//
// Output shape:
//   {
//     R,                                  half-extent of the bounding cube
//     origins: [{ id, centre:[x,y,z], spread:[sx,sy,sz], colour }],
//     nodes:   [{ id, originId, t, basePos:[x,y,z] }],
//   }
//
// `originId` is the generation-time mixture component the node was sampled
// from. It is intentionally NOT called "cluster" — clusters belong to a
// separate layer that infers them from positions. originId is only kept for
// debug visualization of the generator itself.

import { mulberry32, gauss3 } from "./rng.js";

export const R_GLOBAL = 60;

// Distinct palette for origins. Reused for both the origin marker and the
// nodes drawn from that origin, so debug viz reads at a glance.
const ORIGIN_PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ab",
  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
];

export const defaultGenerationParams = () => ({
  seed: 42,
  nodeCount: 100,
  pointsOfOrigin: 6,
  // Multiplier on the per-axis sigma. 1.0 keeps the math.md baseline
  // [0.07R, 0.25R]; >1 widens each blob, <1 tightens it. Centres are
  // unaffected — only the spread of nodes around each centre.
  spreadScale: 1.0,
});

export function generate(params) {
  const seed = params.seed >>> 0;
  const N = Math.max(1, params.nodeCount | 0);
  const K = Math.max(1, Math.min(N, params.pointsOfOrigin | 0));
  const spreadScale = Math.max(0, +params.spreadScale || 1);
  const rng = mulberry32(seed);
  const R = R_GLOBAL;

  // 1. Origin centres + per-axis spreads.
  //    Centre: each axis uniform on [-R, +R] (uniform in the cube).
  //    Spread: per-axis sigma in [0.07R, 0.25R], independent → ellipsoids.
  const origins = [];
  for (let k = 0; k < K; k++) {
    const centre = [
      R * (2 * rng() - 1),
      R * (2 * rng() - 1),
      R * (2 * rng() - 1),
    ];
    const spread = [
      R * (0.07 + rng() * 0.18) * spreadScale,
      R * (0.07 + rng() * 0.18) * spreadScale,
      R * (0.07 + rng() * 0.18) * spreadScale,
    ];
    origins.push({
      id: k,
      centre,
      spread,
      colour: ORIGIN_PALETTE[k % ORIGIN_PALETTE.length],
    });
  }

  // 2. Allocate N nodes across origins by weighted multinomial.
  //    Every origin guaranteed >=1 node; remainder distributed by weight.
  const counts = new Array(K).fill(1);
  const remaining = Math.max(0, N - K);
  if (remaining > 0) {
    const weights = [];
    let wSum = 0;
    for (let k = 0; k < K; k++) {
      const w = 0.4 + rng();
      weights.push(w);
      wSum += w;
    }
    if (wSum === 0) wSum = 1;
    for (let i = 0; i < remaining; i++) {
      let r = rng() * wSum;
      for (let k = 0; k < K; k++) {
        r -= weights[k];
        if (r <= 0) { counts[k]++; break; }
      }
    }
  }

  // 3. Sample positions: x = centre + g ⊙ spread, g ~ N(0, I3).
  //    Timestamp t ~ U(0,1). basePos is frozen for the lifetime of this set.
  const nodes = [];
  let nid = 0;
  for (let k = 0; k < K; k++) {
    const c = origins[k].centre;
    const s = origins[k].spread;
    for (let i = 0; i < counts[k]; i++) {
      const g = gauss3(rng);
      nodes.push({
        id: nid++,
        originId: k,
        t: rng(),
        basePos: [
          c[0] + g[0] * s[0],
          c[1] + g[1] * s[1],
          c[2] + g[2] * s[2],
        ],
      });
    }
  }

  return { R, origins, nodes };
}
