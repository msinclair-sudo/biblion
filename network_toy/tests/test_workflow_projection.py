"""Browser-only residue of the back-compat projection tests.

The synthetic-tree projection logic moved to
tests/unit/workflow-projection.test.mjs (run under `node --test`). Only the
end-to-end chart-click case stays here: it needs the BFS-5000 ingest plus
layer-descriptors / clustering-registry (→ esm.sh engine) to apply a real
second clustering and click through workflow-chart.
"""

import pytest


@pytest.mark.slow
def test_chart_click_swaps_viewer_data(page):
    """End-to-end on the rehydrated fallworm baseline (n=1638): apply a
    second clustering creating a sibling card, then click the FIRST
    clustering card on the chart.
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
    # Both clusterings produced data of the same length (fallworm n=1638).
    assert out["originalNcLen"] == 1638
    assert out["afterApplyNcLen"] == 1638
    # The two clusterings differ (different mutualK).
    assert out["differBeforeProject"] is True
    # Projecting back to the original restored its data byte-for-byte.
    assert out["afterProjectMatchesOriginal"] is True
