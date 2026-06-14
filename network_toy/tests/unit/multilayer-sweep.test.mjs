// Node-native unit tests for app/src/eval/multilayer-sweep.js — the
// producer/picker split of the multi-layer sweep (§9 revamp).
//
// Ports tests/test_multilayer_sweep.py 1:1. The sweep no longer auto-selects
// layers: Phase 1 maps minClusterSize→clusterCount over one shared model,
// plateaus give candidate granularities, runPhase2Score bootstraps every
// candidate, and buildLayersFromPicks turns picked counts into the coarse→fine
// clusterLevels[] ladder.
//
//   node --test tests/unit/multilayer-sweep.test.mjs
//
// The pure helpers (logSpacedSizes / findPlateauCandidates /
// buildLayersFromPicks) need no compute. The end-to-end test builds a small
// seeded blob hierarchy (rng.js, seed 3) and runs runMultilayerSweep against a
// prebuilt HDBSCAN model.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as ms from "../../app/src/eval/multilayer-sweep.js";
import * as h from "../../app/src/clustering-hdbscan.js";
import * as reg from "../../app/src/clustering-registry.js";
import * as rng from "../../app/src/rng.js";

test("pure helpers: logSpacedSizes / findPlateauCandidates / buildLayersFromPicks", () => {
  const sizes = ms.logSpacedSizes(1000, 25);
  const cands = ms.findPlateauCandidates([
    { size: 2, count: 8 }, { size: 3, count: 8 },
    { size: 5, count: 5 }, { size: 8, count: 5 }, { size: 12, count: 5 },
    { size: 20, count: 3 }, { size: 40, count: 3 },
    { size: 80, count: 1 },
  ]);
  // buildLayersFromPicks: pick a subset of candidate counts → a coarse→fine
  // ladder; unknown picks dropped; dups collapsed.
  const scored = [
    { count: 3, size: 40, stability: 0.9, clusterResult: { nodeCluster: new Int32Array([0]) } },
    { count: 5, size: 12, stability: 0.7, clusterResult: { nodeCluster: new Int32Array([1]) } },
    { count: 8, size: 3, stability: 0.8, clusterResult: { nodeCluster: new Int32Array([2]) } },
  ];
  const ladder = ms.buildLayersFromPicks(scored, [8, 3, 99, 3], "PFX");

  const sizesMonotone = sizes.every((v, i) => i === 0 || v > sizes[i - 1]);
  assert.equal(sizesMonotone, true);
  assert.equal(sizes[0], 2);                          // 2 ..
  assert.equal(sizes[sizes.length - 1], 500);         // .. n/2
  assert.deepEqual(cands.map(c => c.count), [3, 5, 8]); // count<2 dropped
  // picks {8,3,99,3} → dedup, drop unknown 99, sort coarse→fine → [3,8]
  assert.deepEqual(ladder.map(l => l.numClusters), [3, 8]);
  assert.deepEqual(ladder.map(l => l.uid), ["PFX-L0", "PFX-L1"]);
  assert.equal(
    ladder.every(l => l.clusterResult && l.clusterResult.nodeCluster),
    true,
  );                                                  // clusterResults retained
});

test("sweep scores all candidates: 2-coarse / 4-fine blob hierarchy", async () => {
  const nPer = 40, d = 3;
  const groups = [[0, 0, 0], [2, 0, 0], [20, 0, 0], [22, 0, 0]]; // 2 super-blobs of 2 sub-blobs
  const n = nPer * groups.length;
  const data = new Float32Array(n * d);
  const nodes = [];
  const rand = rng.mulberry32(3);
  let idx = 0;
  for (const g of groups) for (let k = 0; k < nPer; k++) {
    for (let c = 0; c < d; c++) data[idx * d + c] = g[c] + (rand() - 0.5) * 0.8;
    nodes.push({ id: idx, basePos: [data[idx * d], data[idx * d + 1], data[idx * d + 2]] });
    idx++;
  }
  const genResult = { nodes };
  const dimred = { method: "identity", params: {}, n, d, data };
  // leaf, as the production multi-layer sweep uses.
  const params = { minSamples: 5, selectionMethod: "leaf", uidPrefix: "MLT" };
  const model = h.buildHdbscanModel(genResult, params, dimred);
  const out = await ms.runMultilayerSweep({
    model, genResult, dimredResult: dimred, algo: reg.getAlgorithm("hdbscan"),
    params, sizeGridCount: 18,
    bootstrapOpts: { B: 5, subsampleFrac: 0.7 },
  });
  // Manual pick: the 2- and 4-cluster granularities.
  const ladder = ms.buildLayersFromPicks(out.candidates, [2, 4], "MLT");

  const curveCounts = out.curve.map(c => c.count);
  assert.ok(curveCounts.includes(2) && curveCounts.includes(4));
  // every candidate keeps its clusterResult
  assert.equal(out.candidates.every(c => c.clusterResult && c.clusterResult.nodeCluster), true);
  assert.equal(out.candidates.every(c => c.stability === null || Number.isFinite(c.stability)), true);
  assert.deepEqual(ladder.map(l => l.numClusters), [2, 4]); // the manual pick → coarse→fine ladder
  assert.deepEqual(ladder.map(l => l.uid), ["MLT-L0", "MLT-L1"]);
  assert.equal(ladder.every((l, i) => i === 0 || l.numClusters > ladder[i - 1].numClusters), true);
});
