# Citation-aware embedding fusion (Layer 1.5 fusion sub-stage)

This document is the source of truth for Layer 1.5's **fusion**
sub-stage: what it does mathematically, why it sits between noise
and compression, how the fusion-comparison slider works, and what
the cluster A/B colour mode shows.

Implementation in `app/src/dimred/graph-diffusion.js` plus the engine
wiring in `app/src/ui/engine.js`'s `redimred()` / `recluster()` lanes.

> **Ghost nodes:** metadata-less citation participants (`isGhost`) have no
> anchor `X`, so they ride this stage as **no-self-anchor conduits** — excluded
> from the `(1−α)·X` teleport term (`α_eff = 1`), they transmit a shared
> neighbour's signal along `A→G←B` without injecting a fabricated anchor. This is
> the stage where a shared ghost actually pulls two real nodes together. See
> `doc/ghost-nodes.md`.

---

## 1. Why fusion exists

The toy started with **two parallel views** of the same dataset:

- **basePos** — UMAP-3 of the SPECTER2 embedding (semantic
  similarity).
- **citation-topology layout** — FR / MDS / UMAP-on-graph on the
  citation graph (who-cites-whom topology).

The Layer 5 blend slider interpolates between those two views,
which answers *"do the two signals agree?"* — but cannot answer
*"what does the topic map look like when the two signals are
**combined** into a single representation?"*. The two-view design
is a **comparison**; fusion is an **integration**.

Empirically, the cross-view comparison at α=0 (basePos) coloured
by clusters defined at α=0 looks coherent — same papers, same
clusters, same colours form clean regions. But the same colours
at α=1 (citation layout) scatter into noise: a cluster defined in
semantic space rarely survives the morph to citation space. That
scattering is itself a strong measurement — **the two signals
encode genuinely different relationships**, with alignment
correlation ≈ 0.5 on the BFS-5000 SPECTER2 subset.

Fusion takes a different question: *let citations inform the
embedding before clustering happens*. The output is a new 768-d
(or post-PCA 100-d) representation that mixes each paper's
SPECTER2 vector with the mean of its citation neighbours'
vectors. Downstream clustering, dim-reduction, and the viewers
all see this fused representation. The fusion-comparison slider
then asks *which papers moved when citation context was folded in*.

---

## 2. Architectural placement

Layer 1.5 now has **five sub-stages**:

```
embedding ─▶ noise ─▶ fusion ─┬─▶ compression ──▶ dimredResult (clustering input)
                              │
                              ├─▶ viz         ──▶ _basePos     (3D viewer / blend)
                              │
                              └─▶ viz2d       ──▶ _basePos2d   (2D viewer)
```

Fusion is a **lateral** stage — input dimension equals output
dimension. It does not reduce, it re-weights. Sits between noise
(typically PCA-100) and the sibling triple (UMAP-100 / UMAP-3 /
UMAP-2) so that:

- PCA denoises first, removing the variance directions that don't
  carry topic signal.
- Fusion then re-weights the cleaned representation by citation
  context, before UMAP commits to a manifold.
- All three siblings read fusion's output, so clustering and both
  viewers operate on the same fused representation.

Defaults:

- Toy mode: `fusion.method = "identity"` (pass-through). Toy's
  citations are *generated* by taste-network *after* clustering,
  so there's a chicken-and-egg with running fusion on the first
  pass. Two-pass toy fusion is deferred.
- Real-data mode: `fusion.method = "identity"` initially. User
  opts into `graph-diffusion` via the dim-reduction modal's new
  fifth section.

---

## 3. Algorithm: anchored graph diffusion (APPNP)

`app/src/dimred/graph-diffusion.js`. Iterates a convex combination
of the original vectors and the citation-neighbour mean:

```
X'⁽⁰⁾   =  X
X'⁽ᵏ⁺¹⁾ =  (1 − α) · X  +  α · (D⁻¹ A) · X'⁽ᵏ⁾
```

where `A` is the symmetrised citation adjacency (A ∨ Aᵀ), `D` is
its degree matrix, and `α ∈ [0, 0.999]` is the **mixing
strength** (UI convention: higher α → more citation influence).

### 3.1 Convention vs the published APPNP paper

APPNP (Klicpera, Bojchevski, Günnemann; ICLR 2019) defines `α` as
the **teleport probability** — its α=1 means "stay at X", α=0
means "pure diffusion". We use the inverse convention so the
slider reads intuitively (right = more fusion). Mathematically
equivalent under relabeling: `α_ours = 1 − α_APPNP`.

### 3.2 Why anchored, not pure

Pure diffusion `X' ← D⁻¹A X'` drifts toward each connected
component's stationary distribution — papers lose their original
SPECTER2 identity entirely after enough iterations. The anchored
form keeps `(1 − α) X` as a per-iteration restoring term, so X'
converges to a finite mixture rather than a degenerate limit:

```
X'∞  =  (1 − α) · (I − α · D⁻¹A)⁻¹ · X
```

The inverse is well-defined for `α < 1` because the spectral
radius of `D⁻¹A` is 1 and we clamp `α ≤ 0.999`.

### 3.3 Why symmetric adjacency

Direction matters in citation graphs (a methodological paper
cited by many vs a survey citing many are structurally different
roles), but for **positional** fusion both endpoints of a citation
should be pulled together. Asymmetric diffusion would propagate
"papers I cite" separately from "papers that cite me" — a richer
model but harder to interpret in a single position. Symmetric
A ∨ Aᵀ is the MVP choice; asymmetric is a one-line toggle if
needed.

### 3.4 Isolated nodes

A node with degree 0 has `D[i,i] = 0`, making `D⁻¹` undefined for
its row. The implementation handles this by setting `invDeg[i] = 0`
for isolated rows; combined with the anchor term, `X'[i] = (1−α) X[i]
+ 0 = (1−α) X[i]` — the isolated node converges to its own
shrunk SPECTER2 vector. UMAP downstream then handles the scale
discrepancy naturally. (BFS-5000 has 100% coverage so no isolated
rows arise there.)

### 3.5 Cost

`O(k · |E| · d)` where `k` = iterations, `|E|` = edges, `d` =
embedding dimension. At BFS-5000 with `k = 4`, `|E| = 12 268`,
`d = 100` (after PCA): ~5 M ops. Sub-second. Without PCA
(`d = 768`): ~38 M ops. Still sub-second.

The full redimred lane at n=5000 climbs from ~25 s (pre-fusion
shape) to ~45 s with fusion enabled, because the engine ALSO
runs compression + viz on the pre-fusion noise output for the
A/B comparison (§5). The diffusion itself isn't the bottleneck —
UMAP is.

### 3.6 Parameters

| Param        | Default | Range    | Effect                                                                 |
|--------------|---------|----------|------------------------------------------------------------------------|
| `alpha`      | 0.3     | [0, 0.95]| Mixing strength per iteration. 0 = identity; higher = more fusion.    |
| `iterations` | 4       | [1, 20]  | Diffusion depth (hops). Each iteration moves info one hop along A.    |

At `α = 0.3, k = 4`, each paper's vector ends up as roughly:

- 70% own SPECTER2 vector (per iteration's anchor)
- ~24% direct citation neighbours
- ~6% 2-hop neighbours
- < 2% beyond

Sensible mild fusion. Crank α to 0.7 or k to 8 for dramatic
effects; community structure tightens at the cost of original
semantic identity.

---

## 4. Engine wiring

`app/src/ui/engine.js`:

- `produceReal()` fetches `citation_edges.json` at ingest and
  flattens to `[src, dst, src, dst, …]` form, stashed in
  `state.rawCitationEdges` (Int32Array on load, plain Array on
  ingest — algorithm consumers don't care).
- `ensureLayerParams()` injects a `fusion` slot defaulting to
  identity if missing. Older saves load cleanly.
- `redimred()` runs `fusion` between noise and the sibling
  triple. The injected `params.adjacency = state.rawCitationEdges`
  is what the graph-diffusion compute function consumes; identity
  ignores it.

```js
const fusionParams = {
  ...(cfg.fusion.params || {}),
  adjacency: state.rawCitationEdges || [],
};
const rFusion = fusionAlgo.compute(noiseOut, fusionParams);
```

When fusion is non-identity, `redimred()` ALSO runs compression +
viz on the pre-fusion noise output, then runs `alignGlobal()`
(see `doc/blend.md` §1.8) to bring the pre-fusion basePos into
the post-fusion basePos's orientation. Result: `_basePosPreFusion`
sits in the same frame as `_basePos`, so the fusion-comparison
slider's linear interpolation walks the short geometric path
between them.

`recluster()` then clusters on BOTH `dimredResult` and
`dimredResultPreFusion` (via a shared `runClusterLevels()`
helper) when fusion is active, producing `clusterLevels` plus
`clusterLevelsPreFusion`.

---

## 5. The fusion-comparison slider

A second slider next to the existing blend slider, labelled
**fusion**. Bound to `state.fusionBlend ∈ [0, 1]`. Auto-hides in
the left rail when `_basePosPreFusion` is null (toy mode,
identity fusion, or before a fusion run has produced one).

The Layer 5b blend hook (`app/src/blend/blend.js`) now closes
over five getter callbacks instead of three and computes a
**nested lerp** per frame:

```
effectivePos[i] = lerp(_basePosPreFusion[i], _basePos[i], fusionBlend)
livePos[i]      = lerp(effectivePos[i],     alignedCitationPos[i], blend)
```

When either pre-fusion buffer is null (identity / toy) or
fusionBlend is pinned at 1.0, the inner lerp collapses to
`_basePos` and the hook behaves identically to the original
two-endpoint design.

### 5.1 Four corners of (fusion, blend) space

|              | blend = 0                          | blend = 1                                          |
|--------------|------------------------------------|----------------------------------------------------|
| fusion = 0   | pre-fusion semantic basePos        | citation layout aligned to pre-fusion basePos      |
| fusion = 1   | post-fusion (citation-aware)       | citation layout aligned to post-fusion basePos     |

Each slider is independently round-trip exact. Both can be
dragged simultaneously; the four-corner grid is the full
navigable space.

### 5.2 Why pre-fusion → post-fusion needs Procrustes

UMAP picks an arbitrary rotation per fit, so two UMAP-3 runs on
near-identical inputs produce same-topology, different-orientation
layouts. Linear interpolation between unaligned layouts sends
points corkscrewing through nonsense intermediate paths.

Fix: `alignGlobal()` in `blend/align.js` — whole-graph Horn-
quaternion rotation + match-RMS-scale + translation. Same
mathematical machinery as `alignByComponent` (the per-connected-
component variant used for the citation layout) but treats the
whole node set as one rigid body and ignores edges. Run once per
`redimred()` cascade when fusion is non-identity.

---

## 6. The "Cluster — pre-fusion" colour mode

A new colour-mode family `clusterPre:N` (one per cluster level)
becomes available in the 2D + 3D viewers' colour-mode dropdown
when `state.clusterLevelsPreFusion` is non-null.

What it shows:

- **Position** = whichever the fusion slider currently picks
  (lerp of pre/post basePos).
- **Colour** = the node's cluster id from the **pre-fusion**
  clustering pass.

Dragging the fusion slider while this mode is active = papers
move from their pre-fusion to post-fusion positions while
*keeping their pre-fusion cluster colour*. Where the colours
stay coherent at fusion=1, citation context preserved that
cluster's identity. Where colours scatter, citation context
reorganised those papers across multiple new clusters — those
are interesting candidates for closer inspection.

This is the quantitative-eyeball version of cross-view stability:
*are the clusters defined in semantic space still recognisable in
citation-aware space?*. To turn it into a number, run NMI / ARI
between `clusterLevels[i]` and `clusterLevelsPreFusion[i]` — not
shipped in the eval surface yet (§6.15 follow-up).

---

## 7. Persistence

State slots written by the save zip:

- `state.layerParams.dimred.fusion` (JSON pass-through, tiny).
- `state.fusionBlend` (number).
- `state.rawCitationEdges` (Int32Array, `arrays/rawCitationEdges.i32`).
- `state._basePosPreFusion` (Float32Array(n·3), `arrays/basePosPreFusion.f32`).
- `state.dimredResultPreFusion` (Float32Array payload + JSON metadata).
- `state.clusterLevelsPreFusion` (parallel to clusterLevels, with
  per-level Int32Array / Uint8Array payloads under `arrays/clusterLevels/pre.N.*`).

No SCHEMA_VERSION bump. `ensureLayerParams()` injects an identity
fusion slot into older states on load.

---

## 8. Failure modes worth knowing

- **Toy mode fusion is identity-only.** Citations come from
  taste-network *after* clustering, so the first redimred pass
  has no edges to fuse against. Two-pass toy mode (run pipeline,
  then re-cascade with the generated citations as fusion input)
  is deferred. For now: fusion is a real-data feature.
- **Cost doubles when fusion is enabled.** Auto-cascade re-runs
  compression + viz on both pre-fusion and post-fusion paths,
  then clusters both. At n=5000 the redimred lane goes from ~25 s
  to ~45 s. §6.11 (Web Worker port) cuts both halves in parallel
  when picked up.
- **Stability across α changes is bounded by UMAP determinism.**
  Different `α` values produce different fused embeddings, which
  produce slightly-different UMAP-3 layouts even with the same
  seed (UMAP's optimiser is stochastic in initialisation). The
  pre-fusion → post-fusion Procrustes mitigates the orientation
  drift, but small intra-cluster shifts that aren't rigid-body
  motions can still appear. They're real — fusion *does* move
  points — but the user shouldn't read every per-node motion as
  meaningful.
- **PCA-100 before fusion is the recommended path.** Fusion on
  raw 768-d works but consumes ~8× the compute (mostly UMAP's,
  which dominates). PCA-100 first keeps the high-variance
  directions (which carry the topic signal SPECTER2 was trained
  to encode) and discards the low-variance noise. Citation
  diffusion on the cleaner representation is sharper.

---

## 9. Cross-references

- `doc/blend.md` §1 — per-component alignment + §1.8 new
  whole-graph `alignGlobal` used for pre/post-fusion alignment.
- `doc/blend.md` §2 — nested-lerp form of the per-frame blend.
- `doc/citation-layout.md` §3 — UMAP-on-graph; the only
  citation-layout algorithm specifically designed for the same
  graph the fusion stage reads (BFS-5000 / sparse n ≥ 1000).
- `doc/dynamics.md` §4 — the higher-level "layout dynamics"
  picture that the fusion + blend together implement.
- `doc/blend.md` §3 — citation-layout opt-in policy (cascade stops
  at Layer 3; fusion-adjacent because it gates whether changing
  fusion params re-runs the layout).
