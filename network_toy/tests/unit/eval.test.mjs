// Node-native unit tests for app/src/eval/lhs.js (Latin-hypercube sampler) and
// app/src/eval/jaccard.js (bipartite cluster matching).
//
// Ported 1:1 from the pure-JS unit cases of tests/test_eval.py
// (test_lhs_sampler_determinism_and_coverage, test_bipartite_match_min_members_
// filter). lhs.js + clustering-registry.js + jaccard.js are all pure (no DOM,
// no CDN dep), so they run under `node --test`. The sweep / bootstrap cases in
// test_eval.py stay on Playwright: they call clustering-registry algorithms
// against the BFS-5000 genResult/dimredResult held in the booted page's state.
//
//   node --test tests/unit/eval.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { sampleLatinHypercube } from "../../app/src/eval/lhs.js";
import { bipartiteMatchJaccard } from "../../app/src/eval/jaccard.js";
import * as reg from "../../app/src/clustering-registry.js";

test("LHS sampler: count, in-range, log span, deterministic per seed", () => {
  const hdb = reg.getAlgorithm("hdbscan");
  const a  = sampleLatinHypercube(hdb, 30, 42);
  const a2 = sampleLatinHypercube(hdb, 30, 42);   // same seed
  const b  = sampleLatinHypercube(hdb, 30, 99);   // different seed

  const mcs = a.map(s => s.minClusterSize);
  const ms  = a.map(s => s.minSamples);
  const sel = a.map(s => s.selectionMethod);

  assert.equal(a.length, 30);
  assert.ok(Math.min(...mcs) >= 2 && Math.max(...mcs) <= 500);
  assert.ok(Math.max(...mcs) / Math.min(...mcs) >= 10);   // log scale spans ≥1 order
  assert.ok(Math.min(...ms) >= 1 && Math.max(...ms) <= 50);
  assert.ok(sel.includes("eom") && sel.includes("leaf"));
  assert.equal(JSON.stringify(a), JSON.stringify(a2));     // deterministic
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));   // seed changes output
});

test("bipartiteMatchJaccard minMembers drops sub-threshold ref clusters", () => {
  // 10 nodes: refA={0}, refB={1,2}, refC={3..9} — sizes 1, 2, 7.
  const ref  = new Int32Array([0, 1, 1, 2, 2, 2, 2, 2, 2, 2]);
  const cand = new Int32Array([0, 1, 1, 2, 2, 2, 2, 2, 2, 2]);
  const noFilter   = bipartiteMatchJaccard(ref, cand);
  const withFilter = bipartiteMatchJaccard(ref, cand, null, { minMembers: 3 });

  assert.deepEqual([...noFilter.keys()].sort(), [0, 1, 2]);
  assert.deepEqual([...withFilter.keys()].sort(), [2]);    // only refC (size 7) survives
});
