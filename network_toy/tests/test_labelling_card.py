"""Tests for the cluster-labelling card (MLC §7).

A `labelling` card attaches under a clustering-like card and labels EVERY
level of its ladder by the chosen methods, storing the result in the card
branch (result.byLevel keyed by level uid). Labelling is static; the
projection layer replays result.byLevel into state.clusterLabels, which the
scoring panel prefers over an inline recompute. Text methods (c-TF-IDF /
TF-IDF) are gated until paper titles are materialised into ctx.getText.

Uses `clean_page` (no BFS ingest) — synthetic ladder + a small embedding /
node table set straight into state.
"""


# data → dimred → multiLevel(2 levels) with a 2D embedding + years so the
# `representative` and `year` methods are available (text methods are not).
_BUILD_TREE = '''
    const wf = await import("/app/src/ui/workflow.js");
    const st = await import("/app/src/ui/state.js");
    wf.clearWorkflow();
    function lvl(uid, labels) {
        const ids = [...new Set(labels)].filter(x => x >= 0);
        return { uid, scope: "global", clusterResult: {
            method: "hdbscan", params: {},
            nodeCluster: new Int32Array(labels),
            clusters: ids.map(id => ({
                id, members: labels.map((c, i) => c === id ? i : -1).filter(i => i >= 0),
                colour: "#888",
            })),
        }};
    }
    const levels = [lvl("L0", [0,0,0,1,1,1]), lvl("L1", [0,0,1,1,2,2])];
    const data = wf.createStep({ type: "data",   label: "data" });
    const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
    wf.updateStepStatus(dim, "running");
    st.update({
        embedding: { d: 2, data: new Float32Array([0,0, 0.1,0, 0.2,0, 5,0, 5.1,0, 5.2,0]) },
        genResult: { nodes: [0,1,2,3,4,5].map((id, i) => ({ id, year: 2018 + i })) },
        _basePos: null,
    });
    wf.setStepResult(dim, { _basePos: null, dimredResult: {} });
    const ml = wf.createStep({ type: "multiLevel", label: "multi-layer sweep",
        params: { minSamples: 5 }, parentId: dim });
    wf.updateStepStatus(ml, "running");
    wf.setStepResult(ml, { multiLevelSweep: { candidates: [], curve: [], uidPrefix: ml } });
    const pk = wf.createStep({ type: "multiLevelPicker", label: "pick layers",
        params: { pickedCounts: [1, 2] }, parentId: ml });
    wf.updateStepStatus(pk, "running");
    wf.setStepResult(pk, { clusterLevels: levels, clusterResult: levels[1].clusterResult });
    wf.selectStep(pk);
'''


def test_labelling_card_labels_all_levels_and_gates_text(clean_page):
    """applyChange forks a labelling card, labels every level, and reports
    text methods as unavailable when no titles are materialised."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const desc = ld.getLayerDescriptor("labelling");
            const active = desc.getActive();
            await desc.applyChange({ methods: ["representative", "year"] });
            const card = wf.listSteps({ type: "labelling" }).slice(-1)[0];
            const res = card.result;
            const avail = {};
            for (const m of active.methods) avail[m.id] = m.available;
            return {
                hasClustering: active.hasClustering,
                nLevels:       active.nLevels,
                defaultSelected: active.selected,
                availRepresentative: avail.representative,
                availYear:     avail.year,
                availCTfidf:   avail.cTfidf,
                status:        card.status,
                parentIsMl:    card.parentId === pk,
                levelsLabelled: res && Object.keys(res.byLevel).length,
                l0HasPerCluster: !!(res && res.byLevel.L0 && res.byLevel.L0.perCluster.length),
            };
        }'''
    )
    assert out["hasClustering"] is True
    assert out["nLevels"] == 2
    assert out["availRepresentative"] is True
    assert out["availYear"] is True
    assert out["availCTfidf"] is False     # gated: no ctx.getText
    assert out["status"] == "done"
    assert out["parentIsMl"] is True
    assert out["levelsLabelled"] == 2
    assert out["l0HasPerCluster"] is True


def test_labelling_in_next_steps(clean_page):
    """Labelling is offered where it belongs in the pipeline: directly under
    single-run clustering AND directly under the multiLevelPicker (the bridge
    intermediary card was removed in Pass 2a — bridges now compute inside
    the picker's commit and surface on state.bridgeAnalysis)."""
    out = clean_page.evaluate(
        '''async () => {
            const ns = await import("/app/src/ui/next-steps-rules.js");
            return {
                clustering: ns.addStepRulesFor("clustering").map(r => r.modal),
                picker:     ns.addStepRulesFor("multiLevelPicker").map(r => r.modal),
                labelling:  ns.addStepRulesFor("labelling").map(r => r.modal),
            };
        }'''
    )
    assert "labelling" in out["clustering"]        # single-run path: direct
    assert "labelling" in out["picker"]            # multi-layer path: direct (no bridge intermediary)
    # A labelling card's add-step follow-on is the scoring card.
    assert out["labelling"] == ["scoring"]


def test_labelling_projects_into_scoring_slot(clean_page):
    """Selecting the labelling card replays result.byLevel into
    state.clusterLabels (the slot the scoring panel prefers)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const proj = await import("/app/src/ui/workflow-projection.js");
            const desc = ld.getLayerDescriptor("labelling");
            await desc.applyChange({ methods: ["representative", "year"] });
            const card = wf.listSteps({ type: "labelling" }).slice(-1)[0];
            wf.selectStep(ml);
            proj.projectStepIntoLegacyState(card.id);
            const s = st.getState();
            return {
                hasLabels:  !!s.clusterLabels,
                hasL0:      !!(s.clusterLabels && s.clusterLabels.L0),
                hasL1:      !!(s.clusterLabels && s.clusterLabels.L1),
            };
        }'''
    )
    assert out["hasLabels"] is True
    assert out["hasL0"] is True
    assert out["hasL1"] is True


def test_scoring_panel_renders_stored_labels(clean_page):
    """The scoring panel (card-bound scoring.js) renders the labelling card's
    stored per-method labels as bullets, not an inline 'Cluster N' fallback."""
    out = clean_page.evaluate(
        '''async () => {
            const st = await import("/app/src/ui/state.js");
            const wf = await import("/app/src/ui/workflow.js");
            const reg = await import("/app/src/ui/panels/registry.js");
            st.update({ workflow: { steps: {}, rootId: null, selected: null } });
            const lvl = (uid, nc) => ({ uid, scope: "global", clusterResult: {
                method: "hdbscan", nodeCluster: Int32Array.from(nc),
                clusters: [...new Set(nc)].map(id => ({ id, count: nc.filter(x=>x===id).length, colour: "#888" })),
            }});
            const levels = [ lvl("L0", [0,0,0,1,1,1]) ];
            const data = wf.createStep({ type: "data", label: "data" });
            const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
            wf.updateStepStatus(dim, "running"); wf.setStepResult(dim, { dimredResult: {} });
            const ml = wf.createStep({ type: "multiLevel", label: "sweep", params: {}, parentId: dim });
            wf.updateStepStatus(ml, "running");
            wf.setStepResult(ml, { multiLevelSweep: { candidates: [], curve: [], uidPrefix: ml } });
            const pk = wf.createStep({ type: "multiLevelPicker", label: "pick", params: { pickedCounts: [2] }, parentId: ml });
            wf.updateStepStatus(pk, "running");
            wf.setStepResult(pk, { clusterLevels: levels, clusterResult: levels[0].clusterResult });
            const lb = wf.createStep({ type: "labelling", label: "labels", parentId: pk });
            wf.updateStepStatus(lb, "running");
            wf.setStepResult(lb, { byLevel: { L0: { perCluster: [
                { clusterId: 0, byMethod: { keybert: { terms: ["MY LABEL A"] } }, combined: "MY LABEL A" },
                { clusterId: 1, byMethod: { keybert: { terms: ["MY LABEL B"] } }, combined: "MY LABEL B" },
            ]}}});
            const sc = wf.createStep({ type: "scoring", label: "scoring", parentId: lb });
            wf.updateStepStatus(sc, "running"); wf.setStepResult(sc, { scores: {} });
            wf.selectStep(sc);

            const host = document.createElement("div");
            host.style.width = "700px";
            document.body.appendChild(host);
            const inst = reg.getPanelType("scoring").mount(host, st.getState(), { stepId: sc });
            await new Promise(r => setTimeout(r, 40));
            const labels = [...host.querySelectorAll(".scoring-label-bullet")].map(n => n.textContent);
            inst.destroy();
            return { labels };
        }'''
    )
    assert any("MY LABEL A" in t for t in out["labels"])
    assert any("MY LABEL B" in t for t in out["labels"])


def test_scoring_panel_renders_banded_labels_multiline(clean_page):
    """A banded (stratified) method renders one line per df band in the scoring
    panel — anchor / broad / mid / specific / signature each on their own row.
    The panel now shows ONE method (combined by default), so we select the
    banded method via the header dropdown and expand its per-cluster show-more
    before the band lines surface."""
    out = clean_page.evaluate(
        '''async () => {
            const st = await import("/app/src/ui/state.js");
            const wf = await import("/app/src/ui/workflow.js");
            const reg = await import("/app/src/ui/panels/registry.js");
            st.update({ workflow: { steps: {}, rootId: null, selected: null } });
            const lvl = (uid, nc) => ({ uid, scope: "global", clusterResult: {
                method: "hdbscan", nodeCluster: Int32Array.from(nc),
                clusters: [...new Set(nc)].map(id => ({ id, count: nc.filter(x=>x===id).length, colour: "#888" })),
            }});
            const levels = [ lvl("L0", [0,0,0,1,1,1]) ];
            const data = wf.createStep({ type: "data", label: "data" });
            const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
            wf.updateStepStatus(dim, "running"); wf.setStepResult(dim, { dimredResult: {} });
            const ml = wf.createStep({ type: "multiLevel", label: "sweep", params: {}, parentId: dim });
            wf.updateStepStatus(ml, "running");
            wf.setStepResult(ml, { multiLevelSweep: { candidates: [], curve: [], uidPrefix: ml } });
            const pk = wf.createStep({ type: "multiLevelPicker", label: "pick", params: { pickedCounts: [2] }, parentId: ml });
            wf.updateStepStatus(pk, "running");
            wf.setStepResult(pk, { clusterLevels: levels, clusterResult: levels[0].clusterResult });
            const bands = { anchor: [{term:"alga"}], broad: [{term:"reef"}],
                            mid: [{term:"symbiont"}], specific: [{term:"acropora"}],
                            signature: [{term:"cassiopea"}] };
            const lb = wf.createStep({ type: "labelling", label: "labels", parentId: pk });
            wf.updateStepStatus(lb, "running");
            wf.setStepResult(lb, { byLevel: { L0: {
                methods: [{ id: "cTfidfStratified", label: "c-TF-IDF (banded)", available: true }],
                perCluster: [
                    { clusterId: 0, byMethod: { cTfidfStratified: { bands, terms: ["alga"] } }, combined: "alga · cassiopea" },
                    { clusterId: 1, byMethod: { cTfidfStratified: { bands, terms: ["alga"] } }, combined: "alga · cassiopea" },
                ]}}});
            const sc = wf.createStep({ type: "scoring", label: "scoring", parentId: lb });
            wf.updateStepStatus(sc, "running"); wf.setStepResult(sc, { scores: {} });
            wf.selectStep(sc);

            const host = document.createElement("div");
            host.style.width = "700px";
            document.body.appendChild(host);
            const inst = reg.getPanelType("scoring").mount(host, st.getState(), { stepId: sc });
            await new Promise(r => setTimeout(r, 40));
            // pick the banded method from the header dropdown
            const sel = host.querySelector(".scoring-method-select");
            sel.value = "cTfidfStratified";
            sel.dispatchEvent(new Event("change"));
            await new Promise(r => setTimeout(r, 40));
            // expand every per-cluster show-more to reveal the per-band lines
            for (const b of host.querySelectorAll(".scoring-label-showmore")) b.click();
            await new Promise(r => setTimeout(r, 40));
            const bandLines = [...host.querySelectorAll(".scoring-label-band")].map(n => n.textContent);
            const hasDropdown = !!sel;
            inst.destroy();
            return { bandLines, hasDropdown };
        }'''
    )
    assert out["hasDropdown"] is True
    # five band lines per cluster, each band on its own line once expanded
    assert any(t.startswith("anchor:") for t in out["bandLines"])
    assert any(t.startswith("broad:") for t in out["bandLines"])
    assert any(t.startswith("mid:") for t in out["bandLines"])
    assert any(t.startswith("specific:") for t in out["bandLines"])
    assert any(t.startswith("signature:") for t in out["bandLines"])
