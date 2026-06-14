"""Tests for the eval surface — LHS sampler, target-range bootstrap,
bipartite-match minMembers filter, noiseHandling modes,
phase-2 cache hits, precomputedCr fast-path, sweepAgainst routing.

These are unique invariants not covered by test_optimise.py:
  - test_optimise.py exercises resolution-mode sweeps with the
    numClusters scorer (no bootstrap, fast).
  - this file exercises the target-range path, bootstrap-enabled
    scoring (B12 regression), the §6.18.7-9 protocol invariants,
    and the §6.18.3 cache wins.

Most tests need real-data state for meaningful coverage and are
marked @pytest.mark.slow. The bipartiteMatchJaccard / LHS unit
tests are pure JS and fast.

Migrated from scratch/{lhs_unit, target_range_bootstrap,
noise_and_min_members, cache_wins, sweep_against}_smoke.py.
"""

import pytest


def test_lhs_sampler_determinism_and_coverage(page):
    """sampleLatinHypercube produces the requested count, every numeric
    value is in-range, all schema fields are filled, log-scaled fields
    span orders of magnitude, the sample is deterministic across calls
    with the same seed, and different seeds produce different samples."""
    out = page.evaluate(
        '''async () => {
            const { sampleLatinHypercube } = await import("/app/src/eval/lhs.js");
            const reg = await import("/app/src/clustering-registry.js");
            const hdb = reg.getAlgorithm("hdbscan");

            const a = sampleLatinHypercube(hdb, 30, 42);
            const a2 = sampleLatinHypercube(hdb, 30, 42);   // same seed
            const b = sampleLatinHypercube(hdb, 30, 99);    // different seed

            const mcs = a.map(s => s.minClusterSize);
            const ms  = a.map(s => s.minSamples);
            const sel = a.map(s => s.selectionMethod);
            return {
                count: a.length,
                mcsMin:    Math.min(...mcs),
                mcsMax:    Math.max(...mcs),
                mcsRange:  Math.max(...mcs) / Math.min(...mcs),
                msMin:     Math.min(...ms),
                msMax:     Math.max(...ms),
                hasBothSelectionMethods: sel.includes("eom") && sel.includes("leaf"),
                deterministic:           JSON.stringify(a) === JSON.stringify(a2),
                differentSeedDiffers:    JSON.stringify(a) !== JSON.stringify(b),
            };
        }'''
    )
    assert out["count"] == 30
    assert out["mcsMin"] >= 2 and out["mcsMax"] <= 500
    # Log scale should span at least one order of magnitude across 30 samples.
    assert out["mcsRange"] >= 10
    assert out["msMin"] >= 1 and out["msMax"] <= 50
    assert out["hasBothSelectionMethods"]
    assert out["deterministic"] is True
    assert out["differentSeedDiffers"] is True


@pytest.mark.slow
def test_target_range_sweep_with_bootstrap(page):
    """Target-range sweep with runBootstrap=true populates per-row
    reproducibility values. Was a silent bug (B12 — refResult vs
    refClusterResult param mismatch) — every bootstrap call threw
    and all rows ended up with primary=-Inf. Regression check.

    Marked slow: B=5 bootstrap iters × HDBSCAN at n=5000 ≈ 30s × the
    Phase-1 + refine grid.
    """
    out = page.evaluate(
        '''async () => {
            const { runTargetRangeSweep } = await import("/app/src/eval/sweep.js");
            const reg = await import("/app/src/clustering-registry.js");
            const state = await import("/app/src/ui/state.js");
            const s = state.getState();
            const hdb = reg.getAlgorithm("hdbscan");
            const out = await runTargetRangeSweep({
                algorithms:   [hdb],
                genResult:    s.genResult,
                dimredResult: s.dimredResult,
                n:            s.genResult.nodes.length,
                targetMin:    20, targetMax: 60,    // wide enough to hit on BFS-5000
                phase1Count:  6,                    // small for test speed
                refineStep:   1,
                runBootstrap: true,
                bootstrapOpts:{ B: 5, subsampleFrac: 0.5, noiseHandling: "exclude" },
                seed: 42,
            });
            const top5 = out.ranked.slice(0, 5);
            return {
                phase1: out.phase1.length,
                phase2: out.phase2.length,
                hitCount: out.hitCount,
                topErrors: top5.map(r => r.error || null),
                topPrimaries: top5.map(r => Number.isFinite(r.primary) ? +r.primary.toFixed(3) : r.primary),
                anyHasMeanJaccard: top5.some(r => r.extra && Number.isFinite(r.extra.meanJaccard)),
            };
        }'''
    )
    # Sweep ran the requested phase-1 size.
    assert out["phase1"] == 6
    # No per-row errors (this is the actual bug regression).
    assert all(e is None for e in out["topErrors"]), f"per-row errors: {out['topErrors']}"
    # At least one row has a meaningful (positive, finite) primary score
    # — i.e. the bootstrap actually populated reproducibility, not
    # -Infinity from the silent failure.
    primaries = [p for p in out["topPrimaries"] if isinstance(p, (int, float))]
    assert any(p > 0 for p in primaries), f"no positive primary scores: {out['topPrimaries']}"
    assert out["anyHasMeanJaccard"] is True


def test_bipartite_match_min_members_filter(page):
    """§6.18.9 B9: bipartiteMatchJaccard({minMembers}) drops ref
    clusters smaller than the threshold from the match output entirely.
    Without it, a 1-member ref vs any singleton candidate would score
    Jaccard=1.0 mechanically — meaningless inflation. Pure JS unit test."""
    out = page.evaluate(
        '''async () => {
            const { bipartiteMatchJaccard } = await import("/app/src/eval/jaccard.js");
            // 10 nodes: refA={0}, refB={1,2}, refC={3..9} — sizes 1, 2, 7.
            const ref  = new Int32Array([0, 1,1, 2,2,2,2,2,2,2]);
            const cand = new Int32Array([0, 1,1, 2,2,2,2,2,2,2]);
            const noFilter   = bipartiteMatchJaccard(ref, cand);
            const withFilter = bipartiteMatchJaccard(ref, cand, null, { minMembers: 3 });
            return {
                noFilterKeys:   [...noFilter.keys()].sort(),
                withFilterKeys: [...withFilter.keys()].sort(),
            };
        }'''
    )
    assert out["noFilterKeys"]   == [0, 1, 2]
    assert out["withFilterKeys"] == [2]    # only refC (size 7) survives


@pytest.mark.slow
def test_noise_handling_modes(page):
    """§6.18.9 B8: bootstrap with noiseHandling ∈ {exclude, asCluster,
    penalise} produces the expected aggregate shapes against a
    hand-crafted 25%-noise reference clustering.

      - noiseFraction always reported (~0.25).
      - asCluster grows nClusters by 1 (synthetic NOISE_ID).
      - penalise: macro == raw × (1 − noiseFraction). raw exposed via
        meanJaccard_macro_raw; absent in exclude / asCluster modes.

    Slow: 6 bootstrap iters × HDBSCAN at n=5000 per mode × 3 modes."""
    out = page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const { bootstrapStability } = await import("/app/src/eval/bootstrap.js");
            const reg = await import("/app/src/clustering-registry.js");
            const s = state.getState();
            const n = s.genResult.nodes.length;
            const noiseCount = Math.floor(n / 4);
            const half = Math.floor(n / 2);
            const nc = new Int32Array(n);
            for (let i = 0; i < n; i++) {
                if (i < noiseCount) nc[i] = -1;
                else if (i < half) nc[i] = 0;
                else nc[i] = 1;
            }
            const fakeRef = {
                method: "synthetic", params: {},
                nodeCluster: nc,
                clusters: [
                    { id: 0, centre: [0,0,0], spread: 0, count: half - noiseCount, colour: "#888", stability: NaN },
                    { id: 1, centre: [0,0,0], spread: 0, count: n - half,          colour: "#888", stability: NaN },
                ],
                structureEdges: [],
            };
            const algo   = reg.getAlgorithm(s.clusterLevels[0].clusterResult.method);
            const params = s.clusterLevels[0].clusterResult.params;
            const common = {
                refClusterResult: fakeRef, genResult: s.genResult,
                dimredResult: s.dimredResult, algo, params,
                B: 4, seed: 11,
            };
            const rExclude   = await bootstrapStability({ ...common, noiseHandling: "exclude" });
            const rAsCluster = await bootstrapStability({ ...common, noiseHandling: "asCluster" });
            const rPenalise  = await bootstrapStability({ ...common, noiseHandling: "penalise" });
            return {
                excludeAgg:    rExclude.aggregate,
                asClusterAgg:  rAsCluster.aggregate,
                penaliseAgg:   rPenalise.aggregate,
            };
        }'''
    )
    # Noise fraction reported across all modes (~0.25).
    assert 0.24 < out["excludeAgg"]["noiseFraction"] < 0.26
    # asCluster grows nClusters by 1 (synthetic NOISE_ID).
    assert out["asClusterAgg"]["nClusters"] == out["excludeAgg"]["nClusters"] + 1
    # penalise: macro == raw × (1 − noiseFraction).
    p = out["penaliseAgg"]
    expected = p["meanJaccard_macro_raw"] * (1 - p["noiseFraction"])
    assert abs(p["meanJaccard_macro"] - expected) < 1e-9, \
        f"penalise: expected {expected:.4f}, got {p['meanJaccard_macro']:.4f}"
    # exclude doesn't carry the _raw fields.
    assert "meanJaccard_macro_raw" not in out["excludeAgg"]


@pytest.mark.slow
def test_target_range_phase2_cache_hits(page):
    """§6.18.3 A2: Phase-2 cache reuses Phase-1 outputs. Every Phase-1
    hit's base config recurs as a Phase-2 candidate (expandNeighbours
    always includes the base), so phase2CacheHits ≥ 1.

    Uses mutualKNN (fast) since this tests the cache mechanics, not
    the algorithm itself."""
    out = page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const { runTargetRangeSweep } = await import("/app/src/eval/sweep.js");
            const reg = await import("/app/src/clustering-registry.js");
            const s = state.getState();
            const algo = reg.getAlgorithm("mutualKNN");
            const result = await runTargetRangeSweep({
                algorithms:   [algo],
                genResult:    s.genResult,
                dimredResult: s.dimredResult,
                n:            s.genResult.nodes.length,
                targetMin:    3, targetMax: 50,    // wide; mutualKNN at n=5000 produces many ks
                phase1Count:  10,
                refineStep:   2,
                runBootstrap: false,
                seed: 7,
            });
            return {
                phase1Len:       result.phase1.length,
                hitCount:        result.hitCount,
                phase2Len:       result.phase2.length,
                phase2CacheHits: result.phase2CacheHits,
            };
        }'''
    )
    assert out["phase1Len"] == 10
    assert out["phase2CacheHits"] > 0,        "cache should fire at least once"
    assert out["phase2CacheHits"] <= out["phase2Len"]


@pytest.mark.slow
def test_recluster_with_precomputed_cr(page):
    """§6.18.3 A3: engine.recluster({precomputedCr}) skips the L0
    infer when (algoId, params) match the active config. Result is
    byte-identical to the cached cr; warm path is no slower than cold."""
    out = page.evaluate(
        '''async () => {
            const state  = await import("/app/src/ui/state.js");
            const engine = await import("/app/src/ui/engine.js");
            const s0 = state.getState();
            const cfg = s0.layerParams.clustering;
            const algoId = cfg.method;
            const params = cfg.levels[0].params;
            const cachedCr = s0.clusterLevels[0].clusterResult;
            const cachedNc = Array.from(cachedCr.nodeCluster);

            const t0 = performance.now();
            await engine.recluster();
            const coldMs = performance.now() - t0;
            const coldNc = Array.from(state.getState().clusterLevels[0].clusterResult.nodeCluster);

            const t2 = performance.now();
            await engine.recluster({
                precomputedCr: { algoId, params, cr: cachedCr },
            });
            const warmMs = performance.now() - t2;
            const warmNc = Array.from(state.getState().clusterLevels[0].clusterResult.nodeCluster);

            const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
            return {
                coldMs, warmMs,
                coldMatch: eq(coldNc, cachedNc),
                warmMatch: eq(warmNc, cachedNc),
            };
        }'''
    )
    # Determinism: warm with cached cr reproduces the cached cr exactly.
    assert out["warmMatch"] is True
    # Cold should also match (algorithm is deterministic given the same input).
    assert out["coldMatch"] is True
    # Warm path should not be slower than cold (small overhead tolerance
    # for the wrapping cascade machinery).
    assert out["warmMs"] <= out["coldMs"] + 200, \
        f"warm {out['warmMs']:.0f}ms should be ≤ cold {out['coldMs']:.0f}ms + 200ms"


@pytest.mark.slow
def test_sweep_against_both_passes(page):
    """§6.17 sweepAgainst='both': runTargetRangeSweep called twice
    (once on post-fusion, once on pre-fusion), merged into a single
    ranked table, each row tagged with .source ∈ {pre, post}.

    Tests the RUNNER side (not the modal UI). Injects a synthetic
    dimredResultPreFusion (perturbed copy of dimredResult) so the
    'both' code path has something to compare against."""
    out = page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const { runTargetRangeSweep } = await import("/app/src/eval/sweep.js");
            const reg = await import("/app/src/clustering-registry.js");
            const s = state.getState();
            // Synthesise a pre-fusion buffer (shifted copy of dimredResult).
            const preBuf = new Float32Array(s.dimredResult.data);
            for (let i = 0; i < preBuf.length; i++) preBuf[i] += 0.01;
            const dimredPre = { ...s.dimredResult, data: preBuf };
            const algo = reg.getAlgorithm("mutualKNN");
            const commonOpts = {
                algorithms:   [algo],
                genResult:    s.genResult,
                n:            s.genResult.nodes.length,
                targetMin:    3, targetMax: 50,
                phase1Count:  6,
                refineStep:   1,
                runBootstrap: false,
            };
            // Replicate optimise-tab.js's "both" logic: two sub-sweeps.
            const postOut = await runTargetRangeSweep({
                ...commonOpts, dimredResult: s.dimredResult, seed: 42,
            });
            const preOut = await runTargetRangeSweep({
                ...commonOpts, dimredResult: dimredPre, seed: 42 + 1009,
            });
            for (const r of postOut.ranked) r.source = "post";
            for (const r of preOut.ranked)  r.source = "pre";
            const merged = [...postOut.ranked, ...preOut.ranked];
            const sources = [...new Set(merged.map(r => r.source))].sort();
            return {
                postLen: postOut.ranked.length,
                preLen:  preOut.ranked.length,
                sources,
            };
        }'''
    )
    assert out["postLen"] > 0
    assert out["preLen"]  > 0
    assert out["sources"] == ["post", "pre"], \
        f"expected both pre + post tags, got {out['sources']}"
