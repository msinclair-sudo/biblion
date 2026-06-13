---
title: Ghost-node positioning — full implementation spec
status: spec (Part A built; Parts B/C designed, instrument-first)
updated: 2026-06-13
tags:
  - doc_dump
  - biblion
  - network
  - embedding
  - node
destinations:
  - "[[ghost-node-positioning]]"
  - "[[ghost-node-positioning-result]]"
  - "[[ghost-node-open-questions]]"
---

# Ghost-node positioning — full implementation spec

Provenance: literature review `[[ghost-node-positioning-result]]`, targeted result
"Featureless Ghost Nodes under Anchored Graph-Diffusion Fusion" (vault:
`PhD/biblion/research/results/`), open questions `[[ghost-node-open-questions]]`,
plan `~/.claude/plans/soft-questing-ladybug.md` (this supersedes its Part C).

## 0. Decision (what we are building and why)

Materialize external citation endpoints ("ghosts") as real structural nodes, and
position them in the viewer by citation topology **without** giving them a
fabricated semantic anchor. The chosen positioning operator is a **masked,
no-self-anchor variant of the existing anchored graph-diffusion (APPNP) fusion**:
a ghost stays in the propagation graph (so it transmits A→B influence) but is
excluded from the teleport (`α·X`) term (so it never injects a fabricated or
zero anchor that distorts real nodes). We **instrument before we commit**: the
research is clear that our regime is outside every proven zone, so the design is
validated by measurement on our own data, not assumed.

Evidence basis (condensed):
- Our regime — **~70% featureless** (fallworm: 3,392 ghosts vs 1,405 real at
  degree ≥2), **dense** SPECTER2 (768-d), **whole-node structural** missingness —
  is outside the published "proven zone" (homophilous, sparse bag-of-words, MCAR,
  small missing fraction). Treat published thresholds (e.g. FP's 4% drop at 99%
  missing; the ~50–60% crossover) as optimistic upper bounds, not targets.
- The co-citation bridge `A→ghost→B` is **encoded by construction** (APPNP =
  personalized PageRank; LINE second-order proximity) but **not validated
  downstream**: low-variance collapse (Um et al. ICML 2025, proven),
  oversmoothing, and UMAP/HDBSCAN can erase a thin bridge. Encoded ≠ survives.
- The anchored design is the specific risk: a ghost re-tethered to a fabricated
  anchor each step is a **persistent injector**. Zero-anchor → pulls neighbours
  toward the origin (Yi et al. ICLR 2020, variable-sparsity proof). Mean-impute →
  low-variance washout. The **masked no-self-anchor** treatment is the
  FP-supported fix (FP's steady state is invariant to the unknown init).

## 1. Architecture context

Pipeline (network_toy):
```
SPECTER2 768-d → noise: PCA→100-d (denoise) → fusion: graph-diffusion APPNP
              → compression: UMAP → clustering: HDBSCAN → citation-layout → blend
```
- Fusion (`app/src/dimred/graph-diffusion.js`): `X'⁽ᵏ⁺¹⁾ = (1−α)·X + α·(D⁻¹A)·X'⁽ᵏ⁾`,
  α=0.3, K=4, symmetric A∨Aᵀ, `invDeg[i]=1/deg or 0`.
- The pipeline assumes a **dense n×d embedding** (PCA, HDBSCAN distance matrix,
  cascade slicing, blend all index `data[i*d…]`); there is no vector-less-node
  concept today (see `app/src/datasource/contract.js`).

## 2. Part A — `materialize_ghost_stubs` daemon  (BUILT, verified)

`biblion/modules/materialize_ghost_stubs.py` (registered in
`biblion/modules/__init__.py`; `--min-degree` wired in `cmd_run`). Scans
`pending_citations`, resolves endpoints via the identifier index, finds ghosts
referenced by ≥ `min_degree` distinct in-corpus nodes, pushes identifier-only
`PaperRecord`s. Writer creates `is_stub=1` rows, Resolver dedups, PendingResolver
promotes the now-resolvable edges. Verified on scratch fallworm: 3,392 stubs →
3,042 net (dedup), citations 2,374→14,789, pending 40,774→26,627, no full paper
altered, idempotent, 480 tests green. **No changes needed for the positioning
work.**

## 3. Part B — surface structural nodes in the snapshot

`biblion/snapshot.py` + a `--include-structural` flag on `advanced snapshot`.
When set, the node set is `is_rejected=0 AND title IS NOT NULL` (drop the
`is_stub=0 AND abstract IS NOT NULL` requirement) and each node row carries a
`structural` boolean = `is_stub=1 OR abstract IS NULL`. `paper_index.json` and
`nodes.jsonl` gain the flag; the embedding step (`biblion/embed.py`) embeds only
non-structural nodes, so `embeddings.npy` has `m ≤ n` rows plus a sidecar
`structural_mask.json` (or a `structural` column in the index) telling the toy
which node indices have no embedding row. Manifest records `n_nodes`,
`n_structural`, `n_embedded`.

Contract change is minimal because structural nodes are flagged, not interleaved:
emit embedded nodes first (rows `0..m-1`), structural nodes last (`m..n-1`), so
`embeddings.npy` stays a contiguous `m×d` block and the toy knows rows `≥m` are
ghosts.

## 4. Part C — toy positioning (masked-conduit APPNP)

### 4.1 Data contract (`app/src/datasource/contract.js`, `sqlite.js`, `real.js`)
- Node gains `isGhost: boolean` (default false). Built from the snapshot's
  `structural` flag.
- `embedding.data` stays a dense `m×d` block for the **m embedded** nodes; ghosts
  (`isGhost`) have **no** row. Add `embedding.rowOf: Int32Array(n)` mapping node
  index → embedding row, or `-1` for ghosts. (Equivalently: emit ghosts as the
  last `n−m` indices and store `m`.)
- Relax the dense-`n×d` assertion in `contract.js` to `embedding.data.length ===
  m*d` with `m = count(!isGhost)`.

### 4.2 PCA noise stage (`app/src/dimred/pca.js`, `engine.js pickStage0Input`)
- Fit + project PCA on the **m embedded** nodes only. Ghosts get **no** PCA row.
  (Fitting on real-only avoids the covariance bias the research flags in Q4.)
- Output of the noise stage is `m×100`. Ghosts enter at fusion (next stage),
  where they acquire a position by propagation.

### 4.3 Fusion — masked no-self-anchor APPNP (`graph-diffusion.js`)  ← core change
Expand the working matrix to all `n` nodes (embedded + ghost). Initialise:
- embedded node i: `cur[i] = X[i]` (its PCA-denoised vector); `anchor[i] = X[i]`.
- ghost node g: `cur[g] = mean(cur over g's embedded neighbours)` (warm start, NOT
  an anchor — it is overwritten every iteration); no `anchor[g]`.

Per-iteration update (the one-branch change to the existing loop):
```
for each node i:
  s = invDeg[i] * Σ_{j∈N(i)} cur[j]        # D⁻¹A cur  (neighbours incl. ghosts)
  if isGhost[i]:
    next[i] = s                            # α_eff = 1: pure conduit, NO teleport
  else:
    next[i] = (1−α)·anchor[i] + α·s        # unchanged anchored APPNP
```
Properties: a ghost never contributes a fabricated/zero teleport anchor; it holds
the K-step-diffused boundary value of its real neighbourhood (FP-style, init-
invariant at convergence). Real nodes are unchanged except that their neighbour
sum now includes ghost conduits, which carry other real papers' signal (the
A→ghost→B bridge).

Params: add `ghostMask: Uint8Array(n)` to `params` (alongside `adjacency`).
Degree `D` **includes** ghosts by default (they are real edges); expose
`countGhostsInDegree` as a toggle for the Q3 ablation ("in-degree-but-not-in-
aggregation" vs "fully excluded").

Output: dense `n×d` fused matrix (embedded + ghost positions). From here the
pipeline is unchanged — ghosts now have real coordinates.

### 4.4 Clustering (`clustering-hdbscan.js`, `clustering-cascade.js`)
Default: **exclude ghosts from the HDBSCAN fit** (build the distance matrix over
the `m` embedded nodes only), then assign each ghost post-hoc to the cluster of
its nearest embedded citation neighbour (or `-1`/"structural" if none). Rationale:
the contamination question is unbenchmarked; a ghost's position is derived, so it
should not redefine semantic cluster boundaries. `nodeCluster` stays
`Int32Array(n)`; ghosts get the post-hoc label. (This is independent of 4.3 and
can be toggled for the contamination ablation.)

### 4.5 Downstream (UMAP, blend, viewer, labelling)
- UMAP / blend consume the dense fused `n×d` — no change.
- Viewer: render ghosts visually distinct (lower opacity / different glyph) and
  add a show/hide toggle. Colour-modes (`viewer-shared/colour-modes.js`) treat
  `isGhost` as its own category.
- Labelling (`labelling/cluster-labels.js`): exclude ghosts from c-TF-IDF / TF-IDF
  (no text); they may still count toward representative-paper/year if desired —
  default exclude.

## 5. Staged experiment plan (instrument FIRST; each gate changes the next step)

### Step 1 — Instrument the current (imputed-anchor) pipeline. Do this before any code change beyond materialization.
Build an eval harness (node script importing the pure JS modules `graph-diffusion.js`,
`clustering-hdbscan.js`, or a Playwright `page.evaluate` like `tests/conftest.py`)
on fallworm with ghosts materialized. Measure:
- **Ghost-vs-real per-channel variance ratio** and **Dirichlet energy** of the
  fused vectors (low-variance-collapse detector).
- **Bridge co-cluster rate**: real pairs (A,B) sharing a degree-≥2 ghost, with no
  direct edge and no other short path, fraction co-clustered in HDBSCAN — vs a
  **random-shared-ghost null** (rewire ghost edges). Bridged ≫ null ⇒ the bridge
  does work.
- **Stage localisation**: measure pair distance in fused-100d, in UMAP space, and
  co-cluster rate — so washout is attributable to fusion vs UMAP vs clustering.
- **Real-node displacement**: real fused positions with ghosts vs a ghost-free
  reference embedding (contamination magnitude).
**Gate:** if ghost channels are near-constant (variance ≪ real) ⇒ low-variance
collapse confirmed ⇒ go to Step 2 now. If ghost variance is within ~1 order of
real AND bridged pairs co-cluster ≫ null ⇒ imputed-anchor may suffice; prioritise
Step 3 thresholding instead.

### Step 2 — Implement + A/B the masked no-self-anchor APPNP (§4.3).
Arms: (a) imputed-mean anchor, (b) zero anchor, (c) masked conduit, (d) ghosts
dropped (structural-loss baseline). Metrics: real-node displacement vs ghost-free
reference; bridge co-cluster rate vs null.
**Gate:** adopt (c) if it reduces real-node displacement vs (a)/(b) **without**
measurably weakening the bridge.

### Step 3 — Degree-threshold sweep (Q2).
Sweep `min_degree` ∈ {2,3,5,10}; at each, plot featureless fraction AND retained
bridges/edges/nodes on one axis, plus an unsupervised reliability metric
(mask-a-real-node imputation self-consistency vs SPECTER2 truth) and homophily +
mean degree of the surviving graph.
**Gate:** raise the threshold only if reliability improves materially AND bridge
retention stays acceptable. If ≥3 cuts featureless well below 50% while keeping
most bridges, that likely beats any operator tweak; else keep ≥2 + masked operator.

### Step 4 — Denoise × injection factorial (Q4). Most exploratory; do last.
Cross {denoise-then-propagate, propagate-then-denoise} × {raw-768d, 100d ghost
injection} × {zero, imputed, masked}. Use a scale-invariant distortion metric
(correlation of real-real distance rankings vs ghost-free reference) so PCA
magnitude changes don't masquerade as distortion.

## 6. Failure modes & decision thresholds

| concept | failure mode | guard / decision |
|---|---|---|
| imputed-mean anchor | low-variance collapse → bridge washout | Step 1 variance/Dirichlet check; if collapsed → masked operator |
| zero anchor | origin-pull distorts real neighbours (proven) | do not ship; A/B arm (b) only |
| masked conduit (chosen) | slow convergence at K=4 for deep ghosts; isolated masked ghosts scatter in UMAP | warm-start init; raise K or use PCFI confidence weighting; check isolated-ghost handling |
| ghosts in clustering fit | contamination of real clusters (unbenchmarked) | default exclude-from-fit + post-hoc assign |
| degree ≥2 (~70% featureless) | past proven crossover on dense/structural data | Step 3 sweep; reliability-vs-structure plot |
| dense n×d assumption | index out-of-range / NaN on ghost rows | flagged contract (`m` embedded rows + ghost mask), PCA fit-on-real-only |

## 7. Verification
- Step-1 harness reproduces on fallworm; metrics logged (no silent truncation of
  dropped ghosts).
- `pytest` in biblion stays green (Part A unaffected); toy `pytest -m "not slow"`
  green after contract + fusion changes.
- Toy end-to-end: snapshot `--include-structural` → ghosts load with `isGhost`,
  fuse via masked operator, render distinct, toggle works; displayed citation
  graph stays honest (ghosts visibly separate).
- A/B and sweep results recorded back into the vault result note family.

## 8. Open questions (do not treat as settled)
See `[[ghost-node-open-questions]]` Q1–Q4. Step 1–4 above are the experiments that
answer them on our data; the literature cannot.
