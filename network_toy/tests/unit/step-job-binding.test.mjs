// Node-native unit tests for the step↔job binding (Phase 2 slice 2.4 / 2.9):
// enqueueJob({stepId}) mirrors a job's lifecycle onto its bound workflow step.
//
// Ported 1:1 from the pure-mechanic cases of tests/test_step_job_binding.py
// (test_queue_mirrors_all_lifecycle_paths) and
// tests/test_slice_2_9_step_bindings.py (test_save_card_attaches_under_root_via_
// enqueue_job). queue.js + workflow.js + state.js + workflow-projection.js are
// all pure, so the lifecycle mirror runs under `node --test`.
//
// NOT ported (stay browser): the chart-spinner / queue-badge render case (DOM),
// and the descriptor-driven slice cases (layer-descriptors → esm.sh engine),
// the bootstrap/dim-sweep sidecar cases (engine.recluster). The enqueueBusy
// import-guard test stays in test_slice_2_9_step_bindings.py — it's a pure
// filesystem grep in Python, not a browser test.
//
// Note: on a job's `done`, queue.js fires a best-effort dynamic import of
// panel-system.js to auto-open the result panel; under plain Node that import
// fails (force-graph is CDN-only) and queue.js logs a caught console.warn. It's
// harmless and does not affect the binding assertions below.
//
//   node --test tests/unit/step-job-binding.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as wf from "../../app/src/ui/workflow.js";
import * as q from "../../app/src/ui/queue.js";

test("queue mirrors done / failed / cancelled onto bound steps", async () => {
  wf.clearWorkflow();
  const rootId   = wf.createStep({ type: "data",     label: "root" });
  const okStep   = wf.createStep({ type: "optimise", label: "ok",     parentId: rootId });
  const failStep = wf.createStep({ type: "optimise", label: "fail",   parentId: rootId });
  const cancStep = wf.createStep({ type: "optimise", label: "cancel", parentId: rootId });

  // OK path: pending → running (synchronous) → done with setStepResult.
  assert.equal(wf.getStep(okStep).status, "pending");
  const ok = q.enqueueJob({
    type: "t", label: "ok",
    fn: async () => { await new Promise(r => setTimeout(r, 40)); return { ok: 1 }; },
    stepId: okStep,
  });
  assert.equal(wf.getStep(okStep).status, "running");      // synchronous transition
  const okResult = await ok.promise;
  const okFinal = wf.getStep(okStep);
  assert.deepEqual(okResult, { ok: 1 });
  assert.equal(okFinal.status, "done");
  assert.equal(JSON.stringify(okFinal.result), JSON.stringify({ ok: 1 }));
  assert.equal(okFinal.revision, 1);

  // FAIL path.
  const fail = q.enqueueJob({
    type: "t", label: "fail",
    fn: async () => { throw new Error("boom"); },
    stepId: failStep,
  });
  let failErr = null;
  try { await fail.promise; } catch (e) { failErr = e.message; }
  const failSnap = wf.getStep(failStep);
  assert.equal(failErr, "boom");
  assert.equal(failSnap.status, "failed");
  assert.equal(failSnap.error, "boom");

  // CANCEL path: enqueue a slow job, then a job we cancel before it runs.
  const slowStep = wf.createStep({ type: "optimise", label: "slow", parentId: rootId });
  const slow = q.enqueueJob({
    type: "t", label: "slow",
    fn: async () => { await new Promise(r => setTimeout(r, 200)); return "s"; },
    stepId: slowStep,
  });
  const canc = q.enqueueJob({
    type: "t", label: "cancel-me",
    fn: async () => "should-never-run",
    stepId: cancStep,
  });
  q.cancelJob(canc.id);
  try { await canc.promise; } catch (_e) { /* cancelled */ }
  await slow.promise;
  assert.equal(wf.getStep(cancStep).status, "cancelled");
});

test("enqueueJob binds a save card under the root and lands its result", async () => {
  wf.clearWorkflow();
  const rootId = wf.createStep({ type: "data", label: "root" });
  const stepId = wf.createStep({
    type: "save", label: "Save smoke", params: { filename: "smoke.zip" }, parentId: rootId,
  });
  const { promise } = q.enqueueJob({
    type: "save", label: "Save smoke", stepId,
    fn: async () => ({ capturedAt: "x", filename: "smoke.zip", sizeBytes: 42, savedAt: "x" }),
  });
  await promise;

  const card = wf.getStep(stepId);
  assert.equal(card.status, "done");
  assert.equal(card.parentId, rootId);
  assert.equal(card.result.sizeBytes, 42);
  assert.equal(card.result.filename, "smoke.zip");
});
