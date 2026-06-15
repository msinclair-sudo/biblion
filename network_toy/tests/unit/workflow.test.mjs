// Node-native unit tests for app/src/ui/workflow.js (CRUD + invariants) and
// app/src/ui/workflow-migration.js (legacy state → tree migration).
//
// Ported 1:1 from the pure-logic cases of tests/test_workflow.py. workflow.js
// and workflow-migration.js own state.workflow end-to-end through state.js
// (no DOM), so they import and run directly under `node --test`. Each test
// calls clearWorkflow() first, matching the Playwright `page` fixture's reset.
//
// The two migration cases that need a booted data fixture
// (test_migration_bfs5000_real_mode / test_migration_toy_mode_includes_citations)
// stay on Playwright: they assert the shape inferBaselineTree produces from a
// real/toy genResult, which needs ingest. The migration LOGIC over a hand-built
// snapshot is covered here by test_validation_runs_attach_to_right_anchor.
//
//   node --test tests/unit/workflow.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as w from "../../app/src/ui/workflow.js";
import * as state from "../../app/src/ui/state.js";
import * as mig from "../../app/src/ui/workflow-migration.js";

test("empty workflow on boot", () => {
  w.clearWorkflow();
  assert.deepEqual(state.getState().workflow, { steps: {}, rootId: null, selected: null });
  assert.equal(w.getRootStep(), null);
  assert.equal(w.getSelectedStep(), null);
  assert.deepEqual(w.listSteps(), []);
});

test("createStep validation", () => {
  w.clearWorkflow();
  const out = {};
  try { w.createStep({ label: "x" }); out.missingType = false; }
  catch (e) { out.missingType = e.message.includes("type is required"); }
  try { w.createStep({ type: "data" }); out.missingLabel = false; }
  catch (e) { out.missingLabel = e.message.includes("label is required"); }
  try { w.createStep({ type: "data", label: "x", refIds: "no" }); out.badRefs = false; }
  catch (e) { out.badRefs = e.message.includes("refIds must be an array"); }
  const rootId = w.createStep({ type: "data", label: "n=400 toy" });
  out.rootSet = w.getRootStep().id === rootId;
  try { w.createStep({ type: "data", label: "another" }); out.twoRoots = false; }
  catch (e) { out.twoRoots = e.message.includes("root already exists"); }
  try { w.createStep({ type: "dimred", label: "x", parentId: "nope" }); out.badParent = false; }
  catch (e) { out.badParent = e.message.includes("unknown parentId"); }
  try { w.createStep({ type: "fc", label: "x", parentId: rootId, refIds: ["nope"] }); out.badRef = false; }
  catch (e) { out.badRef = e.message.includes("unknown refId"); }
  for (const [k, v] of Object.entries(out)) assert.equal(v, true, `validation failure: ${k}`);
});

test("status transitions", () => {
  w.clearWorkflow();
  const root  = w.createStep({ type: "data",   label: "root" });
  const child = w.createStep({ type: "dimred", label: "child", parentId: root });
  w.updateStepStatus(child, "running");
  assert.equal(w.getStep(child).status, "running");

  let badBack = false;
  try { w.updateStepStatus(child, "pending"); }
  catch (e) { badBack = e.message.includes("invalid transition"); }
  assert.equal(badBack, true);

  let notRunning = false;
  try { w.setStepResult(root, { x: 1 }); }
  catch (e) { notRunning = e.message.includes('must be "running"'); }
  assert.equal(notRunning, true);

  w.setStepResult(child, { dim: 50 });
  const cSnap = w.getStep(child);
  assert.equal(cSnap.status, "done");
  assert.equal(cSnap.revision, 1);
  assert.equal(cSnap.upstreamRevision, 0);

  let terminal = false;
  try { w.updateStepStatus(child, "running"); }
  catch (e) { terminal = e.message.includes("invalid transition"); }
  assert.equal(terminal, true);
});

test("stale propagation from re-run root", () => {
  w.clearWorkflow();
  const root  = w.createStep({ type: "data",   label: "root" });
  const child = w.createStep({ type: "dimred", label: "child", parentId: root });
  w.updateStepStatus(child, "running");
  w.setStepResult(child, { dim: 50 });
  assert.equal(w.isStepStale(child), false);
  w.updateStepStatus(root, "running");
  w.setStepResult(root, { reingested: true });
  assert.equal(w.isStepStale(child), true);
});

test("progress clamping and running-only", () => {
  w.clearWorkflow();
  const root = w.createStep({ type: "data",     label: "root" });
  const id   = w.createStep({ type: "optimise", label: "sweep", parentId: root });
  w.updateStepProgress(id, { phase: "noisy", fraction: 0.3 });
  assert.equal(w.getStep(id).progress, null);
  w.updateStepStatus(id, "running");
  w.updateStepProgress(id, { phase: "compress", fraction: 0.5 });
  assert.deepEqual(w.getStep(id).progress, { phase: "compress", fraction: 0.5 });
  w.updateStepProgress(id, { fraction: 2.0 });
  assert.equal(w.getStep(id).progress.fraction, 1.0);
  w.updateStepStatus(id, "cancelled");
});

test("selectStep", () => {
  w.clearWorkflow();
  const root  = w.createStep({ type: "data",   label: "root" });
  const child = w.createStep({ type: "dimred", label: "child", parentId: root });
  w.selectStep(child);
  assert.equal(w.getSelectedStep().id, child);
  w.selectStep(null);
  assert.equal(w.getSelectedStep(), null);
  w.selectStep("nope");                  // silent no-op
  assert.equal(w.getSelectedStep(), null);
  w.selectStep(root);
  assert.equal(w.getSelectedStep().id, root);
});

test("delete cascade prunes children and dangling refs", () => {
  w.clearWorkflow();
  const root  = w.createStep({ type: "data",       label: "root" });
  const child = w.createStep({ type: "dimred",     label: "child", parentId: root });
  const gc    = w.createStep({ type: "clustering", label: "gc",    parentId: child });
  const cmp   = w.createStep({
    type: "fusionComparison", label: "cmp",
    parentId: root, refIds: [child, gc],
  });
  w.selectStep(gc);
  const deleted = w.deleteStep(child);
  assert.equal(deleted.length, 2);                  // child + gc
  assert.equal(w.getStep(child), null);
  assert.equal(w.getStep(gc), null);
  assert.notEqual(w.getStep(cmp), null);
  assert.deepEqual(w.getStep(cmp).refIds, []);      // pruned of deleted ids
  assert.notEqual(w.getStep(root), null);
});

test("listSteps filters don't prune traversal", () => {
  w.clearWorkflow();
  const a = w.createStep({ type: "data",       label: "A" });
  const b = w.createStep({ type: "dimred",     label: "B", parentId: a });
  w.createStep({ type: "dimred",               label: "C", parentId: a });
  const d = w.createStep({ type: "clustering", label: "D", parentId: b });
  w.updateStepStatus(b, "running");
  w.setStepResult(b, "B-result");
  assert.deepEqual(w.listSteps({ type: "dimred" }).map(s => s.label).sort(), ["B", "C"]);
  assert.deepEqual(w.listSteps({ status: "done" }).map(s => s.label), ["B"]);
  assert.deepEqual(w.getStepAncestors(d).map(s => s.label), ["A", "B", "D"]);
  assert.deepEqual(w.getStepDescendants(a).map(s => s.label).sort(), ["B", "C", "D"]);
});

test("migration is idempotent over a hand-built snapshot", () => {
  // The Playwright version runs migration on the real-data fixture. Here we
  // drive inferBaselineTree directly off a minimal toy-shaped snapshot so the
  // idempotence + apply logic is covered without an ingest.
  w.clearWorkflow();
  const snap = {
    dataSource: { mode: "toy", configs: { toy: {} } },
    genResult:  { nodes: new Array(100).fill({}), origins: [] },
    layerParams: {
      dimred: {
        noise:       { method: "identity", params: {} },
        fusion:      { method: "identity", params: {} },
        compression: { method: "identity", params: {} },
        viz:         { method: "identity", params: {} },
        viz2d:       { method: "identity", params: {} },
      },
      clustering: { method: "mutualKNN", levels: [{ params: { mutualK: 5 } }] },
    },
    dimredResult:  { method: "identity", n: 100, d: 3, data: new Float32Array(300) },
    clusterLevels: [{ uid: "abc", clusterResult: { method: "mutualKNN", nodeCluster: new Int32Array(100), clusters: [] } }],
    citationResult: null,
    validationRuns: [],
  };
  const plan = mig.inferBaselineTree(snap);
  assert.ok(plan.length > 0);
  mig.applyTreePlan(plan);
  const firstCount = w.listSteps().length;
  // Re-applying the same plan onto a non-empty workflow is rejected (single
  // root invariant), so a second apply must not grow the tree.
  let grew = false;
  try { mig.applyTreePlan(plan); grew = w.listSteps().length > firstCount; }
  catch (_e) { grew = false; }
  assert.equal(grew, false);
});

test("validation runs attach to the right anchor", () => {
  w.clearWorkflow();
  const fakeState = {
    dataSource: { mode: "toy", configs: { toy: {} } },
    genResult:  { nodes: new Array(100).fill({}), origins: [] },
    layerParams: {
      dimred: {
        noise:       { method: "identity", params: {} },
        fusion:      { method: "identity", params: {} },
        compression: { method: "identity", params: {} },
        viz:         { method: "identity", params: {} },
        viz2d:       { method: "identity", params: {} },
      },
      clustering: { method: "mutualKNN", levels: [{ params: { mutualK: 5 } }] },
    },
    dimredResult:  { method: "identity", n: 100, d: 3, data: new Float32Array(300) },
    clusterLevels: [{ uid: "abc", clusterResult: { method: "mutualKNN", nodeCluster: new Int32Array(100), clusters: [] } }],
    citationResult: null,
    validationRuns: [
      { id: "r1", type: "optimise",           label: "opt",  results: {}, scoreVersion: 3, timestamp: "2026-05-26T10:00Z" },
      { id: "r2", type: "dimSweep",           label: "ds",   results: {}, scoreVersion: 1, timestamp: "2026-05-26T10:01Z" },
      { id: "r3", type: "bootstrapStability", label: "boot", results: {}, scoreVersion: 3, timestamp: "2026-05-26T10:02Z" },
    ],
  };
  const plan = mig.inferBaselineTree(fakeState);
  mig.applyTreePlan(plan);
  const parentOf = (type) =>
    w.listSteps({ type }).map(s => (s.parentId ? w.getStep(s.parentId).type : null));
  assert.deepEqual(parentOf("optimise"),           ["clustering"]);
  assert.deepEqual(parentOf("dimSweep"),           ["dimred"]);
  assert.deepEqual(parentOf("bootstrapStability"), ["clustering"]);
});
