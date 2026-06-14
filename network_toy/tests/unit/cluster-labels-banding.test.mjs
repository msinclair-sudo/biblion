// Node-native unit tests for the paper-df banding in
// app/src/labelling/cluster-labels.js — the banded ("stratified") label methods.
//
// labelClusters() over an injected getText accessor is pure logic (no DOM, no
// engine import), so it runs directly under `node --test`. These cases pin the
// two behaviours of J04's banding change:
//   1. the modest minimum-support floor drops sub-threshold (corpus-rare) terms
//      before banding, and
//   2. banding is on PAPER-df, so a corpus-common term lands in a more-general
//      band than a near-unique one.
// The DOM-bound rendering stays on Playwright (tests/test_cluster_labels.py).
//
//   node --test tests/unit/cluster-labels-banding.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { labelClusters, STRAT_PER_BAND } from "../../app/src/labelling/cluster-labels.js";

const ORDER = ["anchor", "broad", "mid", "specific", "signature"];

// Find which band (index in ORDER, 0 = most general) holds `term` in a banded
// cluster result; -1 if it isn't placed anywhere.
function bandIndexOf(banded, term) {
  for (const b of ORDER) {
    if ((banded.bands[b] || []).some((t) => t.term === term)) return ORDER.indexOf(b);
  }
  return -1;
}

function allBandTerms(banded) {
  const out = new Set();
  for (const b of ORDER) for (const t of banded.bands[b] || []) out.add(t.term);
  return out;
}

test("support floor drops a corpus-rare term before banding", () => {
  // 400 papers across 2 clusters. "common" is in every paper; "midword" is in
  // cluster 0's first 50 papers; "raresig" appears in exactly ONE paper. With a
  // 0.5% floor over 400 papers the threshold is ceil(2.0)=2, so a df==1 term is
  // below support and must not appear in any band, while df>=2 terms survive.
  const N = 200;            // per cluster → 400 papers total
  const texts = {};
  const nodeCluster = new Int32Array(2 * N);
  for (let i = 0; i < N; i++) {
    // cluster 0 papers: ids 0..N-1
    let t0 = "common alpha alpha";
    if (i < 50) t0 += " midword midword";
    if (i === 0) t0 += " raresig raresig";   // single paper → df==1
    texts[i] = t0;
    nodeCluster[i] = 0;
    // cluster 1 papers: ids N..2N-1
    texts[N + i] = "common beta beta";
    nodeCluster[N + i] = 1;
  }
  const cr = { nodeCluster, clusters: [{ id: 0 }, { id: 1 }] };
  const ctx = {
    embedding: null,
    nodes: Object.keys(texts).map((id) => ({ id: +id })),
    getText: (id) => texts[id],
  };

  const res = labelClusters(cr, ctx, { methods: ["cTfidfStratified"] });
  const c0 = res.perCluster[0].byMethod.cTfidfStratified;
  const terms = allBandTerms(c0);

  assert.equal(res.methods[0].available, true);
  // the single-paper term is below the support floor → dropped from every band
  assert.equal(terms.has("raresig"), false);
  // a term in 50 papers clears the floor and is placed
  assert.equal(terms.has("midword"), true);
  // the flat term list and bands never surface the sub-threshold term either
  assert.equal(c0.terms.includes("raresig"), false);
});

test("paper-df banding puts a corpus-common term in a more-general band", () => {
  // Same shape: "common" is in all 400 papers (general), "midword" in 50
  // (mid-ish), "alpha" only ever in cluster 0 (still many papers). With banding
  // on paper-df, "common" must sit at a strictly lower (more general) band index
  // than the rarer "midword".
  const N = 200;
  const texts = {};
  const nodeCluster = new Int32Array(2 * N);
  for (let i = 0; i < N; i++) {
    let t0 = "common alpha alpha";
    if (i < 50) t0 += " midword midword";
    texts[i] = t0;
    nodeCluster[i] = 0;
    texts[N + i] = "common beta beta";
    nodeCluster[N + i] = 1;
  }
  const cr = { nodeCluster, clusters: [{ id: 0 }, { id: 1 }] };
  const ctx = {
    embedding: null,
    nodes: Object.keys(texts).map((id) => ({ id: +id })),
    getText: (id) => texts[id],
  };

  const res = labelClusters(cr, ctx, { methods: ["cTfidfStratified"] });
  const c0 = res.perCluster[0].byMethod.cTfidfStratified;
  const commonBand = bandIndexOf(c0, "common");
  const midBand = bandIndexOf(c0, "midword");

  assert.notEqual(commonBand, -1);
  assert.notEqual(midBand, -1);
  // lower index = more general; the corpus-common term must be more general
  assert.ok(commonBand < midBand,
    `expected common(${commonBand}) more general than midword(${midBand})`);
  assert.equal(c0.edges.length, 3);
  // per-band cap holds
  for (const b of ORDER) assert.ok((c0.bands[b] || []).length <= STRAT_PER_BAND);
});
