"""Tests for the Optimise sweep flow (workflow-tree-redesign Phase 1
slice B): Run enqueues a typed job, modal closes immediately, result
auto-saves as a ValidationRun, per-row Apply works from the saved-run
panel.

Tests run against the rehydrated fallworm baseline + locked-default
dim-reduction + locked-default HDBSCAN (per conftest.py's `page`
session fixture).
"""


def test_run_enqueues_and_closes_modal(page):
    """Clicking Run enqueues an "optimise" job in state.jobs and fires
    the closeModal callback within the same tick. The job carries the
    expected metadata (type, label).

    Slice 2.11 retired state.busy + the busy-bar mirror; the job's own
    state.jobs entry is now the single source of truth for what's running.
    """
    snapshot = page.evaluate(
        '''async () => {
            let modalClosedAt = null;
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { buildOptimiseTab } = await import("/app/src/ui/modals/clustering-tabs/optimise-tab.js");
            buildOptimiseTab(host, {
                closeModal: () => { modalClosedAt = Date.now(); },
            });
            // Click Run. Defaults: real mode → no Auto scorer; ranks via
            // "richness" by default. resolution-only mode. All 3 algos.
            const t0 = Date.now();
            host.querySelector(".cm-tab-run").click();
            const state = await import("/app/src/ui/state.js");
            const jobs = state.getState().jobs;
            const runningId = jobs.runningId;
            const running = runningId ? jobs.byId[runningId] : null;
            return {
                closedSoon:   modalClosedAt !== null && (modalClosedAt - t0) < 1000,
                runningId,
                runningType:  running ? running.type : null,
                runningLabel: running ? running.label : null,
            };
        }'''
    )
    assert snapshot["closedSoon"] is True
    assert snapshot["runningId"] is not None
    assert snapshot["runningType"] == "optimise"
    assert snapshot["runningLabel"].startswith("Optimise · ")
    # No manual job cancel here: the `page` fixture's per-test reset
    # (_reset_page in conftest) cancels any pending/running jobs and wipes
    # state.jobs before the next test, on pass OR fail. An inline cancel
    # would be skipped if an assert above threw, leaving a job on the
    # shared session — so teardown is the fixture's job, not the test's.


import pytest


@pytest.mark.slow
def test_smallest_sweep_completes_and_auto_saves(page):
    """End-to-end: enqueue a small HDBSCAN-only resolution sweep
    ranked by number-of-clusters (no bootstrap). Verify auto-save
    lands a ValidationRun with the expected shape and branchId:null.

    Settings chosen for speed:
      - HDBSCAN only (the algorithm the user cares about at n=5000)
      - Resolution-only mode (~6 configs, no Phase 1/Phase 2 expansion)
      - numClusters scorer = no bootstrap, single algo.infer per config
    """
    save_id = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { buildOptimiseTab } = await import("/app/src/ui/modals/clustering-tabs/optimise-tab.js");
            buildOptimiseTab(host, { closeModal: () => {} });

            // Pick HDBSCAN only.
            const checkboxes = host.querySelectorAll(".cm-tab-checkbox-body input[type=checkbox]");
            for (const cb of checkboxes) {
                const label = cb.parentElement.textContent.trim();
                if (label.startsWith("mutualKNN") || label.startsWith("Connected")) {
                    cb.checked = false; cb.dispatchEvent(new Event("change"));
                }
            }
            // Switch scorer to numClusters — no bootstrap, fastest per-config.
            const scorerSelect = host.querySelector(".cm-tab-select-row select");
            scorerSelect.value = "numClusters";
            scorerSelect.dispatchEvent(new Event("change"));

            // Click Run. Resolution mode is the default.
            host.querySelector(".cm-tab-run").click();

            // Poll until job completes and validationRuns grows.
            const state = await import("/app/src/ui/state.js");
            for (let i = 0; i < 600; i++) {
                await new Promise(r => setTimeout(r, 200));
                if (!state.getState().jobs.runningId &&
                    state.getState().validationRuns.length > 0) break;
            }
            const runs = state.getState().validationRuns;
            const last = runs.length > 0 ? runs[runs.length - 1] : null;
            return last ? {
                id:           last.id,
                type:         last.type,
                label:        last.label,
                rankedLen:    last.results.ranked.length,
                scoreVersion: last.scoreVersion,
                branchId:     last.branchId,
                hasInputs:    !!last.inputs,
                dataSourceId: last.inputs && last.inputs.dataSourceId,
            } : null;
        }'''
    )
    assert save_id is not None, "auto-save didn't fire — sweep may have timed out"
    assert save_id["type"] == "optimise"
    assert save_id["scoreVersion"] == 3
    assert save_id["branchId"] is None
    assert save_id["rankedLen"] > 0
    assert save_id["dataSourceId"] == "real"


def test_saved_run_panel_renders(page):
    """A saved Optimise run, picked up by the validation-run-optimise
    panel in saved mode, renders sortable rows with Apply buttons."""
    page.evaluate(
        '''async () => {
            // Inject a synthetic optimise ValidationRun so the panel
            // has something to render — avoids re-running a sweep.
            const state = await import("/app/src/ui/state.js");
            const id = state.saveValidationRun({
                type: "optimise",
                label: "synthetic optimise run",
                inputs: { dataSourceId: "real", dataSourceConfig: { subset: "dev_subset_bfs_5000" }, layerParamsSnapshot: state.getState().layerParams },
                settings: { B: 10, scorerId: "ari", sweepMode: "resolution", algorithms: ["mutualKNN"] },
                results: {
                    ranked: [
                        { rank: 1, algoId: "mutualKNN", algoLabel: "mutualKNN", params: { mutualK: 10 }, primary: 0.42, nClusters: 30 },
                        { rank: 2, algoId: "mutualKNN", algoLabel: "mutualKNN", params: { mutualK: 20 }, primary: 0.38, nClusters: 18 },
                    ],
                    totalConfigs: 2, completed: 2,
                    scorerId: "ari", scorerLabel: "ARI",
                },
                scoreVersion: 3, runtimeSec: 5.0, branchId: null,
            });
            window.__synthRunId = id;
        }'''
    )
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/validation-run-optimise.js");
            const state = await import("/app/src/ui/state.js");
            mount(host, state.getState(), { runId: window.__synthRunId });
            await new Promise(r => setTimeout(r, 100));
            return {
                title:    host.querySelector(".panel-vr-title")?.textContent,
                rows:     host.querySelectorAll("tbody tr.cm-tab-row").length,
                applies:  host.querySelectorAll(".cm-tab-apply").length,
            };
        }'''
    )
    assert out["title"] == "synthetic optimise run"
    assert out["rows"] == 2
    assert out["applies"] == 2
