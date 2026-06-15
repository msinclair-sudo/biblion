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
  // Citation in-degree menu: log (default, perceptually spread) + linear. The
  // colour-identical "inDeg:raw" is no longer surfaced as a menu option.
  assert.ok(realValues.includes("inDeg:log"));
  assert.ok(realValues.includes("inDeg"));
  assert.ok(!realValues.includes("inDeg:raw"));
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

test("selection focus (J25): selected nodes keep colour-by, the rest grey", () => {
  // A "scoring" highlight group selects node 1. With a selection active, the
  // colour-by stays the primary colouring for selected nodes; everything not
  // selected drops to grey. Node 0 is also pinned via the single selection, so
  // it stays coloured even though it isn't in the highlight set.
  const nodes = [{ id: 0, year: 1990 }, { id: 1, year: 2000 }, { id: 2, year: 2020 }];
  const state = {
    genResult: { nodes },
    clusterLevels: [],
    citationResult: null,
    selection: { type: "node", id: 0 },
    highlights: { bySource: { scoring: { ids: new Set([1]), colour: "#ff00ff", seq: 1 } } },
  };
  const c0 = cm.nodeColourFor(nodes[0], state, "year");   // single-selected → base
  const c1 = cm.nodeColourFor(nodes[1], state, "year");   // highlighted → base colour-by
  const c2 = cm.nodeColourFor(nodes[2], state, "year");   // neither → grey

  assert.equal(c1, cm.baseColourFor(nodes[1], state, "year"));   // colour-by, NOT a glow hue
  assert.notEqual(c1, "#ff00ff");
  assert.equal(c0, cm.baseColourFor(nodes[0], state, "year"));   // single-sel match stays lit
  assert.equal(c2, cm.DIMMED_COLOUR);                            // unselected greyed
  assert.equal(cm.anyHighlightActive(state), true);
  assert.equal(cm.isNodeHighlighted(nodes[1], state), true);
  assert.equal(cm.isNodeHighlighted(nodes[0], state), false);
});

test("no selection → every node shows its colour-by colour", () => {
  const nodes = [{ id: 0, year: 1990 }, { id: 1, year: 2020 }];
  const state = {
    genResult: { nodes }, clusterLevels: [], citationResult: null,
    selection: { type: null, id: null }, highlights: { bySource: {} },
  };
  assert.equal(cm.anyHighlightActive(state), false);
  assert.equal(cm.nodeColourFor(nodes[0], state, "year"), cm.baseColourFor(nodes[0], state, "year"));
  assert.equal(cm.nodeColourFor(nodes[1], state, "year"), cm.baseColourFor(nodes[1], state, "year"));
});

test("pinned nodes render pure white, overriding colour-by + selection-dim", () => {
  const nodes = [{ id: 0, year: 1990 }, { id: 1, year: 2000 }, { id: 2, year: 2020 }];
  const state = {
    genResult: { nodes }, clusterLevels: [], citationResult: null,
    selection: { type: null, id: null }, highlights: { bySource: {} },
    pinnedNodes: new Set([1]),
  };
  assert.equal(cm.nodeColourFor(nodes[1], state, "year"), cm.PINNED_COLOUR);   // pinned → white
  assert.equal(cm.nodeColourFor(nodes[0], state, "year"), cm.baseColourFor(nodes[0], state, "year"));
  // White wins even when the node would otherwise be greyed by a selection.
  const dimmed = { ...state, highlights: { bySource: { s: { ids: new Set([0]), seq: 1 } } } };
  assert.equal(cm.nodeColourFor(nodes[1], dimmed, "year"), cm.PINNED_COLOUR);  // still white (pinned)
  assert.equal(cm.nodeColourFor(nodes[2], dimmed, "year"), cm.DIMMED_COLOUR);  // unselected, unpinned → grey
});

test("selectedNodeIds = highlight union ∪ single-selection matches", () => {
  const nc = Int32Array.from([0, 0, 1, 1, 2]);
  const nodes = Array.from({ length: 5 }, (_, id) => ({ id, originId: id % 2 }));
  const levels = [{ uid: "L0", clusterResult: { nodeCluster: nc } }];

  // Highlight channel only.
  const hlState = {
    genResult: { nodes }, clusterLevels: levels,
    selection: { type: null, id: null },
    highlights: { bySource: { scoring: { ids: new Set([2, 4]), seq: 1 } } },
  };
  assert.deepEqual([...cm.selectedNodeIds(hlState)].sort((a,b)=>a-b), [2, 4]);

  // Single cluster selection (cluster 1 = nodes 2,3) unions with highlights.
  const both = { ...hlState, selection: { type: "cluster", level: 0, id: 1 } };
  assert.deepEqual([...cm.selectedNodeIds(both)].sort((a,b)=>a-b), [2, 3, 4]);

  // Nothing selected → empty.
  const none = { genResult: { nodes }, clusterLevels: levels,
    selection: { type: null, id: null }, highlights: { bySource: {} } };
  assert.equal(cm.selectedNodeIds(none).size, 0);
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
