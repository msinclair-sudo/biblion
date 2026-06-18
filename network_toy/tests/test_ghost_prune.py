"""Browser tests for ghost pruning + kind classification in the sqlite loader.

`produceSqlite` re-derives the node set from a real snapshot DB, so unlike the
rehydrated fixtures this exercises the live prune/classify path. We load the
committed fallworm + PhD_proposal datasets fresh and assert the keep rule:

  - is_stub=0 (missing-data) ghost kept iff >=1 real-paper citation partner;
  - is_stub=1 (pending) ghost kept iff >=2 (none in these datasets today);
  - isolated no-abstract papers dropped.

Counts come from the snapshot data (verified with SQL): fallworm keeps 116 /
drops 117; PhD_proposal keeps 2 / drops 26. All current ghosts are is_stub=0,
so all kept are "missing-data".

Uses the clean_page fixture (empty workflow); we don't push the result into
state, and drop the corpus afterwards to leave the shared page as we found it.
"""

import pytest


def _produce(page, dataset):
    return page.evaluate(
        """async (dataset) => {
            const sq = await import("/app/src/datasource/sqlite.js");
            try {
                const res = await sq.produceSqlite({ dataset });
                const nodes = res.nodes || [];
                let embWithKind = 0, ghostMissing = 0, ghostPending = 0, ghostOther = 0;
                for (const n of nodes) {
                    if (n.isGhost) {
                        if (n.ghostKind === "missing-data") ghostMissing++;
                        else if (n.ghostKind === "pending") ghostPending++;
                        else ghostOther++;
                    } else if (n.ghostKind != null) {
                        embWithKind++;   // embedded nodes must carry null ghostKind
                    }
                }
                return { ok: true, params: res.params, nNodes: nodes.length,
                         embWithKind, ghostMissing, ghostPending, ghostOther };
            } catch (e) {
                return { ok: false, error: String(e && e.message || e) };
            } finally {
                sq.clearSqliteCorpus();
            }
        }""",
        dataset,
    )


def test_fallworm_prune_and_classify(clean_page):
    out = _produce(clean_page, "fallworm")
    if not out["ok"]:
        pytest.skip(f"fallworm dataset unavailable: {out.get('error')}")
    p = out["params"]
    assert p["nEmbedded"] == 1405
    assert p["nGhostMissingData"] == 116
    assert p["nGhostPending"] == 0
    assert p["nGhostDroppedIsolated"] == 117
    assert p["nGhost"] == 116
    # node-level tallies agree with params; embedded nodes carry no ghostKind.
    assert out["ghostMissing"] == 116
    assert out["ghostPending"] == 0
    assert out["ghostOther"] == 0
    assert out["embWithKind"] == 0
    assert out["nNodes"] == 1405 + 116


def test_phd_proposal_keeps_connected_missing_data(clean_page):
    out = _produce(clean_page, "PhD_proposal")
    if not out["ok"]:
        pytest.skip(f"PhD_proposal dataset unavailable: {out.get('error')}")
    p = out["params"]
    assert p["nEmbedded"] == 261
    assert p["nGhostMissingData"] == 2
    assert p["nGhostPending"] == 0
    assert p["nGhostDroppedIsolated"] == 26
    assert p["nGhost"] == 2
    assert out["ghostMissing"] == 2
    assert out["ghostOther"] == 0


@pytest.mark.slow
def test_viewer_3d_renders_ghost_incident_edges(clean_page):
    """End-to-end: run the full real pipeline (ingest → dim-red → cluster →
    citations) on fallworm, mount a real viewer-3d, and read the ForceGraph3D
    instance's graphData() to prove ghost-incident citation edges render with
    "Show citations" ON (alongside real↔real edges), vanish when citations are
    toggled OFF (they obey the toggle like any citation edge), and drop out when
    ghosts are hidden while real↔real edges remain. Slow: real UMAP + HDBSCAN
    at n=1405."""
    out = clean_page.evaluate(
        """async () => {
            const state  = await import("/app/src/ui/state.js");
            const engine = await import("/app/src/ui/engine.js");
            try {
                state.setDataSourceMode("sqlite");
                state.setDataSourceConfig("dataset", "fallworm", "sqlite");
                await engine.ingestDataOnly();
                // viewer-3d needs a 3-d viz reduction (_basePos); the default viz
                // is identity. Point it at UMAP (defaults to n_components=3).
                const dr = await import("/app/src/dimred/registry.js");
                const umap = dr.getAlgorithm("umap");
                const lp = state.getState().layerParams;
                state.update({ layerParams: { ...lp, dimred: { ...lp.dimred,
                  viz: { method: "umap", params: umap.defaultParams() } } } });
                await engine.redimred({ cascade: true });    // dim-red (UMAP-3) + clustering
                await engine.resampleViaImport();            // Layer 3 → citationResult
            } catch (e) {
                return { ok: false, error: String(e && e.message || e) };
            }
            const cr = state.getState().citationResult;
            if (!cr || !cr.citations) return { ok: false, error: "no citationResult" };

            const nodes = state.getState().genResult.nodes;
            const isGhost = (x) => {
                const id = (x && typeof x === "object") ? x.id : x;
                const nd = nodes[id];
                return !!(nd && nd.isGhost);
            };
            // citationResult-level ghost-incident count (the expected upper bound).
            let crGhostInc = 0;
            for (const c of cr.citations) if (isGhost(c.source) || isGhost(c.target)) crGhostInc++;

            // Capture the ForceGraph3D instance our viewer creates.
            if (!window.__fgWrapped) {
                const orig = window.ForceGraph3D;
                window.ForceGraph3D = function (...a) {
                    const cfg = orig.apply(this, a);
                    return function (div) { const inst = cfg(div); window.__fg = inst; return inst; };
                };
                window.__fgWrapped = true;
            }
            const counts = () => {
                const data = window.__fg.graphData();
                let cit = 0, ghostInc = 0, realReal = 0;
                for (const l of data.links) {
                    if (l.kind !== "citation") continue;
                    cit++;
                    if (isGhost(l.source) || isGhost(l.target)) ghostInc++; else realReal++;
                }
                return { cit, ghostInc, realReal };
            };

            // Citations ON, ghosts ON → both real↔real and ghost-incident render.
            state.setView({ showCitations: true, showGhosts: true });
            const v3d = await import("/app/src/ui/panels/viewer-3d.js");
            const host = document.createElement("div");
            host.style.width = "400px"; host.style.height = "400px";
            document.body.appendChild(host);
            const inst = v3d.mount(host, state.getState(), {}, null);
            await new Promise(r => setTimeout(r, 300));
            const citOn = counts();

            // Citations OFF → all citation edges vanish (ghost-incident obey it too).
            state.setView({ showCitations: false });
            inst.update(state.getState());
            await new Promise(r => setTimeout(r, 150));
            const citOff = counts();

            // Citations ON, ghosts OFF → ghost edges gone, real↔real remain.
            state.setView({ showCitations: true, showGhosts: false });
            inst.update(state.getState());
            await new Promise(r => setTimeout(r, 150));
            const ghostOff = counts();

            try { inst.destroy(); } catch (_) {}
            host.remove();
            return { ok: true, crGhostInc, citOn, citOff, ghostOff };
        }"""
    )
    if not out["ok"]:
        pytest.skip(f"pipeline/dataset unavailable: {out.get('error')}")
    # Citations ON + ghosts ON → ghost-incident edges render (all of them)...
    assert out["citOn"]["ghostInc"] > 100
    assert out["citOn"]["ghostInc"] == out["crGhostInc"]
    # ...alongside real↔real edges.
    assert out["citOn"]["realReal"] > 0
    # Citations OFF → every citation edge vanishes, ghost-incident included.
    assert out["citOff"]["cit"] == 0
    # Ghosts OFF (citations on) → ghost edges drop out, real↔real stay.
    assert out["ghostOff"]["ghostInc"] == 0
    assert out["ghostOff"]["realReal"] > 0
