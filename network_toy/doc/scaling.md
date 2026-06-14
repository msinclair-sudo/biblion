# Scaling — toy at n ≈ 400 vs real data at n = 810k

The toy is a methods sandbox. It runs comfortably at `n = 100–400`
nodes and ~2,500 citations. The real target (in
`literture-network/`) is:

| Quantity                                | Count    |
|-----------------------------------------|----------|
| Citation-graph nodes (raw, incl. stubs) | 2.23 M   |
| Citation-graph nodes with proper IDs    | 1.94 M   |
| **Embedded papers** (SPECTER2 768-d, the basePos analogue) | **810 k** |
| Raw citation edges (S2 + CrossRef)      | 7.95 M   |
| Hybrid edges (citation + semantic, α=0.5) | 5.64 M |
| **Hybrid edges, both endpoints embedded** | **1.82 M** |

The relevant `n` for the toy → real port is **810 k embedded papers
and 1.82 M filtered hybrid edges** — i.e., the subset where both
endpoints have a SPECTER2 embedding (so basePos exists) and a
hybrid edge survives the filter. That's the input the toy's layer
modules would actually consume.

Several toy implementations have `O(n²)` terms that are catastrophic
at that scale. This document is the bridge: which layers scale,
which don't, what the cliffs are, and what trade-offs each
alternative pays.

The structure mirrors `doc/dynamics.md`: one section per pipeline
layer, plus cross-cutting concerns (storage, determinism, what
carries over).

If a per-layer doc disagrees with this one about scaling, this
document wins — the per-layer docs describe the toy implementation
and may flag scaling concerns in passing, but the trade-off
discussion lives here.

---

## 1. Big picture

The toy's core insight is **two precomputed topologies blended
deterministically per frame** (`doc/blend.md` §4). That insight
scales. What doesn't scale is several of the **production
machinery** choices around it — primarily the explicit
materialisation of `n × n` matrices.

Per-layer summary, with the binding cost called out:

| Layer | Toy cost                          | At n=810k          | Verdict                             |
|-------|-----------------------------------|--------------------|-------------------------------------|
| 1 — generation         | `O(n)`                  | trivial             | N/A — SPECTER2 embeddings already exist |
| 2 — clustering         | `O(n²)` time + memory   | 656 GB matrix       | needs replacement (real pipeline already uses Leiden) |
| 3 — citation gen       | `O(n²)` enumeration     | 328 G enumerations  | not needed — citgraphv2 already observes 7.95 M edges |
| 4a — FR layout         | `O(iters · n²)`         | 131 T ops/run       | needs Barnes–Hut or replacement     |
| 4b — MDS layout        | per-component `O(iters · m²)` + `O(m²)` matrix | infeasible if one giant component | needs landmark / pivot variants  |
| 5a — alignment         | `O(N + |E|)` + per-component math | sub-second   | scales as-is                        |
| 5b — per-frame blend   | `O(n)` per frame        | 49 M lerps/s @ 60fps | scales as-is                        |

The two layers that scale unchanged (5a + 5b) are the most
*unique* parts of the toy. The expensive layers (2 + 4) are
well-studied — the alternatives at scale are off-the-shelf.

---

## 2. Per-layer detail

### 2.1 Generation (Layer 1)

**Not applicable at scale.** Real data exists; sampling from a
Gaussian mixture is a toy artefact for producing controlled
synthetic data with known ground-truth labels.

What carries over conceptually:

- **`basePos` is the semantic ground truth** for the α=0 endpoint.
  In the real data this is whatever embedding represents node
  positions — a learned doc2vec / SciNCL / specter embedding,
  citation-network spectral coordinates, etc. The blend's invariant
  ("at α=0 we see the embedding, at α=1 we see the citation
  topology") only requires that some basePos exists per node; how
  it's produced is upstream of this codebase.
- **`originId` is generator-only** and has no real-data analogue.
  Replaced by whatever metadata the real corpus carries (venue,
  topic, year, author) — but those are *features*, not ground-truth
  cluster labels. There is no ground truth at scale; cluster
  evaluation has to use unsupervised metrics or external benchmarks.

This means **the cluster-sweep ARI metric** (`app/src/eval/ari.js`,
ranks against `originId`) does not transfer. The layout sweep's
`alignmentCorrelation` metric does (it has no ground-truth
dependency).

### 2.2 Clustering (Layer 2)

Both toy algorithms (`mutualKNN`, `hdbscan`) materialise an `n × n`
distance matrix. At `n = 810k`:

```
n × n × 8 bytes  =  640 GB
```

Infeasible. The cluster contract itself (`doc/clustering.md` §1) has
no scale dependency and survives unchanged.

**Trade-off space at scale**, from minimum-disruption to
maximum-disruption:

#### Option A: ANN-backed k-NN graph + density methods on the graph

Build a sparse k-NN graph (`k ≈ 30–100`) using an approximate
nearest-neighbour library (FAISS, hnswlib, ScaNN) in
`O(n log n)`-ish time and `O(n · k)` memory. Then:

- Run **HDBSCAN-on-MST-of-the-k-NN-graph** instead of the full
  pairwise MST. This is what `cuML`'s GPU HDBSCAN does internally,
  and what `hdbscan`'s `algorithm="boruvka_kdtree"` mode does.
  Carries the entire `doc/clustering.md` §4.2 algorithm forward —
  same condensed tree, same EOM extraction, same `selectionEpsilon`
  semantics — only the MST construction is different.
- Or run **mutual-k-NN clustering on the same graph**, mirroring
  the toy's `mutualKNN` algorithm. Even simpler.

**Trade-off**: the k-NN graph is approximate, so cluster boundaries
shift slightly between runs. The condensed-tree stability metric
becomes less precise (small-stability clusters may not survive
re-runs). Tolerable for visualisation; check if it matters for
downstream analysis.

#### Option B: graph-community methods

Treat the k-NN graph (or a sparser version) as a network and run
**Leiden** or **Louvain** for community detection. These are
modularity-based, not density-based, so the contract's `stability`
field becomes `NaN` for every cluster (already supported via
`Number.isFinite` guards in consumers per `doc/clustering.md` §1).

**Trade-off**: no density theory — clusters are "modules" in the
sense of the modularity objective, not "high-density regions
separated by valleys." For citation networks this is often the
*better* model since citation graphs have community structure that
position-only clustering misses. For position-only data it's a
mismatch.

Leiden is `O(n log n)` empirically; works on graphs with billions
of edges.

#### Option C: GPU HDBSCAN

`RAPIDS cuML.HDBSCAN` keeps the algorithm verbatim, just on GPU.
Practical up to `n ≈ 1M` on a single A100. Same contract, same
parameters, same failure modes — just faster.

**Trade-off**: needs a GPU. The toy's `noiseMode = absorb |
singletons` semantics carry over directly.

#### Option D: hierarchical decomposition

If the data has an obvious top-level partition (e.g., disjoint
sub-corpora), cluster each piece independently and concatenate. The
cluster contract supports this trivially — IDs are contiguous from
0 globally, so the wrapper just renumbers per piece.

**What does NOT carry**: the toy's "Find best params" sweep
(`app/src/eval/sweep.js`) re-runs the full clustering pipeline per
parameter combination. At scale this is `(num_params) ×
(clustering_cost)` — multiply a 30-minute run by 100 combinations
and you have a 50-hour sweep. Sweep tooling at scale needs
subsampling: pick a representative subset (`~50k`?) and tune on
that.

### 2.3 Citation generation (Layer 3)

**Skip this layer entirely at scale.** Real citations are observed,
not generated. The four-stage taste-network model (`doc/citations.md`
§4.1) is a *generative* model — its purpose was to produce
controlled synthetic citation graphs for testing the rest of the
pipeline.

What carries over conceptually (the *vocabulary*, not the code):

- **Intra-cluster vs cross-cluster** is a useful frame for analysing
  observed citation patterns. "What fraction of observed citations
  are intra-cluster under our cluster assignment?" is a meaningful
  metric — and one that depends on cluster quality, so it's a way
  to back-validate clustering choices.
- **Per-cluster taste** can be reframed as an *observed* statistic:
  for each cluster `c`, `T_observed(c)` is the empirical
  distribution of cited cluster IDs. Useful for sanity checks
  (e.g., does cluster X actually cite cluster Y as much as the
  embedding similarity would suggest?).
- **Triangle transitivity** is observable directly (count completed
  triangles in the citation graph; compare to a null model).
- The `CitationResult` contract — `hasCit`, `inDeg`, `edges`,
  `citations`, `pools` — applies unchanged to *observed* citations,
  with one critical exception: `hasCit: Uint8Array(n²)` is `640 GB`
  at `n = 810k` and must be replaced. See §3.1 below.

**What does NOT carry**: the entire `app/src/citations/` +
`neighbourhoods.js` + `citation-taste.js` + `citations.js` chain.
At scale, citations come from a database / parquet / TSV file and
go directly into the sparse `CitationResult` representation.

### 2.4 Citation layout (Layer 4)

The two registered algorithms have very different scaling profiles.

#### 2.4.1 FR (`citation-layout/fr.js`)

`O(iterations · n²)` repulsion, dominated by all-pairs sum.

```
200 iters × (8×10⁵)²  =  1.28 × 10¹⁴ ops/run
```

Infeasible without optimisation. Options:

- **Barnes–Hut** (octree approximation of repulsion): `O(iters · n
  log n)`. Standard choice — `graph-tool`, `Gephi ForceAtlas2`,
  `igraph layout_fr` (via `BH3D` mode). At `n = 810k`: `200 · 810k ·
  20 ≈ 3.2 × 10⁹` ops, plausible on GPU, slow on CPU. Carries the
  toy's force formulation (k², attraction, time-axis anchor) verbatim;
  only the repulsion sum changes.
- **SGD-based force-directed layout** (Zheng, Pawar, Goodman 2018):
  `O(iters · |E|)` per pass with stochastic gradient descent on
  edge-stress. Much faster than Barnes–Hut on sparse graphs.
  `forceatlas2` Python implementations and `graph-tool` support
  this.
- **Drop FR entirely**: see MDS / spectral / UMAP below.

The time-axis radial anchor (`tBias` × `(1 − t)`) in the toy is
specific to the citation domain and not built into off-the-shelf
libraries. If keeping it matters, a fork of an existing Barnes–Hut
implementation is the smallest viable change.

#### 2.4.2 MDS (`citation-layout/mds.js`)

`O(iterations · m²)` per component plus `O(m · (m + |E_c|))` BFS,
where `m` is the largest component size.

For real citation networks, **expect a giant component**. The
`Microsoft Academic Graph` and `OpenCitations` follow standard
preferential-attachment statistics — typically 90%+ of nodes sit in
one giant component. So `m ≈ 700k` and:

```
m × m × 4 bytes   =   ~ 2 PB        (BFS distance matrix)
200 iters × m²    =   ~ 10¹⁴ ops
```

The full-MDS algorithm is just as infeasible as FR. Options:

- **Pivot MDS** (Brandes & Pich 2007): pick `p ≈ 50–500` pivot nodes,
  BFS from each (`O(p · (m + |E|))`), embed into `ℝᵖ` exactly, then
  project to ℝ³ via PCA. `O(p · m + p²)`. Carries the
  graph-distance-preservation idea verbatim, just with low-rank
  approximation. `O(p · m)` is tractable at any size.
- **Landmark MDS** (de Silva & Tenenbaum 2004): closely related;
  picks landmarks, computes their full distance sub-matrix, embeds
  the rest by triangulation.
- **Spectral layout**: low-eigenvectors of the graph Laplacian
  (`scipy.sparse.linalg.eigsh`). Linear-ish in `n` for sparse
  graphs. Preserves graph structure differently from MDS — captures
  large-scale topology rather than per-pair distances. The
  `1–2–3 chain ratio = 2.0` test (`doc/citation-layout.md` §2.1)
  doesn't pass exactly but the layout is qualitatively similar.
- **UMAP** (`umap-learn` with `metric='precomputed_nearest_neighbors'`
  on the citation graph). Linear-ish, GPU-supported via cuML, gives
  3D embeddings directly. Not "MDS" mathematically — it preserves
  topology rather than distances — but for visualisation purposes
  often produces what users expect.

**Implication for the registry pattern.** Adding pivot MDS / spectral
/ UMAP as new entries in `app/src/citation-layout/registry.js` is
the natural extension. Each conforms to the
`{ id, defaultParams, compute, modalSchema }` contract; the layout
sweep automatically crosses them once `sweepValues` is provided.

### 2.5 Alignment (Layer 5a)

`O(N + |E|)` for the union-find scan + per-component Kabsch
(Horn-quaternion → Jacobi over a 4×4 matrix → fixed cost per
component). Per-component math is `O(component_size)` for centroids
+ `O(1)` for the eigendecomp.

At `n = 810k`, `|E| = 1.82M`: roughly `2.6M` int ops + Jacobi over
each of (a few hundred?) connected components. **Sub-second wall
time at full scale, no algorithmic changes needed.**

The per-component pattern is the right abstraction at any scale —
it scales with *component count*, not `n`. Citation networks
typically have one giant component plus a long tail of small ones;
the alignment cost is dominated by the giant component's
`O(component_size)` pass, which is still linear.

**One caveat**: `Float32Array(n × 3)` for `aligned` and basePos at
`n = 810k` is `9.6 MB` each — fine. At `n = 10M` it would be
`120 MB` each — still fine but worth noting.

### 2.6 Per-frame blend (Layer 5b)

`O(n)` lerps per frame. At `n = 810k` and 60 fps:

```
810k lerps × 60 frames/s  =  48M lerps/s
```

Trivial in any modern runtime — JS, Python+numpy, native, GPU.

The endpoint-exactness, round-trip-exactness, and N-independence
properties (`doc/blend.md` §2.2) hold at any scale — these are
properties of linear interpolation, not of the toy's specific
implementation.

**Real-time interaction at full scale** is feasible: a slider drag
moves 810k points per frame at 60 fps, well within budget for both
CPU and GPU implementations. The d3-force-3d wrapper specifically
will not scale (its rendering is per-link in WebGL, and the lib's
internals were written for graphs in the 100s of nodes); a
WebGL/WebGPU re-render with instanced point primitives is the
expected path. None of that affects the **blend math**, which is
the reusable piece.

---

## 3. Cross-cutting concerns

### 3.1 Storage formats

Three toy data structures are O(n²) and must be replaced:

| Toy structure                       | Toy size @ n=810k | Replacement                               |
|-------------------------------------|-------------------|-------------------------------------------|
| `hasCit: Uint8Array(n²)`            | `640 GB`          | CSR, hash set on `i*n+j`, or sorted lists |
| HDBSCAN pairwise distance matrix    | `640 GB`          | sparse k-NN graph from ANN                |
| MDS per-component BFS distance matrix | `2 PB` worst case | pivot/landmark — never materialise full   |

The CitationResult contract documents `hasCit` as the canonical
membership query. At scale the contract should expose the *query*,
not the underlying representation:

```
contract:  has(i, j) → boolean      (was: hasCit[i*n+j] === 1)
```

Existing consumers (`citation-layout/`, `blend/align.js`,
`citations-debug.js`) all only need the query semantics, not the
flat array. A sparse-representation refactor is mechanical and
preserves the contract's surface area.

### 3.2 Determinism + seeds

`mulberry32` (and the Box–Muller wrapper in `rng.js`) are scale-
agnostic. The toy's invariant — same seed produces same output
byte-for-byte — carries forward to any scale, on any platform that
can implement an unsigned 32-bit multiply consistently.

The deterministic blend itself (round-trip α: 0 → 1 → 0 returns
basePos byte-identical) is **the most valuable pattern from the
toy** and one of the few that scales linearly.

### 3.3 Quality metrics

`alignmentCorrelation` (`doc/blend.md` §1.5) is a number in `[0, 1]`
falling out of the per-component alignment math for free. **It has
no ground-truth dependency** and works at any scale — at 810k it's
the same `Σ trace(R · S) / Σ √(sumA² · sumB²)` summed over
components. This is the right metric for the layout-algorithm sweep
in any deployment.

The cluster sweep's ARI-vs-`originId` metric (`app/src/eval/ari.js`)
does NOT transfer because `originId` is generator-only. At scale,
unsupervised cluster metrics (silhouette, Davies–Bouldin, modularity
on a citation graph) replace it.

### 3.4 Registry pattern + sub-stage caching

Both patterns scale unchanged:

- **Registries** (`clustering-registry.js`, `citations/registry.js`,
  `citation-layout/registry.js`) — adding a new algorithm is one
  entry, no other file touches. Language-agnostic. At scale, e.g.,
  the Python port adds `pivot-mds` to a similar registry without
  touching `main.py`.
- **Sub-stage caches in `main.js`** (`reneighbour() → retaste() →
  resample()`) are *more* important at scale than at toy scale.
  At 810k, recomputing clustering when only the sampling seed
  changed is a 30-minute mistake; the granular re-run lanes prevent
  it.

---

## 4. What carries forward

In rough priority order (most important first):

1. **The deterministic blend pattern.** Two precomputed endpoints,
   per-frame linear interpolation, no constraint solver. Scales
   linearly, round-trip exact. (`doc/blend.md` §2.)
2. **Per-component alignment with match-RMS scale.** Carries the
   topology survival (similarity transform preserves angles) and
   visible-scale matching (RMS norm decoupled from alignment
   quality). Cost is per-component-size, scales naturally.
   (`doc/blend.md` §1.4.)
3. **`alignmentCorrelation` as a quality metric.** Falls out of the
   alignment math for free, no ground-truth needed. Same formula
   at any scale.
4. **Registry pattern + sub-stage caches.** Architectural patterns
   that survive re-implementation in any language.
5. **Layer encapsulation.** Layout module never sees basePos;
   alignment is the only place they meet. This was a decision
   forced by the per-frame-Kabsch failure mode in v2 (`doc/blend.md`
   §4) and prevents an entire class of bugs from reappearing.
6. **Contracts + validators.** `ClusterResult`, `CitationResult`,
   layout-output validators. At scale these are even more
   load-bearing — they catch silent shape mismatches that would
   otherwise crash 30 minutes into a pipeline.
7. **Frozen `basePos`.** The α=0 endpoint must be the input
   embedding, byte-identical, never moved by the layout pipeline.
   (`doc/dynamics.md` §6.)

---

## 5. What does NOT carry forward

In rough order of "biggest disruption":

1. **`Uint8Array(n²)` storage everywhere.** `hasCit`, distance
   matrices in clustering and MDS — all replaced with sparse
   equivalents.
2. **All-pairs computations.** FR's repulsion sum, pair enumeration
   in citation generation, full pairwise distance in HDBSCAN — all
   need ANN / Barnes–Hut / pivot variants.
3. **Citation generation entire layer.** Replaced by reading
   observed citations from disk. The taste-network code is reference
   material for the *vocabulary* used to analyse observed citations,
   not for code reuse.
4. **The cluster eval ARI sweep.** Depends on `originId`, which is
   generator-only. Unsupervised metrics replace it.
5. **Live full-pipeline re-runs.** The "drag a slider, regenerate
   everything" interaction model only works at toy scale. At 810k,
   each layer's recompute is minutes-to-hours; UX is offline-batched
   pre-compute followed by interactive blend (which IS still fast).
6. **d3-force-3d as the rendering layer.** Designed for graphs in
   the 100s of nodes. WebGL/WebGPU instanced rendering replaces it.
   Doesn't affect the blend math.

---

## 6. The real pipeline (`literture-network/`) — what already exists

The real-data port is not a green-field exercise. Most of the
heavy lifting (embedding, citation discovery, clustering, hybrid
blending) already runs in `literture-network/`. The toy's job is
to fit alongside it, not replace it. See `network.md` in that
directory for the full inventory.

Toy-layer to real-pipeline mapping:

| Toy layer                | Real pipeline equivalent                                                                              | Status                  |
|--------------------------|-------------------------------------------------------------------------------------------------------|-------------------------|
| L1 generation (basePos)  | SPECTER2 768-d embeddings, `pipeline/step02_embeddings.py`                                            | ✓ exists, 768-d not 3-d |
| L2 clustering            | Recursive Leiden (CPM, resolution ramp 1.0→2.0), `scoring_app/build_reduced_dataset.py`               | ✓ exists, Leiden ≠ HDBSCAN |
| L3 citation generation   | `citgraphv2/` (S2 + CrossRef discovery, identity dedup, 7.95 M edges)                                 | ✓ exists, observed not generated |
| L4 citation layout       | UMAP-on-embeddings only (no graph layout).                                                            | **gap**                 |
| L5a alignment            | None.                                                                                                  | **gap**                 |
| L5b α blend              | Hard-coded `FUSION_ALPHA = 0.5` in `pipeline/config.py`. Static.                                      | **gap (the big one)**   |

The two genuine gaps where the toy adds value:

1. **Interactive α exploration.** The current hybrid blend is one
   number, set at pipeline-build time. Rebuilding to compare α=0.3
   vs α=0.7 is hours of recompute. The toy's deterministic blend
   is exactly the answer: precompute two endpoint arrangements,
   then `α` is a per-frame `O(n)` lerp. At `n = 810k` that's
   `49 M` lerps/s — trivial.
2. **Quality metric for the blend.** `alignmentCorrelation` is a
   `[0, 1]` per-component score that falls out of the per-component
   Kabsch math for free, with no ground-truth dependency. At scale
   it answers per-cluster: "does the embedding agree with citation
   topology here?" Currently the real pipeline has no such metric.

Minimum-viable port that delivers both gaps:

```
1. embedding_pos        UMAP-on-SPECTER2 (already built by build_reduced_dataset.py)
                          — α = 0 endpoint

2. citation_pos         pivot MDS per Leiden component on the citation graph
                          — α = 1 endpoint, computed once per (clustering × layout-params) tuple

3. Per-component align  blend/align.js ported to Python
                          — match-RMS scale, Horn quaternion, per-Leiden-component
                          — emits aligned_citation_pos + alignmentCorrelation per cluster

4. Per-frame blend      live = (1−α) · embedding_pos + α · aligned_citation_pos
                          — slider in scoring app drives α
                          — Plotly scattergl repaints at 60 fps for ~100k visible points

5. alignmentCorrelation Surface as a column in cluster_diagnostics.csv and as a
                          topology overlay toggle in mod_umap.R
```

Steps 3, 4, 5 are the toy's actual contribution. Steps 1, 2 are
off-the-shelf graph-layout work where pivot MDS is the cheapest
viable path at giant-component scale.

The toy's existing `app/` stays as the **methods sandbox** (low-dim,
3-d, interactive, full-pipeline live). The real-data integration is
a **separate surface** that shares modules with the toy via the
registry pattern.

---

## 7. Things to reconcile when integrating

Open design questions that need decisions when integration starts:

- **Hierarchical clustering contract.** Toy `ClusterResult` is flat.
  Real pipeline emits L1/L2/L3/... paths. Need to extend the
  contract additively (optional `nodePath` field) without breaking
  toy consumers.
- **Two different "α blends".** The real pipeline's α is a graph-
  *construction* parameter (`hybrid_weight = α · sim + (1−α) ·
  default`). The toy's α is a layout-*display* parameter (lerp
  between two precomputed positions). They're orthogonal and can
  coexist; surfacing both as sliders is a UX choice.
- **Unit of analysis.** Real pipeline is unipartite (papers cite
  papers via `paper_key`). The 1.94 M figure is "citation-graph
  nodes with proper IDs"; the layout-relevant set is the 810 k
  embedded subset. Layouts that include un-embedded nodes have to
  decide: drop them, or emit a placeholder position.
- **Sweep tooling at scale.** The toy's ARI-vs-`originId` sweep is
  generator-only. `alignmentCorrelation` carries forward as a
  ground-truth-free metric. Cluster-modularity is intrinsic and
  applies to all graph-based clusterings. A 100-combo sweep at
  810 k is still hours — subsample-and-tune (representative ~10 k
  papers) is the usual workaround; subsample size is empirical.
