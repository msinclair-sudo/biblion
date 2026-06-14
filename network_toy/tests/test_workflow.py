"""Browser-only residue of the workflow tests.

The CRUD + invariant cases and the pure migration-planner logic moved to
tests/unit/workflow.test.mjs (run under `node --test`). Only the two
migration cases that genuinely need a booted data fixture stay here: they
assert the spine shape inferBaselineTree produces from a real / toy
genResult, which requires ingest (BFS-5000 / toy taste-network) and so
can't run headless under plain Node.
"""


def test_migration_bfs5000_real_mode(page):
    """Real-mode (BFS-5000): migration emits data → dimred → clustering →
    citations. The citations card appears because BFS-5000 ships with
    citation_edges.json and the §6.4c `imported-edges` Layer 3
    algorithm populates state.citationResult on ingest. citationLayout /
    alignment / blend are opt-in (§6.16) and NOT emitted by default."""
    out = page.evaluate(
        '''async () => {
            const w   = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            w.clearWorkflow();
            const ran = mig.migrateLegacyToWorkflowIfNeeded();
            const all = w.listSteps().map(s => ({ type: s.type, label: s.label }));
            return {
                ran,
                typeChain: all.map(c => c.type),
                rootLabel: all[0] ? all[0].label : null,
            };
        }'''
    )
    assert out["ran"] is True
    # BFS-5000 ships with citations → migration emits the spine + citations.
    # No citationLayout / alignment / blend (opt-in).
    assert out["typeChain"] == ["data", "dimred", "clustering", "citations"]
    assert "Real · dev_subset_bfs_5000" in out["rootLabel"]


def test_migration_toy_mode_includes_citations(toy_page):
    """Toy mode: migration emits data → dimred → clustering → citations
    because the taste-network populates state.citationResult at boot."""
    out = toy_page.evaluate(
        '''async () => {
            const w   = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            w.clearWorkflow();
            mig.migrateLegacyToWorkflowIfNeeded();
            return w.listSteps().map(s => s.type);
        }'''
    )
    # Toy boot: data → dimred → clustering → citations (taste-network).
    # Citation layout / alignment / blend are opt-in (§6.16); not emitted.
    assert out[:4] == ["data", "dimred", "clustering", "citations"]
