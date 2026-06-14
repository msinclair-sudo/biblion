"""Cross-cluster citation degree — pure compute, card wiring, panel.

For each committed layer, every citation edge (directed citing→cited, in
node-index space) is mapped to a cluster pair via nodeCluster, building a
directed cluster×cluster flow matrix + per-cluster in/out/intra degree + top
inter-cluster links. Edges with a noise endpoint (cluster < 0) are dropped.
"""


def test_cross_cluster_compute(clean_page):
    """Directed matrix + degrees on a hand-built level with known edges.
      nodeCluster = [0,0,1,1,2,-1]  → c0={0,1}, c1={2,3}, c2={4}, node5=noise
      edges (citing→cited):
        0→2 (c0→c1), 1→3 (c0→c1), 2→4 (c1→c2), 4→4 (c2 intra), 5→0 (noise→drop)
    """
    out = clean_page.evaluate(r'''async () => {
        const m = await import("/app/src/ui/cross-cluster-citations.js");
        const levels = [ { uid: "L0", clusterResult: {
            nodeCluster: Int32Array.from([0,0,1,1,2,-1]),
            clusters: [{id:0,count:2},{id:1,count:2},{id:2,count:1}],
        }}];
        const edges = [0,2, 1,3, 2,4, 4,4, 5,0];
        const res = m.computeCrossClusterAllLayers(levels, edges);
        const L = res.byLayer[0];
        const pc = Object.fromEntries(L.perCluster.map(p => [p.id, p]));
        return {
            nLevels: res.nLevels, totalEdges: res.totalEdges,
            layer: L.layer, k: L.k, edgesUsed: L.edgesUsed, edgesDropped: L.edgesDropped,
            matrix: L.matrix,
            c0: pc[0], c1: pc[1], c2: pc[2],
            topLinks: L.topLinks,
        };
    }''')
    assert out["nLevels"] == 1
    assert out["totalEdges"] == 5
    assert out["edgesUsed"] == 4 and out["edgesDropped"] == 1   # 5→0 dropped (noise)
    # matrix[a][b]: c0→c1 = 2 ; c1→c2 = 1 ; c2→c2 (intra) = 1
    assert out["matrix"] == [[0, 2, 0], [0, 0, 1], [0, 0, 1]]
    # degrees: c0 out=2 in=0 intra=0 ; c1 out=1 in=2 intra=0 ; c2 out=0 in=1 intra=1
    assert out["c0"]["outDeg"] == 2 and out["c0"]["inDeg"] == 0 and out["c0"]["intra"] == 0
    assert out["c1"]["outDeg"] == 1 and out["c1"]["inDeg"] == 2 and out["c1"]["intra"] == 0
    assert out["c2"]["outDeg"] == 0 and out["c2"]["inDeg"] == 1 and out["c2"]["intra"] == 1
    # top inter-cluster links (a≠b), strongest first: c0→c1 (2), c1→c2 (1)
    assert [(l["a"], l["b"], l["count"]) for l in out["topLinks"]] == [(0, 1, 2), (1, 2, 1)]


def test_cross_cluster_no_edges_returns_null(clean_page):
    """No citation edges → null (the card surfaces a clear message)."""
    out = clean_page.evaluate(r'''async () => {
        const m = await import("/app/src/ui/cross-cluster-citations.js");
        const levels = [ { uid: "L0", clusterResult: {
            nodeCluster: Int32Array.from([0,0,1,1]), clusters: [{id:0},{id:1}] }}];
        return {
            empty: m.computeCrossClusterAllLayers(levels, []),
            noLevels: m.computeCrossClusterAllLayers([], [0,1]),
        };
    }''')
    assert out["empty"] is None
    assert out["noLevels"] is None


def test_cross_cluster_card_and_next_steps(clean_page):
    """A crossClusterCitations card runs under the picker, computes the
    per-layer flow, and the picker offers it in its '+'."""
    out = clean_page.evaluate(r'''async () => {
        const wf = await import("/app/src/ui/workflow.js");
        const st = await import("/app/src/ui/state.js");
        const ld = await import("/app/src/ui/modals/layer-descriptors.js");
        const ns = await import("/app/src/ui/next-steps-rules.js");
        wf.clearWorkflow();
        const lvl = (uid, nc) => ({ uid, scope: "global", clusterResult: {
            method: "hdbscan", nodeCluster: Int32Array.from(nc),
            clusters: [...new Set(nc)].filter(x=>x>=0).map(id => ({ id, count: nc.filter(x=>x===id).length, colour: "#888" })),
        }});
        const levels = [ lvl("L0", [0,0,1,1,2,2]), lvl("L1", [0,1,1,2,2,3]) ];
        const data = wf.createStep({ type: "data", label: "data" });
        const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
        const ml = wf.createStep({ type: "multiLevel", label: "sweep", parentId: dim });
        wf.updateStepStatus(ml, "running");
        wf.setStepResult(ml, { multiLevelSweep: { candidates: [], curve: [], uidPrefix: ml } });
        const pk = wf.createStep({ type: "multiLevelPicker", label: "pick", params: { pickedCounts: [3,4] }, parentId: ml });
        wf.updateStepStatus(pk, "running");
        wf.setStepResult(pk, { clusterLevels: levels, clusterResult: levels[1].clusterResult });
        // citation edges (node-index space): c0→c1, c1→c2, c2→c0 at L0
        st.update({ rawCitationEdges: [0,2, 2,4, 4,0, 1,3] });
        wf.selectStep(pk);

        await ld.getLayerDescriptor("crossClusterCitations").applyChange();
        const card = wf.listSteps({ type: "crossClusterCitations" }).slice(-1)[0];
        const cc = card.result && card.result.crossClusterCitations;
        return {
            status: card.status,
            parentIsPicker: card.parentId === pk,
            nLayers: cc && cc.byLayer.length,
            l0k: cc && cc.byLayer[0].k,
            l0used: cc && cc.byLayer[0].edgesUsed,
            pickerOffers: ns.addStepRulesFor("multiLevelPicker").map(r => r.modal),
        };
    }''')
    assert out["status"] == "done"
    assert out["parentIsPicker"] is True
    assert out["nLayers"] == 2                       # both committed layers
    assert out["l0k"] == 3                            # L0 has 3 clusters
    assert out["l0used"] == 4                         # all 4 edges map (no noise)
    assert "crossClusterCitations" in out["pickerOffers"]


def test_cross_cluster_panel_renders(clean_page):
    """The panel binds to the selected card, renders the matrix heatmap +
    degree table + level selector, and switches level."""
    out = clean_page.evaluate(r'''async () => {
        const wf = await import("/app/src/ui/workflow.js");
        const st = await import("/app/src/ui/state.js");
        const reg = await import("/app/src/ui/panels/registry.js");
        wf.clearWorkflow();
        const card = wf.createStep({ type: "crossClusterCitations", label: "xcc" });
        wf.updateStepStatus(card, "running");
        wf.setStepResult(card, { crossClusterCitations: {
            nLevels: 2, totalEdges: 3,
            byLayer: [
              { layer: 0, uid: "L0", k: 2, clusterIds: [0,1],
                matrix: [[0,2],[1,0]], edgesUsed: 3, edgesDropped: 0,
                perCluster: [{id:0,size:3,outDeg:2,inDeg:1,intra:0},{id:1,size:3,outDeg:1,inDeg:2,intra:0}],
                topLinks: [{a:0,b:1,count:2},{a:1,b:0,count:1}] },
              { layer: 1, uid: "L1", k: 3, clusterIds: [0,1,2],
                matrix: [[0,1,0],[0,0,1],[0,0,0]], edgesUsed: 2, edgesDropped: 0,
                perCluster: [{id:0,size:2,outDeg:1,inDeg:0,intra:0},{id:1,size:2,outDeg:1,inDeg:1,intra:0},{id:2,size:2,outDeg:0,inDeg:1,intra:0}],
                topLinks: [{a:0,b:1,count:1},{a:1,b:2,count:1}] },
            ],
        }});
        wf.selectStep(card);

        const host = document.createElement("div");
        host.style.width = "600px";
        document.body.appendChild(host);
        const inst = reg.getPanelType("cross-cluster").mount(host, st.getState(), { stepId: card });
        await new Promise(r => setTimeout(r, 40));

        const cells0 = host.querySelectorAll(".chart-heatmap-cell, rect").length;
        const rows0 = host.querySelectorAll(".xcc-table tbody tr").length;
        const links0 = host.querySelectorAll(".xcc-link").length;
        // switch to L1 → 3 clusters → 3 table rows
        const sel = host.querySelector(".xcc-select");
        sel.value = "1"; sel.dispatchEvent(new Event("change"));
        await new Promise(r => setTimeout(r, 30));
        const rows1 = host.querySelectorAll(".xcc-table tbody tr").length;
        inst.destroy();
        return { hasHeatmap: cells0 > 0, rows0, links0, rows1, panelId: reg.getPanelType("cross-cluster").id };
    }''')
    assert out["panelId"] == "cross-cluster"
    assert out["hasHeatmap"] is True
    assert out["rows0"] == 2          # L0: 2 clusters
    assert out["links0"] == 2
    assert out["rows1"] == 3          # L1: 3 clusters after level switch
