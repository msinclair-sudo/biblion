# Multi-level clustering + bridge analysis

How recursion / sub-clustering / boundary detection are
implemented in the toy. Specifies:

- `state.clusterLevels` — the multi-level data shape
- The engine cascade for level-by-level clustering
- The two scope modes (`global` vs `within-parent`) and their
  stitching semantics
- The bridge-analysis derivation that runs on top of `clusterLevels`
- UI surfaces (colour modes, node-table sources, modal)

Pairs with `doc/clustering.md` (Layer 2 contract — unchanged) and
`doc/ui-architecture.md` (the modal + workflow surfaces).

---

## 1. Why multi-level

Single-level clustering answers "what are the natural groups in
this data?" Multi-level answers "what's the *hierarchy* of groups,
and where do they share members?"

Two distinct sub-clustering questions can be asked of the same
data:

1. **Drill into one cluster.** Take cluster `c`'s members, run
   the algorithm on just those, get sub-clusters of `c`. Useful
   for "research focus targets" — zoom into a cluster, see its
   internal structure. Pure containment: every sub-cluster is a
   strict subset of its parent.

2. **Re-cluster the whole dataset at finer resolution and
   observe overlap.** A fine cluster *may* span multiple coarse
   clusters at boundary regions. These cross-boundary fine
   clusters are **bridges** — a structural feature you'd otherwise
   lose to arbitrary boundary-assignment.

Both are useful. The toy supports both via a per-level `scope`
flag, and bridges (case 2) get an automatic derived analysis.

The original plan called for a contract extension (`nodePath` /
`clusterTree` fields on `ClusterResult`). What landed instead is
simpler: a flat array of ordinary `ClusterResult`s in
`state.clusterLevels`, with each level's `scope` telling the
engine how to compute it. The contract didn't change; existing
panels keep working; level navigation is just an array index.

---

## 2. State shape

### `layerParams.clustering`

The user's intent — algorithm + per-level params.

```js
state.layerParams.clustering = {
  method: "mutualKNN",       // shared across all levels (per design call)
  levels: [
    { uid: "abc123", params: { mutualK: 5 }, scope: "global"        },  // L0 — root
    { uid: "def456", params: { mutualK: 3 }, scope: "within-parent" },  // L1
    ...
  ],
};
```

Constraints:
- `levels.length >= 1` (always at least L0)
- `levels[0].scope` is **always treated as `global`** by the
  engine (no parent to be within)
- `method` is shared — switching algorithm in the modal resets
  every level's `params` to the new algorithm's defaults (the
  schemas don't carry across)
- `uid` is internal; lets the modal track levels stably across
  add/remove

### `clusterLevels` — engine output

The engine's per-level `ClusterResult`s, in level order.

```js
state.clusterLevels = [
  { uid: "abc123", scope: "global",        clusterResult: ClusterResult_L0 },
  { uid: "def456", scope: "within-parent", clusterResult: ClusterResult_L1 },
  ...
];
```

Each `clusterResult` conforms to the unchanged
`doc/clustering.md` §1 contract — flat `nodeCluster: Int32Array`,
flat `clusters[]` array, etc. Cluster IDs are contiguous from 0
**within each level** (they don't accumulate across levels).

### Backward-compat alias

```js
state.clusterResult = state.clusterLevels[finest].clusterResult;
```

`finest === clusterLevels.length - 1`. This alias exists because
many panels and engine modules pre-date multi-level clustering and
still read `state.clusterResult`. Always set to the deepest
level's `ClusterResult`.

---

## 3. Engine cascade

The cascade logic lives in `app/src/clustering-cascade.js`
(`runClusterLevels`) — a pure module imported by both the engine
on the main thread AND by `app/src/workers/clustering-worker.js`,
so one source of truth covers both sides of the worker boundary.

```
for (i = 0; i < cfg.levels.length; i++):
    isGlobal = (i === 0) || levels[i].scope === "global"
    if isGlobal:
        cr = algo.infer(genResult, levels[i].params)
    else:
        cr = clusterWithinParents(algo, genResult, parent, levels[i].params)
    validateClusterResult(cr, n, { allowNoise })
    levels.push({ uid, scope, clusterResult: cr })
    parent = cr

bridgeAnalysis = computeBridgeAnalysis(levels)   // null when levels.length < 2
update({ clusterLevels: levels, clusterResult: levels[finest].clusterResult, bridgeAnalysis })
```

`engine.js`'s `recluster()` lane wraps this in a small DAG: a
`post` clustering-worker job runs the cascade on
`state.dimredResult`; when fusion is active, a parallel `pre` job
runs it on `state.dimredResultPreFusion` and the result lands in
`state.clusterLevelsPreFusion`. Bridge analysis runs on the main
thread after both jobs return.

The full cascade re-runs whenever Apply is hit in the clustering
modal. Granular re-runs (only L1 changed) are not yet implemented
— a small future optimisation; not load-bearing at toy scale.

Worker / DAG architecture: see `doc/workers.md`.

### Within-parent stitching (`clusterWithinParents`)

For `scope: "within-parent"` levels: the algorithm runs once per
**parent cluster's member set**, then results are stitched into a
globally-numbered `ClusterResult`.

Steps:
1. Group node ids by `parent.nodeCluster[i]`.
2. For each parent's `ids` (more than one node):
   - Build a `subGenResult` whose `nodes[]` is a copy of those
     nodes with **local ids 0..ids.length-1** (so the algorithm
     doesn't see arbitrary global ids).
   - Run `algo.infer(subGenResult, params)` → `subResult`.
   - Renumber: each sub-cluster id `c` becomes `nextId + c` in the
     global output. `nextId` advances by `subResult.clusters.length`
     after each parent.
   - Map `subResult.nodeCluster[localIdx]` back to the original
     node id via `ids[localIdx]` and write into the global
     `nodeCluster`.
   - Map `subResult.structureEdges` back to original ids.
3. Singletons (one-node parents) become a single trivial sub-cluster
   carrying their parent's colour.

Result: a `ClusterResult` whose `nodeCluster` has unique
non-overlapping cluster ids globally, but the *partition* respects
the parent boundaries — every fine cluster sits entirely within
one coarse cluster.

### Algorithm shared across levels

The user's design call: same algorithm at every level for a
coherent story. The modal exposes one algorithm dropdown; switching
it resets every level's `params` to the new algorithm's
`defaultParams()` (schemas don't carry across — switching from
mutual k-NN to HDBSCAN replaces `{ mutualK: 5 }` with
`{ minSamples: 5, minClusterSize: 5, ... }`).

Per-level algorithm choice was on the original plan but deferred
— if the need arises, extend the level entry to include a
per-level `method` field and patch the engine cascade to look up
the algorithm per level.

---

## 4. Bridge analysis (`bridge-analysis.js`)

Pure derivation: takes `clusterLevels`, returns the bridge
characterisation. Engine calls it once per `recluster()`.

### Definition

A FINE cluster (at level i+1) is a **bridge** iff its members come
from two or more COARSE clusters (at level i).

The toy currently pairs the FINEST level with the level immediately
above it. With more than two levels, additional pair-wise analyses
could be added (one per consecutive pair) — out of scope today.

### Output shape

```js
state.bridgeAnalysis = null | {
  coarseLevel: int,                      // index in clusterLevels
  fineLevel:   int,
  perCluster: [{
    fineId:           int,
    memberCount:      int,
    spanCount:        int,                // number of distinct coarse parents
    dominantCoarseId: int,                // -1 if cluster is empty
    dominantFraction: float,              // 0..1
    isBridge:         bool,               // spanCount >= 2
    coarseShares: [{ id, count, fraction }],   // sorted desc by count
  }],
  perNodeScore:    Float32Array(n),       // boundary score per node
  perNodeIsBridge: Uint8Array(n),         // 1 iff owning fine cluster spans ≥ 2
  bridgeCount:     int,                   // tally
};
```

### Boundary score

```
score = 1 - dominantFraction
```

- Pure interior (one parent) → `0`
- Perfectly even mixing → close to `1`

Definition picked for simplicity and direct interpretability. An
entropy formulation gives a smoother gradient on highly-mixed
clusters but conflates "two-way 50/50" with "ten-way 10/10" —
the dominant-fraction version keeps the score reading as "how
ambiguous is this cluster's coarse parent?"

The score is a **cluster property** (every member of the same
fine cluster has the same score), not a per-node property. Per-
node access is via `perNodeScore[node.id]` for convenience —
internally it just looks up the owning fine cluster.

### Why this matters

The bridge concept turns a hidden artefact (boundary papers
arbitrarily assigned to one side) into a first-class structural
feature. Bridges are exactly the inter-disciplinary papers,
methodological reviews, or topical-overlap regions that would
otherwise vanish into one cluster's tail.

---

## 5. UI surfaces

Multi-level clustering is set up via a producer–picker card pair in
the workflow. The primary path is the **Optimise multi-layer** sweep,
which runs an HDBSCAN parameter grid and scores each candidate;
a fallback manual path exists in the clustering modal for hand-tuned
configs.

### Primary surface: Optimise multi-layer sweep + picker

Workflow entry point: from a `dimred` (or `fusionBranch`) card's **+**
menu, select "Optimise multi-layer clustering". This creates a
`multiLevel` **producer** card.

The producer runs an HDBSCAN sweep across leaf selection methods and
granularities, scoring each candidate with bootstrap reproducibility
(bootstrap protocol in `doc/eval.md`). When complete, the result is stored in
`state.multiLevelSweep = { candidates, curve, bridgesPerPair,
uidPrefix, floor }` and a `multiLevelPicker` card auto-spawns beneath it.

**Picker card:** selecting it opens the **multilayer-curve panel** (routed
to the primary slot) with two columns:

- **Left:** stability curve (reproducibility score vs cluster count) with
  interactive dots; clicking a dot selects that candidate.
- **Right:** bridge heatmap — an Int32 matrix `bridgesPerPair.counts` with
  per-cell raw bridge count and normalised colour; only the strict upper
  triangle (child > parent) is live; lower triangle and diagonal are
  inactive. Clicking a heatmap cell highlights the matching layers.

Cross-bindings between curve dots and heatmap rows/cols update in
real-time. A live readout at the bottom shows the picked layer
granularities and bridge counts between adjacent picks.

**Apply commit:** pressing Apply runs the picker's commit job, which calls
`engine.commitMultiLevelLayers`, builds `state.clusterLevels` directly,
and populates `state.bridgeAnalysis` in the same job (bridge analysis no
longer runs as a separate card post-pick). When citation edges are
present (`state.rawCitationEdges` non-empty), a `crossClusterCitations`
card auto-spawns below the picker to analyse citation flows between
cluster hierarchy levels.

### Bridge panel

The bridge panel is a singleton viewport that renders when
`state.bridgeAnalysis` exists. It displays a per-cluster breakdown of
how fine-cluster members are distributed across coarse parents, split
by a dominance threshold τ (default 0.8, user-adjustable). Two modes:

- **Encapsulated:** clusters where the dominant parent accounts for ≥ τ
  of members (cleanly nested).
- **Bridges:** clusters where no parent reaches τ (spanning multiple
  coarse boundaries).

The panel complements the picker's per-pair bridge *counts* (heatmap)
by showing per-cluster *dominance* and sharing. The picker is used for
layer selection; the bridge panel is used for threshold-based analysis
of the chosen hierarchy.

### Viewer colour modes (`viewer-3d.js`)

| Mode | What it paints |
|------|----------------|
| `bridge` | Bridge nodes: their *own* coarse parent's colour at full saturation. Non-bridge nodes: dimmed slate. Bridges visually pop while still showing which side they sit on. |
| `boundaryScore` | Gradient on `perNodeScore[i]` (faint slate at 0 = pure interior, vivid orange-red at 1 = max mixing). Continuous; reads as "where is this map most ambiguous?" |

### Node-table sources

| Source | What rows represent |
|--------|---------------------|
| `bridge` | One row per bridge fine-cluster. Columns: colour, fine id, count, span, dom, dom %, 2nd, 2nd %. |
| `boundaryScore` | One row per fine cluster sorted by score (boundaryScoreGradient swatch). Columns: colour, fine id, count, score, span, dom. Includes a gradient legend bar. |

Selecting a bridge row sets `selection = { type: "cluster", level:
fineLevel, id: fineId }` — re-uses the existing cluster-level
selection so dimming works on any colour mode.

### Manual fallback: clustering modal

The clustering modal (`modals/clustering-modal.js`) still supports the
Configure tab's `+ Add level` button for hand-tuned multi-level configs
(explicit parameter per level). This path bypasses the sweep; bridge
analysis runs automatically after Apply.

---

## 6. Demo notes

Algorithm choice strongly affects whether bridges appear:

- **Mutual k-NN** rarely produces bridges on well-separated toy
  data — its mutuality requirement keeps fine clusters tight to
  local density.
- **Connected-components** at `k ≥ 6` globally produces bridges
  routinely on toy data (no mutuality requirement; any direction
  of k-NN edge counts).
- **HDBSCAN** at smaller `min_cluster_size` for L1 also tends to
  produce bridges where density is uniform across coarse boundaries.

If the user adds an L1 with sensible scope/params and sees
`bridgeCount: 0`, the analysis is working as designed —
the algorithm just isn't producing cross-boundary clusters on
*this* data. Suggest switching to a more permissive algorithm or
increasing the toy's `Spread` so origins overlap.

---

## 7. Future extensions

Things deliberately not built yet:

- **Per-level algorithm choice.** Each `levels[i]` could carry its
  own `method` field. Useful when L1 should use a different
  topology assumption (e.g., density at L1 inside Leiden L0
  communities). Plumbing change is small (`activeClusterAlgorithm()`
  takes a level index); UI change is one dropdown per level in the
  clustering modal.
- **Bridges across all consecutive pairs.** Currently only the
  finest pair has a `bridgeAnalysis`. Could store
  `state.bridgeAnalyses: [{ coarseLevel, fineLevel, ... }, ...]`
  for L0↔L1, L1↔L2, etc. The viewer/table would need a level-pair
  selector.
- **Cluster tree visualisation.** The hierarchy implicit in
  multi-level + within-parent could be drawn as a tree
  (treemap / dendrogram / collapsible list). New panel type.
- **`recluster_subset` operation.** On-demand sub-clustering of
  one cluster without rebuilding the whole tree. Useful for
  exploration; not load-bearing yet.
