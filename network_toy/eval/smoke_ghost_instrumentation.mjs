// Smoke run for the Part C Step-1 instrumentation harness (spec §5).
//
// Proves the harness EXECUTES headlessly and prints all three metric blocks on
// a SMALL synthetic graph (a handful of real nodes + a couple of ghosts). It
// does NOT need the fallworm data setup — see ghost_instrumentation.mjs header
// for the real-data gate-run prep (materialize_ghost_stubs + snapshot
// --include-structural + embed).
//
// Synthetic design (so the metrics have something to detect):
//   - 12 real nodes in two well-separated embedding clusters (rows 0..5 near
//     +R on every channel, rows 6..11 near -R), each with light intra-cluster
//     citation edges (homophilous backbone).
//   - 2 ghosts (indices 12,13), trailing per the ghosts-last invariant:
//       ghost 12 = a BRIDGE: cites one node in each cluster (0 and 6) that have
//                  no direct edge and no shared real neighbour → a genuine
//                  A→ghost→B bridge across the gap.
//       ghost 13 = an in-cluster ghost: cites 1 and 2 (already same cluster) —
//                  a control with no cross-gap work to do.
//
// Run:  node eval/smoke_ghost_instrumentation.mjs

import { runInstrumentation, formatReport } from "./ghost_instrumentation.mjs";
import { mulberry32, gauss } from "../app/src/rng.js";

const D = 8;                         // embedding dimensionality (small)
const CLUST_A = [0, 1, 2, 3, 4, 5];
const CLUST_B = [6, 7, 8, 9, 10, 11];
const M = CLUST_A.length + CLUST_B.length;   // 12 embedded (real) nodes
const N = M + 2;                              // + 2 ghosts (indices 12, 13)

// Embedding for the m real nodes only (rows 0..m-1). Two separated Gaussians.
const rng = mulberry32(7);
const R = 5;
const embData = new Float32Array(M * D);
for (let i = 0; i < M; i++) {
  const sign = CLUST_A.includes(i) ? +1 : -1;
  for (let c = 0; c < D; c++) embData[i * D + c] = sign * R + 0.6 * gauss(rng);
}
const embedding = { n: M, d: D, data: embData };

// Ghost mask over all n nodes — ghosts last (indices 12,13).
const ghostMask = new Uint8Array(N);
ghostMask[12] = 1;
ghostMask[13] = 1;

// Citation edges (flat [src,dst,...]).
const edges = [
  // intra-cluster real backbone (homophilous)
  0, 1,  1, 2,  2, 3,  3, 4,  4, 5,
  6, 7,  7, 8,  8, 9,  9, 10, 10, 11,
  // bridge ghost 12 → 0 (cluster A) and 6 (cluster B): no direct 0–6 edge,
  // no shared real neighbour ⇒ a real A→ghost→B bridge.
  12, 0,  12, 6,
  // in-cluster ghost 13 → 1, 2 (both cluster A) — control.
  13, 1,  13, 2,
];

const result = runInstrumentation(embedding, ghostMask, edges, {
  pcaComponents: D,        // tiny graph: keep all channels
  nullSamples: 16,
  seed: 999,
  hdbscan: { minSamples: 2, minClusterSize: 2 },
});

const replacer = (k, v) => (v instanceof Float64Array || v instanceof Float32Array ? Array.from(v) : v);

// `--json` → emit ONLY the result JSON on one line (machine-readable, for the
// pytest wrapper). Default → human report + pretty JSON.
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, replacer));
} else {
  console.log(formatReport(result));
  console.log("\n--- raw result (JSON) ---");
  console.log(JSON.stringify(result, replacer, 2));
}
