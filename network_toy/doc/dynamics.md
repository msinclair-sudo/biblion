# Network dynamics — math as currently implemented

This document describes the math that is actually running in `network-dynamics.html` today (the version that "mostly works"). It is meant as the reference for the clean rebuild — anything not described here should not appear in the rebuilt version, and anything described here should appear once and only once.

The pipeline has six layers, each with its own math:

1. **Layer 1 — Generation / data source** — sampling node positions
   and timestamps (toy) or loading real SPECTER2 embeddings.
2. **Layer 1.5 — Dim-reduction** — five sub-stages (noise / fusion /
   compression / viz / viz2d). See `doc/dimred.md`, `doc/fusion.md`.
3. **Layer 2 — Cluster inference** — recovering cluster IDs from
   positions or dim-reduced features.
4. **Layer 3 — Citation generation** — choosing which directed edges
   exist (toy: taste-network; real: imported edges).
5. **Layer 4 — Citation-driven layout** — FR / MDS / UMAP-on-graph
   (opt-in; cascade STOPS at Layer 3).
6. **Layer 5 — Alignment + per-frame blend** — Procrustes alignment
   + nested lerp between basePos endpoints + aligned citation
   layout.

**Ghost nodes** (metadata-less citation participants, `isGhost`) cut across
Layers 1/1.5/2: no embedding row, carried through fusion as no-self-anchor
conduits, excluded from the clustering fit and assigned post-hoc. They shape
clusters only by moving real nodes during fusion, never by being clustered. See
`doc/ghost-nodes.md`.

Section 5 lists the controls and what each one actually drives.

**Engine architecture and execution model:**
- `doc/ui-architecture.md` — shell, state container, engine
  orchestrator, workflow chart (tree-aware), panel system,
  modals, typed-job queue + per-card status.
- `app/src/ui/next-steps-rules.js` (+ `modals/layer-descriptors.js`) —
  the live palette of card choices, valid parent–child relationships,
  and auto-spawn rules (these live in code, not a doc).
- `doc/workers.md` — module workers + the DAG that runs heavy
  lanes in parallel with cancellation.
- `doc/eval.md` — Optimise (bootstrap-Jaccard, scorers, three sweep
  modes including target-range LHS). The standalone Validate tab was
  retired 2026-05-24.

**For the real-data port (n = 810 k base, 1.82 M filtered hybrid
edges):** see `doc/scaling.md` for which layers scale unchanged,
which need replacement, and the trade-offs at each cliff. The
per-layer docs below also each have a "Scaling characteristics"
subsection that points back to `scaling.md` for cross-cutting
decisions.

**Multi-level extension (Layer 2 / 2.5):** since the original
single-level layer-2 spec, the toy has gained multi-level
clustering (state.clusterLevels) plus a derived bridge analysis.
See `doc/multi-level.md` for the multi-level engine cascade,
within-parent stitching, and the bridge / boundary-score
derivation. The original `ClusterResult` contract in
`doc/clustering.md` §1 is unchanged — multi-level is a sibling
state slot, not a contract extension.

**UI architecture:** the v3 shell at `app/src/ui/` (workflow chart
+ multi-tab panels + modals + state container) is specified in
`doc/ui-architecture.md`. Engine modules in `app/src/` (outside
`ui/`) remain pure functions and don't read or write state — they're
called by the orchestrator at `app/src/ui/engine.js`.

---

## 1. Generation: where nodes come from

Nodes are sampled from a **Gaussian mixture** over a bounding cube of half-extent `R = 60`.

**Inputs.** `pointsOfOrigin` (number of mixture centres, call it `K`), `nodeCount` (total nodes `N`), `seed`.

**Centres.** For each `k ∈ [0, K)`, the centre `μ_k ∈ ℝ³` is sampled with each axis uniform on `[−R, +R]`. (Uniform per axis, i.e. uniform in the bounding cube — *not* uniform in a ball. Every point in the cube is equally likely.)

**Spreads.** Each centre gets an independent per-axis standard deviation:
```
σ_k,axis  =  R · (0.07 + u · 0.18) · spreadScale,     u ~ U(0,1)
```
so at the default `spreadScale = 1` each `σ` lies in `[0.07·R, 0.25·R] = [4.2, 15]`. `spreadScale` is a global multiplier the user can drag live — `>1` widens every blob, `<1` tightens it. Because σ is independent per axis, mixture components are axis-aligned ellipsoids, not spheres.

**Allocation across centres.** Every centre is guaranteed at least one node. The remaining `N − K` nodes are distributed by weighted multinomial draws:
```
w_k  =  0.4 + u_k,         u_k ~ U(0,1),     k = 0..K−1
```
For each remaining node, draw `r ~ U(0, Σw)` and assign it to the first `k` whose cumulative weight exceeds `r`.

**Position.** A node assigned to centre `k` is placed at
```
x_i  =  μ_k  +  g ⊙ σ_k,        g ~ 𝒩(0, I₃)
```
where `g` is a 3-vector of independent standard normals (Box–Muller) and `⊙` is component-wise multiplication. The resulting position is stored as `basePos[i]` and is *frozen* — it never changes after generation.

**Timestamp.** Each node gets `t_i ~ U(0,1)`. Used only by citations: a citation `i → j` requires `t_i > t_j` (newer cites older).

The generator emits only positions and timestamps. **It does not assign cluster IDs.** Cluster IDs come from step 2.

---

## 2. Cluster inference: pluggable algorithms behind a contract

Cluster IDs are recovered from `basePos` by a clustering algorithm that
the user picks at runtime from the **Cluster ▾** dropdown. The toy
keeps every algorithm behind a fixed `ClusterResult` contract so the
rest of the pipeline (citations, neighbourhoods, taste, render) reads
the same fields regardless of which algorithm produced them.

**See `doc/clustering.md`** for:

- §1 the `ClusterResult` contract, validated at runtime by
  `app/src/contracts/cluster.js`
- §2 every consumer of cluster output across the codebase
- §3 the algorithm-registry shape that lets new algorithms register
  themselves with no UI edits
- §4 the algorithms currently registered, with full math:
  - **§4.1 Mutual k-NN** — top-K + mutuality + connected components.
    Conservative about cluster peripheries (the "halo trap"), but
    refuses to chain narrow bridges between dense regions.
  - **§4.2 HDBSCAN** — core distances + mutual-reachability MST +
    condensed-tree EOM extraction with stability scoring. Density-
    aware. Has a noise concept resolved by `noiseMode = absorb |
    singletons`.
- §5 the rerun semantics
- §6 the contract changelog

What's stable across algorithms (and therefore safe to rely on from
elsewhere in `dynamics.md`):

- Every node has a non-negative cluster id; the toy never propagates
  raw `-1` (HDBSCAN's pre-absorption noise stays in `noiseFlags` for
  debug overlays only).
- `clusters[c].centre` is always defined.
- Cluster ids are contiguous from 0.
- Clustering runs against `basePos`, never against the live moving
  positions.

**Reruns** — clustering re-runs on regeneration, when the active
algorithm changes, or when any algorithm-specific param changes. See
`clustering.md` §5 for the cascade.

---

## 3. Citation generation: pluggable algorithms behind a contract

Citations are directed edges `i → j` ("i cites j", subject to
`t_i > t_j`) produced by an algorithm the user can swap at runtime.
Like clustering (§2), the toy keeps every algorithm behind a fixed
`CitationResult` contract so the rest of the pipeline (citation
layout, alignment, render) reads the same fields regardless of which
algorithm produced them.

**See `doc/citations.md`** for:

- §1 the `CitationResult` contract, validated at runtime by
  `app/src/citations/contract.js`
- §2 every consumer of citation output across the codebase
- §3 the algorithm-registry shape that lets new algorithms register
  themselves with no other code edits
- §4 the algorithms currently registered, with full math:
  - **§4.1 Taste Network** — four pure stages (within-cluster
    neighbourhoods → per-neighbourhood taste with distance-decaying
    shared-taste pass → cluster-level triangle transitivity weighted
    by neighbourhood representativeness → per-pair Bernoulli sampling
    with category budgets). Lifted byte-identical from v2's citation
    pipeline.
- §5 the rerun semantics (sub-stage caches in main.js for granular
  re-runs)
- §6 the contract changelog

What's stable across algorithms (and therefore safe to rely on from
elsewhere in `dynamics.md` and from the layout / blend layers):

- `hasCit` is symmetric and indexed `i*n + j`.
- `edges` is a normalised `i < j` pair list — citation-layout
  iterates this directly.
- `inDeg` is the incoming-citation count per node, used for
  colour-by-in-degree rendering only.
- Citations always satisfy `t_source > t_target` (newer cites older);
  layout and alignment ignore direction.
- Algorithm-specific intermediate state (taste sets, neighbourhood
  ids, etc.) is **not** exposed through the contract — those are
  implementation details of whichever algorithm is registered.

**Reruns.** Citations re-run on regeneration, when the active
clustering changes, when any citation-modal param changes, or when
the citation seed is re-rolled. See `citations.md` §5 for the cascade
and main.js's sub-stage caching.

---

## 4. Layout dynamics: deterministic blend between layouts

Live node positions are produced by **nested linear interpolation**
over two independent sliders, between up to three precomputed
endpoint arrangements:

- `_basePosPreFusion` — pre-fusion semantic basePos (Layer 1.5
  viz on noise-stage output; non-null only when the fusion
  sub-stage is active).
- `_basePos` — post-fusion basePos (Layer 1.5 viz on fusion-stage
  output; identical to pre-fusion when fusion is identity).
- `alignedCitationLayout` — Layer 4's citation-driven layout
  after Layer 5a alignment.

The two sliders are `state.blend` and `state.fusionBlend`. The
per-frame work is two lerps per data node:

```
effective = lerp(_basePosPreFusion, _basePos,             fusionBlend)
live      = lerp(effective,         alignedCitationLayout, blend)
```

When `_basePosPreFusion` is null the inner lerp collapses to
`_basePos` and the model reduces to the original two-endpoint
design. When `alignedCitationLayout` is null (citation layout
not yet applied — the cascade stops at Layer 3 by design; see
`doc/blend.md` §3) the hook bails entirely.

**See `doc/blend.md`** for:

- §1 the per-component similarity alignment that produces
  `alignedCitationLayout` (rotation + uniform scale + translation,
  per connected component; match-RMS scale rather than
  Procrustes-optimal; Horn quaternion + Jacobi eigendecomp for
  the rotation)
- §1.5 the alignment correlation coefficient — a `[0, 1]`
  quality metric that falls out of the alignment math for free
- §1.8 `alignGlobal` — whole-graph Procrustes variant used for
  pre-fusion → post-fusion alignment so the fusion-comparison
  slider walks the short geometric path
- §2 the per-frame nested-lerp blend, registered as a d3-force-3d
  hook with `d3VelocityDecay = 1.0` so no velocity integration
  interferes
- §3 the recompute lanes (including the opt-in policy that stops
  the cascade at Layer 3 — `relayoutCitations()` runs only on
  explicit user Apply)
- §4 historical context: why v3 replaced v2's spring / PBD
  constraint solver with this deterministic blend

**See `doc/fusion.md`** for the Layer 1.5 fusion sub-stage:
graph-diffusion (APPNP-style anchored), the fusion-comparison
slider, the "Cluster — pre-fusion" colour mode, and the cost /
parameter notes.

What's stable across the implementation (and therefore safe to rely
on from elsewhere):

- **Endpoint exactness.** At α=0, `live === basePos` byte-identical.
  At α=1, `live === alignedCitationLayout` byte-identical.
- **Round-trip exactness.** Sweeping α from 0 → 1 → 0 returns to
  basePos with zero residual drift.
- The blend is **linear in position**, not in edge length. An edge
  whose endpoints are far apart in basePos and close in
  citationLayout passes through every intermediate distance at
  intermediate α. (A "minimum-stress path" alternative is wishlist
  material; deferred.)
- No momentum, no constraint solver, no iteration. Per-frame work is
  O(n).
- Per-component alignment is the **only** place in the codebase
  where citationLayout and basePos meet — the layout module never
  sees basePos, by encapsulation.

---

## 5. Controls — what each one actually changes

| Control                                              | Affects                                | Recompute path                                                        |
|------------------------------------------------------|----------------------------------------|-----------------------------------------------------------------------|
| `seed`, `nodeCount`, `pointsOfOrigin`, `spreadScale` | Generation                             | regenerate → recluster → re-neighbour → re-taste → resample           |
| Cluster ▾ algorithm switch / any clustering-modal slider | Cluster inference (see `clustering.md`) | recluster → re-neighbour → re-taste → resample                       |
| `neighbourK`                                         | Stage 1 (neighbourhoods)               | re-neighbour → re-taste → resample                                    |
| `favouritesMean`, `sharedTaste`, `tasteRange`, `transitiveBoost` | Stages 2 + 3 (taste)                   | re-taste → resample                                                   |
| `tasteSeed`, *Randomize taste*                       | Stages 2 + 3                           | re-taste → resample                                                   |
| `density`, `intraRate`, `crossRate`                  | Stage 4 budget                         | resample → relayout                                                   |
| `epsilonIntra`, `epsilonCross`                       | Stage 4 base rates                     | resample → relayout                                                   |
| `samplingSeed`, *Randomize sampling*                 | Stage 4                                | resample → relayout                                                   |
| Citation Layout ▾ algorithm switch / layout-modal Apply | Citation-layout params (FR / MDS / UMAP-on-graph knobs) | relayout (chosen algo + per-component alignment) — **opt-in, only on Apply** |
| `blend` (slider)                                     | Per-frame interpolation factor only    | reheat (no recompute; blend force re-reads each tick)                |
| `fusionBlend` (slider)                               | Per-frame interpolation factor only    | reheat (no recompute; blend force re-reads each tick)                |
| Fusion (Layer 1.5) algorithm switch / params         | Citation-aware re-embedding            | redimred → recluster → reneighbour → resampleViaImport → mark layout stale |
| `baseDensity` (visual)                               | Visible base edges only                | rebuild graph data (no layout change)                                |
| Freeze                                               | Sim pause                              | `Graph.pauseAnimation/resumeAnimation`                                |
| edge toggles, colours, γ                             | Render only                            | rebuild graph data / refresh                                          |

**Important non-couplings:**
- `baseDensity` is **purely visual**. The blend uses every pair's
  `basePos` regardless of how many base edges are drawn.
- Cluster IDs are **only** used by citation generation as a grouping.
  They have no effect on either layout endpoint.
- Colour-by mode is render-only; it does not change layout or
  topology.

---

## 6. Frozen quantities

Once generation runs, these are immutable until the next regeneration:
- `basePos[i]` for every node
- `t_i` for every node
- `state._basePos` (flat `Float32Array(n×3)` form of basePos, used by
  the blend force and the alignment pass)

Cluster IDs are immutable until the active clustering algorithm or
any of its params change (or regeneration). See `clustering.md` §5.

Neighbourhood IDs are immutable until `neighbourK` changes (or any
upstream change).

`alignedCitationLayout` is immutable until the citation graph or the
citation-layout params change (`relayoutCitations()` re-runs FR and
the per-component Kabsch alignment in one pass).

Per-neighbourhood taste sets `T(Ng)` are immutable until any Stage 2/3 knob changes or `tasteSeed` is rolled (or any upstream change).

Citations are immutable until any Stage 4 knob changes or `samplingSeed` is rolled (or any upstream change).

Live positions `(x_i, y_i, z_i)` and velocities are the only things that change every tick.
