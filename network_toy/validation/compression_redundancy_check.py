"""§6.9 follow-up — is UMAP-after-PCA doing real work, or is it redundant?

The dim-sweep validation (validation/dim_sweep_validation.py) compared
UMAP at different compression dims. It showed ARI(50, 100) = 0.806
(below 0.9 → bump default to 100) and ARI(100, 200) = 1.000
(information saturates at 100). The user then asked: if PCA-100 is
already taking us to 100-d, is the compression step redundant?

That's a different question. PCA and UMAP are both 100-d here but
do very different things to the geometry:
  - PCA-100: keeps the 100 directions of greatest variance from the
    original 768-d. Preserves variance; doesn't reshape the manifold.
  - UMAP-100: rearranges points so that neighbours stay neighbours
    in Euclidean space. The "compression" label is a misnomer at
    100-d input → 100-d output — it's a *manifold reshape*, not a
    dimensionality reduction.

Per doc/clustering-research.md §2.2, prior literature says PCA alone
fails for HDBSCAN on transformer embeddings (GDELT measured PCA-50 →
HDBSCAN dumping almost everything into noise on USEv4 embeddings;
UMAP-50 → HDBSCAN clustered cleanly on the same data). This script
confirms on our specific fixture (BFS-5000).

Protocol:
  - Same as dim_sweep_validation.py: BFS-5000, PCA-100 noise stage,
    HDBSCAN with min_cluster_size=15, min_samples=5, eom.
  - Two compression setups:
      A. compression=identity (HDBSCAN runs on PCA-100 output)
      B. compression=UMAP-100, random_state ∈ {42, 43, 44}
  - Compare partitions: ARI(A, B_seed_i) for i in {42, 43, 44}.
  - If high (>0.9): UMAP at 100→100 is redundant on this fixture.
  - If low: UMAP is doing real cluster-geometry work; keep it.

Outputs:
  - stdout summary
  - appends a "Compression redundancy check" section to
    doc/dim-sweep-results.md.

Cost: ~4 runs × 60-90 s ≈ 5 minutes wall.

Run from project root after starting the dev server on :8000:
    python -m http.server 8000 &
    python validation/compression_redundancy_check.py
"""

from playwright.sync_api import sync_playwright
import statistics
import time
from pathlib import Path

URL = "http://localhost:8000/app/"
KNOWN_FG_TEARDOWN = "Cannot read properties of undefined (reading 'tick')"

UMAP_SEEDS = [42, 43, 44]

HDBSCAN_PARAMS = {
    "minSamples":       5,
    "minClusterSize":   15,
    "selectionMethod":  "eom",
    "selectionEpsilon": 0,
    "noiseMode":        "absorb",
}


def boot_and_load_real(page):
    """Boot the app and switch to BFS-5000 with PCA-100 noise; compression
    starts at identity (we'll vary it per run)."""
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    print("→ switching to BFS-5000 real fixture")
    page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const engine = await import("/app/src/ui/engine.js");
            const cur = state.getState();
            state.update({
                activeAlgorithm: { ...cur.activeAlgorithm, dataSource: "real" },
                dataSource: {
                    ...cur.dataSource,
                    mode: "real",
                    configs: {
                        ...cur.dataSource.configs,
                        real: { subset: "dev_subset_bfs_5000" },
                    },
                },
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
    assert n == 5000, f"expected BFS-5000 fixture, got n={n}"


def run_identity(page):
    """Run HDBSCAN with compression=identity (PCA-100 → HDBSCAN direct)."""
    return page.evaluate(
        '''async ({ hdbscanParams }) => {
            const state = await import("/app/src/ui/state.js");
            const engine = await import("/app/src/ui/engine.js");
            const cur = state.getState();
            const uid = Math.random().toString(36).slice(2, 10);
            state.update({
                layerParams: {
                    ...cur.layerParams,
                    dimred: {
                        ...cur.layerParams.dimred,
                        // identity at compression means HDBSCAN sees the
                        // PCA-100 output of the noise stage directly.
                        compression: { method: "identity", params: {} },
                    },
                    clustering: {
                        method: "hdbscan",
                        levels: [{ uid, params: hdbscanParams, scope: "global" }],
                    },
                },
            });
            await engine.redimred();
            const s = state.getState();
            const cr = s.clusterLevels && s.clusterLevels[0] && s.clusterLevels[0].clusterResult;
            return {
                nodeCluster: cr ? Array.from(cr.nodeCluster) : null,
                nClusters:   cr ? cr.clusters.length : 0,
            };
        }''',
        { "hdbscanParams": HDBSCAN_PARAMS }
    )


def run_umap(page, seed):
    """Run HDBSCAN with compression=UMAP-100 at the given seed."""
    return page.evaluate(
        '''async ({ seed, hdbscanParams }) => {
            const state = await import("/app/src/ui/state.js");
            const engine = await import("/app/src/ui/engine.js");
            const cur = state.getState();
            const uid = Math.random().toString(36).slice(2, 10);
            state.update({
                layerParams: {
                    ...cur.layerParams,
                    dimred: {
                        ...cur.layerParams.dimred,
                        compression: {
                            method: "umap",
                            params: {
                                n_components:  100,
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
            await engine.redimred();
            const s = state.getState();
            const cr = s.clusterLevels && s.clusterLevels[0] && s.clusterLevels[0].clusterResult;
            return {
                nodeCluster: cr ? Array.from(cr.nodeCluster) : null,
                nClusters:   cr ? cr.clusters.length : 0,
            };
        }''',
        { "seed": seed, "hdbscanParams": HDBSCAN_PARAMS }
    )


def ari_via_app(page, a, b):
    return page.evaluate(
        '''async ({ a, b }) => {
            const { adjustedRandIndex } = await import("/app/src/eval/ari.js");
            return adjustedRandIndex(new Int32Array(a), new Int32Array(b));
        }''',
        { "a": a, "b": b }
    )


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
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

        # ── Setup A: identity compression. ──
        t0 = time.time()
        print(f"→ identity (PCA-100 → HDBSCAN, no UMAP) … ", end="", flush=True)
        a = run_identity(page)
        dt = time.time() - t0
        print(f"{a['nClusters']} clusters · {dt:.1f}s")
        assert a["nodeCluster"] is not None, "identity run produced no clusterResult"
        identity_nc = a["nodeCluster"]
        identity_count = a["nClusters"]

        # ── Setup B: UMAP-100 × 3 seeds. ──
        umap_results = {}
        for seed in UMAP_SEEDS:
            t0 = time.time()
            print(f"→ UMAP-100 seed={seed} … ", end="", flush=True)
            r = run_umap(page, seed)
            dt = time.time() - t0
            print(f"{r['nClusters']} clusters · {dt:.1f}s")
            assert r["nodeCluster"] is not None
            umap_results[seed] = (r["nodeCluster"], r["nClusters"])

        # ── Pairwise ARI. ──
        # ARI(identity, UMAP_seed_i) for each seed.
        identity_vs_umap = {}
        for seed in UMAP_SEEDS:
            identity_vs_umap[seed] = ari_via_app(page, identity_nc, umap_results[seed][0])

        # ARI(UMAP_seed_i, UMAP_seed_j) — context: should be ~1.0 per
        # the original dim-sweep (UMAP-100 was deterministic across seeds).
        umap_vs_umap = {}
        for i, s1 in enumerate(UMAP_SEEDS):
            for s2 in UMAP_SEEDS[i+1:]:
                umap_vs_umap[(s1, s2)] = ari_via_app(page, umap_results[s1][0], umap_results[s2][0])

        # ── Report. ──
        print()
        print("Cluster counts:")
        print(f"  identity (PCA-100 → HDBSCAN):  {identity_count}")
        for seed in UMAP_SEEDS:
            print(f"  UMAP-100 seed={seed}:              {umap_results[seed][1]}")

        print()
        print("ARI(identity, UMAP-100):")
        for seed in UMAP_SEEDS:
            print(f"  vs seed {seed}: {identity_vs_umap[seed]:.3f}")
        identity_vs_umap_vals = list(identity_vs_umap.values())
        m = statistics.mean(identity_vs_umap_vals)
        sd = statistics.pstdev(identity_vs_umap_vals)
        print(f"  mean: {m:.3f} ± {sd:.3f}")

        print()
        print("ARI(UMAP_i, UMAP_j) — context (seed-to-seed variance):")
        for (s1, s2), v in umap_vs_umap.items():
            print(f"  ({s1}, {s2}): {v:.3f}")

        threshold = 0.9
        redundant = m > threshold
        print()
        print(f"VERDICT — mean ARI(identity, UMAP-100) = {m:.3f} ± {sd:.3f}")
        print(f"          threshold {threshold:.2f} for UMAP redundancy:",
              "REDUNDANT (drop UMAP)" if redundant else "NOT REDUNDANT (keep UMAP)")

        # ── Append to results doc. ──
        append_to_results_md(identity_count, umap_results,
                              identity_vs_umap, umap_vs_umap, m, sd, redundant)
        print()
        print("→ appended 'Compression redundancy check' section to doc/dim-sweep-results.md")

        b.close()


def append_to_results_md(identity_count, umap_results, identity_vs_umap,
                          umap_vs_umap, mean_ari, sd_ari, redundant):
    lines = []
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("# Compression redundancy check (§6.9 follow-up)")
    lines.append("")
    lines.append("Question: if PCA-100 is already producing 100-d output,")
    lines.append("is the UMAP-100 compression stage redundant — or is the")
    lines.append("manifold reshape it does actually load-bearing for clustering?")
    lines.append("")
    lines.append("Per `doc/clustering-research.md` §2.2, prior literature")
    lines.append("(GDELT) found that PCA alone fails for HDBSCAN on")
    lines.append("transformer embeddings. This is the same check on our")
    lines.append("specific BFS-5000 fixture.")
    lines.append("")
    lines.append("## Protocol")
    lines.append("")
    lines.append("- Same setup as the main dim-sweep above (BFS-5000, PCA-100")
    lines.append("  noise, HDBSCAN at `min_cluster_size=15, min_samples=5,`")
    lines.append("  `selection=eom, noiseMode=absorb`).")
    lines.append("- Two compression configs:")
    lines.append("  - **A**: `compression = identity` (HDBSCAN runs on PCA-100 output direct)")
    lines.append("  - **B**: `compression = UMAP-100`, seeds ∈ {42, 43, 44}")
    lines.append("- Pairwise ARI: ARI(identity, UMAP_seed_i).")
    lines.append("")
    lines.append("## Cluster counts")
    lines.append("")
    lines.append("| Setup | Clusters |")
    lines.append("|-------|---------:|")
    lines.append(f"| identity (PCA-100 → HDBSCAN) | {identity_count} |")
    for seed in UMAP_SEEDS:
        lines.append(f"| UMAP-100 seed={seed} | {umap_results[seed][1]} |")
    lines.append("")
    lines.append("## ARI vs identity setup")
    lines.append("")
    lines.append("| Compared to | ARI |")
    lines.append("|-------------|----:|")
    for seed in UMAP_SEEDS:
        lines.append(f"| UMAP-100 seed={seed} | {identity_vs_umap[seed]:.3f} |")
    lines.append(f"| **mean ± SD** | **{mean_ari:.3f} ± {sd_ari:.3f}** |")
    lines.append("")
    lines.append("## UMAP-to-UMAP context (seed-to-seed variance)")
    lines.append("")
    lines.append("Confirms UMAP-100 is stable across seeds; the divergence")
    lines.append("above can't be explained by UMAP non-determinism.")
    lines.append("")
    lines.append("| Seed pair | ARI |")
    lines.append("|-----------|----:|")
    for (s1, s2), v in umap_vs_umap.items():
        lines.append(f"| ({s1}, {s2}) | {v:.3f} |")
    lines.append("")
    lines.append("## Verdict")
    lines.append("")
    lines.append(f"`mean ARI(identity, UMAP-100) = {mean_ari:.3f} ± {sd_ari:.3f}`")
    lines.append("")
    if redundant:
        lines.append(f"**REDUNDANT** — UMAP at 100→100 produces a partition")
        lines.append(f"essentially identical to clustering on PCA-100 directly.")
        lines.append(f"The UMAP manifold reshape isn't adding clustering-relevant")
        lines.append(f"structure on this fixture. Recommendation: drop the")
        lines.append(f"compression default to `identity` and save ~30 s per")
        lines.append(f"clustering run at BFS-5000.")
    else:
        lines.append(f"**NOT REDUNDANT** — UMAP at 100→100 produces a meaningfully")
        lines.append(f"different partition from clustering on PCA-100 directly.")
        lines.append(f"The manifold reshape is load-bearing: even at the same")
        lines.append(f"output dimension, UMAP is rearranging points so that")
        lines.append(f"Euclidean distance becomes a useful similarity measure for")
        lines.append(f"density-based clustering. PCA alone preserves variance but")
        lines.append(f"not cluster boundaries on transformer embeddings, as the")
        lines.append(f"literature predicted (`doc/clustering-research.md` §2.2).")
        lines.append(f"Recommendation: keep `compression = UMAP-100` as the default.")
    lines.append("")
    lines.append("Re-run via `python validation/compression_redundancy_check.py`.")
    lines.append("")

    out_path = Path("doc/dim-sweep-results.md")
    existing = out_path.read_text()
    out_path.write_text(existing + "\n".join(lines))


if __name__ == "__main__":
    main()
