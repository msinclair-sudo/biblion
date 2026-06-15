"""Browser tests for app/src/ui/workflow-migration.js (legacy state →
tree migration) on the real-data fixture.

The pure workflow.js CRUD + invariant tests, and the pure migration
planner tests (inferBaselineTree / applyTreePlan over a hand-built
snapshot), now live in the Node tier: `tests/unit/workflow.test.mjs`
(run with `node --test`). Per the suite's dedup policy (see
`tests/README.md` §3): logic is covered once, in the Node tier; the
browser tier keeps only what needs a browser. What remains here are the
migration tests that exercise the spine on the rehydrated fallworm
fixture, including the imported-edges citation branch — those need the
real genResult / dimredResult the session carries.
"""


def test_migration_fallworm_real_mode(page):
    """Real-mode (fallworm): migration emits data → dimred → clustering →
    citations. The citations card appears because the fixture ships with
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
    # fallworm ships with citations → migration emits the spine + citations.
    # No citationLayout / alignment / blend (opt-in).
    assert out["typeChain"] == ["data", "dimred", "clustering", "citations"]
    # Fixture is fallworm (no subset name in its config) → label falls back
    # to "(unknown subset)" with the fallworm node count.
    assert "Real · (unknown subset) (n=1638)" in out["rootLabel"]


def test_migration_is_idempotent(page):
    out = page.evaluate(
        '''async () => {
            const w   = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            w.clearWorkflow();
            const firstRan = mig.migrateLegacyToWorkflowIfNeeded();
            const firstCount = w.listSteps().length;
            const secondRan = mig.migrateLegacyToWorkflowIfNeeded();
            const secondCount = w.listSteps().length;
            return { firstRan, firstCount, secondRan, secondCount };
        }'''
    )
    assert out["firstRan"] is True
    assert out["secondRan"] is False
    assert out["firstCount"] == out["secondCount"]
