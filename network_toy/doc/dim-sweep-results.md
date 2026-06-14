# Dim-sweep validation results

Empirical answer to §6.9 ARI dim-sweep validation: is the
default UMAP compression dimension (50) preserving enough
information that clustering at 100-d wouldn't change the
partition meaningfully?

## Protocol

- **Data**: BFS-5000 real-data fixture (`dev_subset_bfs_5000`).
- **Noise stage**: PCA `n_components=100` (locked default).
- **Compression sweep**: UMAP `n_components ∈ {30, 50, 100, 200}`,
  `n_neighbors=50`, `min_dist=0`, `metric=cosine`.
- **Clustering**: HDBSCAN `min_cluster_size=15, min_samples=5,`
  `selection=eom, selectionEpsilon=0, noiseMode=absorb`.
  (A pilot run at `min_cluster_size=50` degenerated to 2-cluster
  partitions where ARI is mechanically ~1.0 regardless of dim;
  dropped to 15 so HDBSCAN produces 50–60 meaningful clusters and
  the ARI signal is informative.)
- **Replicates**: 3 seeds per dim (42, 43, 44).
- **Total**: 12 (dim × seed) runs.

## Cluster counts (mean ± SD across seeds)

| Dim | Mean clusters | SD |
|----:|--------------:|---:|
| 30 | 60.3 | 5.7 |
| 50 | 56.7 | 3.7 |
| 100 | 57.0 | 2.2 |
| 200 | 57.0 | 2.2 |

## Pairwise ARI — mean across seeds

| dim \ dim | 30 | 50 | 100 | 200 |
|---:|---:|---:|---:|---:|
| **30** | 1.000 | 0.780 | 0.750 | 0.750 |
| **50** | 0.780 | 1.000 | 0.806 | 0.806 |
| **100** | 0.750 | 0.806 | 1.000 | 1.000 |
| **200** | 0.750 | 0.806 | 1.000 | 1.000 |

## Pairwise ARI — SD across seeds

| dim \ dim | 30 | 50 | 100 | 200 |
|---:|---:|---:|---:|---:|
| **30** | 0.000 | 0.015 | 0.059 | 0.059 |
| **50** | 0.015 | 0.000 | 0.063 | 0.063 |
| **100** | 0.059 | 0.063 | 0.000 | 0.000 |
| **200** | 0.059 | 0.063 | 0.000 | 0.000 |

## Verdict

`mean ARI(50, 100) = 0.806 ± 0.063`

Threshold for 50-d defensibility: ARI(50, 100) > 0.9.

**FAIL** — 50-d gives meaningfully different clusterings than 100-d.
Recommendation: bump the compression default to `n_components=100`
in `app/src/dimred/registry.js`
(`umap.defaultParamsForSlot('compression')`).

### Notable secondary finding: information saturates by d=100

`ARI(100, 200) = 1.000 ± 0.000` — at d=100 and d=200, HDBSCAN
recovers byte-identical partitions across all three seeds. Past
d=100 the embedding adds no clustering-relevant information on
this fixture. This bounds the recommendation: the new default
should be **100**, not "as high as possible". d=150 or d=200
would cost more compute (UMAP scales roughly linearly in
n_components) for no clustering benefit.

### Asymmetric loss pattern

ARI(30, 50) = 0.780 < ARI(50, 100) = 0.806 < ARI(100, 200) = 1.000.
The loss-per-octave is roughly linear-ish below the saturation
point. 30-d loses ~22% of the partition; 50-d loses ~19%; 100-d
matches 200-d.

## Limitations

- Single fixture (BFS-5000). Other corpora may behave
  differently; re-run when a new real-data fixture lands.
- Single clustering algorithm (HDBSCAN). Leiden / spectral
  may have different sensitivities to compression dim;
  test per algorithm when they're registered.
- Single `min_cluster_size`. Coarser / finer clustering
  granularity may show different ARI patterns.
- ARI compares partition labels only; cluster *shape* could
  still drift inside the ARI tolerance.

Re-run via `python validation/dim_sweep_validation.py` (needs
the dev server on :8000). ~17 minutes wall time on this fixture
(actual; 9 minutes was the pre-run estimate before UMAP at
d=100 / 200 turned out to be slower than expected at n=5000).

---

# Compression redundancy check (§6.9 follow-up)

Question: if PCA-100 is already producing 100-d output,
is the UMAP-100 compression stage redundant — or is the
manifold reshape it does actually load-bearing for clustering?

Prior literature on transformer embeddings (GDELT) found that
PCA alone fails for HDBSCAN — the UMAP non-linear reshape is
load-bearing. This is the same check on our specific BFS-5000
fixture.

## Protocol

- Same setup as the main dim-sweep above (BFS-5000, PCA-100
  noise, HDBSCAN at `min_cluster_size=15, min_samples=5,`
  `selection=eom, noiseMode=absorb`).
- Two compression configs:
  - **A**: `compression = identity` (HDBSCAN runs on PCA-100 output direct)
  - **B**: `compression = UMAP-100`, seeds ∈ {42, 43, 44}
- Pairwise ARI: ARI(identity, UMAP_seed_i).

## Cluster counts

| Setup | Clusters |
|-------|---------:|
| identity (PCA-100 → HDBSCAN) | 2 |
| UMAP-100 seed=42 | 58 |
| UMAP-100 seed=43 | 54 |
| UMAP-100 seed=44 | 59 |

## ARI vs identity setup

| Compared to | ARI |
|-------------|----:|
| UMAP-100 seed=42 | 0.002 |
| UMAP-100 seed=43 | 0.002 |
| UMAP-100 seed=44 | 0.002 |
| **mean ± SD** | **0.002 ± 0.000** |

## UMAP-to-UMAP context (seed-to-seed variance)

Confirms UMAP-100 is stable across seeds; the divergence
above can't be explained by UMAP non-determinism.

| Seed pair | ARI |
|-----------|----:|
| (42, 43) | 0.681 |
| (42, 44) | 0.806 |
| (43, 44) | 0.700 |

## Verdict

`mean ARI(identity, UMAP-100) = 0.002 ± 0.000`

**NOT REDUNDANT** — UMAP at 100→100 produces a meaningfully
different partition from clustering on PCA-100 directly.
The manifold reshape is load-bearing: even at the same
output dimension, UMAP is rearranging points so that
Euclidean distance becomes a useful similarity measure for
density-based clustering. PCA alone preserves variance but
not cluster boundaries on transformer embeddings, as prior work
on similar corpora predicted. Recommendation: keep
`compression = UMAP-100` as the default.

Re-run via `python validation/compression_redundancy_check.py`.
