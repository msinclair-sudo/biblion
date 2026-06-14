"""Tests for Phase 2 slice 2.10 — cross-source comparison cards.

A `fusionComparison` card compares ANY two clustering cards (ref + cand)
of the same network, wiring them as refIds (DAG fan-in). The comparison
maths (eval/fusion-compare.js) is source-agnostic, so these tests build
small synthetic clustering cards and exercise the descriptor → runner →
panel → chart path with no real clustering recompute.

Uses `clean_page` (no BFS ingest) — the whole flow is pure-module logic
over synthetic equal-length partitions.
"""


# Build a minimal tree: data → dimred → {clustering A, clustering B},
# each clustering carrying a synthetic equal-length partition. Returns
# the JS source so each test can compose it. n=8, 3 clusters, A vs B
# differ on two nodes so ARI lands strictly between 0.5 and 1.
_BUILD_TREE = '''
    const wf = await import("/app/src/ui/workflow.js");
    wf.clearWorkflow();
    const data = wf.createStep({ type: "data",   label: "data" });
    const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
    function clustering(label, arr) {
        const id = wf.createStep({ type: "clustering", label, parentId: dim });
        wf.updateStepStatus(id, "running");
        wf.setStepResult(id, {
            clusterLevels: [{ uid: label, scope: "global", clusterResult: {
                method: "mutualKNN", params: {},
                nodeCluster: new Int32Array(arr),
                clusters: [{ id: 0 }, { id: 1 }, { id: 2 }],
            }}],
        });
        return id;
    }
    const cluA = clustering("clustering A", [0,0,0,1,1,1,2,2]);
    const cluB = clustering("clustering B", [0,0,1,1,1,2,2,2]);
    wf.selectStep(cluA);
'''


def test_descriptor_creates_card_with_refids_and_result(clean_page):
    """getLayerDescriptor('fusionComparison').applyChange forks a
    fusionComparison card under the selected clustering, wires both
    clusterings as refIds, runs the comparison, and populates
    result.comparison + auto-saves a validationRun."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const st = await import("/app/src/ui/state.js");

            const desc = ld.getLayerDescriptor("fusionComparison");
            const active = desc.getActive();
            await desc.applyChange({ refStepId: cluA, candStepId: cluB });

            const cards = wf.listSteps({ type: "fusionComparison" });
            const card = cards[cards.length - 1];
            const runs = (st.getState().validationRuns || [])
                .filter(r => r.type === "fusionComparison");
            const fc0 = card.result && card.result.comparison &&
                        card.result.comparison.perLevel &&
                        card.result.comparison.perLevel[0];
            return {
                optionCount:  active.options.length,
                hasEnough:    active.hasEnough,
                status:       card.status,
                refIds:       card.refIds,
                parentId:     card.parentId,
                parentIsCluA: card.parentId === cluA,
                perLevelLen:  card.result.comparison.perLevel.length,
                ari:          fc0 ? fc0.aggregate.ari : null,
                nClustersPre: fc0 ? fc0.aggregate.nClustersPre : null,
                refLabel:     card.result.refLabel,
                candLabel:    card.result.candLabel,
                savedRunCount: runs.length,
            };
        }'''
    )
    assert out["optionCount"] == 2
    assert out["hasEnough"] is True
    assert out["status"] == "done"
    # Both clusterings wired as refIds, in [ref, cand] order.
    assert len(out["refIds"]) == 2
    # Parent is the selected clustering (analysis-card convention).
    assert out["parentIsCluA"] is True
    assert out["perLevelLen"] == 1
    assert out["ari"] is not None and 0.0 < out["ari"] < 1.0
    assert out["nClustersPre"] == 3
    assert out["refLabel"] == "clustering A"
    assert out["candLabel"] == "clustering B"
    assert out["savedRunCount"] == 1


def test_panel_renders_saved_comparison_card(clean_page):
    """The fusion-comparison panel, bound to a done fusionComparison
    card via config.stepId, renders the aggregate strip + per-cluster
    table with the ref/cand labels (saved mode, slice 2.10 / §10.D5)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const all = wf.listSteps({ type: "clustering" });
            await ld.getLayerDescriptor("fusionComparison")
                .applyChange({ refStepId: all[0].id, candStepId: all[1].id });
            const card = wf.listSteps({ type: "fusionComparison" }).slice(-1)[0];

            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/fusion-comparison.js");
            const st = await import("/app/src/ui/state.js");
            mount(host, st.getState(), { stepId: card.id });
            await new Promise(r => setTimeout(r, 50));
            const warn = host.querySelector(".panel-fc-warn-banner");
            return {
                title:     host.querySelector(".panel-fc-title")?.textContent,
                aggStrip:  !!host.querySelector(".panel-fc-agg"),
                rows:      host.querySelectorAll(".panel-fc-row").length,
                sectionText: host.querySelector(".panel-fc-section")?.textContent,
                warnText:  warn ? warn.textContent : null,
            };
        }'''
    )
    assert out["title"] == "compare · clustering A vs clustering B"
    assert out["aggStrip"] is True
    assert out["rows"] > 0
    # cards.md Pass 2 placeholder warning is rendered above every result.
    assert out["warnText"] is not None
    assert "Placeholder" in out["warnText"]
    assert "same" in out["warnText"].lower() or "matching" in out["warnText"].lower()
    # Per-cluster table header uses the ref label ("clustering A" is the
    # ref; the generic "pre"/"post" framing is replaced by the labels).
    assert "best match" in (out["sectionText"] or "")


def test_selecting_comparison_card_projects_candidate_geometry(clean_page):
    """Selecting a fusionComparison card projects the CANDIDATE refId's
    clustering into legacy state.clusterLevels (§10.O2 — viewer shows
    the candidate), not the comparison card's parent chain."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const proj = await import("/app/src/ui/workflow-projection.js");
            const st = await import("/app/src/ui/state.js");
            // cand = cluB (from _BUILD_TREE)
            await ld.getLayerDescriptor("fusionComparison")
                .applyChange({ refStepId: cluA, candStepId: cluB });
            const card = wf.listSteps({ type: "fusionComparison" }).slice(-1)[0];

            // Candidate (cluB) partition for comparison.
            const candNc = Array.from(wf.getStep(cluB).result.clusterLevels[0].clusterResult.nodeCluster);

            proj.projectStepIntoLegacyState(card.id);
            const projNc = Array.from(st.getState().clusterLevels[0].clusterResult.nodeCluster);
            return { candNc, projNc };
        }'''
    )
    # Projecting the comparison card surfaced the candidate's partition.
    assert out["projNc"] == out["candNc"]


def test_rerun_forks_new_sibling_comparison(clean_page):
    """rerunStep on a fusionComparison card forks a NEW sibling card
    (immutable-once-done, §10.D1) carrying the same two refIds — the
    fusion-comparison-specific re-run path added in slice 2.10."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            await ld.getLayerDescriptor("fusionComparison")
                .applyChange({ refStepId: cluA, candStepId: cluB });
            const card1 = wf.listSteps({ type: "fusionComparison" }).slice(-1)[0];

            await ld.rerunStep(card1.id);
            const cards = wf.listSteps({ type: "fusionComparison" });
            const card2 = cards[cards.length - 1];
            return {
                countAfter:   cards.length,
                differentId:  card2.id !== card1.id,
                sameRefIds:   JSON.stringify(card2.refIds) === JSON.stringify(card1.refIds),
                status:       card2.status,
                hasResult:    !!(card2.result && card2.result.comparison),
            };
        }'''
    )
    assert out["countAfter"] == 2
    assert out["differentId"] is True
    assert out["sameRefIds"] is True
    assert out["status"] == "done"
    assert out["hasResult"] is True


def test_chart_draws_dashed_ref_edges(clean_page):
    """When a fusionComparison card exists, the workflow chart draws one
    dashed .wf-arrow-ref cross-edge per refId (slice 2.10.c / §10.D4)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const all = wf.listSteps({ type: "clustering" });
            await ld.getLayerDescriptor("fusionComparison")
                .applyChange({ refStepId: all[0].id, candStepId: all[1].id });
            // Let the chart's state subscription re-render.
            await new Promise(r => setTimeout(r, 80));
            const refEdges = document.querySelectorAll("#workflow-chart .wf-arrow-ref");
            return { refEdgeCount: refEdges.length };
        }'''
    )
    # Two refIds → two dashed cross-edges.
    assert out["refEdgeCount"] == 2
