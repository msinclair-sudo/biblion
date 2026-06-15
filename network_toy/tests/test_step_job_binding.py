"""Browser-only residue of the step↔job binding + descriptor-as-step-creator
tests (Phase 2 slices 2.4 / 2.5).

The pure lifecycle-mirror mechanic (enqueueJob({stepId}) → running / done /
failed / cancelled on the bound step) moved to
tests/unit/step-job-binding.test.mjs (run under `node --test`). What stays here
needs a browser: the chart spinner / queue-badge render case (DOM) and the
descriptor.applyChange sibling-card cases (layer-descriptors → esm.sh engine).
"""

import pytest


def test_chart_spinner_and_queue_badge(page):
    """The chart's render path produces both the spinner overlay (for
    RUNNING) and the queue-position badge (for PENDING) — exercise
    both at once with one slow + one queued job."""
    out = page.evaluate(
        '''async () => {
            const wf  = await import("/app/src/ui/workflow.js");
            const q   = await import("/app/src/ui/queue.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            mig.migrateLegacyToWorkflowIfNeeded();
            const clustering = wf.listSteps({ type: "clustering" })[0];
            if (!clustering) throw new Error("no clustering step in migrated tree");
            const slowId = wf.createStep({
                type: "optimise", label: "slow",
                parentId: clustering.id,
            });
            const queuedId = wf.createStep({
                type: "optimise", label: "queued",
                parentId: clustering.id,
            });
            const slow = q.enqueueJob({
                type: "t", label: "slow",
                fn:   async () => { await new Promise(r => setTimeout(r, 400)); return "s"; },
                stepId: slowId,
            });
            const queued = q.enqueueJob({
                type: "t", label: "queued",
                fn:   async () => "q",
                stepId: queuedId,
            });
            // Wait a tick so the chart subscriber re-renders.
            await new Promise(r => setTimeout(r, 80));
            const root = document.getElementById("workflow-chart");
            const spinners = root.querySelectorAll("svg .wf-spinner");
            const badges = Array.from(root.querySelectorAll("svg .wf-queue-badge text"))
                                .map(t => t.textContent);
            await slow.promise; await queued.promise;
            return { spinners: spinners.length, badges };
        }'''
    )
    assert out["spinners"] >= 1, "expected a spinner on the running step"
    assert "1" in out["badges"], f"expected position-1 badge, got {out['badges']}"


# ── Slice 2.5: modal-as-step-creator (descriptor.applyChange) ──────────


@pytest.mark.slow
def test_clustering_descriptor_creates_sibling_card(page):
    """Calling clusteringDescriptor.applyChange creates a new
    clustering tree step under the dimred parent. Slow because the
    cascade runs real HDBSCAN at n=5000."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            const { getLayerDescriptor } = await import("/app/src/ui/modals/layer-descriptors.js");
            mig.migrateLegacyToWorkflowIfNeeded();

            const beforeClustering = wf.listSteps({ type: "clustering" }).length;
            const dimredCards = wf.listSteps({ type: "dimred" });
            if (dimredCards.length === 0) throw new Error("no dimred parent in migrated tree");
            const desc = getLayerDescriptor("clustering");
            // Use mutualKNN to keep this test as fast as possible at n=5000.
            const reg = await import("/app/src/clustering-registry.js");
            const algo = reg.getAlgorithm("mutualKNN");
            const newLevels = [{
                uid: Math.random().toString(36).slice(2, 10),
                params: algo.defaultParams(),
                scope: "global",
            }];
            // applyChange returns a promise that resolves after the job
            // completes (queue.js runs the cascade).
            await desc.applyChange("mutualKNN", newLevels);

            const afterClustering = wf.listSteps({ type: "clustering" });
            const newCard = afterClustering[afterClustering.length - 1];
            return {
                beforeCount:   beforeClustering,
                afterCount:    afterClustering.length,
                newCardType:   newCard.type,
                newCardStatus: newCard.status,
                newCardParentType: newCard.parentId
                    ? wf.getStep(newCard.parentId).type
                    : null,
                newCardHasResult: newCard.result !== null,
            };
        }'''
    )
    assert out["afterCount"] == out["beforeCount"] + 1
    assert out["newCardType"] == "clustering"
    assert out["newCardStatus"] == "done"
    assert out["newCardParentType"] == "dimred"
    assert out["newCardHasResult"] is True


@pytest.mark.slow
def test_clustering_applies_create_siblings_not_replace(page):
    """Each Apply creates a NEW sibling card under the same dimred
    parent — never overwrites a prior clustering card (§10.D1).
    Tests immutability + uniqueness across two consecutive Applies."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            const { getLayerDescriptor } = await import("/app/src/ui/modals/layer-descriptors.js");
            const reg = await import("/app/src/clustering-registry.js");
            mig.migrateLegacyToWorkflowIfNeeded();
            const desc = getLayerDescriptor("clustering");
            const algo = reg.getAlgorithm("mutualKNN");

            const startCount = wf.listSteps({ type: "clustering" }).length;

            // Apply #1.
            await desc.applyChange("mutualKNN", [{
                uid: "u1", params: { ...algo.defaultParams(), mutualK: 5 }, scope: "global",
            }]);
            // Apply #2 — different params.
            await desc.applyChange("mutualKNN", [{
                uid: "u2", params: { ...algo.defaultParams(), mutualK: 20 }, scope: "global",
            }]);

            const after = wf.listSteps({ type: "clustering" });
            // Find the two newest siblings — both should share the same
            // dimred parent + each should have its own non-null result.
            const last = after[after.length - 1];
            const prev = after[after.length - 2];
            return {
                createdCount:        after.length - startCount,
                lastParent:          last && last.parentId,
                prevParent:          prev && prev.parentId,
                sameParent:          last && prev && last.parentId === prev.parentId,
                lastParams_mutualK:  last && last.params.levels[0].params.mutualK,
                prevParams_mutualK:  prev && prev.params.levels[0].params.mutualK,
                lastResultId:        last && (last.result && last.result.capturedAt),
                prevResultId:        prev && (prev.result && prev.result.capturedAt),
                distinctIds:         last.id !== prev.id,
            };
        }'''
    )
    assert out["createdCount"] == 2
    assert out["sameParent"] is True
    # Each card carries its own (different) params.
    assert out["lastParams_mutualK"] != out["prevParams_mutualK"]
    # Both have a non-null result blob.
    assert out["lastResultId"] is not None
    assert out["prevResultId"] is not None
    assert out["distinctIds"] is True
