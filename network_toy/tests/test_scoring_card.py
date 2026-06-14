"""Tests for the scoring card + scoring panel (MLC §5) — placeholder phase.

The scoring card sits downstream of a labelling card. Picking it from the
"+" preps the data (level ladder + labels snapshot + an empty per-card
scores map) with NO config modal. The interactive scoring UI is a separate
PANEL (panels/scoring.js, currently a placeholder) opened from the panel
picker; it binds to the SELECTED branch's scoring card so different work
trees show their own.

Uses `clean_page` (no BFS ingest).
"""


_BUILD_TREE = '''
    const wf = await import("/app/src/ui/workflow.js");
    const st = await import("/app/src/ui/state.js");
    const ld = await import("/app/src/ui/modals/layer-descriptors.js");
    wf.clearWorkflow();
    function lvl(uid, labels) {
        const ids = [...new Set(labels)].filter(x => x >= 0);
        return { uid, scope: "global", clusterResult: { method: "hdbscan", params: {},
            nodeCluster: new Int32Array(labels),
            clusters: ids.map(id => ({ id, members: labels.map((c, i) => c === id ? i : -1).filter(i => i >= 0), colour: "#888" })) }};
    }
    const levels = [lvl("L0", [0,0,0,1,1,1]), lvl("L1", [0,0,1,1,2,2])];
    const data = wf.createStep({ type: "data", label: "data" });
    const dim = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
    wf.updateStepStatus(dim, "running");
    st.update({
        embedding: { d: 2, data: new Float32Array([0,0, 0.1,0, 0.2,0, 5,0, 5.1,0, 5.2,0]) },
        genResult: { nodes: [0,1,2,3,4,5].map((id, i) => ({ id, year: 2018 + i })) },
        _basePos: null,
    });
    wf.setStepResult(dim, { _basePos: null, dimredResult: {} });
    const ml = wf.createStep({ type: "multiLevel", label: "multi-layer sweep", params: { minSamples: 5 }, parentId: dim });
    wf.updateStepStatus(ml, "running");
    wf.setStepResult(ml, { multiLevelSweep: { candidates: [], curve: [], uidPrefix: ml } });
    const pk = wf.createStep({ type: "multiLevelPicker", label: "pick layers", params: { pickedCounts: [1, 2] }, parentId: ml });
    wf.updateStepStatus(pk, "running");
    wf.setStepResult(pk, { clusterLevels: levels, clusterResult: levels[1].clusterResult });
    wf.selectStep(pk);
    await ld.getLayerDescriptor("labelling").applyChange({ methods: ["representative", "year"] });
    const lbl = wf.listSteps({ type: "labelling" }).slice(-1)[0];
    wf.selectStep(lbl.id);
'''


def test_scoring_card_preps_under_labelling(clean_page):
    """Picking scoring forks a card under the labelling card and preps the
    level/label snapshot (no config modal involved)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const desc = ld.getLayerDescriptor("scoring");
            const active = desc.getActive();
            await desc.applyChange();
            const card = wf.listSteps({ type: "scoring" }).slice(-1)[0];
            const r = card.result || {};
            return {
                hasLabelling: active.hasLabelling,
                status:       card.status,
                parentIsLbl:  card.parentId === lbl.id,
                nLevels:      r.nLevels,
                labelMethods: r.labelMethods,
                scoresEmpty:  r.scores && Object.keys(r.scores).length === 0,
                levelSummaryLen: r.levelSummary && r.levelSummary.length,
            };
        }'''
    )
    assert out["hasLabelling"] is True
    assert out["status"] == "done"
    assert out["parentIsLbl"] is True
    assert out["nLevels"] == 2
    assert out["labelMethods"] == ["representative", "year"]
    assert out["scoresEmpty"] is True
    assert out["levelSummaryLen"] == 2


def test_scoring_in_next_steps_and_panel_registered(clean_page):
    """labelling exposes 'scoring' in its '+'; the scoring panel type is
    registered so it shows in the panel picker."""
    out = clean_page.evaluate(
        '''async () => {
            const ns = await import("/app/src/ui/next-steps-rules.js");
            const reg = await import("/app/src/ui/panels/registry.js");
            const t = reg.getPanelType("scoring");
            return {
                labelling: ns.addStepRulesFor("labelling").map(r => r.modal),
                scoringFollow: ns.addStepRulesFor("scoring").map(r => r.modal),
                panelId: t && t.id,
                panelLabel: t && t.label,
            };
        }'''
    )
    assert "scoring" in out["labelling"]
    assert out["scoringFollow"] == []      # scoring's only follow-on is re-run
    assert out["panelId"] == "scoring"
    assert out["panelLabel"] == "Scoring"


def test_scoring_panel_binds_to_selected_branch(clean_page):
    """The board renders for the selected scoring card — and still finds the
    branch's scoring card when an ancestor (the labelling card) is selected,
    since different branches each have their own. No selection → empty."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            await ld.getLayerDescriptor("scoring").applyChange();
            const sc = wf.listSteps({ type: "scoring" }).slice(-1)[0];
            const reg = await import("/app/src/ui/panels/registry.js");
            const host = document.createElement("div");
            document.body.appendChild(host);
            const inst = reg.getPanelType("scoring").mount(host, st.getState(), {});
            const cols = () => host.querySelectorAll(".scoring-col").length;

            wf.selectStep(sc.id); inst.update(st.getState());
            const colsSelected = cols();

            wf.selectStep(lbl.id); inst.update(st.getState());   // labelling ancestor
            const colsAncestor = cols();

            wf.selectStep(null); inst.update(st.getState());      // nothing selected
            const emptyText = host.querySelector(".scoring-board.empty")?.textContent || "";

            return { colsSelected, colsAncestor, emptyText };
        }'''
    )
    assert out["colsSelected"] == 2          # 2-level ladder → 2 columns
    assert out["colsAncestor"] == 2          # ancestor selection still resolves the branch card
    assert "No scoring card" in out["emptyText"]


def test_scoring_board_scores_on_card_and_propagates(clean_page):
    """Clicking a star stores the score ON the scoring card and gates the
    next layer: L1 clusters are ineligible until their L0 parent clears the
    column threshold."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            await ld.getLayerDescriptor("scoring").applyChange();
            const sc = wf.listSteps({ type: "scoring" }).slice(-1)[0];
            wf.selectStep(sc.id);
            const reg = await import("/app/src/ui/panels/registry.js");
            const host = document.createElement("div");
            document.body.appendChild(host);
            reg.getPanelType("scoring").mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 20));

            const l0uid = (sc.result.levelSummary[0] || {}).uid;
            const l1col = () => host.querySelectorAll(".scoring-col")[1];
            const ineligibleBefore = l1col().querySelectorAll(".scoring-cluster.ineligible").length;
            const l1Total = l1col().querySelectorAll(".scoring-cluster").length;

            // Score every L0 cluster = 4 (≥ default threshold 3).
            const l0col = host.querySelectorAll(".scoring-col")[0];
            for (const blk of l0col.querySelectorAll(".scoring-cluster")) {
                blk.querySelector(".scoring-star:nth-child(4)").click();
            }
            await new Promise(r => setTimeout(r, 20));

            // Re-read the card fresh (setCardScore makes a new step object).
            const scNow = wf.getStep(sc.id);
            const storedAtL0 = scNow.result.scores[l0uid] || {};
            const ineligibleAfter = host.querySelectorAll(".scoring-col")[1]
                .querySelectorAll(".scoring-cluster.ineligible").length;

            return {
                ineligibleBefore, l1Total,
                nScoredL0: Object.keys(storedAtL0).length,
                sampleScore: storedAtL0[Object.keys(storedAtL0)[0]],
                ineligibleAfter,
            };
        }'''
    )
    assert out["ineligibleBefore"] == out["l1Total"]   # all L1 gated initially
    assert out["nScoredL0"] >= 1                        # scores landed on the card
    assert out["sampleScore"] == 4
    assert out["ineligibleAfter"] == 0                 # parents scored → L1 unlocked
