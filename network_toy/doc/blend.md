# Blend layer — transition between layouts

Layer 5 of the v3 pipeline. Takes up to **three** precomputed
positional layouts — `_basePos`, `_basePosPreFusion` (optional),
and `alignedCitationLayout` (Layer 4 after alignment) — and
composes them per frame through a **nested lerp** controlled by
two independent sliders. See §2 for the formula; §1 for the
alignment machinery that produces the inputs.

The original two-endpoint design (basePos ↔ aligned citation
layout, one slider) is preserved as the fusion=identity / toy
mode special case. When fusion is non-identity (`doc/fusion.md`),
the fusion-comparison slider adds a second axis: pre-fusion
semantic ↔ post-fusion (citation-aware) basePos.

Two sub-layers:

- **5a. Alignment** (`app/src/blend/align.js`) — runs once per
  trigger. Two variants:
  - `alignByComponent` brings the citation layout into
    basePos's coordinate frame, per connected component. Used
    for the citation ↔ basePos endpoint pair.
  - `alignGlobal` is a whole-graph Procrustes variant used for
    the pre-fusion → post-fusion basePos pair (no edges needed;
    all nodes treated as one rigid body). See §1.8.
- **5b. Blend** (`app/src/blend/blend.js`) — runs every animation
  tick. Nested linear interpolation; both sliders compose.

Modules:

```
basePos                        ┐
                               ├──→ blend/align.js  ──→  alignedCitationLayout
citation-layout output         ┘            ↑
                                            └─ once per change

alignedCitationLayout          ┐
basePos                        ├──→ blend/blend.js  ──→  live node.x/y/z
α (slider)                     ┘            ↑
                                            └─ every animation tick
```

`alignmentCorrelation` falls out of the alignment math for free and is
exposed as a quality metric (§1.5).

---

## 1. Alignment: per-component similarity transform

`app/src/blend/align.js`. Takes basePos and the raw layout output and
produces `alignedCitationLayout` by applying an independent similarity
transform (rotation + uniform scale + translation) per connected
component of the citation graph.

The citation-layout module (Layer 4) produces a deterministic 3D
arrangement in its **own** coordinate frame — orientation, centroid,
and scale are arbitrary, picked by the algorithm's initial seeding +
its force or stress balance. Without anchoring it to basePos's frame,
the slider transition from α=0 (basePos) to α=1 (citationPos) makes
nodes fly across the screen in arbitrary directions, and the citation
arrangement at α=1 might also sit at a much larger or smaller scale
than basePos — both of which read as "the camera moved" rather than
"the topology rearranged." Alignment fixes both.

**Encapsulation.** This is the *only* place in the codebase where
citationPos and basePos meet. The layout module never sees basePos;
the per-frame blend in §2 consumes the OUTPUT of this alignment, not
the raw layout positions.

### 1.1 Why per-component (not whole-graph)

A single similarity transform across the whole graph forces a
compromise: two components whose basePos centroids are far apart, or
whose intrinsic densities differ, can't all be aligned
simultaneously. Per-component handles each independently:

- A component's **internal geometry** is dictated by Layer 4's
  algorithm. It carries topological information (which nodes cite
  which). We preserve it by applying a similarity transform —
  rotation × uniform scale × translation only, no per-node
  deformation. Uniform scaling is a similarity transform, so angles
  and intra-component distance ratios are preserved intact; only the
  absolute scale shifts.
- A component's **overall position, orientation, AND scale** in space
  are underdetermined by topology. We pick a translation + rotation
  that minimises RMSD to basePos and a scale that matches RMS norm.

### 1.2 Singletons

A degree-0 node is a singleton component. Similarity alignment on one
point is just translation: the node lands exactly at its basePos.

This is exactly the right answer for isolated nodes — they have zero
topological constraint, so their citation-layout position should
default to wherever basePos says they belong.

### 1.3 Algorithm (per component)

For each connected component with node ids `{i₀, i₁, …}`:

1. **Centroids**:
   ```
   c    =  Σ citationPos[i] / m
   bc   =  Σ basePos[i]     / m
   ```
2. **Cross-correlation** `S` (3×3, `a` = citationPos centred,
   `b` = basePos centred), plus squared-norm sums:
   ```
   S_xy   =  Σ a_x b_y     etc.
   sumA²  =  Σ |a|²
   sumB²  =  Σ |b|²
   ```
3. **Horn's symmetric 4×4 matrix** `N` (entries built from the `S`
   sums; see `align.js` for the explicit construction). The
   eigenvector of N's largest eigenvalue is the unit quaternion of
   the optimal rotation that maps `a → b`.
4. **Eigendecomposition** via cyclic Jacobi (50 sweeps max, `1e-12`
   off-diagonal threshold). Pick the largest eigenvalue; normalise
   its eigenvector to a unit quaternion `(qw, qx, qy, qz)`. Build
   `R` from the quaternion (standard formula).
5. **Scale**:
   ```
   s  =  √(sumB² / sumA²)
   ```
   Match-the-RMS-norm. See §1.4 for why not Procrustes-optimal.
6. **Apply** to each node in the component:
   ```
   alignedCitationPos[i]  =  s · R · (citationPos[i] − c)  +  bc
   ```

### 1.4 Match-RMS scale vs Procrustes-optimal scale

Two natural choices for the scale, with the same `R` from step 4:

```
s_match_rms    =  √(sumB² / sumA²)
s_procrustes   =  trace(R · S) / sumA²    =  eigvals[best] / sumA²
```

The two coincide for perfectly aligned layouts and diverge as
alignment quality drops. The ratio `s_procrustes / s_match_rms` is a
Pearson-style correlation coefficient between `R·a` and `b` — see
§1.5.

**Procrustes-optimal** is the textbook choice — it minimises
`Σ |s·R·a − b|²` over `s`, the natural least-squares objective. But
for **partially correlated** layouts (which citation-driven and
basePos-driven layouts are by design — taste network biases edges
toward spatially-close pairs in basePos, so the topologies agree
about cluster structure, but Layer 4's algorithm finds its own 3D
embedding of that topology), Procrustes shrinks the source
proportional to alignment quality. Half-correlated layouts get
half-scale, and the slider at α=1 reads as "the camera zoomed out"
rather than "the topology rearranged."

**Match-RMS** decouples scale from alignment quality. The source's
RMS extent always equals the target's, regardless of how well
rotation aligns them. `R` still does the orientation work; `s` just
keeps the visible scale comparable.

For perfectly aligned inputs the two are identical, so this only
matters for the imperfectly-aligned case — which is the common case.

### 1.5 The correlation coefficient as a quality metric

The ratio `s_procrustes / s_match_rms` is a number in `[0, 1]` that
measures how well the layout's topology can be aligned with basePos
by a similarity transform:

```
correlation_c  =  trace(R_c · S_c)        (per component c)
                  ─────────────────
                  √(sumA²_c · sumB²_c)
```

- 1.0 = perfect alignment (the layout IS basePos modulo similarity).
- 0.0 = uncorrelated (random shuffle gets ~0.10–0.16 in our test
  graph; pure geometric coincidence keeps it above 0).
- ~0.5 = typical for citation-driven layouts of well-connected
  graphs.

A single global correlation is aggregated across components weighted
by `√(sumA²_c · sumB²_c)`:

```
correlation_global  =  Σ_c trace(R_c · S_c)
                       ──────────────────────────
                       Σ_c √(sumA²_c · sumB²_c)
```

(Singletons have zero variance and contribute 0/0; they're skipped.)

`alignByComponent` returns `{ aligned, correlation }` and main.js
caches the global value on `state.alignmentCorrelation`. Surfaced in
the **Citation Layout ▾** modal as a live "current params" reading,
and used as the ranking metric for the layout sweep ("Find best
params").

### 1.6 Cost

`O(N + |E|)` for union-find on the citation graph + per-component
math (3×3 cross-covariance and 4×4 Jacobi eigendecomp per component).
Sub-millisecond for typical toy sizes.

**Scaling.** This layer is one of the few in the pipeline that
scales naturally to the real-data regime. At `n = 800k` and
`|E| = 1.9M`, alignment is `~2.7M` integer ops + per-component
Jacobi over a 4×4 matrix (constant per component, total cost
proportional to component count, not `n`). Expect sub-second wall
time even at full scale. The per-component pattern is the right
abstraction at any scale — see `doc/scaling.md` §2.6.

Runs once when the citation graph or layout params change; cached
on `state.alignedCitationLayout`.

### 1.7 Failure modes

- **Components overlap** if their basePos centroids happen to
  coincide. Per-component alignment can't separate them — it has no
  inter-component repulsion. Geometrically correct (no edges between
  the components, so no spacing constraint), but visually possibly
  confusing. An inter-component spacing pass is wishlist material;
  defer until two components actually collide visually in normal use.
- **Two-node components** have a degenerate rotation (rotation around
  the axis between the two points is undefined). Horn picks one
  valid rotation deterministically; the choice is arbitrary but
  consistent across runs at the same seed.
- **Coincident points within a component** (`sumA² ≈ 0`) make scale
  undefined. Defensive fallback: `s = 1`, behaves as rotation-only.

### 1.8 Whole-graph alignment for pre-fusion → post-fusion

`alignGlobal({ target, source, n })` returns
`{ aligned, correlation }` using the same Horn-quaternion + match-
RMS-scale + translation machinery as `alignByComponent`, but
applied to a single all-nodes "component" with no edges argument.
Designed for the fusion-comparison slider's pre-fusion → post-
fusion alignment.

**Why a separate function:** the pre-fusion vs post-fusion basePos
pair are two UMAP-3 fits of nearly-identical embeddings. They
agree topologically but disagree on orientation because UMAP picks
an arbitrary rotation per fit. Per-connected-component logic
makes no sense here — both layouts cover the same node set as a
single rigid body. Calling `alignByComponent` with a fake
fully-connected edge list would work but cost `O(n²)` for the
edge set; the global variant is `O(n)`.

**Where it's called from:** `app/src/ui/engine.js`'s `redimred()`
lane. When fusion is non-identity, after computing both
post-fusion `_basePos` and pre-fusion `_basePosPreFusion` via two
parallel viz UMAP fits, the pre-fusion buffer is overwritten with
`alignGlobal(target=postFusion, source=preFusion).aligned`. The
fusion-comparison slider in `blend/blend.js` then walks the short
geometric path between the two layouts instead of corkscrewing
through arbitrary intermediate rotations.

Same correlation interpretation as §1.5: a number in [0, 1]
measuring how rigidly one basePos can be mapped onto the other.
Typical values: ~0.7–0.95 (the two are very similar; PCA + UMAP
on slightly-different inputs produces near-identical topologies).

The function is exported alongside `alignByComponent`; both
share the inner `alignSubset(ids, target, source, out)` helper.

---

## 2. Per-frame blend (nested lerp)

`app/src/blend/blend.js`. Pure linear interpolation, applied to
every data node every frame, but now over **two stacked axes**:

```
effective_i  =  (1 − f) · preFusionBasePos_i  +  f · basePos_i      (inner)
live_i       =  (1 − α) · effective_i        +  α · alignedCitationPos_i   (outer)
```

with `α ∈ [0, 1]` (the existing blend slider, `state.blend`) and
`f ∈ [0, 1]` (the fusion-comparison slider, `state.fusionBlend`).
No state, no momentum, no constraint solver.

When `preFusionBasePos` is null (toy mode, identity fusion, or a
data source that didn't trigger pre-fusion compute), the inner
lerp collapses to `basePos` and the outer lerp reduces to the
original two-endpoint formula. When `alignedCitationPos` is null
(citation layout not yet applied — see §3 on the opt-in cascade),
the hook bails entirely and `node.x/y/z` stay at their last write
— visually the `α` slider does nothing until the user applies a
citation layout.

### 2.1 Why linear

The two endpoints are static and deterministic; the path between them
should be too. Linear interpolation is the cheapest, most predictable
choice that lands exactly on each endpoint at α = 0 and α = 1.

It's linear **in position**, not in edge length. An edge whose two
endpoints are far apart in basePos and close in citationPos passes
through every intermediate distance — the interpolation is geometric,
not topological. A "minimum-stress path" that finds an intermediate
arrangement minimising max-edge-distortion would be a more
sophisticated alternative; deferred to future work because the
visible result of pure linear blend is already smooth and the
deterministic round-trip property is hard to give up.

### 2.2 Properties

- **Endpoint exactness.** At α = 0, `live === basePos` byte-identical.
  At α = 1, `live === alignedCitationPos` byte-identical.
- **Round-trip exactness.** Sweeping α from 0 → 1 → 0 returns the
  network to basePos with zero residual drift (verified to floating-
  point precision: ~0.0000 across the entire data set in
  `scratch/v3_phase3_smoke.py`).
- **No oscillation, no overshoot, no momentum.** The slider is a pure
  animation parameter; nothing accumulates.
- **N-independent per node.** Per-frame work is `n` lerps,
  independent of citation density or graph structure. At `n = 800k`
  and 60 fps that's 48 M lerps/s — trivial in any reasonable
  runtime, and the only Layer-5 cost that scales linearly with `n`
  rather than with component count.

### 2.3 Implementation

Registered as a d3-force-3d "force" hook so it runs every tick of the
lib's animation loop, but mutates `node.x/y/z` directly instead of
modifying velocities. `Graph.d3VelocityDecay(1.0)` is set so the
lib's `x += vx; vx *= 0` integration is a no-op alongside our writes
— any stray velocity from drag interactions or lib internals zeroes
each tick. The blend hook owns motion entirely.

The hook closes over **five** getter callbacks (`getBasePos`,
`getBasePosPreFusion`, `getAlignedCitationPos`, `getBlend`,
`getFusionBlend`); the registration is stable across the program's
lifetime, and downstream changes (slider drag, citation reroll,
regeneration, layout-algorithm swap, fusion-param change) take
effect on the next frame by mutating what those getters return.

Slider drag still calls `Graph.d3ReheatSimulation()`. The d3
simulation tick freezes when "the network looks settled," which is
instantly true under deterministic blending; without reheat-on-drag,
slider drags after the first second go ignored. The reheat is the
only reason d3's tick scheduling stays involved at all. **Both
sliders** (`state.blend` and `state.fusionBlend`) trigger reheat
via `viewer-3d.js`'s update handler — comparing each subscribed
update's value against the last observed.

### 2.4 What the per-frame hook does NOT do

- It does **not** re-run alignment. Alignment happens once per
  cascade (Layer 5a triggers; §3 of this doc).
- It does **not** observe `state.layerStates`. If
  `alignedCitationPos` is null because the user hasn't applied a
  layout, the hook silently bails — workflow chart status dots
  (orange / stale) are the visual cue.
- It does **not** care which Layer 4 algorithm produced the
  citation layout (FR / MDS / UMAP-on-graph). All three feed the
  same `state.alignedCitationLayout` slot through `relayoutCitations()`.

---

## 3. Recompute lanes (opt-in citation layout)

| Trigger                                              | What recomputes                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| α slider drag                                        | per-frame lerp only — both endpoint buffers stay cached                                                  |
| Fusion slider drag                                   | per-frame lerp only — pre-fusion and post-fusion basePos stay cached                                     |
| Citation graph changes (Layer 3 emits new edges)     | `markCitationLayoutStale()`: clears layout/alignment, marks layerStates stale. **No auto-relayout.**     |
| Fusion params change                                 | Layer 1.5 re-runs (both pre- and post-fusion paths) → Layer 2 re-clusters both → Layer 3 → stale-mark   |
| Citation Layout modal Apply (algo / param change)    | Layer 4 layout → Layer 5a alignment → next blend tick reflects. **Explicit user action only.**           |
| Generation regenerates                               | basePos buffer + everything downstream                                                                   |

### Opt-in citation layout (§6.16 in the plan)

The pipeline cascade STOPS at Layer 3. After Layer 3 publishes a
new `citationResult`, the engine calls
`markCitationLayoutStale()`:

```js
update({
  citationLayout:        null,
  alignedCitationLayout: null,
  alignmentCorrelation:  NaN,
});
setLayerState("layout",    "stale");
setLayerState("alignment", "stale");
setLayerState("blend",     "stale");
```

`relayoutCitations()` only runs when the user explicitly applies
in the Citation Layout modal (`modals/layer-descriptors.js` calls
`engine.relayoutCitations()` from the Apply handler). Workflow
chart shows orange dots on layout / alignment / blend until then;
the `α` slider visually does nothing because the blend hook bails
on null `alignedCitationPos`.

This avoids re-running expensive layout passes (UMAP-on-graph at
n=5000 is 5–15 s) every time the user tweaks a fusion param. It
subsumes the layout-cache optimisation that was originally
deferred under §6.15.

### Where the buffers live

`state._basePos` is repopulated by Layer 1.5's viz sub-stage on
every dim-reduction run. `state._basePosPreFusion` is repopulated
by the parallel pre-fusion viz path when fusion is non-identity
(null otherwise). `state.citationLayout`,
`state.alignedCitationLayout`, and `state.alignmentCorrelation`
are populated only by an explicit `relayoutCitations()` call.

The blend force hook reads these buffers through getters every
tick; mutating the buffers takes effect on the next frame without
re-registering the hook. **This is the part that's easy to break.**
Re-registering the hook or rebinding nodes when state changes
downstream is how the previous version of this project broke; don't
do it.

---

## 4. Why deterministic blend, not constraint solver

(Historical context; v2 used a damped spring system, v3 replaced it.)

The previous spring-force / PBD layer drove layout through pairwise
distance constraints + velocity + integration. Three problems
compounded:

1. **Momentum stored energy.** Slider nudges injected impulse into
   velocities; the network rang out for seconds afterwards.
2. **Per-tick force scaled with N.** At high citation density, every
   node had hundreds of constraints firing per tick. The integrator
   wasn't stable.
3. **Distance constraints are rigid-body invariant.** Asymmetric
   impulses imparted angular momentum and the network rotated visibly
   during α sweeps.

Each fix layered another defensive cap (extension clamp, per-node
force cap, Kabsch-per-tick to remove rigid drift, weighted Jacobi to
remove iteration-order bias). The user-visible behaviour we wanted —
"α deforms the layout according to citation topology" — has no need
for momentum or time-step coupling. v3 deletes the entire spring/PBD
layer and replaces it with deterministic blend between two static
endpoints.

The v3 model has none of those problems by construction:

- No velocities = no momentum = no oscillation.
- α changes are O(1) per node, not O(degree).
- Per-component Kabsch alignment runs once per relayout, not per
  tick. There's no rigid drift to correct.

The cost is that the slider is "just" an interpolation parameter, not
the hot knob of a dynamical system. The user explicitly framed v3
as a topology-comparison demo rather than a physics demo, so this is
the right tradeoff.

---

## 5. Versioning

The blend layer's contract — what `relayoutCitations()` populates on
state and what the blend hook reads — is stable. If it changes,
update this doc first, then code.

### Changelog

- **v3 stage 3**: blend layer introduced. State buffers
  `state._basePos`, `state.alignedCitationLayout`, `state.blend`.
  Linear lerp; per-frame work in `app/src/blend/blend.js`.
- **v3 stage 6**: alignment promoted from rotation-only to similarity
  transform (added uniform scale per component). Initial choice of
  Procrustes-optimal scale rejected in favour of match-RMS (see §1.4).
- **v3 stage 8**: alignment now also returns `correlation` ∈ [0, 1]
  alongside `aligned`. Surfaced as `state.alignmentCorrelation`.
  Used as the ranking metric for the cross-algorithm layout sweep
  added in the same stage.
- **§6.15 (2026-05-20)**: per-frame blend extended to a nested
  lerp over two sliders (`blend` × `fusionBlend`). Hook closes
  over five getter callbacks instead of three; reads
  `_basePosPreFusion` and `getFusionBlend`. Added §1.8
  `alignGlobal` for whole-graph Procrustes used on the pre-fusion
  → post-fusion endpoint pair. See `doc/fusion.md` for the full
  fusion layer spec.
- **§6.16 (2026-05-20)**: citation layout opt-in. Cascade stops at
  Layer 3 via `markCitationLayoutStale()`; `relayoutCitations()`
  only runs from the Citation Layout modal's Apply. Blend hook
  silently bails when `alignedCitationPos` is null. See §3.
