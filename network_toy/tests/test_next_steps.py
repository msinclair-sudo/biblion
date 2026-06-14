"""Tests for Phase 2 slice 2.12 — next-step affordances panel.

The next-steps panel is a static per-type rule table: select a card and
it offers the valid follow-on actions, each opening the relevant modal.
Pure UI logic over the workflow tree — uses `clean_page` (no BFS ingest).
"""


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
'''


def test_next_steps_lists_clustering_followons(clean_page):
    """Selecting a clustering card surfaces its follow-on actions:
    compare-with-another-clustering, cross-cluster citations, label clusters,
    dim sweep, citation layout. (Bridge analysis was removed in Pass 2a;
    bootstrap was removed in Pass 2b — it's a sidecar inside the clustering
    modal now, not a separate card.)"""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            wf.selectStep(cluA);
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/next-steps.js");
            const st = await import("/app/src/ui/state.js");
            mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 30));
            const labels = [...host.querySelectorAll(".panel-ns-action-label")]
                .map(n => n.textContent);
            return {
                title:   host.querySelector(".panel-ns-title")?.textContent,
                context: host.querySelector(".panel-ns-context")?.textContent,
                actionCount: host.querySelectorAll(".panel-ns-action").length,
                labels,
            };
        }'''
    )
    assert out["title"] == "What's next?"
    assert "clustering A" in (out["context"] or "")
    assert out["actionCount"] == 5
    joined = " | ".join(out["labels"])
    assert "compare with another clustering" in joined.lower()
    assert "cross-cluster citations" in joined.lower()
    assert "label clusters" in joined.lower()
    assert "dim sweep" in joined.lower()
    assert "citation layout" in joined.lower()
    assert "bridge analysis" not in joined.lower()        # Pass 2a: bridge folded into picker
    assert "bootstrap stability" not in joined.lower()    # Pass 2b: bootstrap folded into clustering modal


def test_next_steps_empty_without_selection(clean_page):
    """With no selected step, the panel shows the select-a-card hint."""
    out = clean_page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            wf.clearWorkflow();
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/next-steps.js");
            const st = await import("/app/src/ui/state.js");
            mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 30));
            return {
                actionCount: host.querySelectorAll(".panel-ns-action").length,
                emptyText:   host.querySelector(".panel-ns-empty")?.textContent,
            };
        }'''
    )
    assert out["actionCount"] == 0
    assert "Select a card" in (out["emptyText"] or "")


def test_add_step_modal_lists_downstream_options(clean_page):
    """The per-card '+' add-step modal (UI #2) lists the downstream
    options for a clustering card — bootstrap, compare, dim sweep,
    citation layout — and excludes 'rerun this card' actions."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            wf.selectStep(cluA);
            const { openAddStepModal } = await import("/app/src/ui/modals/add-step-modal.js");
            openAddStepModal(wf.getStep(cluA));
            await new Promise(r => setTimeout(r, 30));
            const options = [...document.querySelectorAll(".add-step-option-label")]
                .map(n => n.textContent);
            const title = document.querySelector(".modal-title")?.textContent;
            document.querySelectorAll(".modal-backdrop").forEach(m => m.remove());
            return { options, title };
        }'''
    )
    joined = " | ".join(out["options"]).lower()
    assert "compare with another clustering" in joined
    assert "cross-cluster citations" in joined
    assert "label clusters" in joined
    assert "dim sweep" in joined
    assert "citation layout" in joined
    assert "bridge analysis"     not in joined            # Pass 2a removed
    assert "bootstrap stability" not in joined            # Pass 2b removed
    # No 'rerun this card' option in the add-step menu.
    assert "re-run" not in joined
    assert 'clustering A' in (out["title"] or "")


def test_next_steps_action_opens_modal(clean_page):
    """Clicking the 'Compare with another clustering' action opens the
    fusion-comparison modal (the panel is the launcher for net-new
    analysis cards)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            wf.selectStep(cluA);
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/next-steps.js");
            const st = await import("/app/src/ui/state.js");
            mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 30));

            const beforeModals = document.querySelectorAll(".modal-backdrop").length;
            const btn = [...host.querySelectorAll(".panel-ns-action")]
                .find(b => /compare with another/i.test(b.textContent));
            btn.click();
            await new Promise(r => setTimeout(r, 30));
            const afterModals = document.querySelectorAll(".modal-backdrop").length;
            const modalTitle = document.querySelector(".modal-backdrop .modal-title")?.textContent;
            // Clean up the modal so it doesn't leak into later tests.
            document.querySelectorAll(".modal-backdrop").forEach(m => m.remove());
            return { beforeModals, afterModals, modalTitle };
        }'''
    )
    assert out["beforeModals"] == 0
    assert out["afterModals"] == 1
    assert "Compare clusterings" in (out["modalTitle"] or "")
