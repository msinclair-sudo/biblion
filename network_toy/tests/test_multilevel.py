"""MLC-1/2 — multi-level clustering: discover λ-shelves from one HDBSCAN
condensed tree, extract a coarse→fine partition ladder with bridge-
producing absorption, and fan the distance matrix out across cores.

The pure tree maths (discoverLayers / flattenFrontier / absorbViaMST) and
the parallel-distance API-contract check moved to
tests/unit/multilevel.test.mjs (run under `node --test`). The engine lane +
nested-worker fan-out cases below stay browser — they need engine.recluster /
layer-descriptors / DOM and the real Worker substrate.
"""

import pytest


# ── Engine lane (toy, fast) ─────────────────────────────────────────────
def test_multilevel_sweep_then_commit_toy(toy_page):
    """The produce/picker split: recomputeMultiLevelSweep scores every
    candidate (state.multiLevelSweep, no clusterLevels yet); then
    commitMultiLevelLayers(pickedCounts) builds the coarse→fine ladder in
    state.clusterLevels with bridge analysis."""
    out = toy_page.evaluate(r'''async () => {
        const engine = await import("/app/src/ui/engine.js");
        const st = await import("/app/src/ui/state.js");
        // toy_page pre-runs data→dimred→clustering, so clusterLevels is
        // already populated. Clear it so we can prove the SWEEP alone commits
        // nothing (it must not create clusterLevels — only the picker does).
        st.update({ clusterLevels: null, clusterResult: null });
        // 1. Produce-only sweep: scores candidates, no layers committed.
        await engine.recomputeMultiLevelSweep({
            params: { minSamples: 5, selectionMethod: "leaf" }, floor: 0.5,
            sizeGridCount: 14, bootstrapOpts: { B: 5, subsampleFrac: 0.6 },
            uidPrefix: "MLTEST",
        });
        const afterSweep = st.getState();
        const sweep = afterSweep.multiLevelSweep || {};
        const cands = sweep.candidates || [];
        const candCounts = cands.map(c => c.count).sort((a,b)=>a-b);
        const noLevelsYet = !afterSweep.clusterLevels;

        // 2. Pick the two coarsest distinct granularities and commit.
        const picks = [...new Set(candCounts)].slice(0, 2);
        engine.commitMultiLevelLayers(picks, { uidPrefix: "MLTEST" });

        const s = st.getState();
        const lv = s.clusterLevels || [];
        const counts = lv.map(l => l.clusterResult.clusters.length);
        let noNoise = true, contiguous = true;
        for (const l of lv) {
            const nc = l.clusterResult.nodeCluster;
            let max = -1; const seen = new Set();
            for (let i = 0; i < nc.length; i++) {
                if (nc[i] < 0) noNoise = false;
                if (nc[i] > max) max = nc[i];
                seen.add(nc[i]);
            }
            for (let c = 0; c <= max; c++) if (!seen.has(c)) contiguous = false;
        }
        // Per-pair bridge counts populated by the sweep — feed the picker
        // heatmap. Shape is { n, counts: Int32Array(n*n) } with only the
        // strict upper triangle (child > parent) filled.
        const bpp = sweep.bridgesPerPair || null;
        let upperOnly = true;
        if (bpp && bpp.counts) {
            for (let i = 0; i < bpp.n; i++) {
                for (let j = i; j < bpp.n; j++) {
                    // diag + lower triangle (parent ≥ child) must be 0
                    if (bpp.counts[i * bpp.n + j] !== 0) { upperOnly = false; }
                }
            }
        }

        return {
            candCount: cands.length,
            candHaveCR: cands.every(c => c.clusterResult && c.clusterResult.nodeCluster),
            noLevelsYet,
            curveLen: Array.isArray(sweep.curve) ? sweep.curve.length : 0,
            picks,
            nLevels: lv.length,
            counts,
            ascending: counts.every((c, i) => i === 0 || c >= counts[i-1]),
            noNoise,
            contiguous,
            hasBridge: !!s.bridgeAnalysis,
            allHaveStability: lv.every(l => l.stability === null || Number.isFinite(l.stability)),
            method: lv[0] && lv[0].clusterResult.method,
            // Per-pair bridge heatmap data — Pass 1a.
            bppN: bpp ? bpp.n : null,
            bppLen: bpp && bpp.counts ? bpp.counts.length : null,
            bppUpperOnly: upperOnly,
        };
    }''')
    assert out["candCount"] >= 2, f"expected ≥2 candidates, got {out['candCount']}"
    assert out["candHaveCR"] is True            # every candidate retains its clusterResult
    assert out["noLevelsYet"] is True           # sweep alone commits nothing
    assert out["curveLen"] == out["candCount"]
    assert out["nLevels"] == len(out["picks"])
    assert out["method"] == "hdbscan"
    assert out["ascending"] is True
    assert out["noNoise"] is True
    assert out["contiguous"] is True
    assert out["hasBridge"] is True
    assert out["allHaveStability"] is True
    # Per-pair bridge counts (Pass 1a) — populated alongside the sweep.
    assert out["bppN"] == out["candCount"]
    assert out["bppLen"] == out["candCount"] ** 2
    assert out["bppUpperOnly"] is True


def test_multilevel_producer_picker_cards_toy(toy_page):
    """The produce/picker card split: the multiLevel descriptor creates a
    SWEEP card under the dimred ancestor whose result holds the scored sweep
    (multiLevelSweep, no clusterLevels). A picker card auto-spawns under it;
    picking granularities + applyChange commits clusterLevels into the picker
    card's result, and selecting the picker projects them into legacy state."""
    out = toy_page.evaluate(r'''async () => {
        const ld = await import("/app/src/ui/modals/layer-descriptors.js");
        const wf = await import("/app/src/ui/workflow.js");
        const proj = await import("/app/src/ui/workflow-projection.js");
        const st = await import("/app/src/ui/state.js");

        // ensure a dimred card is in the selected lineage (toy_page yields
        // data→dimred→clustering; select the clustering leaf).
        const clust = wf.listSteps().filter(s => s.type === "clustering").pop();
        wf.selectStep(clust.id);

        // 1. Producer sweep card.
        const desc = ld.getLayerDescriptor("multiLevel");
        const active = desc.getActive();
        await desc.applyChange({
            minSamples: active.defaults.minSamples,
            floor:      0.5,
            B:          5,            // small bootstrap budget to keep the test quick
        });
        const producer = wf.listSteps().filter(s => s.type === "multiLevel").pop();
        const producerHasSweep = !!(producer.result && producer.result.multiLevelSweep);
        const producerNoLevels = !(producer.result && producer.result.clusterLevels);

        // 2. The picker auto-spawned under the producer (promise.then). Give
        //    the microtask a beat to land.
        await new Promise(r => setTimeout(r, 30));
        const picker = wf.listSteps().filter(s => s.type === "multiLevelPicker" && s.parentId === producer.id).pop();

        // 3. Pick the two coarsest distinct granularities and apply.
        const cands = producer.result.multiLevelSweep.candidates || [];
        const picks = [...new Set(cands.map(c => c.count).sort((a,b)=>a-b))].slice(0, 2);
        wf.selectStep(picker.id);
        const pdesc = ld.getLayerDescriptor("multiLevelPicker");
        await pdesc.applyChange({ pickedCounts: picks });

        const committed = wf.listSteps().filter(s => s.type === "multiLevelPicker" && s.parentId === producer.id).pop();
        wf.selectStep(committed.id);
        proj.projectStepIntoLegacyState(committed.id);
        const s = st.getState();
        return {
            producerExists: !!producer,
            producerStatus: producer.status,
            producerHasSweep,
            producerNoLevels,
            producerParent: wf.getStep(producer.parentId).type,
            pickerAutoSpawned: !!picker,
            pickerStatus: committed.status,
            pickerLevels: committed.result ? committed.result.clusterLevels.length : 0,
            picks,
            projectedLevels: (s.clusterLevels || []).length,
            projectedSweep: !!s.multiLevelSweep,
        };
    }''')
    assert out["producerExists"] is True
    assert out["producerStatus"] == "done"
    assert out["producerHasSweep"] is True
    assert out["producerNoLevels"] is True          # producer commits nothing
    assert out["producerParent"] == "dimred"
    assert out["pickerAutoSpawned"] is True
    assert out["pickerStatus"] == "done"
    assert out["pickerLevels"] == len(out["picks"])
    assert out["projectedLevels"] == out["pickerLevels"]
    assert out["projectedSweep"] is True            # producer ancestor projects the curve


def test_picker_commit_populates_bridges_and_auto_spawns_crosscite(toy_page):
    """Pass 1c + Pass 2a: after the picker commits a ladder, bridgeAnalysis
    is computed inline (no separate card — Pass 2a removed it) and surfaced
    on state.bridgeAnalysis. crossClusterCitations auto-spawns ONLY when
    citation edges are present in live state (gated to avoid a perma-failed
    card on toy data). Toggling state.rawCitationEdges between two commits
    proves the gate works."""
    out = toy_page.evaluate(r'''async () => {
        const ld = await import("/app/src/ui/modals/layer-descriptors.js");
        const wf = await import("/app/src/ui/workflow.js");
        const st = await import("/app/src/ui/state.js");

        // Build producer → picker.
        const clust = wf.listSteps().filter(s => s.type === "clustering").pop();
        wf.selectStep(clust.id);
        const desc = ld.getLayerDescriptor("multiLevel");
        const active = desc.getActive();
        await desc.applyChange({
            minSamples: active.defaults.minSamples,
            floor: 0.5, B: 5,
        });
        const producer = wf.listSteps().filter(s => s.type === "multiLevel").pop();
        await new Promise(r => setTimeout(r, 30));
        const picker = wf.listSteps().filter(s => s.type === "multiLevelPicker" && s.parentId === producer.id).pop();
        wf.selectStep(picker.id);
        const cands = producer.result.multiLevelSweep.candidates || [];
        const picks = [...new Set(cands.map(c => c.count).sort((a,b)=>a-b))].slice(0, 2);
        const pdesc = ld.getLayerDescriptor("multiLevelPicker");

        // ── Phase 1: no edges (toy default) — picker commits + bridges land
        //    on state.bridgeAnalysis, but crossCluster is gated out.
        const edgesBefore = st.getState().rawCitationEdges;
        st.update({ rawCitationEdges: null });
        await pdesc.applyChange({ pickedCounts: picks });
        // wait for the picker job to commit
        for (let i = 0; i < 25; i++) {
            await new Promise(r => setTimeout(r, 40));
            const p = wf.listSteps().filter(s => s.type === "multiLevelPicker" && s.parentId === producer.id).pop();
            if (p && p.status === "done") break;
        }
        const phase1_state = st.getState();
        const phase1_hasBridge = !!phase1_state.bridgeAnalysis;
        // No separate bridgeAnalysis card should exist (Pass 2a deleted the type).
        const phase1_bridgeCards = wf.listSteps().filter(s => s.type === "bridgeAnalysis").length;
        const xcc1 = wf.listSteps().filter(s => s.type === "crossClusterCitations" && s.parentId === picker.id);

        // ── Phase 2: synthesise edges + re-pick — crossCluster should join.
        st.update({ rawCitationEdges: [[0, 1], [1, 2], [2, 0]] });
        await pdesc.applyChange({ pickedCounts: picks });
        for (let i = 0; i < 25; i++) {
            await new Promise(r => setTimeout(r, 40));
            const xcc = wf.listSteps().filter(s => s.type === "crossClusterCitations" && s.parentId === picker.id);
            if (xcc.length && xcc[0].status === "done") break;
        }
        const xcc2 = wf.listSteps().filter(s => s.type === "crossClusterCitations" && s.parentId === picker.id);

        // Restore so we don't bleed into later tests.
        st.update({ rawCitationEdges: edgesBefore });

        return {
            phase1_hasBridge,
            phase1_bridgeCards,                      // expected: 0 (card type removed)
            phase1_xccCount: xcc1.length,            // expected: 0 (gated out)
            phase2_xccCount: xcc2.length,            // expected: 1 (auto-spawned)
            phase2_xccStatus: xcc2[0] && xcc2[0].status,
        };
    }''')
    # Bridge computed inline + surfaced on state, no separate card.
    assert out["phase1_hasBridge"] is True
    assert out["phase1_bridgeCards"] == 0
    # CrossCluster gated out when no edges.
    assert out["phase1_xccCount"] == 0
    # ...and auto-spawns when edges are present.
    assert out["phase2_xccCount"] == 1
    assert out["phase2_xccStatus"] == "done"


def test_bridge_panel_sections_and_tau(toy_page):
    """After a multi-level run, the bridge panel renders Encapsulated +
    Bridges sections that together account for every fine cluster, and the
    τ slider re-buckets without an engine recompute."""
    out = toy_page.evaluate(r'''async () => {
        const engine = await import("/app/src/ui/engine.js");
        const state = await import("/app/src/ui/state.js");
        // Sweep, then commit the two coarsest granularities so bridge
        // analysis (needs ≥2 levels) has a ladder to work on.
        await engine.recomputeMultiLevelSweep({
            params: { minSamples: 5, selectionMethod: "leaf" }, floor: 0.5,
            sizeGridCount: 14, bootstrapOpts: { B: 5, subsampleFrac: 0.6 },
            uidPrefix: "MLBRIDGE",
        });
        const cands = (state.getState().multiLevelSweep.candidates || []);
        const picks = [...new Set(cands.map(c => c.count).sort((a,b)=>a-b))].slice(0, 2);
        engine.commitMultiLevelLayers(picks, { uidPrefix: "MLBRIDGE" });

        const host = document.createElement("div");
        document.body.appendChild(host);
        const { mount } = await import("/app/src/ui/panels/bridge-analysis.js");
        const inst = mount(host, state.getState(), {});
        await new Promise(r => setTimeout(r, 50));

        const heads = [...host.querySelectorAll(".panel-bridge-section-head")].map(e => e.textContent);
        const slider = host.querySelector(".panel-bridge-tau-slider");
        const totalFine = state.getState().bridgeAnalysis.perCluster.length;
        // count rows across both section tables
        const rowsAt = () => host.querySelectorAll(".panel-bridge-row").length;
        const rowsDefault = rowsAt();
        // lower τ to 0.5 → fewer/equal bridges; raise to 1.0 → more bridges
        slider.value = "1"; slider.dispatchEvent(new Event("input"));
        await new Promise(r => setTimeout(r, 20));
        const headsHigh = [...host.querySelectorAll(".panel-bridge-section-head")].map(e => e.textContent);

        inst.destroy();
        return {
            nHeads: heads.length,
            hasSlider: !!slider,
            totalFine,
            rowsDefault,
            // every fine cluster appears in exactly one section
            accounts: rowsDefault === totalFine,
            headsHighOk: headsHigh.length === 2,
        };
    }''')
    assert out["nHeads"] == 2                 # Encapsulated + Bridges
    assert out["hasSlider"] is True
    assert out["totalFine"] >= 2
    assert out["accounts"] is True
    assert out["headsHighOk"] is True


@pytest.mark.slow
def test_multilevel_engine_real(page):
    """Real BFS-5000: the sweep's Phase-1 nested-worker distance fan-out runs
    inside the clustering worker, Phase-2 bootstraps fan out across workers,
    and a coarse→fine reproducible ladder lands."""
    out = page.evaluate(r'''async () => {
        const engine = await import("/app/src/ui/engine.js");
        const st = await import("/app/src/ui/state.js");
        await engine.recomputeMultiLevelSweep({
            params: { minSamples: 15, selectionMethod: "leaf" }, floor: 0.5,
            sizeGridCount: 16, bootstrapOpts: { B: 6, subsampleFrac: 0.6 },
            uidPrefix: "MLREAL",
        });
        const cands = (st.getState().multiLevelSweep.candidates || []);
        const picks = [...new Set(cands.map(c => c.count).sort((a,b)=>a-b))].slice(0, 3);
        engine.commitMultiLevelLayers(picks, { uidPrefix: "MLREAL" });
        const s = st.getState();
        const lv = s.clusterLevels || [];
        const counts = lv.map(l => l.clusterResult.clusters.length);
        let noNoise = true;
        for (const l of lv) for (let i = 0; i < l.clusterResult.nodeCluster.length; i++)
            if (l.clusterResult.nodeCluster[i] < 0) noNoise = false;
        return {
            n: s.genResult.nodes.length,
            nLevels: lv.length,
            counts,
            noNoise,
            allStable: lv.every(l => Number.isFinite(l.stability)),
            hasBridge: !!s.bridgeAnalysis,
        };
    }''')
    assert out["n"] == 5000
    assert out["nLevels"] >= 2
    assert out["noNoise"] is True
    assert out["counts"] == sorted(out["counts"])
    assert out["allStable"] is True
    assert out["hasBridge"] is True
