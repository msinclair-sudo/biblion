// Node-native unit tests for computeBridgesPerPair — the lean per-pair bridge
// counter that populates the multiLevelPicker heatmap. For every
// (childIdx, parentIdx) where childIdx > parentIdx (finer than coarser), it
// counts child clusters whose members straddle >= 2 parent clusters.
//
// Ports tests/test_bridges_per_pair.py 1:1. bridge-analysis.js is a pure
// dependency-free ES module, so it runs directly under Node's built-in test
// runner: no Playwright, no http.server, no Chromium. These tests build their
// own synthetic candidates (the .py used `clean_page` with no data loaded), so
// there is no shared module state to reset between tests.
//
//   node --test tests/unit/bridges-per-pair.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as ba from "../../app/src/ui/bridge-analysis.js";

// Three candidates over 6 nodes, designed so each (child, parent) pair has a
// known bridge count:
//   c0:  [0,0,0,0,0,0]   one cluster
//   c1:  [0,0,0,1,1,1]   two clusters
//   c2:  [0,0,1,1,2,2]   three clusters; cluster 1 = nodes {2,3} straddles
//                        c1 parents {0,1}  ->  1 bridge vs c1
//                        c0 has only one parent, so no bridges vs c0
//   c1 vs c0:  c1's two children both fit inside c0's single parent -> 0
//   c2 vs c0:  all 3 c2 children fit inside c0's single parent      -> 0
//   c2 vs c1:  c2-cluster 0 = {0,1} subset of c1-0; c2-cluster 1 = {2,3}
//              straddles c1-{0,1}; c2-cluster 2 = {4,5} subset of c1-1 -> 1 bridge
const cand = (labels) => ({
  clusterResult: {
    nodeCluster: new Int32Array(labels),
    clusters: [...new Set(labels)].filter((x) => x >= 0).map((id) => ({
      id,
      members: labels.map((c, i) => (c === id ? i : -1)).filter((i) => i >= 0),
    })),
  },
});

const FIXTURE_CANDIDATES = [
  cand([0, 0, 0, 0, 0, 0]),
  cand([0, 0, 0, 1, 1, 1]),
  cand([0, 0, 1, 1, 2, 2]),
];

test("output is { n, counts } with only the strict upper triangle filled", () => {
  const { n, counts } = ba.computeBridgesPerPair(FIXTURE_CANDIDATES);

  assert.equal(n, 3);
  assert.equal(counts.length, 9);

  // Lower triangle + diagonal must be 0.
  assert.deepEqual([counts[0 * n + 0], counts[1 * n + 1], counts[2 * n + 2]], [0, 0, 0]);
  assert.deepEqual([counts[0 * n + 1], counts[0 * n + 2], counts[1 * n + 2]], [0, 0, 0]);

  // Strict upper triangle: the cells we care about.
  assert.equal(counts[1 * n + 0], 0); // c1_vs_c0: both c1 children fit inside one c0 parent
  assert.equal(counts[2 * n + 0], 0); // c2_vs_c0: all c2 children fit inside one c0 parent
  assert.equal(counts[2 * n + 1], 1); // c2_vs_c1: c2-cluster 1 straddles c1-{0,1}
});

test("0 or 1 candidates -> empty counts, no crash", () => {
  const empty = ba.computeBridgesPerPair([]);
  const one = ba.computeBridgesPerPair([
    { clusterResult: { nodeCluster: new Int32Array([0, 0, 1, 1]) } },
  ]);

  assert.equal(empty.n, 0);
  assert.equal(empty.counts.length, 0);
  assert.equal(one.n, 1);
  assert.equal(one.counts.length, 1);
  assert.equal(one.counts[0], 0);
});

test("nodes with nodeCluster < 0 (HDBSCAN noise) are ignored at both ends", () => {
  const candNoise = (labels) => ({
    clusterResult: { nodeCluster: new Int32Array(labels) },
  });
  // 6 nodes; node 2 is noise in c1 (parent), node 5 is noise in c2 (child)
  // c1: [0,0,-1,1,1,1]
  // c2: [0,0,1,1,2,-1]
  // c2-cluster 0 = {0,1} subset of c1-0
  // c2-cluster 1 = {2,3} but node 2 has no parent -> only contributes node 3 (parent 1)
  // c2-cluster 2 = {4} -> parent 1 -> not a bridge
  // -> 0 bridges
  const candidates = [candNoise([0, 0, -1, 1, 1, 1]), candNoise([0, 0, 1, 1, 2, -1])];
  const { n, counts } = ba.computeBridgesPerPair(candidates);

  assert.equal(n, 2);
  assert.equal(counts[1 * n + 0], 0);
});

test("classic straddle: every child cluster straddles two parents -> count == child cluster count", () => {
  const candNoise = (labels) => ({
    clusterResult: { nodeCluster: new Int32Array(labels) },
  });
  // 8 nodes
  // parent: 4 evenly-sized parents [0,0,1,1,2,2,3,3]
  // child:  4 children that each straddle two parents
  //         child 0 = nodes {0,2} -> parents {0,1}
  //         child 1 = nodes {1,3} -> parents {0,1}
  //         child 2 = nodes {4,6} -> parents {2,3}
  //         child 3 = nodes {5,7} -> parents {2,3}
  const candidates = [
    candNoise([0, 0, 1, 1, 2, 2, 3, 3]),
    candNoise([0, 1, 0, 1, 2, 3, 2, 3]),
  ];
  const { n, counts } = ba.computeBridgesPerPair(candidates);

  assert.equal(counts[1 * n + 0], 4);
});
