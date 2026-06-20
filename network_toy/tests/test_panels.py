"""Tests for the panel surfaces (§6.19 work):
  - validation-run-optimise (covered in test_optimise.py)
  - bootstrap-stability
  - method-receipt
  - bridge-analysis
  - fusion-comparison (+ NMI + comparePartitions helpers)
  - dim-sweep (+ heatmap + bars chart helpers + sweep runner)

Real-data (BFS-5000) page by default.
"""

import pytest


# ── method-receipt ─────────────────────────────────────────────────────


def test_method_receipt_renders(page):
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/method-receipt.js");
            const state = await import("/app/src/ui/state.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 100));
            return {
                bodyText: host.textContent,
                hasCopyBtn: !!host.querySelector("button"),
            };
        }'''
    )
    # Sanity: receipt mentions the data source + algorithm. J27 flipped the
    # default source to `sqlite` (and retired `real`), so the receipt now
    # renders "Data: sqlite, ...".
    assert "sqlite" in out["bodyText"].lower()
    assert "hdbscan" in out["bodyText"].lower()
    assert out["hasCopyBtn"] is True


def test_method_receipt_follows_selected_multilevel_card(page):
    """Regression: the receipt must describe the SELECTED workflow card,
    not the global layerParams.clustering. Selecting a multi-layer card
    should switch the clustering paragraph to the sweep-selected ladder
    wording and surface that card's own minSamples/floor — even though
    the global config still says plain HDBSCAN."""
    out = page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const wf    = await import("/app/src/ui/workflow.js");
            // Build a minimal data → dimred → multiLevel tree and select
            // the multiLevel card. clusterLevels stays the live one.
            state.update({ workflow: { steps: {}, rootId: null, selected: null } });
            const data = wf.createStep({ type: "data", label: "Data", params: {} });
            const dr   = wf.createStep({ type: "dimred", label: "Dimred", params: {}, parentId: data });
            // Producer (sweep) card carries the settings; picker child carries
            // the committed ladder — the receipt describes the picker.
            const ml   = wf.createStep({
                type: "multiLevel", label: "Multi-layer sweep",
                params: { minSamples: 17, floor: 0.55, B: 12 },
                parentId: dr,
            });
            wf.updateStepStatus(ml, "running");
            wf.setStepResult(ml, {
                multiLevelSweep: { candidates: [], curve: [], uidPrefix: ml, floor: 0.55 },
                settings:        { minSamples: 17, floor: 0.55, B: 12 },
                scoreVersion:    3,
            });
            const pk = wf.createStep({
                type: "multiLevelPicker", label: "Pick layers",
                params: { pickedCounts: [3, 6] }, parentId: ml,
            });
            wf.updateStepStatus(pk, "running");
            wf.setStepResult(pk, {
                clusterLevels:   state.getState().clusterLevels,
                clusterResult:   state.getState().clusterResult,
                pickedCounts:    [3, 6],
                nLevels:         (state.getState().clusterLevels || []).length,
            });
            wf.selectStep(pk);

            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/method-receipt.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 100));
            const txt = host.textContent;
            // Clean up so we don't leak the synthetic tree into later tests.
            state.update({ workflow: { steps: {}, rootId: null, selected: null } });
            return txt;
        }'''
    )
    assert "multi-layer ladder" in out.lower()
    assert "minsamples=17" in out.lower()
    assert "floor=0.55" in out.lower()


# ── bridge-analysis ────────────────────────────────────────────────────


def test_bridge_analysis_empty_with_one_level(page):
    """With only one clustering level (the BFS-5000 default), the
    bridge panel shows an empty-state hint."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/bridge-analysis.js");
            const state = await import("/app/src/ui/state.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 100));
            return {
                emptyText: host.querySelector(".panel-bridge-empty")?.textContent,
                table:     !!host.querySelector(".panel-bridge-table"),
            };
        }'''
    )
    assert out["emptyText"] is not None
    assert "two" in out["emptyText"].lower() or "level" in out["emptyText"].lower()
    assert out["table"] is False


# ── bootstrap-stability ────────────────────────────────────────────────


def test_bootstrap_stability_panel_saved_mode(page):
    """Saved-mode render: slice 2.9.a removed the panel's live tab —
    bootstrap is now kicked off from the workflow chart and the panel
    renders a bound run/card. Inject a synthetic bootstrapStability
    ValidationRun and verify the aggregate strip + per-cluster table
    render (the actual compute + card-binding path is covered by
    test_slice_2_9_step_bindings.test_bootstrap_descriptor_*)."""
    out = page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const id = state.saveValidationRun({
                type: "bootstrapStability",
                label: "synthetic bootstrap run",
                inputs: { dataSourceId: "real", dataSourceConfig: { subset: "dev_subset_bfs_5000" } },
                settings: { B: 5 },
                results: {
                    bootstrapResult: {
                        aggregate: {
                            meanJaccard_macro: 0.71, meanJaccard_unweighted: 0.68,
                            nClusters: 3, noiseFraction: 0.04, noiseHandling: "exclude",
                            nStable: 2, nDoubtful: 1, nUnstable: 0,
                        },
                        perCluster: [
                            { clusterId: 0, memberCount: 120, meanJaccard: 0.91, classification: "stable" },
                            { clusterId: 1, memberCount: 80,  meanJaccard: 0.74, classification: "stable" },
                            { clusterId: 2, memberCount: 40,  meanJaccard: 0.58, classification: "doubtful" },
                        ],
                    },
                    cluster: { label: "hdbscan", nClusters: 3 },
                },
                scoreVersion: 3, runtimeSec: 4.0, branchId: null,
            });

            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/bootstrap-stability.js");
            mount(host, state.getState(), { runId: id });
            await new Promise(r => setTimeout(r, 100));
            return {
                title:     host.querySelector(".panel-bs-title")?.textContent,
                aggStrip:  !!host.querySelector(".panel-bs-agg"),
                tableRows: host.querySelectorAll(".panel-bs-row").length,
            };
        }'''
    )
    assert out["title"] == "synthetic bootstrap run"
    assert out["aggStrip"] is True
    assert out["tableRows"] == 3


# ── fusion-comparison helpers ──────────────────────────────────────────


def test_fusion_compare_helpers(page):
    """Pure helper unit tests — NMI on three label arrays + a hand-
    crafted compareFusionPartitions case. Merged from two prior
    tests since both exercise the eval/{nmi,fusion-compare}.js
    surface with no data dependency."""
    out = page.evaluate(
        '''async () => {
            const { normalisedMutualInformation, adjustedMutualInformation } =
                await import("/app/src/eval/nmi.js");
            const { compareFusionPartitions } = await import("/app/src/eval/fusion-compare.js");
            // NMI cases.
            const A = new Int32Array([0,0,0,1,1,1,2,2,2]);
            const B = new Int32Array([0,0,0,1,1,1,2,2,2]);  // identical
            const C = new Int32Array([2,2,2,0,0,0,1,1,1]);  // relabelled
            const D = new Int32Array([0,1,2,0,1,2,0,1,2]);  // independent
            // compareFusionPartitions case.
            const pre  = { nodeCluster: new Int32Array([0,0,0,0, 1,1,1,1, 2,2,2,2]),
                           clusters: [{id:0},{id:1},{id:2}] };
            const post = { nodeCluster: new Int32Array([0,0,0,2, 1,1,1,1, 2,2,2,1]),
                           clusters: [{id:0},{id:1},{id:2}] };
            const r = compareFusionPartitions(pre, post);
            return {
                identical: normalisedMutualInformation(A, B).nmi_arith,
                permuted:  normalisedMutualInformation(A, C).nmi_arith,
                indep:     normalisedMutualInformation(A, D).nmi_arith,
                ami:       adjustedMutualInformation(A, B).ami,
                cmp: {
                    ari:   r.aggregate.ari,
                    macro: r.aggregate.macroJaccard,
                    pre:   r.aggregate.nClustersPre,
                    post:  r.aggregate.nClustersPost,
                    topRetention: r.topMovers[0].retention,
                    len:   r.perNodeRetention.length,
                },
            };
        }'''
    )
    # NMI.
    assert abs(out["identical"] - 1.0) < 1e-6
    assert abs(out["permuted"]  - 1.0) < 1e-6
    assert out["indep"] < 0.3
    assert abs(out["ami"] - 1.0) < 1e-3
    # compareFusionPartitions.
    c = out["cmp"]
    assert 0.5 < c["ari"]   < 1.0
    assert 0.5 < c["macro"] < 1.0
    assert c["pre"] == 3 and c["post"] == 3
    assert c["len"] == 12
    assert c["topRetention"] < 0.5


def test_fusion_comparison_panel_empty_when_unbound(page):
    """With no saved comparison bound, the panel shows the new empty hint
    pointing at the fork → Fusion comparison card flow. (The old live
    pre/post mode reading clusterLevelsPreFusion was removed with the fusion
    fork.)"""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/fusion-comparison.js");
            const state = await import("/app/src/ui/state.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 100));
            return {
                title: host.querySelector(".panel-fc-title")?.textContent,
                emptyText: host.querySelector(".panel-fc-empty")?.textContent,
                hasAgg: !!host.querySelector(".panel-fc-agg"),
            };
        }'''
    )
    assert out["title"] == "Fusion comparison"
    assert out["emptyText"] is not None
    assert "No comparison bound" in out["emptyText"]
    assert out["hasAgg"] is False


# ── dim-sweep panel + chart helpers ────────────────────────────────────


def test_chart_helpers_render(page):
    """heatmap + bars helpers produce SVG output. No data needed."""
    out = page.evaluate(
        '''async () => {
            const heatHost = document.createElement("div");
            const barsHost = document.createElement("div");
            document.body.appendChild(heatHost);
            document.body.appendChild(barsHost);
            const { renderHeatmap } = await import("/app/src/ui/charts/heatmap.js");
            const { renderBars }    = await import("/app/src/ui/charts/bars.js");
            renderHeatmap(heatHost, {
                matrix:    [[1.0, 0.7], [0.7, 1.0]],
                rowLabels: ["d=2", "d=3"],
                colLabels: ["d=2", "d=3"],
                palette:   "ari",
            });
            renderBars(barsHost, {
                values: [50, 55],
                errors: [2, 3],
                labels: ["d=2", "d=3"],
                yLabel: "n clusters",
            });
            return {
                heatCells:    heatHost.querySelectorAll(".chart-heatmap-cell").length,
                heatOverlays: heatHost.querySelectorAll(".chart-heatmap-overlay").length,
                bars:         barsHost.querySelectorAll(".chart-bars-rect").length,
                whiskers:     barsHost.querySelectorAll(".chart-bars-whisker").length,
            };
        }'''
    )
    assert out["heatCells"] == 4
    assert out["heatOverlays"] == 4
    assert out["bars"] == 2
    assert out["whiskers"] == 2


@pytest.mark.slow
def test_dim_sweep_runner_tiny(page):
    """Run a 2-dim × 1-seed sweep on BFS-5000. Pure runner exercise
    (no panel). Expected: ariMatrix has the expected keys, diagonals
    are 1.0. Takes ~30-60s (two UMAP-100 fits + two HDBSCAN passes)."""
    out = page.evaluate(
        '''async () => {
            const { runDimSweep } = await import("/app/src/eval/dim-sweep.js");
            const state = await import("/app/src/ui/state.js");
            const s = state.getState();
            const result = await runDimSweep({
                input:     { n: s.genResult.nodes.length, d: s.embedding.d, data: s.embedding.data },
                genResult: s.genResult,
                dims:  [50, 100],
                seeds: [42],
                noise:        { method: "pca",      params: { n_components: 100 } },
                compression:  { method: "umap",     params: { n_neighbors: 50, min_dist: 0, metric: "cosine" } },
                clustering:   { method: "hdbscan",  params: { minClusterSize: 15, minSamples: 5, selectionMethod: "eom", selectionEpsilon: 0, noiseMode: "absorb" } },
            });
            return {
                dims:  result.dims,
                seeds: result.seeds,
                diag50:  result.ariMatrix[50][50].mean,
                diag100: result.ariMatrix[100][100].mean,
                cross:   result.ariMatrix[50][100].mean,
                runtimeSec: result.runtimeSec,
            };
        }'''
    )
    assert out["dims"] == [50, 100]
    assert abs(out["diag50"] - 1.0) < 1e-6
    assert abs(out["diag100"] - 1.0) < 1e-6
    assert 0 <= out["cross"] <= 1


def test_dim_sweep_panel_mounts(page):
    """Empty-state smoke: slice 2.9.b removed the panel's live tab, so
    mounting with no bound run/card renders the title + the hint that
    points at the workflow chart's Dim sweep card. No run button or
    live estimate any more (saved-mode render is covered by
    test_dim_sweep_panel_saved_mode)."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/dim-sweep.js");
            const state = await import("/app/src/ui/state.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 100));
            return {
                title:     host.querySelector(".panel-ds-title")?.textContent,
                emptyText: host.querySelector(".panel-ds-empty")?.textContent,
                runBtn:    !!host.querySelector(".panel-ds-run"),
                estimate:  !!host.querySelector(".panel-ds-estimate"),
            };
        }'''
    )
    assert out["title"] == "Dim sweep"
    assert out["emptyText"] is not None
    assert "Dim sweep card" in out["emptyText"]
    assert out["runBtn"] is False
    assert out["estimate"] is False


def test_dim_sweep_panel_saved_mode(page):
    """Saved-mode render: inject a synthetic dimSweep ValidationRun
    and verify the panel renders the heatmap + bars + verdict banner."""
    out = page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const sweep = {
                dims: [50, 100],
                seeds: [42],
                inputs: { noise: { method: "pca" }, compression: { method: "umap" }, clustering: { method: "hdbscan" } },
                partitions: { 42: {
                    50:  { nodeCluster: new Int32Array(5000), nClusters: 30, timeSec: 30 },
                    100: { nodeCluster: new Int32Array(5000), nClusters: 32, timeSec: 35 },
                }},
                ariMatrix: {
                    50:  { 50: {mean:1.0,sd:0,perSeed:[1.0]},   100: {mean:0.78,sd:0,perSeed:[0.78]} },
                    100: { 50: {mean:0.78,sd:0,perSeed:[0.78]}, 100: {mean:1.0,sd:0,perSeed:[1.0]} },
                },
                clusterCounts: {
                    50:  { mean: 30, sd: 0, perSeed: [30] },
                    100: { mean: 32, sd: 0, perSeed: [32] },
                },
                runtimeSec: 65, completedAt: new Date().toISOString(),
            };
            const id = state.saveValidationRun({
                type: "dimSweep",
                label: "synthetic dim sweep",
                inputs: { dataSourceId: "real", dataSourceConfig: { subset: "dev_subset_bfs_5000" }, layerParamsSnapshot: state.getState().layerParams },
                settings: { dims: [50, 100], seeds: [42], verdictPair: [50, 100], verdictThreshold: 0.9 },
                results:  { sweep, verdict: { pair: [50, 100], threshold: 0.9, mean: 0.78, sd: 0, defensible: false } },
                scoreVersion: 1, runtimeSec: 65, branchId: null,
            });
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/dim-sweep.js");
            mount(host, state.getState(), { runId: id });
            await new Promise(r => setTimeout(r, 200));
            return {
                title:        host.querySelector(".panel-ds-title")?.textContent,
                bannerText:   host.querySelector(".panel-ds-verdict-banner")?.textContent,
                heatmapCells: host.querySelectorAll(".chart-heatmap-cell").length,
                bars:         host.querySelectorAll(".chart-bars-rect").length,
                hasRunBtn:    !!host.querySelector(".panel-ds-run"),
                hasSaveBtn:   !!host.querySelector(".panel-ds-save"),
            };
        }'''
    )
    assert out["title"] == "synthetic dim sweep"
    assert "FAIL" in out["bannerText"]
    assert out["heatmapCells"] == 4
    assert out["bars"] == 2
    assert out["hasRunBtn"] is False
    assert out["hasSaveBtn"] is False


# ── selected-papers abstract modal ──────────────────────────────────────


def test_abstract_modal_shows_and_navigates(page):
    """The Selected-papers per-row 'abstract' button opens a reader modal that
    pulls the abstract from the live snapshot DB and pages across the rows it
    was handed. Mirrors test_export_bibtex's live-corpus reconnect/cleanup."""
    out = page.evaluate(r'''async () => {
        const sq    = await import("/app/src/datasource/sqlite.js");
        const state = await import("/app/src/ui/state.js");
        const pt    = await import("/app/src/ui/panels/paper-table.js");
        const am    = await import("/app/src/ui/modals/abstract-modal.js");
        const nodes = (state.getState().genResult || {}).nodes || [];
        const ok = await sq.reconnectSqliteCorpus("fallworm", nodes);
        try {
            if (!ok || !sq.hasSqliteText()) return { sqliteLoaded: false };
            const levels = state.getState().clusterLevels || [];
            const rows = [];
            for (let i = 0; i < 3; i++) rows.push(pt.joinPaperRow(i, state.getState(), levels));
            const modal = am.openAbstractModal(rows, 0);
            const dialog = document.querySelector("#modal-root .modal-dialog");
            const title0 = dialog.querySelector(".abstract-modal-title").textContent;
            const counter0 = dialog.querySelector(".abstract-modal-counter").textContent;
            const hasText = !!dialog.querySelector(".abstract-modal-text");
            const prevDisabled0 = dialog.querySelector(".abstract-modal-nav button").disabled;

            // Page forward.
            const navBtns = dialog.querySelectorAll(".abstract-modal-nav button");
            navBtns[navBtns.length - 1].click();   // Next ›
            const title1 = dialog.querySelector(".abstract-modal-title").textContent;
            const counter1 = dialog.querySelector(".abstract-modal-counter").textContent;

            modal.close();
            const closed = !document.querySelector("#modal-root .modal-dialog");
            return {
                sqliteLoaded: true, hasText, prevDisabled0,
                title0, title1, counter0, counter1, closed,
                titleChanged: title0 !== title1,
            };
        } finally {
            sq.clearSqliteCorpus();
        }
    }''')
    if out.get("sqliteLoaded") is not True:
        pytest.skip("fallworm snapshot DB unavailable in this environment")
    assert out["hasText"] is True
    assert out["prevDisabled0"] is True           # Prev disabled on the first row
    assert out["counter0"] == "1 of 3"
    assert out["counter1"] == "2 of 3"
    assert out["titleChanged"] is True
    assert out["closed"] is True


# ── panel-system re-entrancy guard ─────────────────────────────────────


def test_secondary_slot_survives_state_writing_panel_teardown(page):
    """Regression: switching away from a panel whose destroy() writes state
    (e.g. tags-list clearing its 'tags' highlight) must NOT double-mount the
    incoming secondary panel. The teardown's synchronous state.update() re-
    enters the panel-system subscribe; without the slot-tracker guard in
    renderActivePanel that recursion re-ran the render and mounted the
    incoming panel twice, wiping its DOM and leaving the slot unresponsive."""
    out = page.evaluate(r'''async () => {
        const state = await import("/app/src/ui/state.js");
        const reg   = await import("/app/src/ui/panels/registry.js");

        const cartMeta = reg.getPanelType("cart");
        const tagsMeta = reg.getPanelType("tags-list");
        const origCart = cartMeta.mount;
        const origTags = tagsMeta.mount;
        const priorSecondary = state.getState().panels.secondary;

        // Outgoing panel whose instance.destroy() writes state — mimics
        // tags-list.destroy() -> clearHighlight("tags").
        cartMeta.mount = (c, s, cfg, tc) => {
            const inst = origCart(c, s, cfg, tc);
            return {
                update: inst && inst.update ? (x) => inst.update(x) : undefined,
                destroy() { state.clearHighlight("tags"); if (inst && inst.destroy) inst.destroy(); },
            };
        };
        let mounts = 0;
        tagsMeta.mount = (...a) => { mounts++; return origTags(...a); };

        try {
            const cur = state.getState().panels;
            state.update({ panels: { ...cur, secondary: {
                activeTabId: "reentryA",
                tabs: [ { id: "reentryA", type: "cart", config: {} },
                        { id: "reentryB", type: "tags-list", config: {} } ],
            }}});
            // Populate the channel the outgoing destroy clears, so its
            // clearHighlight actually fires update() (the re-entrancy trigger).
            state.addHighlight("tags", [0], "#ffffff");

            mounts = 0;
            state.setActiveTab("secondary", "reentryB");
            const switchMounts = mounts;

            const contentEl = document.querySelector('.panel-slot[data-slot="secondary"] .panel-content');
            const childCount = contentEl ? contentEl.children.length : -1;

            // Slot still responsive afterwards?
            state.setActiveTab("secondary", "reentryA");
            const back = state.getState().panels.secondary.activeTabId;
            state.setActiveTab("secondary", "reentryB");
            const fwd = state.getState().panels.secondary.activeTabId;

            return { switchMounts, childCount, back, fwd };
        } finally {
            cartMeta.mount = origCart;
            tagsMeta.mount = origTags;
            state.clearHighlight("tags");
            state.update({ panels: { ...state.getState().panels, secondary: priorSecondary } });
        }
    }''')
    assert out["switchMounts"] == 1, "incoming panel double-mounted (re-entrancy guard missing)"
    assert out["childCount"] == 1
    assert out["back"] == "reentryA" and out["fwd"] == "reentryB"



# ── tags-list category grouping (§ tag-categories) ─────────────────────

# Groups render collapsed on open; this JS helper clicks every collapsed
# header (category + genus) until the whole tree is expanded.
_EXPAND_ALL = """
        const expandAll = () => {
          for (let i = 0; i < 12; i++) {
            const c = [...host.querySelectorAll(".tags-group-toggle")]
              .filter(h => h.querySelector(".tags-group-chevron").textContent === "▸");
            if (!c.length) break;
            c.forEach(h => h.click());
          }
        };
"""


def test_tags_list_starts_collapsed(page):
    """On open every group is collapsed: headers show ▸ and no tag rows render."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const state = await import("/app/src/ui/state.js");
            const prev = { tags: state.getState().tags, tagCategories: state.getState().tagCategories,
                           tagVocabulary: state.getState().tagVocabulary };
            state.update({
                tags: { 1: ["Canis lupus"], 2: ["BRCA1"] },
                tagCategories: { "Canis lupus": "species", "BRCA1": "gene" },
                tagVocabulary: ["species", "gene", "method", "theme"],
            });
            try {
                const { mount } = await import("/app/src/ui/panels/tags-list.js");
                mount(host, state.getState(), {});
                await new Promise(r => setTimeout(r, 30));
                return {
                    headers: [...host.querySelectorAll(".tags-group-header")]
                        .map(h => h.textContent.replace(/^[▸▾] */, "")),
                    chevrons: [...host.querySelectorAll(".tags-group-header .tags-group-chevron")]
                        .map(c => c.textContent),
                    nameCount: host.querySelectorAll(".tags-name").length,
                };
            } finally { state.update(prev); }
        }'''
    )
    assert out["nameCount"] == 0                       # nothing expanded
    assert set(out["chevrons"]) == {"▸"}               # all collapsed
    assert any("species" in h for h in out["headers"]) # headers still listed


def test_tags_list_groups_by_category(page):
    """After expanding, a header per category (default name-asc → alphabetical,
    uncategorised last) files each tag under its category."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const state = await import("/app/src/ui/state.js");
            const prev = { tags: state.getState().tags, tagCategories: state.getState().tagCategories,
                           tagVocabulary: state.getState().tagVocabulary };
            state.update({
                tags: { 1: ["Canis lupus", "to-read"], 2: ["BRCA1"] },
                tagCategories: { "Canis lupus": "species", "BRCA1": "gene" },
                tagVocabulary: ["species", "gene", "method", "theme"],
            });
            try {
                const { mount } = await import("/app/src/ui/panels/tags-list.js");
                mount(host, state.getState(), {});
                await new Promise(r => setTimeout(r, 30));
                ''' + _EXPAND_ALL + '''
                expandAll();
                await new Promise(r => setTimeout(r, 10));
                const headers = [...host.querySelectorAll(".tags-group-header")]
                    .map(h => h.textContent.replace(/^[▸▾] */, ""));
                const names = [...host.querySelectorAll(".tags-name")].map(n => n.textContent);
                return { headers, names };
            } finally { state.update(prev); }
        }'''
    )
    assert out["headers"] == ["gene (1)", "species (1)", "Uncategorised (1)"], out["headers"]
    assert set(out["names"]) == {"Canis lupus", "BRCA1", "to-read"}


def test_tags_list_category_sort_reorders_groups(page):
    """The Count sort reorders the category headers themselves (by aggregate
    occurrence sum), not just the tags within them; Name sort is alphabetical."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const state = await import("/app/src/ui/state.js");
            const prev = { tags: state.getState().tags, tagCategories: state.getState().tagCategories,
                           tagVocabulary: state.getState().tagVocabulary };
            // "gene" sorts before "method" by name, but "method" has the larger
            // aggregate count (3 vs 1), so Count flips their order.
            state.update({
                tags: { 1: ["Mmm"], 2: ["Mmm"], 3: ["Mmm", "Ggg"] },
                tagCategories: { "Ggg": "gene", "Mmm": "method" },
                tagVocabulary: ["species", "gene", "method", "theme"],
            });
            try {
                const { mount } = await import("/app/src/ui/panels/tags-list.js");
                mount(host, state.getState(), {});
                await new Promise(r => setTimeout(r, 30));
                const headers = () => [...host.querySelectorAll(".tags-group-header")]
                    .map(h => h.textContent.replace(/^[▸▾] */, ""));
                const btn = (label) => [...host.querySelectorAll(".tags-sort-btn")]
                    .find(b => b.textContent.startsWith(label));
                const byNameAsc = headers();
                btn("Count").click(); await new Promise(r => setTimeout(r, 10));
                const byCountDesc = headers();
                return { byNameAsc, byCountDesc };
            } finally { state.update(prev); }
        }'''
    )
    assert out["byNameAsc"] == ["gene (1)", "method (1)"], out["byNameAsc"]
    assert out["byCountDesc"] == ["method (1)", "gene (1)"], out["byCountDesc"]


def test_tags_list_filter_and_collapse(page):
    """Filter narrows the list; collapsing the species category hides its rows."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const state = await import("/app/src/ui/state.js");
            const prev = { tags: state.getState().tags, tagCategories: state.getState().tagCategories,
                           tagVocabulary: state.getState().tagVocabulary };
            state.update({
                tags: { 1: ["Canis lupus", "Felis catus"], 2: ["BRCA1"] },
                tagCategories: { "Canis lupus": "species", "Felis catus": "species", "BRCA1": "gene" },
                tagVocabulary: ["species", "gene", "method", "theme"],
            });
            try {
                const { mount } = await import("/app/src/ui/panels/tags-list.js");
                mount(host, state.getState(), {});
                await new Promise(r => setTimeout(r, 30));
                ''' + _EXPAND_ALL + '''
                const names = () => [...host.querySelectorAll(".tags-name")].map(n => n.textContent);
                const input = host.querySelector(".tags-filter-bar input");

                // filter forces expansion regardless of collapse state
                input.value = "can"; input.dispatchEvent(new Event("input"));
                await new Promise(r => setTimeout(r, 10));
                const filtered = names();

                input.value = ""; input.dispatchEvent(new Event("input"));
                await new Promise(r => setTimeout(r, 10));
                expandAll(); await new Promise(r => setTimeout(r, 10));
                const speciesHeader = [...host.querySelectorAll(".tags-group-header")]
                    .find(h => h.textContent.includes("species"));
                const chevBefore = speciesHeader.querySelector(".tags-group-chevron").textContent;
                speciesHeader.click();
                await new Promise(r => setTimeout(r, 10));
                const afterCollapse = names();
                const chevAfter = [...host.querySelectorAll(".tags-group-header")]
                    .find(h => h.textContent.includes("species"))
                    .querySelector(".tags-group-chevron").textContent;
                return { filtered, afterCollapse, chevBefore, chevAfter };
            } finally { state.update(prev); }
        }'''
    )
    assert out["filtered"] == ["Canis lupus"], out["filtered"]
    assert out["afterCollapse"] == ["BRCA1"], out["afterCollapse"]
    assert out["chevBefore"] == "▾" and out["chevAfter"] == "▸"


def test_tags_list_genus_subgroups(page):
    """Species sub-group by genus; each genus sub-header collapses independently."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const state = await import("/app/src/ui/state.js");
            const prev = { tags: state.getState().tags, tagCategories: state.getState().tagCategories,
                           tagVocabulary: state.getState().tagVocabulary };
            state.update({
                tags: { 1: ["Spodoptera frugiperda", "Spodoptera litura"], 2: ["Chlorella vulgaris"] },
                tagCategories: { "Spodoptera frugiperda": "species", "Spodoptera litura": "species",
                                 "Chlorella vulgaris": "species" },
                tagVocabulary: ["species", "gene", "method", "theme"],
            });
            try {
                const { mount } = await import("/app/src/ui/panels/tags-list.js");
                mount(host, state.getState(), {});
                await new Promise(r => setTimeout(r, 30));
                ''' + _EXPAND_ALL + '''
                expandAll(); await new Promise(r => setTimeout(r, 10));
                const subs = () => [...host.querySelectorAll(".tags-subgroup-header")]
                    .map(h => h.textContent.replace(/^[▸▾] */, ""));
                const names = () => [...host.querySelectorAll(".tags-name")].map(n => n.textContent);
                const subsBefore = subs();
                const spod = [...host.querySelectorAll(".tags-subgroup-header")]
                    .find(h => h.textContent.includes("Spodoptera"));
                spod.click();
                await new Promise(r => setTimeout(r, 10));
                return { subsBefore, namesAfter: names() };
            } finally { state.update(prev); }
        }'''
    )
    assert out["subsBefore"] == ["Chlorella (1)", "Spodoptera (2)"], out["subsBefore"]
    assert out["namesAfter"] == ["Chlorella vulgaris"], out["namesAfter"]


def test_tags_list_column_sort(page):
    """The Name/Count sort controls reorder tags within a group."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const state = await import("/app/src/ui/state.js");
            const prev = { tags: state.getState().tags, tagCategories: state.getState().tagCategories,
                           tagVocabulary: state.getState().tagVocabulary };
            state.update({
                tags: { 1: ["Aaa", "Bbb"], 2: ["Bbb"] },
                tagCategories: { "Aaa": "gene", "Bbb": "gene" },
                tagVocabulary: ["species", "gene", "method", "theme"],
            });
            try {
                const { mount } = await import("/app/src/ui/panels/tags-list.js");
                mount(host, state.getState(), {});
                await new Promise(r => setTimeout(r, 30));
                ''' + _EXPAND_ALL + '''
                expandAll(); await new Promise(r => setTimeout(r, 10));
                const names = () => [...host.querySelectorAll(".tags-name")].map(n => n.textContent);
                const btn = (label) => [...host.querySelectorAll(".tags-sort-btn")]
                    .find(b => b.textContent.startsWith(label));
                const defaultOrder = names();
                btn("Count").click(); await new Promise(r => setTimeout(r, 10));
                const byCountDesc = names();
                btn("Count").click(); await new Promise(r => setTimeout(r, 10));
                const byCountAsc = names();
                btn("Name").click(); await new Promise(r => setTimeout(r, 10));
                const byNameAsc = names();
                return { defaultOrder, byCountDesc, byCountAsc, byNameAsc };
            } finally { state.update(prev); }
        }'''
    )
    assert out["defaultOrder"] == ["Aaa", "Bbb"], out["defaultOrder"]
    assert out["byCountDesc"] == ["Bbb", "Aaa"], out["byCountDesc"]
    assert out["byCountAsc"] == ["Aaa", "Bbb"], out["byCountAsc"]
    assert out["byNameAsc"] == ["Aaa", "Bbb"], out["byNameAsc"]
