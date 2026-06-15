// Node-native unit tests for the multi-level clustering tree maths
// (app/src/clustering-multilevel.js) and the parallel-distance API contract
// (app/src/workers/parallel-distance.js).
//
// Ported 1:1 from the pure-maths cases of tests/test_multilevel.py
// (test_discover_and_flatten_synthetic, test_absorb_via_mst_crosses_branches,
// test_parallel_distance_matches_sync). The engine-lane / picker-card / panel
// cases stay on Playwright (they need engine.recluster + layer-descriptors +
// DOM).
//
// NOTE on parallel-distance: under plain Node `typeof Worker === "undefined"`,
// so pairwiseDistancesParallel takes its sync fallback. This therefore checks
// the API contract (parallel result == sync result) but does NOT exercise the
// real worker fan-out — that path only runs in the browser.
//
//   node --test tests/unit/multilevel.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as m from "../../app/src/clustering-multilevel.js";
import * as pd from "../../app/src/workers/parallel-distance.js";

test("discoverLayers + flattenFrontier cut a balanced tree 2→3→4", () => {
  const tree = {
    numNodes: 7, n: 8, root: 0,
    parent:      Int32Array.from([-1, 0, 0, 1, 1, 2, 2]),
    birthLambda: Float64Array.from([0, 1, 1, 3, 3, 6, 6]),
    stability:   Float64Array.from([0, 2, 2, 1, 1, 1, 1]),
    size:        Int32Array.from([8, 4, 4, 2, 2, 2, 2]),
    leafHome:    Int32Array.from([3, 3, 4, 4, 5, 5, 6, 6]),
    leafLambda:  Float64Array.from([8, 8, 8, 8, 8, 8, 8, 8]),
  };
  const layers = m.discoverLayers(tree);
  const cut = (lam) => Array.from(m.relabelFrontier(m.flattenFrontier(tree, lam), 8).labels).join("");

  assert.deepEqual(layers.map(l => l.clusterCount), [2, 3, 4]);
  assert.ok(layers.every((l, i) => i === 0 || l.clusterCount > layers[i - 1].clusterCount));
  assert.equal(cut(layers[0].lambda), "00001111");   // A | B
  assert.equal(cut(layers[1].lambda), "00112222");   // A1 | A2 | B
  assert.equal(cut(layers[2].lambda), "00112233");   // A1 | A2 | B1 | B2
});

test("absorbViaMST attaches stripped points across branches (bridge)", () => {
  // path graph 0-1-2-3-4-5-6-7, unit weights
  const mst = [0, 1, 2, 3, 4, 5, 6].map(i => ({ i, j: i + 1, w: 1 }));
  const adj = m.buildMstAdjacency(mst, 8);
  const labels = Int32Array.from([0, 0, 0, -1, -1, 1, 1, 1]);
  m.absorbViaMST(labels, adj, 8);
  // the two stripped middle points split to opposite clusters by MST distance
  assert.ok(!Array.from(labels).includes(-1));
  assert.deepEqual(Array.from(labels), [0, 0, 0, 0, 1, 1, 1, 1]);
});

test("pairwiseDistancesParallel matches the sync matrix (n=1500)", async () => {
  const n = 1500, d = 8;
  let s = 12345 >>> 0;
  const rnd = () => (s = (1103515245 * s + 12345) >>> 0) / 4294967296;
  const data = new Float32Array(n * d);
  for (let i = 0; i < data.length; i++) data[i] = rnd();
  const dimred = { method: "test", params: {}, n, d, data };

  const A = pd.pairwiseDistancesSync(dimred, n);
  const B = await pd.pairwiseDistancesParallel(dimred, n, { concurrency: 4 });
  let maxDiff = 0;
  for (let i = 0; i < A.length; i++) {
    const diff = Math.abs(A[i] - B[i]);
    if (diff > maxDiff) maxDiff = diff;
  }
  assert.equal(A.length, 1500 * 1500);
  assert.equal(B.length, A.length);
  assert.ok(maxDiff < 1e-4);
});
