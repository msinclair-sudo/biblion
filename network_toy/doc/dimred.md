# Layer 1.5 — Dim-reduction

Pluggable dim-reduction stage between Layer 1 (data source) and
Layer 2 (clustering), same registry pattern as every other layer.
Source: `app/src/dimred/`.

This document is the contract + orchestration overview. Algorithm
math sits in source headers and (for the fusion sub-stage) in
`doc/fusion.md`.

---

## 1. Five sub-stages

```
embedding ─▶ noise ─▶ fusion ─┬─▶ compression ──▶ dimredResult (clustering input, e.g. UMAP-100)
                              │
                              ├─▶ viz         ──▶ _basePos     (3D viewer / blend, UMAP-3)
                              │
                              └─▶ viz2d       ──▶ _basePos2d   (2D viewer, UMAP-2)
```

| Sub-stage     | Purpose                                                          | Output written to                  | Default        |
|---------------|------------------------------------------------------------------|-------------------------------------|----------------|
| `noise`       | Denoise the input embedding (typically PCA-100)                  | (intermediate; consumed by next)    | identity       |
| `fusion`      | **Lateral** — re-weight by citation context. Same d in as out    | (intermediate; consumed by siblings) | identity       |
| `compression` | Reduce to clustering input (UMAP-100 at real-data scale; §6.9 verdict 2026-05-25) | `state.dimredResult`         | identity       |
| `viz`         | Reduce to 3-d for the 3D viewer / Layer 5 blend                  | `state._basePos`                    | identity       |
| `viz2d`       | Reduce to 2-d for the 2D viewer panel                            | `state._basePos2d`                  | identity       |

Compression, viz, and viz2d are **siblings** — all three read the
fusion stage's output (which is identity-equivalent to noise's
output when fusion is off). They run independent fits with
distinct seeds so re-running one doesn't disturb the others.

Defaults are identity everywhere, so an unconfigured Layer 1.5
behaves as pass-through. Picking an algorithm in a slot triggers
its `defaultParamsForSlot(slot)` so the user lands at the
locked-default config for that slot rather than generic numbers
(see §3).

---

## 2. Registry contract

`app/src/dimred/registry.js` exposes:

- `ALGORITHMS: Algorithm[]` — entries indexed by id.
- `getAlgorithm(id)` — throws on unknown ids.
- `listAlgorithms(slot?)` — slot-filtered list (no slot → all
  entries; slot → entries whose `family` includes the slot OR
  the `"any"` wildcard).

Each entry shape:

```ts
{
  id:            string,                // unique algorithm id (also the method field on outputs)
  label:         string,                // UI display name
  family:        string[],              // eligible slots: subset of ["noise","fusion","compression","viz","viz2d","any"]
  description:   string,                // one-paragraph "what this is good for" prose
  defaultParams: () => object,          // slot-agnostic baseline params
  defaultParamsForSlot?: (slot) => object,  // optional slot-aware override
  compute:       (input, params) => DimredResult,
  modalSchema:   FieldSchema[],         // describes sliders / dropdowns + sweep grids
}
```

Algorithm signature:

```ts
compute(input, params) → DimredResult
  input  = { n: int, d: int, data: Float32Array(n * d) }
  output = { method: string, params: object, n, d, data: Float32Array(n * d) }
```

Output is validated against `app/src/dimred/contract.js`'s
`validateDimredResult()` on every redimred() — contract violations
surface at the engine boundary, not three layers downstream.

---

## 3. Currently-registered algorithms

| id                 | Module                               | Families                                  | Notes                                                                  |
|--------------------|--------------------------------------|-------------------------------------------|------------------------------------------------------------------------|
| `identity`         | `app/src/dimred/identity.js`         | `["any"]`                                 | No-op pass-through. The "skip this stage" option.                      |
| `pca`              | `app/src/dimred/pca.js`              | `["noise"]`                               | Recommended `n_components = 100`.                                      |
| `umap`             | `app/src/dimred/umap.js`             | `["compression", "viz", "viz2d"]`         | Wraps umap-js. Slot-aware defaults per §3.1 below.                     |
| `graph-diffusion`  | `app/src/dimred/graph-diffusion.js`  | `["fusion"]`                              | Anchored citation-aware diffusion. See `doc/fusion.md` for the spec.   |

### 3.1 Slot-aware defaults (recommended)

`defaultParamsForSlot(slot)` returns the locked configuration for
each slot (the UMAP-100 compression default is empirically validated
in `doc/dim-sweep-results.md`):

| Algorithm × slot          | Locked params                                                            |
|---------------------------|--------------------------------------------------------------------------|
| `pca` × `noise`           | `n_components = 100`                                                     |
| `umap` × `compression`    | `n_components = 100, n_neighbors = 50, min_dist = 0,  metric=cosine, seed=42` (was 50; bumped per §6.9 dim-sweep) |
| `umap` × `viz`            | `n_components = 3,  n_neighbors = 15, min_dist = 0.1, metric=cosine, seed=43` |
| `umap` × `viz2d`          | `n_components = 2,  n_neighbors = 15, min_dist = 0.1, metric=cosine, seed=44` |
| `graph-diffusion` × `fusion` | `alpha = 0.3, iterations = 4`                                          |

The three UMAP seeds are distinct so re-running one viz fit
doesn't disturb the other two.

---

## 4. Engine orchestration

`app/src/ui/engine.js`'s `redimred()` lane runs the five stages in
order:

1. `input0` — picked from `state.embedding` (real data) or
   `state._basePos` packed into a DimredInput (toy data —
   basePos doubles as the embedding).
2. **Stage 1 — noise**: `noiseAlgo.compute(input0, params)` →
   `noiseOut` (validated against the contract).
3. **Stage 1.5 — fusion**: `fusionAlgo.compute(noiseOut,
   {...fusionParams, adjacency: state.rawCitationEdges})` →
   `fusionOut`. The adjacency injection is what makes
   `graph-diffusion` work; `identity` ignores it.
4. **Stage 2a — compression**: `compAlgo.compute(fusionOut,
   params)` → `r2`. Written to `state.dimredResult` for Layer 2.
5. **Stage 2b — viz**: `vizAlgo.compute(fusionOut, params)` →
   `r3`. Adopted as `state._basePos` (after centre + isotropic
   scale to `VIEWER_TARGET_RMS = 90` when the output is 3-d).
6. **Stage 2c — viz2d**: `viz2dAlgo.compute(fusionOut, params)`
   → `r4`. Adopted as `state._basePos2d` when the output is 2-d.

When fusion is non-identity (`fusionCfg.method !== "identity"`),
the engine ALSO runs compression + viz on the pre-fusion
`noiseOut` to produce parallel `dimredResultPreFusion` +
`_basePosPreFusion` for the fusion-comparison slider. The
pre-fusion `_basePosPreFusion` is then Procrustes-aligned to
`_basePos` via `alignGlobal()` (`doc/blend.md` §1.8) so the
slider walks the short geometric path between the two layouts
instead of corkscrewing through arbitrary UMAP rotations.

After redimred(), the engine cascades into `recluster()` — which
also runs twice when `dimredResultPreFusion` is present, producing
the parallel `clusterLevelsPreFusion` for the "Cluster —
pre-fusion" colour mode (`doc/fusion.md` §6).

---

## 5. State slots written

| Slot                                       | Type                          | Populated by                                          |
|--------------------------------------------|-------------------------------|--------------------------------------------------------|
| `state.dimredResult`                       | `DimredResult` (n×d float32)  | Compression stage every redimred                       |
| `state.dimredResultPreFusion`              | same                          | Compression on noise output when fusion ≠ identity     |
| `state._basePos`                           | `Float32Array(n*3)`           | Viz stage when output is 3-d                           |
| `state._basePosPreFusion`                  | `Float32Array(n*3)`           | Viz on noise output (then `alignGlobal`-aligned)       |
| `state._basePos2d`                         | `Float32Array(n*2)`           | Viz2d stage when output is 2-d                         |
| `state.layerParams.dimred.{noise,fusion,compression,viz,viz2d}` | `{ method, params }` | Modal Apply path; defaults injected by `ensureLayerParams` |

---

## 6. Lazy-render gate (real-data UX)

Viewer panels render only when their respective basePos slot is
non-null. The viz sub-stage produces a `_basePos` only when its
output is 3-d. Identity on a 768-d embedding stays 768-d, which
can't render — so the viewer shows an empty-state hint until the
user explicitly picks UMAP-3 (or PCA-3, or any other 3-d-capable
algorithm) in the viz slot. **No special gating logic; it falls
out of the contract.**

Same rule for the 2D viewer + viz2d.

---

## 7. Viz output normalisation

Any viz-stage output adopted as `_basePos` is centred + isotropically
scaled (`VIEWER_TARGET_RMS = 90` in `engine.js`) so UMAP-3
(~`[-3, 3]`) renders at the same volume as toy basePos
(~`[-60, 60]`). Pure isotropic transform — topology preserved
exactly.

`_basePos2d` follows the same normalisation (`TARGET_RMS_2D = 90`
in `engine.js`). Toy and identity-passthrough basePos are not
normalised — they keep their native scale.

---

## 8. Adding a new algorithm

1. Drop the implementation in `app/src/dimred/<name>.js`. Export
   `defaultParams()` and `compute(input, params)`. `compute` must
   return an object satisfying `validateDimredResult` (which
   checks length / shape / no NaN entries).
2. Add one entry to `ALGORITHMS` in
   `app/src/dimred/registry.js` with `{ id, label, family,
   description, defaultParams, compute, modalSchema }`.
   Optionally add `defaultParamsForSlot(slot)` if the recommended
   config differs per slot.
3. The dim-reduction modal, the workflow chart, the engine cascade,
   and the dimred-stage validator all drive themselves from this
   list — no switches elsewhere should grow.
4. For each `modalSchema` field declare `kind` (`int` / `range` /
   `select`), `min/max/step`, a one-line `hint`, and `sweepValues`
   (used by the future cross-algorithm sweep).

---

## 9. Cross-references

- `doc/fusion.md` — full spec for the fusion sub-stage
  (graph-diffusion algorithm + fusion-comparison slider + cluster
  A/B colour mode).
- `doc/blend.md` §1.8 — `alignGlobal()`, called from redimred()
  to align pre-fusion vs post-fusion basePos.
- `doc/dim-sweep-results.md` — empirical validation behind the
  UMAP-100 compression default (ARI saturation curve on BFS-5000).
- `doc/scaling.md` §2.3 — how each algorithm scales from toy
  (n ≈ 400) to real (n = 810 k).
