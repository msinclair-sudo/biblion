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
