"""Node-table legend row-builders — real-year gradient + in-degree max.

The colour-mode resolution itself (viewer-shared/colour-modes.js) moved to the
Node unit tier (tests/unit/colour-modes.test.mjs). This Playwright test stays
because node-table.js transitively imports the engine (→ esm.sh UMAP), which
doesn't import under plain Node.
"""


def test_node_table_year_and_indeg_legend(clean_page):
    """The node-table row-builders reflect real values: year bins carry a
    real-year gradient range + 'years' column, and the in-degree gradient max
    is the real count. Tested via the exported builders on a synthetic state
    (no panel mount → no workflow-migration side effects)."""
    out = clean_page.evaluate(r'''async () => {
        const nt = await import("/app/src/ui/panels/node-table.js");
        const nodes = Array.from({length: 20}, (_, id) => ({ id, year: 2000 + (id % 11) }));
        const s = {
            genResult: { nodes },
            citationResult: { inDeg: Int32Array.from(nodes.map((_, i) => i === 0 ? 99 : (i % 4))) },
            clusterResult: null, clusterLevels: [],
        };
        const yearData  = nt.__test.timeBinRows(s);
        const indegData = nt.__test.inDegRows(s, "inDeg:raw");
        return {
            yearGradLabel: yearData.gradient.label,
            yearGradMin: yearData.gradient.min, yearGradMax: yearData.gradient.max,
            yearCol: yearData.columns.some(c => c.label === "years"),
            yearTitle: yearData.title,
            indegMax: indegData.gradient.max,
            indegTopRow: indegData.rows[0].inDeg,
        };
    }''')
    assert out["yearGradLabel"] == "year"
    assert out["yearGradMin"] == 2000 and out["yearGradMax"] == 2010   # real year range
    assert out["yearCol"] is True
    assert "2000" in out["yearTitle"] and "2010" in out["yearTitle"]
    assert out["indegMax"] == 99                  # real max count
    assert out["indegTopRow"] == 99               # sorted desc by in-degree


def test_node_table_row_select_resolves_nodes_in_every_view(clean_page):
    """Selecting a row resolves to its node ids regardless of the table view.
    A year-bin row emits {type:"nodes", ids:[...]} that selectedNodeIds expands
    (and the viewer dims to) exactly that bin's members; an in-degree row still
    resolves its single node. Regression for: year/degree selections produced an
    empty Selected-papers panel because their selection type wasn't resolved."""
    out = clean_page.evaluate(r'''async () => {
        const nt = await import("/app/src/ui/panels/node-table.js");
        const cm = await import("/app/src/ui/viewer-shared/colour-modes.js");
        const nodes = Array.from({length: 20}, (_, id) => ({ id, year: 2000 + (id % 11) }));
        const s = {
            genResult: { nodes },
            citationResult: { inDeg: Int32Array.from(nodes.map((_, i) => i === 0 ? 99 : (i % 4))) },
            clusterResult: null, clusterLevels: [],
        };
        // --- year (time-bin) view ---
        const yearData = nt.__test.timeBinRows(s);
        const row = yearData.rows.find(r => r.count > 0);
        const sel = row._select();
        const resolved = [...cm.selectedNodeIds({ genResult: { nodes }, selection: sel })]
            .sort((a, b) => a - b);
        const rowIds = sel.ids.slice().sort((a, b) => a - b);
        const inNode = nodes[sel.ids[0]];
        const outId  = nodes.findIndex(n => !sel.ids.includes(n.id));
        const matchIn  = cm.nodeMatchesSelection(inNode, s, sel);
        const matchOut = outId >= 0 ? cm.nodeMatchesSelection(nodes[outId], s, sel) : null;
        // --- in-degree view (single-node rows) ---
        const indeg = nt.__test.inDegRows(s, "inDeg:raw");
        const nodeSel = indeg.rows[0]._select();
        const nodeResolved = [...cm.selectedNodeIds({ genResult: { nodes }, selection: nodeSel })];
        return {
            selType: sel.type, resolved, rowIds, matchIn, matchOut,
            nodeSelType: nodeSel.type, nodeResolved, topId: indeg.rows[0].id,
        };
    }''')
    assert out["selType"] == "nodes"
    assert len(out["resolved"]) > 0
    assert out["resolved"] == out["rowIds"]        # bin row → exactly its members
    assert out["matchIn"] is True                  # in-bin node not dimmed
    assert out["matchOut"] is False                # out-of-bin node dimmed
    assert out["nodeSelType"] == "node"            # in-degree rows unchanged
    assert out["nodeResolved"] == [out["topId"]]   # and still resolve their node
