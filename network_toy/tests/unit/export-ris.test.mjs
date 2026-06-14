// Node-native unit tests for app/src/export/ris.js (RIS formatter) and
// app/src/export/cluster-export.js (selection + buildRis).
//
// Ported 1:1 from the pure-helper cases of tests/test_export_ris.py. Both
// modules are dependency-free pure functions, so they run under `node --test`.
// The card/panel WIRING cases stay on Playwright: test_export_card_* imports
// next-steps-rules (→ esm.sh engine) and the panel-render case builds DOM.
//
//   node --test tests/unit/export-ris.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as ris from "../../app/src/export/ris.js";
import * as ex from "../../app/src/export/cluster-export.js";

test("RIS formatter emits a valid record (TY/AU/TI/PY/JO/DO/AB/ER)", () => {
  const rec = {
    paperId: 1, title: "Soil microbial communities", year: 2021,
    venue: "Soil Biology", doi: "10.1/abc", pubType: "journalarticle",
    abstract: "We study\nsoil microbes.",
    authors: ["Smith, J.", "Doe, A."],
  };
  const one = ris.formatRisRecord(rec);
  const many = ris.formatRis([rec, { ...rec, title: "Second", authors: [] }]);

  assert.equal(ris.risTypeFor("journalarticle"), "JOUR");
  assert.equal(ris.risTypeFor("conferencepaper"), "CONF");
  assert.equal(ris.risTypeFor("weirdtype"), "GEN");
  assert.equal(ris.risTypeFor(null), "GEN");
  assert.equal((one.match(/^AU  - /gm) || []).length, 2);
  assert.ok(/ER  - $/m.test(one));
  assert.ok(!/AB  - We study\n/.test(one));          // newline collapsed
  assert.ok(one.includes("TI  - Soil microbial communities"));
  assert.ok(one.includes("PY  - 2021"));
  assert.ok(one.includes("DO  - 10.1/abc"));
  assert.equal((many.match(/^TY  - /gm) || []).length, 2);
});

test("selectNodes picks by per-level score and by single cluster", () => {
  const levels = [
    { uid: "L0", clusterResult: { nodeCluster: Int32Array.from([0, 0, 0, 1, 1, 1]),
      clusters: [{ id: 0 }, { id: 1 }] } },
    { uid: "L1", clusterResult: { nodeCluster: Int32Array.from([0, 0, 1, 1, 2, 2]),
      clusters: [{ id: 0 }, { id: 1 }, { id: 2 }] } },
  ];
  const scores = { L0: { 0: 5, 1: 2 }, L1: { 0: 4, 1: 1, 2: 5 } };

  const a = ex.selectNodes(levels, scores, { mode: "by-score", level: 0, minScore: 3 });
  const b = ex.selectNodes(levels, scores, { mode: "by-score", level: 1, minScore: 4 });
  const c = ex.selectNodes(levels, scores, { mode: "cluster", level: 1, clusterId: 1 });

  assert.deepEqual([...a.nodeIds], [0, 1, 2]);
  assert.deepEqual([...a.clusterIds].sort(), [0]);
  assert.deepEqual([...b.nodeIds].sort((x, y) => x - y), [0, 1, 4, 5]);
  assert.deepEqual([...b.clusterIds].sort(), [0, 2]);
  assert.deepEqual([...c.nodeIds], [2, 3]);
  assert.equal(ex.exportFilename({ mode: "by-score", level: 0, minScore: 3 }), "cluster-L0-score-ge-3.ris");
  assert.equal(ex.exportFilename({ mode: "cluster", level: 1, clusterId: 1 }), "cluster-L1-c1.ris");
});

test("buildRis gathers records via injected getRecord and counts misses", () => {
  const levels = [{ uid: "L0", clusterResult: {
    nodeCluster: Int32Array.from([0, 0, 0, 1, 1, 1]), clusters: [{ id: 0 }, { id: 1 }] } }];
  const scores = { L0: { 0: 5 } };
  const getRecord = (id) => id === 1 ? null : ({
    paperId: id, title: "Paper " + id, year: 2020, authors: ["A, B"],
    venue: null, doi: null, pubType: "journalarticle", abstract: null });
  const { ris: text, count, missing } = ex.buildRis(levels, scores,
    { mode: "by-score", level: 0, minScore: 3 }, getRecord);

  assert.equal(count, 2);          // nodes 0 and 2 (node 1 missing)
  assert.equal(missing, 1);
  assert.ok(text.includes("Paper 0"));
  assert.equal((text.match(/^TY  - /gm) || []).length, 2);
});
