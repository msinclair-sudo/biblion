"""RIS export — formatter, selection logic, and the export card/panel.

The export feature: pick a level + score≥threshold (per-level scores) OR a
single cluster, gather each member node's bibliographic record from the
biblion corpus, and download a RIS file. Pure helpers (export/ris.js,
export/cluster-export.js) are unit-tested with injected records; the
card/panel wiring is exercised on a synthetic tree (clean_page).
"""


def test_ris_formatter(clean_page):
    """A record formats as a valid RIS entry: TY from pub_type, one AU per
    author, TI/PY/JO/DO/AB, ER terminator; many records join cleanly."""
    out = clean_page.evaluate(r'''async () => {
        const ris = await import("/app/src/export/ris.js");
        const rec = {
            paperId: 1, title: "Soil microbial communities", year: 2021,
            venue: "Soil Biology", doi: "10.1/abc", pubType: "journalarticle",
            abstract: "We study\nsoil microbes.",
            authors: ["Smith, J.", "Doe, A."],
        };
        const one = ris.formatRisRecord(rec);
        const many = ris.formatRis([rec, { ...rec, title: "Second", authors: [] }]);
        return {
            ty: ris.risTypeFor("journalarticle"),
            tyConf: ris.risTypeFor("conferencepaper"),
            tyUnknown: ris.risTypeFor("weirdtype"),
            tyNull: ris.risTypeFor(null),
            one,
            nAU: (one.match(/^AU  - /gm) || []).length,
            endsER: /ER  - $/m.test(one),
            absSingleLine: !/AB  - We study\n/.test(one),   // newline collapsed
            manyRecords: (many.match(/^TY  - /gm) || []).length,
        };
    }''')
    assert out["ty"] == "JOUR"
    assert out["tyConf"] == "CONF"
    assert out["tyUnknown"] == "GEN"
    assert out["tyNull"] == "GEN"
    assert out["nAU"] == 2
    assert out["endsER"] is True
    assert out["absSingleLine"] is True
    assert "TI  - Soil microbial communities" in out["one"]
    assert "PY  - 2021" in out["one"]
    assert "DO  - 10.1/abc" in out["one"]
    assert out["manyRecords"] == 2


def test_selection_by_score_and_cluster(clean_page):
    """selectNodes picks the right node set: by-score uses the chosen level's
    per-level scores; single-cluster picks one cluster's members."""
    out = clean_page.evaluate(r'''async () => {
        const ex = await import("/app/src/export/cluster-export.js");
        // L0: clusters {0,1}; L1: clusters {0,1,2}
        const levels = [
            { uid: "L0", clusterResult: { nodeCluster: Int32Array.from([0,0,0,1,1,1]),
                clusters: [{id:0},{id:1}] } },
            { uid: "L1", clusterResult: { nodeCluster: Int32Array.from([0,0,1,1,2,2]),
                clusters: [{id:0},{id:1},{id:2}] } },
        ];
        // Scores are PER-LEVEL. At L0: cluster 0 → 5, cluster 1 → 2.
        const scores = { L0: { 0: 5, 1: 2 }, L1: { 0: 4, 1: 1, 2: 5 } };

        // by-score at L0, ≥3 → only cluster 0 (nodes 0,1,2).
        const a = ex.selectNodes(levels, scores, { mode: "by-score", level: 0, minScore: 3 });
        // by-score at L1, ≥4 → clusters 0 (nodes 0,1) and 2 (nodes 4,5).
        const b = ex.selectNodes(levels, scores, { mode: "by-score", level: 1, minScore: 4 });
        // single cluster: L1 cluster 1 → nodes 2,3.
        const c = ex.selectNodes(levels, scores, { mode: "cluster", level: 1, clusterId: 1 });
        return {
            aNodes: [...a.nodeIds], aClusters: [...a.clusterIds].sort(),
            bNodes: [...b.nodeIds].sort((x,y)=>x-y), bClusters: [...b.clusterIds].sort(),
            cNodes: [...c.nodeIds],
            fnameScore: ex.exportFilename({ mode: "by-score", level: 0, minScore: 3 }),
            fnameCluster: ex.exportFilename({ mode: "cluster", level: 1, clusterId: 1 }),
        };
    }''')
    assert out["aNodes"] == [0, 1, 2]
    assert out["aClusters"] == [0]
    assert out["bNodes"] == [0, 1, 4, 5]
    assert out["bClusters"] == [0, 2]
    assert out["cNodes"] == [2, 3]
    assert out["fnameScore"] == "cluster-L0-score-ge-3.ris"
    assert out["fnameCluster"] == "cluster-L1-c1.ris"


def test_buildris_with_injected_records(clean_page):
    """buildRis gathers records for the selection via an injected getRecord,
    counts misses, and produces RIS text."""
    out = clean_page.evaluate(r'''async () => {
        const ex = await import("/app/src/export/cluster-export.js");
        const levels = [ { uid: "L0", clusterResult: {
            nodeCluster: Int32Array.from([0,0,0,1,1,1]), clusters: [{id:0},{id:1}] } } ];
        const scores = { L0: { 0: 5 } };
        // node 1 has no record (returns null) → counted as missing.
        const getRecord = (id) => id === 1 ? null : ({
            paperId: id, title: "Paper " + id, year: 2020, authors: ["A, B"],
            venue: null, doi: null, pubType: "journalarticle", abstract: null });
        const { ris, count, missing } = ex.buildRis(levels, scores,
            { mode: "by-score", level: 0, minScore: 3 }, getRecord);
        return { count, missing, hasTitle0: ris.includes("Paper 0"), records: (ris.match(/^TY  - /gm)||[]).length };
    }''')
    assert out["count"] == 2          # nodes 0 and 2 (node 1 missing)
    assert out["missing"] == 1
    assert out["hasTitle0"] is True
    assert out["records"] == 2


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
