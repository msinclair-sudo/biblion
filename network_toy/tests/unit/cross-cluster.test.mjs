// Node-native unit tests for app/src/ui/cross-cluster-citations.js — the
// per-layer directed cluster×cluster citation flow matrix + degrees.
//
// Ported 1:1 from the pure-compute cases of tests/test_cross_cluster.py. The
// module is dependency-free pure compute, so it runs under `node --test`. The
// card-wiring case (imports layer-descriptors / next-steps-rules → esm.sh
// engine) and the panel-render case stay on Playwright.
//
//   node --test tests/unit/cross-cluster.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as m from "../../app/src/ui/cross-cluster-citations.js";

test("directed flow matrix + degrees, noise edges dropped", () => {
  // nodeCluster = [0,0,1,1,2,-1] → c0={0,1}, c1={2,3}, c2={4}, node5=noise
  // edges (citing→cited): 0→2, 1→3 (c0→c1), 2→4 (c1→c2), 4→4 (c2 intra), 5→0 (drop)
  const levels = [{ uid: "L0", clusterResult: {
    nodeCluster: Int32Array.from([0, 0, 1, 1, 2, -1]),
    clusters: [{ id: 0, count: 2 }, { id: 1, count: 2 }, { id: 2, count: 1 }],
  } }];
  const edges = [0, 2, 1, 3, 2, 4, 4, 4, 5, 0];
  const res = m.computeCrossClusterAllLayers(levels, edges);
  const L = res.byLayer[0];
  const pc = Object.fromEntries(L.perCluster.map(p => [p.id, p]));

  assert.equal(res.nLevels, 1);
  assert.equal(res.totalEdges, 5);
  assert.equal(L.edgesUsed, 4);
  assert.equal(L.edgesDropped, 1);                 // 5→0 dropped (noise)
  assert.deepEqual(L.matrix, [[0, 2, 0], [0, 0, 1], [0, 0, 1]]);
  assert.equal(pc[0].outDeg, 2); assert.equal(pc[0].inDeg, 0); assert.equal(pc[0].intra, 0);
  assert.equal(pc[1].outDeg, 1); assert.equal(pc[1].inDeg, 2); assert.equal(pc[1].intra, 0);
  assert.equal(pc[2].outDeg, 0); assert.equal(pc[2].inDeg, 1); assert.equal(pc[2].intra, 1);
  assert.deepEqual(L.topLinks.map(l => [l.a, l.b, l.count]), [[0, 1, 2], [1, 2, 1]]);
});

test("no citation edges (or no levels) returns null", () => {
  const levels = [{ uid: "L0", clusterResult: {
    nodeCluster: Int32Array.from([0, 0, 1, 1]), clusters: [{ id: 0 }, { id: 1 }] } }];
  assert.equal(m.computeCrossClusterAllLayers(levels, []), null);
  assert.equal(m.computeCrossClusterAllLayers([], [0, 1]), null);
});
