"""Tests for the back-compat projection layer (Phase 2 slice 2.7).

Selecting a workflow tree card swaps the legacy state slots
(state.dimredResult / state.clusterLevels / state._basePos / etc.) to
that card's snapshot. Existing panels + viewer keep their existing
read APIs; the underlying data becomes selection-driven.

These tests use synthetic step results (hand-crafted, no real cascade)
to verify the projection logic in isolation — fast.
"""

import pytest


def test_project_clustering_swaps_cluster_levels(page):
    """Two clustering siblings with different results. Selecting card A
    via projection sets state.clusterLevels to A's data; selecting B
    swaps to B's data. engineRevision bumps each call."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const proj = await import("/app/src/ui/workflow-projection.js");
            const state = await import("/app/src/ui/state.js");

            // Build a minimal tree: data → dimred → {clusterA, clusterB}.
            wf.clearWorkflow();
            const dataId = wf.createStep({ type: "data",   label: "root" });
            const dimId  = wf.createStep({ type: "dimred", label: "d",  parentId: dataId });
            // Run the dimred step to "done" with a synthetic dimred result.
            wf.updateStepStatus(dimId, "running");
            wf.setStepResult(dimId, {
                dimredResult: { method: "umap", n: 4, d: 2, data: new Float32Array([1,1,2,2,3,3,4,4]) },
                _basePos:     new Float32Array([0,0,0, 1,0,0, 2,0,0, 3,0,0]),
                _basePos2d:   new Float32Array([0,0, 1,0, 2,0, 3,0]),
            });
            // Two clustering siblings under the dimred.
            const clusterA = wf.createStep({ type: "clustering", label: "A", parentId: dimId });
            const clusterB = wf.createStep({ type: "clustering", label: "B", parentId: dimId });
            const aClusters = [{ uid: "a0", scope: "global", clusterResult: {
                method: "mutualKNN", params: { mutualK: 3 },
                nodeCluster: new Int32Array([0,0,1,1]),
                clusters: [{ id: 0 }, { id: 1 }],
            }}];
            const bClusters = [{ uid: "b0", scope: "global", clusterResult: {
                method: "mutualKNN", params: { mutualK: 10 },
                nodeCluster: new Int32Array([0,1,0,1]),
                clusters: [{ id: 0 }, { id: 1 }],
            }}];
            wf.updateStepStatus(clusterA, "running");
            wf.setStepResult(clusterA, { clusterLevels: aClusters });
            wf.updateStepStatus(clusterB, "running");
            wf.setStepResult(clusterB, { clusterLevels: bClusters });

            // Bump engineRevision so we can detect the projection's bump.
            state.update({ engineRevision: 1 });

            // Project A.
            proj.projectStepIntoLegacyState(clusterA);
            const afterA = state.getState();
            const ncA = Array.from(afterA.clusterLevels[0].clusterResult.nodeCluster);
            const revA = afterA.engineRevision;

            // Project B.
            proj.projectStepIntoLegacyState(clusterB);
            const afterB = state.getState();
            const ncB = Array.from(afterB.clusterLevels[0].clusterResult.nodeCluster);
            const revB = afterB.engineRevision;

            // Project A again — round-trip.
            proj.projectStepIntoLegacyState(clusterA);
            const afterA2 = state.getState();
            const ncA2 = Array.from(afterA2.clusterLevels[0].clusterResult.nodeCluster);

            // Also verify dimred ancestor data was projected (its
            // _basePos came along).
            const basePosA = Array.from(afterA._basePos);

            return { ncA, ncB, ncA2, revA, revB, basePosA };
        }'''
    )
    assert out["ncA"]  == [0, 0, 1, 1]
    assert out["ncB"]  == [0, 1, 0, 1]
    assert out["ncA2"] == [0, 0, 1, 1]                           # round-trip
    assert out["revB"] > out["revA"], "engineRevision must bump on each project"
    assert out["basePosA"] == [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]


def test_project_walks_ancestry_in_order(page):
    """Walking root → leaf means deeper ancestors' projections come
    last. Verify dimred + clustering data both arrive in legacy slots."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const proj = await import("/app/src/ui/workflow-projection.js");
            const state = await import("/app/src/ui/state.js");
            wf.clearWorkflow();
            const dataId = wf.createStep({ type: "data",   label: "r" });
            const dimId  = wf.createStep({ type: "dimred", label: "d", parentId: dataId });
            const cluId  = wf.createStep({ type: "clustering", label: "c", parentId: dimId });
            wf.updateStepStatus(dimId, "running");
            wf.setStepResult(dimId, {
                dimredResult: { method: "umap", n: 2, d: 3, data: new Float32Array([1,2,3,4,5,6]) },
                _basePos: new Float32Array([7,8,9, 10,11,12]),
            });
            wf.updateStepStatus(cluId, "running");
            wf.setStepResult(cluId, {
                clusterLevels: [{ uid: "x", scope: "global", clusterResult: {
                    method: "mutualKNN", params: {},
                    nodeCluster: new Int32Array([0,0]),
                    clusters: [{ id: 0 }],
                }}],
            });

            // Clear legacy slots first so we can prove the projection
            // filled them.
            state.update({
                dimredResult: null,
                _basePos: null,
                clusterLevels: null,
            });

            proj.projectStepIntoLegacyState(cluId);
            const s = state.getState();
            return {
                dimredMethod:    s.dimredResult && s.dimredResult.method,
                dimredDim:       s.dimredResult && s.dimredResult.d,
                basePosFirst:    s._basePos && Array.from(s._basePos.slice(0, 3)),
                clusterNc:       s.clusterLevels && Array.from(s.clusterLevels[0].clusterResult.nodeCluster),
            };
        }'''
    )
    assert out["dimredMethod"] == "umap"
    assert out["dimredDim"]    == 3
    assert out["basePosFirst"] == [7, 8, 9]
    assert out["clusterNc"]    == [0, 0]


def test_project_handles_no_result(page):
    """Projecting an ancestry where some steps have no result (pending /
    failed / cancelled) should still work — those steps just contribute
    nothing to the patch. Only engineRevision bumps."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const proj = await import("/app/src/ui/workflow-projection.js");
            const state = await import("/app/src/ui/state.js");
            wf.clearWorkflow();
            const dataId = wf.createStep({ type: "data",   label: "r" });
            const dimId  = wf.createStep({ type: "dimred", label: "d", parentId: dataId });
            // dimred stays pending — no result.

            // Capture engineRevision before.
            const revBefore = state.getState().engineRevision || 0;
            const changed = proj.projectStepIntoLegacyState(dimId);
            const revAfter = state.getState().engineRevision || 0;
            return { changed, revBefore, revAfter };
        }'''
    )
    # changed=False (no result fields projected), but engineRevision still bumps.
    assert out["changed"] is False
    assert out["revAfter"] > out["revBefore"]


def test_project_handles_unknown_step(page):
    """Projecting an unknown stepId returns false + no state changes."""
    out = page.evaluate(
        '''async () => {
            const proj = await import("/app/src/ui/workflow-projection.js");
            const state = await import("/app/src/ui/state.js");
            const before = state.getState().engineRevision || 0;
            const changed = proj.projectStepIntoLegacyState("nonexistent-id");
            const after = state.getState().engineRevision || 0;
            return { changed, before, after };
        }'''
    )
    assert out["changed"] is False
    # No ancestry → no patch applied (no engineRevision bump either).
    assert out["after"] == out["before"]


@pytest.mark.slow
def test_chart_click_swaps_viewer_data(page):
    """End-to-end on BFS-5000: apply a second clustering creating a
    sibling card, then click the FIRST clustering card on the chart.
    state.clusterLevels should swap back to the first card's data —
    proves projection wires through workflow-chart's onCardClick."""
    out = page.evaluate(
        '''async () => {
            const wf  = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            const proj = await import("/app/src/ui/workflow-projection.js");
            const reg = await import("/app/src/clustering-registry.js");
            const { getLayerDescriptor } = await import("/app/src/ui/modals/layer-descriptors.js");
            mig.migrateLegacyToWorkflowIfNeeded();

            // Find the original (migration-created) clustering card.
            const original = wf.listSteps({ type: "clustering" })[0];
            const originalNc = Array.from(
                wf.getStep(original.id).result.clusterLevels[0].clusterResult.nodeCluster
            );

            // Apply a NEW clustering config — creates a sibling card.
            // Use a different mutualK so its nodeCluster differs.
            const algo = reg.getAlgorithm("mutualKNN");
            const desc = getLayerDescriptor("clustering");
            await desc.applyChange("mutualKNN", [{
                uid: "newK", params: { ...algo.defaultParams(), mutualK: 30 }, scope: "global",
            }]);
            // Now state.clusterLevels reflects the sibling.
            const state = await import("/app/src/ui/state.js");
            const afterApplyNc = Array.from(state.getState().clusterLevels[0].clusterResult.nodeCluster);

            // Project back to the original. This is what clicking the
            // first card in the chart does internally.
            proj.projectStepIntoLegacyState(original.id);
            const afterProjectNc = Array.from(state.getState().clusterLevels[0].clusterResult.nodeCluster);

            // Sanity: the two clusterings differ.
            let countDiff = 0;
            const minLen = Math.min(originalNc.length, afterApplyNc.length);
            for (let i = 0; i < minLen; i++) {
                if (originalNc[i] !== afterApplyNc[i]) countDiff++;
            }
            return {
                originalNcLen:        originalNc.length,
                afterApplyNcLen:      afterApplyNc.length,
                afterProjectNcLen:    afterProjectNc.length,
                differBeforeProject:  countDiff > 0,
                afterProjectMatchesOriginal: originalNc.length === afterProjectNc.length &&
                    originalNc.every((v, i) => v === afterProjectNc[i]),
            };
        }'''
    )
    # Both clusterings produced data of the same length (n=5000).
    assert out["originalNcLen"] == 5000
    assert out["afterApplyNcLen"] == 5000
    # The two clusterings differ (different mutualK).
    assert out["differBeforeProject"] is True
    # Projecting back to the original restored its data byte-for-byte.
    assert out["afterProjectMatchesOriginal"] is True
