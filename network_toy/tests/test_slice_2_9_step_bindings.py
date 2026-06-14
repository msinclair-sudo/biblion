"""Tests for Phase 2 slice 2.9 — bootstrap / dim-sweep / save-load
migrated to step-bound queue jobs.

Compact suite: one test per sub-slice, each exercising the integration
point that the migration changed (not the underlying analysis — those
have their own tests). Uses `page` for bootstrap + dim-sweep (real-data
fixture with a valid dimred/clustering ancestor).

The pure save-card step-binding mechanic moved to
tests/unit/step-job-binding.test.mjs (run under `node --test`). The
enqueueBusy import-guard stays here — it's a filesystem grep, not a
browser test.
"""

import pytest


def test_bootstrap_sidecar_runs_with_clustering(page):
    """cards.md Pass 2b — bootstrap is no longer a standalone card. It's a
    sidecar to single-level clustering: knobs live in the clustering modal,
    engine.recluster runs bootstrap after HDBSCAN, the result lands on
    state.bootstrapStability for the panel to render. There must be NO
    bootstrapStability card on the tree (the type was removed)."""
    out = page.evaluate(
        '''async () => {
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const st = await import("/app/src/ui/state.js");
            const wf = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");

            // `page` resets the workflow tree; rebuild the spine so the
            // clustering descriptor has a clustering ancestor to re-apply.
            mig.migrateLegacyToWorkflowIfNeeded();
            const clust = wf.listSteps().filter(s => s.type === "clustering").pop();
            if (clust) wf.selectStep(clust.id);

            // Clear any prior bootstrap (page may carry one from a
            // previous test) so we can assert this clustering produced it.
            st.update({ bootstrapStability: null });

            // Re-run the clustering with bootstrap enabled (B=5 keeps the
            // test quick on the slow CI PC). Re-applying writes a fresh
            // clustering card + runs recluster, which fires the sidecar.
            const desc = ld.getLayerDescriptor("clustering");
            const active = desc.getActive();
            await desc.applyChange(active.method, active.levels, {
                bootstrap: {
                    enabled: true, B: 5, subsampleFrac: 0.5,
                    minMembers: 3, noiseHandling: "exclude",
                },
            });
            // Bootstrap sidecar is detached from the descriptor's promise,
            // so wait for state.bootstrapStability to populate.
            let slot = null;
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 80));
                slot = st.getState().bootstrapStability;
                if (slot && slot.bootstrapResult) break;
            }

            // No bootstrapStability cards should exist after Pass 2b.
            const cards = Object.values(st.getState().workflow.steps)
                .filter(s => s.type === "bootstrapStability");
            // Latest clustering card carries the bootstrap settings on its
            // params (recorded by clusteringDescriptor.applyChange).
            const clustCards = Object.values(st.getState().workflow.steps)
                .filter(s => s.type === "clustering");
            const latestClust = clustCards[clustCards.length - 1];

            return {
                hasLiveSlot:        !!(slot && slot.bootstrapResult),
                aggMacroIsFinite:   slot && slot.aggregate
                                     && Number.isFinite(slot.aggregate.meanJaccard_macro),
                noLegacyCard:       cards.length === 0,
                clusteringStored_B: latestClust && latestClust.params
                                     && latestClust.params.bootstrap
                                     && latestClust.params.bootstrap.B,
            };
        }'''
    )
    assert out["hasLiveSlot"] is True
    assert out["aggMacroIsFinite"] is True
    assert out["noLegacyCard"] is True
    assert out["clusteringStored_B"] == 5


def test_dim_sweep_descriptor_creates_card_under_dimred(page):
    """Phase 2 slice 2.9.b — running a dim-sweep forks a dimSweep card
    under the selected dimred ancestor and persists the verdict.

    Uses a 2-dim × 1-seed sweep (the minimum runDimSweep accepts) for
    fast wall time on the slow CI PC.
    """
    out = page.evaluate(
        '''async () => {
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const st = await import("/app/src/ui/state.js");
            const wf = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");

            // `page` resets the workflow tree; rebuild the spine so the
            // dim-sweep descriptor has a dimred ancestor to fork under.
            mig.migrateLegacyToWorkflowIfNeeded();
            const dimred = wf.listSteps().filter(s => s.type === "dimred").pop();
            if (dimred) wf.selectStep(dimred.id);

            const desc = ld.getLayerDescriptor("dimSweep");
            const active = desc.getActive();
            if (!active.hasDimred)       return { error: "no dimred ancestor" };
            if (!active.hasStage0Input)  return { error: "no stage-0 input" };

            await desc.applyChange({
                dims: [3, 4], seeds: [42], verdictThreshold: 0.9,
            });

            const cards = Object.values(st.getState().workflow.steps)
                .filter(s => s.type === "dimSweep");
            const card = cards[cards.length - 1];
            const runs = (st.getState().validationRuns || [])
                .filter(r => r.type === "dimSweep");
            const run = runs[runs.length - 1];

            return {
                cardStatus:        card && card.status,
                cardParentMatches: card && card.parentId === active.parentId,
                hasSweep:          !!(card && card.result && card.result.sweep),
                hasVerdict:        !!(card && card.result && card.result.verdict),
                sweepDims:         card && card.result && card.result.sweep && card.result.sweep.dims,
                runLinkedToParent: run && run.inputs && run.inputs.parentStepId === active.parentId,
            };
        }'''
    )
    assert out["cardStatus"] == "done"
    assert out["cardParentMatches"] is True
    assert out["hasSweep"] is True
    assert out["hasVerdict"] is True
    assert out["sweepDims"] == [3, 4]
    assert out["runLinkedToParent"] is True


def test_no_remaining_enqueue_busy_imports_in_app_modules():
    """Phase 2 slice 2.9.c — module-level guard that no app/src/ui
    module imports enqueueBusy. Once every non-comment caller is
    gone, slice 2.11 can delete busy.js outright.

    This test reads the file system, not the page — it's a structural
    invariant on the codebase. Cheap; always runs.
    """
    import os, re
    root = os.path.join(os.path.dirname(__file__), "..", "app", "src")
    pat = re.compile(r"^\s*import\s+\{[^}]*\benqueueBusy\b", re.MULTILINE)
    offenders = []
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            if not f.endswith(".js"):
                continue
            full = os.path.join(dirpath, f)
            # busy.js exports enqueueBusy; it's allowed to mention it.
            if os.path.basename(full) == "busy.js":
                continue
            with open(full, encoding="utf-8") as fh:
                src = fh.read()
            if pat.search(src):
                offenders.append(os.path.relpath(full, root))
    assert not offenders, f"modules still importing enqueueBusy: {offenders}"
