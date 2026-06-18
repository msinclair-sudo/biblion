// Node-native unit tests for the ghost keep/classify rule in
// app/src/datasource/sqlite.js (ghostKeepKind). The rule is a pure function so
// it runs under `node --test` without the sql.js load path.
//
//   node --test tests/unit/ghost-keep.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { ghostKeepKind } from "../../app/src/datasource/sqlite.js";

test("missing-data ghost (is_stub=0): kept at >=1 real partner", () => {
  // A real paper missing only an abstract. One real citer is enough.
  assert.equal(ghostKeepKind(0, 1), "missing-data");
  assert.equal(ghostKeepKind(0, 5), "missing-data");
});

test("missing-data ghost: dropped when isolated (0 real partners)", () => {
  assert.equal(ghostKeepKind(0, 0), null);
});

test("pending ghost (is_stub=1): needs >=2 real partners", () => {
  // Identifier-only co-cited stub: a single citer is a pendant — dropped.
  assert.equal(ghostKeepKind(1, 0), null);
  assert.equal(ghostKeepKind(1, 1), null);
  assert.equal(ghostKeepKind(1, 2), "pending");
  assert.equal(ghostKeepKind(1, 9), "pending");
});

test("is_seed is irrelevant — only is_stub + degree decide", () => {
  // Same inputs always give the same answer; there is no seed parameter.
  assert.equal(ghostKeepKind(0, 1), "missing-data");
  assert.equal(ghostKeepKind(1, 1), null);
});
