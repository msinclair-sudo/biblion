"""Browser-only residue of the RIS export tests.

The pure helpers — ris.js (formatter) and cluster-export.js (selectNodes /
buildRis / exportFilename) — moved to tests/unit/export-ris.test.mjs (run
under `node --test`). What stays here needs a browser: the next-steps wiring
case imports next-steps-rules (→ esm.sh engine), and the panel-render case
mounts DOM and exercises live picker events.
"""


def test_export_card_in_next_steps_and_registered(clean_page):
    """Scoring offers Export in its '+'; the export panel type is registered."""
    out = clean_page.evaluate(r'''async () => {
        const ns  = await import("/app/src/ui/next-steps-rules.js");
        const reg = await import("/app/src/ui/panels/registry.js");
        const t = reg.getPanelType("export-ris");
        return {
            scoring: ns.addStepRulesFor("scoring").map(r => r.modal),
            panelId: t && t.id,
            panelLabel: t && t.label,
        };
    }''')
    assert "export" in out["scoring"]
    assert out["panelId"] == "export-ris"
    assert out["panelLabel"] == "Export (RIS)"


def test_export_panel_renders_pickers_and_count(clean_page):
    """The export panel binds to the selected export card, walks up to the
    clustering levels + scoring scores, and shows a live selected-node count
    that updates with the score threshold."""
    out = clean_page.evaluate(r'''async () => {
        const wf = await import("/app/src/ui/workflow.js");
        const reg = await import("/app/src/ui/panels/registry.js");
        const st = await import("/app/src/ui/state.js");
        wf.clearWorkflow();
        const lvl = (uid, nc) => ({ uid, scope: "global", clusterResult: {
            method: "hdbscan", nodeCluster: Int32Array.from(nc),
            clusters: [...new Set(nc)].map(id => ({ id, count: nc.filter(x=>x===id).length, colour: "#888" })),
        }});
        const levels = [ lvl("L0", [0,0,0,1,1,1]) ];
        const data = wf.createStep({ type: "data", label: "data" });
        const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
        const ml = wf.createStep({ type: "multiLevel", label: "sweep", parentId: dim });
        wf.updateStepStatus(ml, "running");
        wf.setStepResult(ml, { multiLevelSweep: { candidates: [], curve: [], uidPrefix: ml } });
        const pk = wf.createStep({ type: "multiLevelPicker", label: "pick", params: { pickedCounts: [2] }, parentId: ml });
        wf.updateStepStatus(pk, "running");
        wf.setStepResult(pk, { clusterLevels: levels, clusterResult: levels[0].clusterResult });
        const lb = wf.createStep({ type: "labelling", label: "labels", parentId: pk });
        wf.updateStepStatus(lb, "running"); wf.setStepResult(lb, { byLevel: {} });
        const sc = wf.createStep({ type: "scoring", label: "scoring", parentId: lb });
        wf.updateStepStatus(sc, "running");
        wf.setStepResult(sc, { scores: { L0: { 0: 5, 1: 2 } } });   // cluster 0 → 5, 1 → 2
        const ex = wf.createStep({ type: "export", label: "export", parentId: sc });
        wf.updateStepStatus(ex, "running"); wf.setStepResult(ex, { lastSelection: null });
        wf.selectStep(ex);

        const host = document.createElement("div");
        host.style.width = "500px";
        document.body.appendChild(host);
        const inst = reg.getPanelType("export-ris").mount(host, st.getState(), { stepId: ex });
        await new Promise(r => setTimeout(r, 40));

        const hasMode = !!host.querySelector(".export-toggle");
        const hasLevel = !!host.querySelector(".export-select");
        const countDefault = host.querySelector(".export-count").textContent;   // score≥3 default
        // lower threshold to 1 → both clusters qualify (all 6 nodes)
        const num = host.querySelector(".export-number");
        num.value = "1"; num.dispatchEvent(new Event("change"));
        await new Promise(r => setTimeout(r, 30));
        const countLow = host.querySelector(".export-count").textContent;
        inst.destroy();
        return { hasMode, hasLevel, countDefault, countLow };
    }''')
    assert out["hasMode"] is True
    assert out["hasLevel"] is True
    assert "3 nodes" in out["countDefault"]     # only cluster 0 (3 nodes) ≥ 3
    assert "6 nodes" in out["countLow"]         # both clusters ≥ 1 → all 6 nodes
