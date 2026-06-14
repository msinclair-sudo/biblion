// Node-native unit tests for app/src/ui/workflow-projection.js — the back-compat
// projection that swaps legacy state slots (clusterLevels / dimredResult /
// _basePos / …) to the selected card's ancestry snapshot.
//
// Ported 1:1 from the synthetic-tree cases of tests/test_workflow_projection.py.
// workflow.js / workflow-projection.js / state.js are all pure (own state.js
// end-to-end, no DOM), so they run under `node --test`. The end-to-end
// chart-click case (test_chart_click_swaps_viewer_data) stays on Playwright:
// it needs the BFS-5000 ingest + layer-descriptors (→ esm.sh engine).
//
//   node --test tests/unit/workflow-projection.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as wf from "../../app/src/ui/workflow.js";
import * as proj from "../../app/src/ui/workflow-projection.js";
import * as state from "../../app/src/ui/state.js";

test("projecting a clustering card swaps clusterLevels (round-trip)", () => {
  wf.clearWorkflow();
  const dataId = wf.createStep({ type: "data",   label: "root" });
  const dimId  = wf.createStep({ type: "dimred", label: "d", parentId: dataId });
  wf.updateStepStatus(dimId, "running");
  wf.setStepResult(dimId, {
    dimredResult: { method: "umap", n: 4, d: 2, data: new Float32Array([1, 1, 2, 2, 3, 3, 4, 4]) },
    _basePos:     new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
    _basePos2d:   new Float32Array([0, 0, 1, 0, 2, 0, 3, 0]),
  });
  const clusterA = wf.createStep({ type: "clustering", label: "A", parentId: dimId });
  const clusterB = wf.createStep({ type: "clustering", label: "B", parentId: dimId });
  const aClusters = [{ uid: "a0", scope: "global", clusterResult: {
    method: "mutualKNN", params: { mutualK: 3 },
    nodeCluster: new Int32Array([0, 0, 1, 1]), clusters: [{ id: 0 }, { id: 1 }] } }];
  const bClusters = [{ uid: "b0", scope: "global", clusterResult: {
    method: "mutualKNN", params: { mutualK: 10 },
    nodeCluster: new Int32Array([0, 1, 0, 1]), clusters: [{ id: 0 }, { id: 1 }] } }];
  wf.updateStepStatus(clusterA, "running"); wf.setStepResult(clusterA, { clusterLevels: aClusters });
  wf.updateStepStatus(clusterB, "running"); wf.setStepResult(clusterB, { clusterLevels: bClusters });

  state.update({ engineRevision: 1 });

  proj.projectStepIntoLegacyState(clusterA);
  const afterA = state.getState();
  const ncA = Array.from(afterA.clusterLevels[0].clusterResult.nodeCluster);
  const revA = afterA.engineRevision;
  const basePosA = Array.from(afterA._basePos);

  proj.projectStepIntoLegacyState(clusterB);
  const afterB = state.getState();
  const ncB = Array.from(afterB.clusterLevels[0].clusterResult.nodeCluster);
  const revB = afterB.engineRevision;

  proj.projectStepIntoLegacyState(clusterA);
  const ncA2 = Array.from(state.getState().clusterLevels[0].clusterResult.nodeCluster);

  assert.deepEqual(ncA, [0, 0, 1, 1]);
  assert.deepEqual(ncB, [0, 1, 0, 1]);
  assert.deepEqual(ncA2, [0, 0, 1, 1]);                    // round-trip
  assert.ok(revB > revA, "engineRevision must bump on each project");
  assert.deepEqual(basePosA, [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);
});

test("projection walks ancestry root→leaf (dimred + clustering both land)", () => {
  wf.clearWorkflow();
  const dataId = wf.createStep({ type: "data",       label: "r" });
  const dimId  = wf.createStep({ type: "dimred",     label: "d", parentId: dataId });
  const cluId  = wf.createStep({ type: "clustering", label: "c", parentId: dimId });
  wf.updateStepStatus(dimId, "running");
  wf.setStepResult(dimId, {
    dimredResult: { method: "umap", n: 2, d: 3, data: new Float32Array([1, 2, 3, 4, 5, 6]) },
    _basePos: new Float32Array([7, 8, 9, 10, 11, 12]),
  });
  wf.updateStepStatus(cluId, "running");
  wf.setStepResult(cluId, {
    clusterLevels: [{ uid: "x", scope: "global", clusterResult: {
      method: "mutualKNN", params: {}, nodeCluster: new Int32Array([0, 0]), clusters: [{ id: 0 }] } }],
  });

  state.update({ dimredResult: null, _basePos: null, clusterLevels: null });
  proj.projectStepIntoLegacyState(cluId);
  const s = state.getState();

  assert.equal(s.dimredResult.method, "umap");
  assert.equal(s.dimredResult.d, 3);
  assert.deepEqual(Array.from(s._basePos.slice(0, 3)), [7, 8, 9]);
  assert.deepEqual(Array.from(s.clusterLevels[0].clusterResult.nodeCluster), [0, 0]);
});

test("projecting a step with no result still bumps engineRevision", () => {
  wf.clearWorkflow();
  const dataId = wf.createStep({ type: "data",   label: "r" });
  const dimId  = wf.createStep({ type: "dimred", label: "d", parentId: dataId });
  // dimred stays pending — no result.
  const revBefore = state.getState().engineRevision || 0;
  const changed = proj.projectStepIntoLegacyState(dimId);
  const revAfter = state.getState().engineRevision || 0;
  assert.equal(changed, false);                  // no result fields projected
  assert.ok(revAfter > revBefore);               // but revision still bumps
});

test("projecting an unknown stepId is a no-op", () => {
  const before = state.getState().engineRevision || 0;
  const changed = proj.projectStepIntoLegacyState("nonexistent-id");
  const after = state.getState().engineRevision || 0;
  assert.equal(changed, false);
  assert.equal(after, before);                    // no ancestry → no patch / bump
});
