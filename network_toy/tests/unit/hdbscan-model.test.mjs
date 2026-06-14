// Node-native unit tests for app/src/clustering-hdbscan.js — the build/extract
// split of the HDBSCAN model (§9 multi-layer-from-sweep rework, Stage 1).
//
// inferHdbscan() was split into:
//   - buildHdbscanModel()  — dist → coreDist → MST → dendrogram (the expensive
//     O(n²) part, computed ONCE per minSamples);
//   - extractHdbscanLevel() — condense → select → resolve at a given
//     minClusterSize (cheap; re-run per layer).
//
// These assert (a) the split reproduces single-run output exactly, and (b) one
// model yields distinct partitions across sizes. The module and rng.js are pure
// (no CDN deps), so this runs directly under Node's built-in test runner — no
// Playwright, no Chromium, no real-data session.
//
//   node --test tests/unit/hdbscan-model.test.mjs
//
// Ports tests/test_hdbscan_model.py 1:1. Uses clean_page (no data) → tests build
// their own synthetic 3-blob point set via the seeded rng; the same JS runs in
// Node as in the browser, so the seeded results match.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as h from "../../app/src/clustering-hdbscan.js";
import * as rng from "../../app/src/rng.js";

// Shared synthetic input: 3 well-separated gaussian blobs, n=150, 3-D.
function setup() {
  const n = 150, d = 3;
  const data = new Float32Array(n * d);
  const rand = rng.mulberry32(7);
  const centres = [[0, 0, 0], [10, 0, 0], [0, 10, 0]];
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const c = centres[i % 3];
    for (let k = 0; k < d; k++) data[i * d + k] = c[k] + (rand() - 0.5) * 2;
    nodes.push({ id: i, basePos: [data[i * d], data[i * d + 1], data[i * d + 2]] });
  }
  const genResult = { nodes };
  const dimred = { method: "identity", params: {}, n, d, data };
  return { genResult, dimred };
}

test("buildHdbscanModel + extractHdbscanLevel == inferHdbscan at same params", () => {
  const { genResult, dimred } = setup();
  const params = { minSamples: 5, minClusterSize: 10 };
  const A = h.inferHdbscan(genResult, params, dimred);
  const model = h.buildHdbscanModel(genResult, params, dimred);
  const B = h.extractHdbscanLevel(model, params);

  let identical = A.nodeCluster.length === B.nodeCluster.length;
  for (let i = 0; identical && i < A.nodeCluster.length; i++) {
    if (A.nodeCluster[i] !== B.nodeCluster[i]) identical = false;
  }

  assert.equal(A.clusters.length, 3);
  assert.equal(B.clusters.length, 3);
  assert.equal(identical, true);
});

test("one model extracts distinct, monotone-collapsing partitions across sizes", () => {
  const { genResult, dimred } = setup();
  const model = h.buildHdbscanModel(genResult, { minSamples: 5 }, dimred);
  const sizes = [5, 15, 40, 120];
  const counts = sizes.map((mcs) =>
    h.extractHdbscanLevel(model, { minSamples: 5, minClusterSize: mcs }).clusters.length);

  // Fine sizes resolve the 3 blobs; a size larger than a blob collapses them.
  assert.equal(counts[0], 3);
  assert.ok(counts[counts.length - 1] < 3); // mcs=120 > blob size → fewer/merged
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a)); // monotone non-increasing
});
