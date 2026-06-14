"""§6.9 ARI dim-sweep validation — empirical check that UMAP-50 isn't
losing information clustering needs.

The question being answered:
  At the default compression dim (UMAP-50), is the dim-reduction
  throwing away enough information to change the clustering
  meaningfully? If clustering at UMAP-50 vs UMAP-100 gives nearly
  identical partitions (ARI > 0.9), 50-d is a defensible default.

Protocol (locked 2026-05-25):
- Real-data BFS-5000 fixture.
- Noise stage: PCA n_components=100 (locked default).
- Compression sweep: UMAP n_components ∈ {30, 50, 100, 200}.
- Clustering: HDBSCAN with min_cluster_size=50 (the locked-default
  value of 100 was tuned for 810k papers; at n=5000 that's 2% of n
  and degenerates toward a handful of mega-clusters which makes
  pairwise ARI uninformative). min_samples=10, selection=eom,
  selectionEpsilon=0, noiseMode=absorb.
- 3 seeds per dim (42, 43, 44) to absorb stochastic UMAP variance.
- 4 × 3 = 12 sweep runs.
- Pairwise ARI matrix per seed; report mean + SD across seeds.
- Verdict on mean(ARI(50, 100)) > 0.9 per plan threshold.

NOTE on the no-real-data-in-tests memory rule: this is a
research-validation run, not a regression smoke. The rule applies
to test contamination via heavy fixtures; here real data is the
explicit purpose of the validation (the toy data is 3-d already so
the dim-sweep is meaningless on it).

Output:
- stdout summary
- doc/dim-sweep-results.md (table + verdict)

Cost: ~45s per (dim, seed). Total ~9 minutes wall.
Reingest happens once; subsequent iterations just re-run redimred
(which cascades into recluster automatically).

Run from project root after starting the dev server on :8000:
    python -m http.server 8000 &
    python validation/dim_sweep_validation.py
"""

from playwright.sync_api import sync_playwright
import json
import statistics
from pathlib import Path

URL = "http://localhost:8000/app/"
KNOWN_FG_TEARDOWN = "Cannot read properties of undefined (reading 'tick')"

DIMS  = [30, 50, 100, 200]
SEEDS = [42, 43, 44]

# HDBSCAN params for n=5000 dim-sweep.
# minClusterSize=50 produced 2-cluster degenerate partitions on a
# first pilot run — ARI between two trivial partitions is mechanically
# ~1.0 regardless of dim, so the sweep is uninformative.
# Drop to 15 + minSamples=5 to push HDBSCAN into producing 5-40
# meaningful clusters. (Per audit note: 5-20 is "fine clusters" at
# n≈400; we want comparable granularity here.)
HDBSCAN_PARAMS = {
    "minSamples":       5,
    "minClusterSize":   15,
    "selectionMethod":  "eom",
    "selectionEpsilon": 0,
    "noiseMode":        "absorb",
}


def boot_and_load_real(page):
    """Boot the app, switch to real mode + BFS-5000 fixture, await ingest."""
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    print("→ switching to BFS-5000 real fixture (~30 MB; one-shot fetch)")
    page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const engine = await import("/app/src/ui/engine.js");
            const cur = state.getState();
            state.update({
                // reingest() dispatches on activeAlgorithm.dataSource —
                // NOT dataSource.mode (which mirrors it for legacy
                // read paths). Both need to be set to switch sources.
                activeAlgorithm: {
                    ...cur.activeAlgorithm,
                    dataSource: "real",
                },
                dataSource: {
                    ...cur.dataSource,
                    mode: "real",
                    configs: {
                        ...cur.dataSource.configs,
                        real: { subset: "dev_subset_bfs_5000" },
                    },
                },
                // Pre-seed dimred with the locked default noise stage
                // (PCA-100). compression will be overwritten per dim;
                // viz / viz2d stay identity (not needed for the test).
                layerParams: {
                    ...cur.layerParams,
                    dimred: {
                        noise:       { method: "pca",      params: { n_components: 100 } },
                        fusion:      { method: "identity", params: {} },
                        compression: { method: "identity", params: {} },
                        viz:         { method: "identity", params: {} },
                        viz2d:       { method: "identity", params: {} },
                    },
                },
            });
            await engine.reingest();
        }'''
    )
    n = page.evaluate(
        '''async () => {
            const s = (await import("/app/src/ui/state.js")).getState();
            return s.genResult && s.genResult.nodes.length;
        }'''
    )
    print(f"  loaded n={n} papers")
    assert n == 5000, f"expected BFS-5000 fixture (5000 papers), got n={n}"


def run_one(page, dim, seed):
    """Set compression to UMAP-D + clustering to locked HDBSCAN, run
    redimred (which cascades to recluster), return (nodeCluster, nClusters)."""
    out = page.evaluate(
        '''async ({ dim, seed, hdbscanParams }) => {
            const state = await import("/app/src/ui/state.js");
            const engine = await import("/app/src/ui/engine.js");
            const cur = state.getState();
            // Generate a uid for the single L0 level so engine doesn't
            // complain about the levels array shape.
            const uid = Math.random().toString(36).slice(2, 10);
            state.update({
                layerParams: {
                    ...cur.layerParams,
                    dimred: {
                        ...cur.layerParams.dimred,
                        compression: {
                            method: "umap",
                            params: {
                                n_components:  dim,
                                n_neighbors:   50,
                                min_dist:      0,
                                metric:        "cosine",
                                random_state:  seed,
                            },
                        },
                    },
                    clustering: {
                        method: "hdbscan",
                        levels: [{ uid, params: hdbscanParams, scope: "global" }],
                    },
                },
            });
            await engine.redimred();   // cascades into recluster()
            const s = state.getState();
            const cr = s.clusterLevels && s.clusterLevels[0] && s.clusterLevels[0].clusterResult;
            return {
                nodeCluster: cr ? Array.from(cr.nodeCluster) : null,
                nClusters:   cr ? cr.clusters.length : 0,
            };
        }''',
        { "dim": dim, "seed": seed, "hdbscanParams": HDBSCAN_PARAMS }
    )
    return out["nodeCluster"], out["nClusters"]


def ari_via_app(page, a, b):
    """Compute adjusted Rand index using the app's adjustedRandIndex
    function so we use the same implementation the eval surface does."""
    return page.evaluate(
        '''async ({ a, b }) => {
            const { adjustedRandIndex } = await import("/app/src/eval/ari.js");
            const arrA = new Int32Array(a);
            const arrB = new Int32Array(b);
            return adjustedRandIndex(arrA, arrB);
        }''',
        { "a": a, "b": b }
    )


def fmt(v, decimals=3):
    if v is None or (isinstance(v, float) and (v != v)):
        return "—"
    return f"{v:.{decimals}f}"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        # Long timeouts — UMAP at n=5000 d=100 → 200 can take 30-60s
        # per fit, and we run 12 of them.
        ctx = b.new_context(viewport={"width": 1400, "height": 900})
        ctx.set_default_timeout(120_000)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}")
                if m.type == "error" else None)

        boot_and_load_real(page)
        relevant = [e for e in errors if KNOWN_FG_TEARDOWN not in e]
        assert not relevant, f"boot errors: {relevant}"

        # ── Sweep ──
        # partitions[seed][dim] = (nodeCluster, nClusters)
        partitions = {seed: {} for seed in SEEDS}
        import time
        for seed in SEEDS:
            for dim in DIMS:
                t0 = time.time()
                print(f"→ dim={dim:3d} seed={seed} … ", end="", flush=True)
                nc, k = run_one(page, dim, seed)
                dt = time.time() - t0
                print(f"{k} clusters · {dt:.1f}s")
                if nc is None:
                    print(f"  ! clustering produced no result; aborting sweep")
                    return
                partitions[seed][dim] = (nc, k)

        # ── Pairwise ARI per seed, then mean + SD across seeds ──
        # ari_per_seed[seed] = {(d1, d2): ari}
        # Compute ARI for d1 <= d2 (symmetric); ARI(d, d) = 1.0.
        ari_per_seed = {}
        for seed in SEEDS:
            mat = {}
            for i, d1 in enumerate(DIMS):
                for d2 in DIMS[i:]:
                    if d1 == d2:
                        mat[(d1, d2)] = 1.0
                    else:
                        mat[(d1, d2)] = ari_via_app(page, partitions[seed][d1][0], partitions[seed][d2][0])
                        mat[(d2, d1)] = mat[(d1, d2)]
            ari_per_seed[seed] = mat

        # Mean ± SD across seeds for each (d1, d2).
        mean_ari = {}
        sd_ari   = {}
        for d1 in DIMS:
            for d2 in DIMS:
                vals = [ari_per_seed[s][(d1, d2)] for s in SEEDS]
                mean_ari[(d1, d2)] = statistics.mean(vals)
                sd_ari[(d1, d2)]   = statistics.pstdev(vals)

        # Cluster counts per dim, mean ± SD across seeds.
        count_stats = {}
        for d in DIMS:
            counts = [partitions[s][d][1] for s in SEEDS]
            count_stats[d] = (statistics.mean(counts), statistics.pstdev(counts))

        # ── Report ──
        print()
        print("Cluster counts (mean ± SD across seeds):")
        for d in DIMS:
            m, sd = count_stats[d]
            print(f"  dim={d:3d}: {m:5.1f} ± {sd:.1f}")

        print()
        print("Mean pairwise ARI matrix:")
        header = "       " + " ".join(f"{d:>8d}" for d in DIMS)
        print(header)
        for d1 in DIMS:
            row = f"  {d1:3d}: " + " ".join(fmt(mean_ari[(d1, d2)]) + " " for d2 in DIMS)
            print(row)

        print()
        print("SD across seeds:")
        print(header)
        for d1 in DIMS:
            row = f"  {d1:3d}: " + " ".join(fmt(sd_ari[(d1, d2)]) + " " for d2 in DIMS)
            print(row)

        verdict_pair = (50, 100)
        m_50_100 = mean_ari[verdict_pair]
        sd_50_100 = sd_ari[verdict_pair]
        threshold = 0.9
        defensible = m_50_100 > threshold
        print()
        print(f"VERDICT — mean ARI(50, 100) = {m_50_100:.3f} ± {sd_50_100:.3f}")
        print(f"          threshold {threshold:.2f} for 50-d defensibility:",
              "PASS" if defensible else "FAIL")
        if not defensible:
            print(f"          recommendation: bump compression default to 100-d")

        # ── Write results doc ──
        results_md = render_results_md(mean_ari, sd_ari, count_stats, m_50_100,
                                        sd_50_100, defensible)
        out_path = Path("doc/dim-sweep-results.md")
        out_path.write_text(results_md)
        print()
        print(f"→ wrote {out_path}")

        b.close()


def render_results_md(mean_ari, sd_ari, count_stats, m_50_100, sd_50_100, defensible):
    lines = []
    lines.append("# Dim-sweep validation results")
    lines.append("")
    lines.append("Empirical answer to §6.9 ARI dim-sweep validation: is the")
    lines.append("default UMAP compression dimension (50) preserving enough")
    lines.append("information that clustering at 100-d wouldn't change the")
    lines.append("partition meaningfully?")
    lines.append("")
    lines.append("## Protocol")
    lines.append("")
    lines.append("- **Data**: BFS-5000 real-data fixture (`dev_subset_bfs_5000`).")
    lines.append("- **Noise stage**: PCA `n_components=100` (locked default).")
    lines.append(f"- **Compression sweep**: UMAP `n_components ∈ {{{', '.join(str(d) for d in DIMS)}}}`,")
    lines.append("  `n_neighbors=50`, `min_dist=0`, `metric=cosine`.")
    hdb_str = ", ".join(f"{k}={v}" for k, v in HDBSCAN_PARAMS.items())
    lines.append(f"- **Clustering**: HDBSCAN `{hdb_str}`.")
    lines.append("- **Replicates**: 3 seeds per dim (42, 43, 44).")
    lines.append("- **Total**: 12 (dim × seed) runs.")
    lines.append("")
    lines.append("## Cluster counts (mean ± SD across seeds)")
    lines.append("")
    lines.append("| Dim | Mean clusters | SD |")
    lines.append("|----:|--------------:|---:|")
    for d in DIMS:
        m, sd = count_stats[d]
        lines.append(f"| {d} | {m:.1f} | {sd:.1f} |")
    lines.append("")
    lines.append("## Pairwise ARI — mean across seeds")
    lines.append("")
    header_cells = " | ".join(f"{d}" for d in DIMS)
    lines.append(f"| dim \\ dim | {header_cells} |")
    lines.append("|---:|" + "---:|" * len(DIMS))
    for d1 in DIMS:
        cells = " | ".join(f"{mean_ari[(d1, d2)]:.3f}" for d2 in DIMS)
        lines.append(f"| **{d1}** | {cells} |")
    lines.append("")
    lines.append("## Pairwise ARI — SD across seeds")
    lines.append("")
    lines.append(f"| dim \\ dim | {header_cells} |")
    lines.append("|---:|" + "---:|" * len(DIMS))
    for d1 in DIMS:
        cells = " | ".join(f"{sd_ari[(d1, d2)]:.3f}" for d2 in DIMS)
        lines.append(f"| **{d1}** | {cells} |")
    lines.append("")
    lines.append("## Verdict")
    lines.append("")
    lines.append(f"`mean ARI(50, 100) = {m_50_100:.3f} ± {sd_50_100:.3f}`")
    lines.append("")
    lines.append(f"Threshold for 50-d defensibility: ARI(50, 100) > 0.9.")
    lines.append("")
    if defensible:
        lines.append(f"**PASS** — 50-d preserves clustering structure. The locked")
        lines.append(f"default of `n_components=50` for the compression slot is")
        lines.append(f"empirically defensible on this fixture.")
    else:
        lines.append(f"**FAIL** — 50-d gives meaningfully different clusterings")
        lines.append(f"than 100-d. Recommendation: bump the compression default to")
        lines.append(f"`n_components=100` in `app/src/dimred/registry.js`")
        lines.append(f"(`umap.defaultParamsForSlot('compression')`).")
    lines.append("")
    lines.append("## Limitations")
    lines.append("")
    lines.append("- Single fixture (BFS-5000). Other corpora may behave")
    lines.append("  differently; re-run when a new real-data fixture lands.")
    lines.append("- Single clustering algorithm (HDBSCAN). Leiden / spectral")
    lines.append("  may have different sensitivities to compression dim;")
    lines.append("  test per algorithm when they're registered.")
    lines.append("- Single `min_cluster_size`. Coarser / finer clustering")
    lines.append("  granularity may show different ARI patterns.")
    lines.append("- ARI compares partition labels only; cluster *shape* could")
    lines.append("  still drift inside the ARI tolerance.")
    lines.append("")
    lines.append("Re-run via `python validation/dim_sweep_validation.py` (needs")
    lines.append("the dev server on :8000). ~9 minutes wall time.")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
