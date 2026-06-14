"""MLC-5 — scoring panel (panels/scoring.js): 1–5 per cluster on a
coarse→fine board, card-bound scores (result.scores[levelUid][clusterId]),
and parent-score threshold gating at finer layers.

The old global-state tree-scoring panel (cluster-scoring.js, state.clusterScores)
was removed 2026-06-01; the live panel is card-bound. These tests build a
data→dimred→clustering→labelling→scoring tree synthetically (clean_page) and
drive the `scoring` panel against the selected scoring card.
"""

import pytest

# Build a minimal data→dimred→(committed levels)→labelling→scoring tree with a
# 2-layer ladder (3 coarse, finer split) and labels, then select the scoring
# card. Mirrors the producer/picker → labelling → scoring chain.
_BUILD_TREE = r'''
    const st = await import("/app/src/ui/state.js");
    const wf = await import("/app/src/ui/workflow.js");
    st.update({ workflow: { steps: {}, rootId: null, selected: null } });
    const lvl = (uid, nc) => ({ uid, scope: "global", clusterResult: {
        method: "hdbscan", nodeCluster: Int32Array.from(nc),
        clusters: [...new Set(nc)].map(id => ({ id, count: nc.filter(x=>x===id).length, colour: "#4e79a7" })),
    }});
    // L0: 2 coarse clusters; L1: 3 fine (so layer 1 has a parent gate).
    const levels = [ lvl("L0", [0,0,0,1,1,1]), lvl("L1", [0,0,1,2,2,2]) ];
    const data = wf.createStep({ type: "data", label: "data" });
    const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
    wf.updateStepStatus(dim, "running");
    wf.setStepResult(dim, { _basePos: null, dimredResult: {} });
    const ml = wf.createStep({ type: "multiLevel", label: "sweep", params: { minSamples: 5 }, parentId: dim });
    wf.updateStepStatus(ml, "running");
    wf.setStepResult(ml, { multiLevelSweep: { candidates: [], curve: [], uidPrefix: ml } });
    const pk = wf.createStep({ type: "multiLevelPicker", label: "pick", params: { pickedCounts: [2,3] }, parentId: ml });
    wf.updateStepStatus(pk, "running");
    wf.setStepResult(pk, { clusterLevels: levels, clusterResult: levels[1].clusterResult });
    const lb = wf.createStep({ type: "labelling", label: "labels", parentId: pk });
    wf.updateStepStatus(lb, "running");
    wf.setStepResult(lb, { byLevel: {
        L0: { perCluster: [
            { clusterId: 0, byMethod: { keybert: { terms: ["alpha topic"] } }, combined: "alpha topic" },
            { clusterId: 1, byMethod: { keybert: { terms: ["beta topic"] } }, combined: "beta topic" },
        ]},
        L1: { perCluster: [
            { clusterId: 0, byMethod: {}, combined: "c0" },
            { clusterId: 1, byMethod: {}, combined: "c1" },
            { clusterId: 2, byMethod: {}, combined: "c2" },
        ]},
    }});
    const sc = wf.createStep({ type: "scoring", label: "scoring", parentId: lb });
    wf.updateStepStatus(sc, "running");
    wf.setStepResult(sc, { scores: {} });
    wf.selectStep(sc);
'''


def test_scoring_panel_click_sets_card_score(clean_page):
    """Clicking a star writes card.result.scores[levelUid][clusterId] and the
    star renders active; the column sub-header reports the scored count."""
    out = clean_page.evaluate(r'''async () => {
        ''' + _BUILD_TREE + r'''
        const reg = await import("/app/src/ui/panels/registry.js");
        const host = document.createElement("div");
        host.style.width = "900px";
        document.body.appendChild(host);
        const inst = reg.getPanelType("scoring").mount(host, st.getState(), { stepId: sc });
        await new Promise(r => setTimeout(r, 40));

        // First column (L0), first cluster block, click the "4" star.
        const col0 = host.querySelector(".scoring-col");
        const firstBlock = col0.querySelector(".scoring-cluster");
        const stars = firstBlock.querySelectorAll(".scoring-star");
        stars[3].click();   // value 4
        await new Promise(r => setTimeout(r, 40));

        const card = wf.getStep(sc);
        const l0Scores = (card.result.scores || {}).L0 || {};
        // The panel re-renders on the state bump (innerHTML rebuilt), so query
        // fresh from host — col0 is now a stale, detached node.
        const col0fresh = host.querySelector(".scoring-col");
        const activeNow = col0fresh.querySelector(".scoring-star.active");
        const sub = col0fresh.querySelector(".scoring-col-sub").textContent;

        inst.destroy();
        return { score0: l0Scores[0], activeText: activeNow ? activeNow.textContent : null, sub };
    }''')
    assert out["score0"] == 4
    assert out["activeText"] == "4"
    assert "1 scored" in out["sub"]


def test_scoring_parent_threshold_gates_finer_layer(clean_page):
    """At layer 1, clusters whose parent scored below the column threshold
    render ineligible (no star control); scoring a parent and lowering the
    threshold makes them eligible. Verifies coarse→fine score flow."""
    out = clean_page.evaluate(r'''async () => {
        ''' + _BUILD_TREE + r'''
        const reg = await import("/app/src/ui/panels/registry.js");
        const host = document.createElement("div");
        host.style.width = "1100px";
        document.body.appendChild(host);
        const inst = reg.getPanelType("scoring").mount(host, st.getState(), { stepId: sc });
        await new Promise(r => setTimeout(r, 40));

        const cols = host.querySelectorAll(".scoring-col");
        const l1 = cols[1];
        // With no parent scored and default threshold 3, every L1 cluster is
        // ineligible (its parent hasn't cleared the bar).
        const eligibleBefore = l1.querySelectorAll(".scoring-cluster:not(.ineligible)").length;

        // Lower the threshold to 1 via the column's parent-≥ input → with no
        // parent scored, dominantScore(undefined) ≥ 1 is false, so still gated.
        // Score both parents in L0 to 5, then set threshold 1 → eligible.
        const card0 = wf.getStep(sc);
        wf.setCardScore(sc, "L0", 0, 5);
        wf.setCardScore(sc, "L0", 1, 5);
        // re-render by re-mounting (panel subscribes to state; force a tick)
        inst.update();
        await new Promise(r => setTimeout(r, 20));
        const inp = host.querySelectorAll(".scoring-col")[1].querySelector(".scoring-threshold input");
        inp.value = "1"; inp.dispatchEvent(new Event("change"));
        await new Promise(r => setTimeout(r, 40));

        const l1after = host.querySelectorAll(".scoring-col")[1];
        const eligibleAfter = l1after.querySelectorAll(".scoring-cluster:not(.ineligible)").length;
        const nL1 = 3;

        inst.destroy();
        return { eligibleBefore, eligibleAfter, nL1 };
    }''')
    assert out["eligibleBefore"] == 0          # no parent scored ≥3 → all gated
    assert out["eligibleAfter"] == out["nL1"]  # parents scored 5, threshold 1 → all eligible


def test_scoring_straddle_metric_badge(clean_page):
    """Migrated from the old panel: finer-layer clusters show a straddle
    metric badge (clean vs bridge), with the bridge ones flagged."""
    out = clean_page.evaluate(r'''async () => {
        ''' + _BUILD_TREE + r'''
        const reg = await import("/app/src/ui/panels/registry.js");
        const host = document.createElement("div");
        host.style.width = "1100px";
        document.body.appendChild(host);
        const inst = reg.getPanelType("scoring").mount(host, st.getState(), { stepId: sc });
        await new Promise(r => setTimeout(r, 40));

        const l1 = host.querySelectorAll(".scoring-col")[1];
        const metrics = [...l1.querySelectorAll(".scoring-metrics")].map(m => m.textContent);
        inst.destroy();
        return {
            anyMetric: metrics.some(t => /clean|bridge/.test(t)),
            metrics,
        };
    }''')
    assert out["anyMetric"] is True            # straddle badge rendered on L1 clusters
