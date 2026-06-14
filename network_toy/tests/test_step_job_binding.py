"""Tests for the step↔job binding (Phase 2 slice 2.4) +
descriptor-level modal-as-step-creator (Phase 2 slice 2.5).

Verifies:
  - enqueueJob({stepId}) mirrors job lifecycle onto the bound step
    (running / done / failed / cancelled all in one test)
  - workflow-chart renders spinner overlay on RUNNING steps + queue-
    position badge on PENDING steps (both in one test — they're
    aspects of the same render path)
  - descriptor.applyChange creates a new tree step under the canonical
    parent type; multiple applies produce sibling cards (slice 2.5)
"""

import pytest


def test_queue_mirrors_all_lifecycle_paths(page):
    """All three lifecycle outcomes — done, failed, cancelled — share
    the same mirror plumbing, so we exercise them in one test against
    three separate step+job pairs."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const q  = await import("/app/src/ui/queue.js");
            // page fixture already cleared workflow + jobs, but tests
            // run on the shared BFS-5000 session — build our own tiny
            // tree so the assertions don't entangle with the migrated
            // baseline.
            wf.clearWorkflow();
            const rootId    = wf.createStep({ type: "data", label: "root" });
            const okStep    = wf.createStep({ type: "optimise", label: "ok",     parentId: rootId });
            const failStep  = wf.createStep({ type: "optimise", label: "fail",   parentId: rootId });
            const cancStep  = wf.createStep({ type: "optimise", label: "cancel", parentId: rootId });

            // OK path: pending → running → done with setStepResult.
            const okPendingStatus = wf.getStep(okStep).status;
            const ok = q.enqueueJob({
                type: "t", label: "ok",
                fn:   async () => { await new Promise(r => setTimeout(r, 40)); return { ok: 1 }; },
                stepId: okStep,
            });
            const okMidStatus = wf.getStep(okStep).status;  // running (synchronous transition)
            const okResult = await ok.promise;
            const okFinal = wf.getStep(okStep);

            // FAIL path.
            const fail = q.enqueueJob({
                type: "t", label: "fail",
                fn:   async () => { throw new Error("boom"); },
                stepId: failStep,
            });
            let failErr = null;
            try { await fail.promise; }
            catch (e) { failErr = e.message; }
            const failSnap = wf.getStep(failStep);

            // CANCEL path: enqueue slow + cancel before it runs.
            const slowStep = wf.createStep({ type: "optimise", label: "slow", parentId: rootId });
            const slow = q.enqueueJob({
                type: "t", label: "slow",
                fn:   async () => { await new Promise(r => setTimeout(r, 200)); return "s"; },
                stepId: slowStep,
            });
            const canc = q.enqueueJob({
                type: "t", label: "cancel-me",
                fn:   async () => "should-never-run",
                stepId: cancStep,
            });
            q.cancelJob(canc.id);
            try { await canc.promise; }
            catch (_) {}
            await slow.promise;
            const cancSnap = wf.getStep(cancStep);

            return {
                okPendingStatus,
                okMidStatus,
                okResult,
                okFinalStatus: okFinal.status,
                okResultMatches: JSON.stringify(okFinal.result) === JSON.stringify({ ok: 1 }),
                okRevision: okFinal.revision,
                failErr,
                failStatus: failSnap.status,
                failError:  failSnap.error,
                cancStatus: cancSnap.status,
            };
        }'''
    )
    # OK path
    assert out["okPendingStatus"] == "pending"
    assert out["okMidStatus"]     == "running"
    assert out["okResult"]        == {"ok": 1}
    assert out["okFinalStatus"]   == "done"
    assert out["okResultMatches"] is True
    assert out["okRevision"]      == 1
    # FAIL path
    assert out["failErr"]    == "boom"
    assert out["failStatus"] == "failed"
    assert out["failError"]  == "boom"
    # CANCEL path
    assert out["cancStatus"] == "cancelled"


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
