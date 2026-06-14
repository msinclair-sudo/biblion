# Ghost nodes — structure-only citation participants

> Status: shipped. Data tier + masked-conduit fusion + clustering exclude-from-fit
> (incl. the Optimise sweep). The biblion-side design + experiment plan lives in
> `claude_doc_dump/ghost-node-positioning-spec.md` (parent repo); the research basis
> is in the vault under `PhD/biblion/research/`.

## What a ghost is

A **ghost** is a real citation participant with **no metadata** — an external paper
that in-corpus papers cite (or are cited by) but which has no title/abstract, so no
SPECTER2 vector. They are the realized, *inclusion* answer to the problem
`citation-edge-salvage.md` framed: the abstract filter severs ~30–55% of citation
edges, and the dropped endpoints are real relationships, not noise.

biblion materializes them (the `materialize_ghost_stubs` daemon promotes frequent
`pending_citations` endpoints to `is_stub=1` rows; the PendingResolver then promotes
their edges to real `citations`), and `biblion advanced snapshot --include-structural`
surfaces them to the toy. A ghost is just a node that carries citation edges but has
no embedding row.

## The one rule

> **Ghosts move real nodes; they don't get a vote.**

A ghost influences the map through exactly one channel — by shifting where the *real*
nodes land during fusion — and is forbidden the other: it is never a point in the
clustering fit. So cluster boundaries are decided purely among embeddable nodes, but
those nodes stand where the citation graph (ghosts included) put them. See
*Clustering* below for why both halves matter.

## Data contract (L1)

`datasource/contract.js`, `datasource/sqlite.js`, `datasource/real.js`:
- A node gains `isGhost: boolean`. Ghosts are the **last** `n − m` node indices.
- `embedding.data` is a dense **`m × d`** block for the `m` embedded nodes only —
  ghosts have **no** embedding row (mask / `m` count carried so consumers know the
  cut). The `n × d` assertion is relaxed to the embedded block.
- Ghost citation edges are in `citationEdges` / `rawCitationEdges` like any other.
- Snapshot shape: `--include-structural` emits embedded nodes first (rows `0..m-1`),
  structural nodes last, each flagged `structural = (is_stub=1 OR abstract IS NULL)`;
  manifest records `n_embedded` / `n_structural`. `paper_index` entries may be a bare
  id (legacy) or `{id, structural}`.

## Noise stage (L1.5, PCA)

PCA is fit and projected on the `m` embedded nodes only — a ghost has no vector to
denoise, and fitting on real anchors avoids biasing the covariance. Ghosts acquire a
position downstream, at fusion.

## Fusion (L1.5) — masked no-self-anchor APPNP

`dimred/graph-diffusion.js`. The fusion is anchored APPNP:
`X' = (1−α)·X + α·(D⁻¹A)·X'`. A real node is tethered to its own vector `X` each step
(the teleport term). A ghost has no real `X`, so:

- A ghost is a **pure conduit**: it stays in the propagation graph but is **excluded
  from the teleport term** (`α_eff = 1`, full diffusion, no self-anchor). Its value
  each step is just the average of its neighbours; it is warm-started to the
  neighbour mean (overwritten each iteration, never a persistent anchor).
- Effect: a ghost `G` shared by real nodes `A` and `B` (edges `A→G`, `B→G`) carries
  `A`'s and `B`'s vectors through itself, nudging them toward each other along the
  2-hop path `A→G←B`. This is where the shared-ghost bridge actually does work.

Why not give the ghost an imputed or zero anchor? The research (vault) is decisive:
our regime is ~70% featureless, dense SPECTER2, whole-node missingness — outside every
proven zone. A fabricated teleport anchor makes the ghost a *persistent injector*: a
mean-imputed anchor collapses to low variance (centroid pile-up); a zero anchor pulls
its real neighbours toward the origin (the variable-sparsity bias). The no-self-anchor
conduit avoids both — the pull is real neighbour topology, bounded by `α≈0.3`.

`ghostMask` and `countGhostsInDegree` are params on `compute()`; the engine builds the
mask from `isGhost` and passes `rawCitationEdges` as the adjacency.

## Clustering (L2) — exclude from fit, assign post-hoc

`clustering-cascade.js`, `clustering-hdbscan.js`, `clustering-worker.js`. Every level
runs HDBSCAN on the `m` embedded nodes only (distance matrix, MST, condensed tree are
all `m`-sized), then each ghost inherits the cluster of its **nearest embedded
citation neighbour** (Euclidean in fused space; ghost↔ghost edges ignored). A ghost
with no embedded neighbour is "structural" — id `−1` under `allowNoise`, else a single
reserved trailing cluster (`STRUCTURAL_COLOUR`). The helpers `buildGhostContext` /
`runLevelOnEmbedded` / `expandGhostResult` encapsulate this; with no ghosts they are
the identity and the clustering math is untouched.

**Direct vs indirect.** This blocks the *direct* channel (a ghost can't seed a
cluster, count toward density, or split/merge real clusters by being a featureless
point — the unbenchmarked contamination risk). It deliberately keeps the *indirect*
channel: because fusion ran first, the real nodes were already moved by their ghosts,
so cluster shapes reflect citation structure. That indirect effect is the intended
signal, not a leak.

### The Optimise multi-layer sweep

`ui/engine.js recomputeMultiLevelSweep` applies the *same* exclusion. When ghosts
exist it slices `nodesSlim` / `dimredResult` / a `genResult` stub to the `m` embedded
nodes, runs the whole sweep on that subproblem — Phase 1 (one HDBSCAN model + plateau
candidates) and Phase 2 (`eval/bootstrap.js` stability) — so the model, the
minClusterSize grid, and the stability scores are computed on real nodes only, then
`expandGhostResult`s every scored candidate back to full `n` before bridges/commit.
The worker, `eval/multilayer-sweep.js`, and `eval/bootstrap.js` are untouched; they
just receive a smaller problem. Candidate `count` stays the embedded cluster count
(the granularity the picker commits on); the `clusterResult` is full `n`. A
sweep-cached L0 reused by `recluster` is therefore already ghost-correct.

## Viewer & labelling

Ghosts render visually distinct with a show/hide toggle, and are excluded from
c-TF-IDF / TF-IDF labelling (no text). Colour modes treat `isGhost` as its own
category.

## Tuning & verification

- **`--min-degree`** (biblion `materialize_ghost_stubs`, default 2): only external
  endpoints shared by ≥ N in-corpus papers become ghosts. Degree-1 leaves (≈84% of
  endpoints) add render mass but no inter-paper structure; raising the threshold
  shrinks the featureless fraction toward the regime where positioning is more
  reliable, at the cost of fewer bridges.
- **Instrumentation** (`eval/ghost_instrumentation.mjs`): the spec §5 gate metrics —
  ghost-vs-real channel variance + Dirichlet energy (low-variance-collapse check),
  bridge co-cluster rate vs a random-shared-ghost null, and **real-node displacement
  vs a ghost-free reference** (this last measures the indirect effect above, so you
  can confirm the nudge is modest and structure-driven, not distortion). UMAP-space
  metrics are skipped headlessly (CDN); fused-100d + HDBSCAN run in node.
