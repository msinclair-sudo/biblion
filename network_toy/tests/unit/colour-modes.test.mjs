// Node-native unit tests for app/src/ui/viewer-shared/colour-modes.js — the
// shared colour resolution for viewer-3d / viewer-2d.
//
// Pure functions over a passed-in state object (no DOM, no shared module state),
// so they run directly under `node --test`. Ported from the colour-mode cases of
// tests/test_colour_modes.py. The node-table legend case stays on Playwright:
// node-table.js transitively imports the engine (→ esm.sh UMAP), which doesn't
// import under plain Node.
//
//   node --test tests/unit/colour-modes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as cm from "../../app/src/ui/viewer-shared/colour-modes.js";

test("colour options surface in-degree raw/normalised/log + real-year", () => {
  const real = {
    genResult: { nodes: [{ id: 0, year: 1990 }, { id: 1, year: 2000 }, { id: 2, year: 2020 }] },
    citationResult: { inDeg: Int32Array.from([0, 3, 50]) },
    clusterLevels: [],
  };
  const toy = { genResult: { nodes: [{ id: 0, t: 0.1 }, { id: 1, t: 0.9 }] }, clusterLevels: [] };
  const realOpts = cm.getColourModeOptions(real).map((o) => ({ v: o.value, l: o.label }));
  const toyOpts = cm.getColourModeOptions(toy).map((o) => ({ v: o.value, l: o.label }));
  const realValues = realOpts.map((o) => o.v);
  const yearLabel = (realOpts.find((o) => o.v === "year") || {}).l;

  assert.ok(realValues.includes("year"));
  assert.ok(realValues.includes("inDeg:raw"));
  assert.ok(realValues.includes("inDeg"));
  assert.ok(realValues.includes("inDeg:log"));
  assert.ok(yearLabel.includes("1990") && yearLabel.includes("2020"));   // real range
  assert.equal((toyOpts.find((o) => o.v === "year") || {}).l, "Time (t)"); // no years → fallback
  assert.equal(toyOpts.some((o) => o.v.startsWith("inDeg")), false);       // no citationResult
});

test("in-degree log mode spreads the skewed low-degree tail", () => {
  const inDeg = Int32Array.from([500, 0, 1, 1, 2, 2, 3, 4, 5, 8]);   // one hub + tail
  const state = {
    genResult: { nodes: Array.from({ length: inDeg.length }, (_, id) => ({ id })) },
    citationResult: { inDeg },
    clusterLevels: [],
  };
  const coloursFor = (mode) => state.genResult.nodes.map((n) => cm.baseColourFor(n, state, mode));
  const tail = (cols) => new Set(cols.slice(1));   // exclude the hub
  const linear = coloursFor("inDeg");
  const log = coloursFor("inDeg:log");
  const raw = coloursFor("inDeg:raw");

  assert.ok(tail(log).size > tail(linear).size);                  // log spreads the tail
  assert.equal(JSON.stringify(raw), JSON.stringify(linear));      // raw/linear share the ramp
});

test("highlight glow (J25) composes additively over base + selection-dim", () => {
  // Two nodes, single-selection on node 0 → node 1 dims. A "scoring" highlight
  // group lights node 1 in its own colour, overriding the dim; node 0 keeps base.
  const nodes = [{ id: 0, t: 0 }, { id: 1, t: 1 }];
  const state = {
    genResult: { nodes },
    clusterLevels: [],
    citationResult: null,
    selection: { type: "node", id: 0 },
    highlights: { bySource: { scoring: { ids: new Set([1]), colour: "#ff00ff" } } },
  };
  const c0 = cm.nodeColourFor(nodes[0], state, "year");   // selected, not highlighted
  const c1 = cm.nodeColourFor(nodes[1], state, "year");   // dimmed by selection, but highlighted

  assert.notEqual(c0, cm.DIMMED_COLOUR);          // selected node keeps base
  assert.equal(c1, "#ff00ff");                     // glow wins over selection-dim
  assert.equal(cm.highlightColourFor(nodes[1], state), "#ff00ff");
  assert.equal(cm.highlightColourFor(nodes[0], state), null);
});

test("highlight signature changes on add / clear / membership", () => {
  const base = { highlights: { bySource: {} } };
  const a = cm.highlightSignature(base);
  const withGroup = { highlights: { bySource: { s: { ids: new Set([1, 2]), colour: "#fff" } } } };
  const b = cm.highlightSignature(withGroup);
  const grown = { highlights: { bySource: { s: { ids: new Set([1, 2, 3]), colour: "#fff" } } } };
  const c = cm.highlightSignature(grown);

  assert.notEqual(a, b);     // add a group
  assert.notEqual(b, c);     // membership grew
  assert.equal(a, "");        // empty channel → empty signature
});

test("year mode maps real publication years across the gradient", () => {
  const nodes = [{ id: 0, year: 1960 }, { id: 1, year: 1990 }, { id: 2, year: 2020 }];
  const state = { genResult: { nodes }, citationResult: null, clusterLevels: [] };
  const ys = cm.yearStats(state.genResult);
  const cOld = cm.baseColourFor(nodes[0], state, "year");
  const cMid = cm.baseColourFor(nodes[1], state, "year");
  const cNew = cm.baseColourFor(nodes[2], state, "year");
  const cNull = cm.baseColourFor({ id: 9, t: 0.5 }, state, "year");   // no year → fallback, no crash

  assert.equal(ys.min, 1960);
  assert.equal(ys.max, 2020);
  assert.equal(new Set([cOld, cMid, cNew]).size, 3);                 // three years → three colours
  assert.ok(typeof cNull === "string" && cNull.length > 0);
});
