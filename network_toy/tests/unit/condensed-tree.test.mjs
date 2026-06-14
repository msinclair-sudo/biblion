// Node-native unit tests for the HDBSCAN condensed tree surfaced on the L0
// clusterResult (app/src/clustering-hdbscan.js → clusterResult.condensedTree).
//
// Ported from the structural + faithfulness invariant of
// tests/test_condensed_tree.py. The Playwright version drove engine.recluster()
// then inspected state; here we call inferHdbscan() directly on a synthetic
// 3-blob point set (same trick as hdbscan-model.test.mjs), so the exact same
// condensed-tree code runs under plain Node with no browser / engine / data.
//
// NOT ported (stay browser): test_condensed_tree_survives_save_load (needs the
// persistence layer → fflate, CDN-only) and the @slow real-data case (needs
// the BFS-5000 ingest). The toy engine.recluster surfacing case is subsumed
// here — same inferHdbscan code path, asserted directly.
//
//   node --test tests/unit/condensed-tree.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as h from "../../app/src/clustering-hdbscan.js";
import * as rng from "../../app/src/rng.js";

// 3 well-separated gaussian blobs, n=150, 3-D — resolves to 3 clusters.
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
  return { genResult: { nodes }, dimred: { method: "identity", params: {}, n, d, data } };
}

test("condensed tree is well-formed and reproduces the flat labels", () => {
  const { genResult, dimred } = setup();
  const cr = h.inferHdbscan(genResult, { minSamples: 5, minClusterSize: 10 }, dimred);
  const t = cr.condensedTree;
  const nc = cr.nodeCluster;
  const nf = cr.noiseFlags;

  assert.ok(t, "condensedTree present");
  assert.equal(cr.method, "hdbscan");
  assert.ok(t.numNodes > 0);
  assert.equal(t.root, 0);

  const m = t.numNodes;
  const n = t.n;
  // node-parallel arrays length == numNodes; per-leaf arrays length == n.
  assert.equal(t.parent.length, m);
  assert.equal(t.birthLambda.length, m);
  assert.equal(t.stability.length, m);
  assert.equal(t.size.length, m);
  assert.equal(t.selectedLabel.length, m);
  assert.equal(t.leafHome.length, n);
  assert.equal(t.leafLambda.length, n);

  // Parents are always lower-id ancestors; root parent is -1.
  let parentOk = (m === 0) || (t.parent[0] === -1);
  for (let i = 1; i < m && parentOk; i++) {
    const p = t.parent[i];
    if (!(p >= 0 && p < i)) parentOk = false;
  }
  assert.equal(parentOk, true);

  // Every leaf has a valid home node.
  let homeOk = true;
  for (let p = 0; p < t.n && homeOk; p++) {
    const hh = t.leafHome[p];
    if (!(hh >= 0 && hh < m)) homeOk = false;
  }
  assert.equal(homeOk, true);

  // selectedLabel covers contiguous 0..k-1.
  const labelSet = new Set();
  for (let i = 0; i < m; i++) if (t.selectedLabel[i] >= 0) labelSet.add(t.selectedLabel[i]);
  assert.ok(labelSet.size >= 1);
  assert.equal(Math.max(...labelSet), labelSet.size - 1);

  // Faithfulness: deepest selected ancestor of each stable leaf's home node
  // reproduces its shipped nodeCluster label.
  const deepestSelectedLabel = (node) => {
    let c = node;
    while (c !== -1) {
      if (t.selectedLabel[c] >= 0) return t.selectedLabel[c];
      c = t.parent[c];
    }
    return -1;
  };
  let stable = 0, match = 0, mismatch = 0;
  for (let p = 0; p < t.n; p++) {
    if (nf && nf[p] === 1) continue;          // absorbed / noise reassigned post-selection
    stable++;
    if (deepestSelectedLabel(t.leafHome[p]) === nc[p]) match++; else mismatch++;
  }
  assert.ok(stable > 0);
  assert.equal(mismatch, 0);
  assert.equal(match, stable);
  assert.equal(labelSet.size, cr.clusters.length);
});
