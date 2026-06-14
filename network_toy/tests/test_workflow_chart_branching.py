"""Tests for slice 2.6 (re-run affordance on stale cards) and slice
2.8 (branching tree layout).
"""

import pytest


# ── Slice 2.6 — re-run affordance ─────────────────────────────────────


def test_rerun_button_appears_on_stale_card(page):
    """Build a tree where a child step's upstream revision differs from
    its current parent revision → isStepStale = true. Render the chart;
    verify a .wf-rerun-btn appears on the stale card.

    Done steps are terminal (workflow.js invariant I5) so we can't
    transition the parent back to running to bump it. Instead, hand-
    construct stale by patching the child's upstreamRevision below the
    parent's revision via direct state mutation."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const state = await import("/app/src/ui/state.js");
            wf.clearWorkflow();
            const dataId  = wf.createStep({ type: "data",   label: "root" });
            const dimId   = wf.createStep({ type: "dimred", label: "d", parentId: dataId });
            wf.updateStepStatus(dimId, "running");
            wf.setStepResult(dimId, { dimredResult: { method: "umap", n: 1, d: 1, data: new Float32Array([0]) } });
            // dim's revision is now 1.
            const cluId = wf.createStep({ type: "clustering", label: "c", parentId: dimId });
            wf.updateStepStatus(cluId, "running");
            wf.setStepResult(cluId, { clusterLevels: [{ uid: "x", clusterResult: { method: "mutualKNN", params: {}, nodeCluster: new Int32Array([0]), clusters: [] } }] });
            // child's upstreamRevision = 1 (the parent's revision at result time).
            // Synthesise stale: bump the parent's revision via direct
            // state.update (bypassing workflow.js's API since done →
            // running is forbidden by the invariant).
            const cur = state.getState();
            const dimStep = cur.workflow.steps[dimId];
            state.update({
                workflow: {
                    ...cur.workflow,
                    steps: {
                        ...cur.workflow.steps,
                        [dimId]: { ...dimStep, revision: dimStep.revision + 5 },
                    },
                },
            });
            const staleNow = wf.isStepStale(cluId);
            // Re-render.
            state.update({ engineRevision: (state.getState().engineRevision || 0) + 1 });
            await new Promise(r => setTimeout(r, 80));

            const root = document.getElementById("workflow-chart");
            const rerunBtns = root.querySelectorAll("svg .wf-rerun-btn");
            const staleRects = root.querySelectorAll("svg .wf-node-rect.stale");
            return {
                staleNow,
                rerunBtnCount: rerunBtns.length,
                staleRectCount: staleRects.length,
            };
        }'''
    )
    assert out["staleNow"] is True
    assert out["rerunBtnCount"] >= 1
    assert out["staleRectCount"] >= 1


@pytest.mark.slow
def test_rerun_click_forks_step(page):
    """Clicking a stale card's re-run button creates a new sibling
    via descriptor.applyChange (slice 2.5's pattern). Slow because
    the cascade runs real HDBSCAN at n=5000."""
    out = page.evaluate(
        '''async () => {
            const wf  = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            const { rerunStep } = await import("/app/src/ui/modals/layer-descriptors.js");
            mig.migrateLegacyToWorkflowIfNeeded();

            const before = wf.listSteps({ type: "clustering" });
            if (before.length === 0) throw new Error("no clustering card in migrated tree");
            const original = before[0];
            const beforeCount = before.length;

            // Trigger the re-run path directly (UI button has the same effect).
            await rerunStep(original.id);

            const after = wf.listSteps({ type: "clustering" });
            const newest = after[after.length - 1];
            return {
                beforeCount,
                afterCount: after.length,
                newestId:   newest.id,
                originalId: original.id,
                newestStatus: newest.status,
                sameParentType: newest.parentId
                    ? wf.getStep(newest.parentId).type
                    : null,
            };
        }'''
    )
    # Original card stays, new sibling appears.
    assert out["afterCount"] == out["beforeCount"] + 1
    assert out["newestId"] != out["originalId"]
    assert out["newestStatus"] == "done"
    assert out["sameParentType"] == "dimred"


# ── Slice 2.8 — branching layout ──────────────────────────────────────


def test_branching_layout_siblings_have_distinct_x(page):
    """Three sibling clustering cards under one dimred parent. The
    layout should give each a distinct x position (laid out side-by-
    side) and the parent should be centred over them."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const state = await import("/app/src/ui/state.js");
            wf.clearWorkflow();
            const dataId = wf.createStep({ type: "data",   label: "root" });
            const dimId  = wf.createStep({ type: "dimred", label: "d",  parentId: dataId });
            const c1 = wf.createStep({ type: "clustering", label: "c1", parentId: dimId });
            const c2 = wf.createStep({ type: "clustering", label: "c2", parentId: dimId });
            const c3 = wf.createStep({ type: "clustering", label: "c3", parentId: dimId });
            state.update({ engineRevision: (state.getState().engineRevision || 0) + 1 });
            await new Promise(r => setTimeout(r, 80));

            const root = document.getElementById("workflow-chart");
            const svg = root.querySelector("svg");
            // Collect each CARD group's transform. A card group is the
            // one with a direct .wf-node-rect child — this excludes the
            // nested gear / spinner / badge / rerun-btn groups, which
            // also carry transforms but aren't cards.
            const groups = svg.querySelectorAll("g[transform]");
            const cards = [];
            for (const g of groups) {
                if (!g.querySelector(":scope > .wf-node-rect")) continue;
                const t = g.getAttribute("transform");
                const m = /translate\\((-?\\d+(?:\\.\\d+)?),\\s*(-?\\d+(?:\\.\\d+)?)\\)/.exec(t || "");
                if (!m) continue;
                cards.push({ x: parseFloat(m[1]), y: parseFloat(m[2]) });
            }
            // Three siblings at the same y (depth = 2 from root).
            const yValues = cards.map(p => p.y);
            const siblingYSet = new Set(yValues.filter(y => yValues.filter(z => z === y).length === 3));
            const xValuesAtSiblingDepth = cards
                .filter(p => siblingYSet.has(p.y))
                .map(p => p.x)
                .sort((a, b) => a - b);
            return {
                cardCount: cards.length,
                siblingXs: xValuesAtSiblingDepth,
                allXsDistinct: new Set(xValuesAtSiblingDepth).size === xValuesAtSiblingDepth.length,
            };
        }'''
    )
    # 5 cards total: data + dimred + 3 clusterings.
    assert out["cardCount"] == 5
    # 3 siblings at the deepest depth, each with a distinct x.
    assert len(out["siblingXs"]) == 3
    assert out["allXsDistinct"] is True
    # Cards laid out left-to-right with increasing x.
    xs = out["siblingXs"]
    assert xs[0] < xs[1] < xs[2]


def test_branching_layout_parent_centred_over_children(page):
    """Parent card's x position should be the midpoint of its children's
    span (Reingold-Tilford property)."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const state = await import("/app/src/ui/state.js");
            wf.clearWorkflow();
            const dataId = wf.createStep({ type: "data",   label: "r" });
            const dimId  = wf.createStep({ type: "dimred", label: "d", parentId: dataId });
            // Two children — parent should sit centred between them.
            const c1 = wf.createStep({ type: "clustering", label: "c1", parentId: dimId });
            const c2 = wf.createStep({ type: "clustering", label: "c2", parentId: dimId });
            state.update({ engineRevision: (state.getState().engineRevision || 0) + 1 });
            await new Promise(r => setTimeout(r, 80));

            const root = document.getElementById("workflow-chart");
            const svg = root.querySelector("svg");
            const groups = Array.from(svg.querySelectorAll("g[transform]"));
            // Extract each step's transform via label text inside.
            function findCardX(label) {
                for (const g of groups) {
                    const t = g.getAttribute("transform");
                    const m = /translate\\((-?\\d+(?:\\.\\d+)?),\\s*(-?\\d+(?:\\.\\d+)?)\\)/.exec(t || "");
                    if (!m) continue;
                    const lbl = g.querySelector(".wf-node-label");
                    if (lbl && lbl.textContent.includes(label)) {
                        return parseFloat(m[1]);
                    }
                }
                return null;
            }
            return {
                dX:  findCardX("d"),
                c1X: findCardX("c1"),
                c2X: findCardX("c2"),
            };
        }'''
    )
    # Dimred parent at midpoint of c1 + c2.
    mid = (out["c1X"] + out["c2X"]) / 2
    # Allow ~1px tolerance for card-width offset arithmetic.
    assert abs(out["dX"] - mid) < 1.5, \
        f"parent x {out['dX']} not centred over children mid {mid:.1f} (c1={out['c1X']}, c2={out['c2X']})"


def test_branching_layout_leaf_is_single_slot(page):
    """A leaf (no children) gets width=1 slot. Two leaf siblings end
    up adjacent."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const state = await import("/app/src/ui/state.js");
            wf.clearWorkflow();
            const root = wf.createStep({ type: "data", label: "root" });
            const a = wf.createStep({ type: "dimred", label: "a", parentId: root });
            const b = wf.createStep({ type: "dimred", label: "b", parentId: root });
            state.update({ engineRevision: (state.getState().engineRevision || 0) + 1 });
            await new Promise(r => setTimeout(r, 80));
            const wfRoot = document.getElementById("workflow-chart");
            const svg = wfRoot.querySelector("svg");
            const groups = Array.from(svg.querySelectorAll("g[transform]"));
            function findCardX(label) {
                for (const g of groups) {
                    const lbl = g.querySelector(".wf-node-label");
                    if (lbl && lbl.textContent.includes(label)) {
                        const t = g.getAttribute("transform");
                        const m = /translate\\((-?\\d+(?:\\.\\d+)?),/.exec(t || "");
                        return m ? parseFloat(m[1]) : null;
                    }
                }
                return null;
            }
            // Distance between siblings should equal one slot (NODE_W + HORIZ_GAP = 132).
            const aX = findCardX("a");
            const bX = findCardX("b");
            return { aX, bX, gap: bX - aX };
        }'''
    )
    # NODE_W (120) + HORIZ_GAP (12) = 132.
    assert 130 <= out["gap"] <= 135, f"sibling gap should be ~132 px, got {out['gap']}"
