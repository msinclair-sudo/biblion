// Node-native unit tests for app/src/eval/node-displacement.js — the pre→post
// fusion movement metric (Procrustes-align pre onto post, then per-node distance).
//
// Pure compute, ported from the compute cases of tests/test_node_displacement.py.
// The card/colour/next-steps WIRING cases stay on Playwright: they import
// layer-descriptors / next-steps-rules, which transitively reach the engine
// (→ esm.sh UMAP) and don't import under plain Node.
//
//   node --test tests/unit/node-displacement.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as m from "../../app/src/eval/node-displacement.js";

test("displacement ranks the single moved node first after alignment", () => {
  const n = 8;
  // post: a cube of side 2 (diameter ~3.5).
  const post = Float32Array.from([
    0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0, 0, 0, 2, 2, 0, 2, 0, 2, 2, 2, 2, 2,
  ]);
  // pre = post but node 3 moved ~1.1 units (modest vs cloud size).
  const pre = post.slice();
  pre[9] = 2 + 0.8; pre[10] = 2 + 0.8;   // node 3 (x,y)

  const res = m.computeDisplacement(pre, post, n);
  const others = res.ranked.slice(1).map((r) => r.dist);

  assert.ok(res);
  assert.equal(res.ranked[0].id, 3);                       // the displaced node ranks first
  assert.ok(res.ranked[0].dist > Math.max(...others) * 2); // clearly above the rest
  assert.ok(res.correlation > 0.9);                        // good rigid fit (one modest mover)
  assert.equal(res.dist.length, 8);
});

test("displacement returns null on missing / mismatched / empty layouts", () => {
  assert.equal(m.computeDisplacement(null, new Float32Array(9), 3), null);
  assert.equal(m.computeDisplacement(new Float32Array(9), new Float32Array(6), 3), null);
  assert.equal(m.computeDisplacement(new Float32Array(0), new Float32Array(0), 0), null);
});
