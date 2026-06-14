# Clustering layer — contract and algorithms

This document is the source of truth for how the clustering layer is
shaped, what every algorithm must produce, and how downstream code
interacts with it. Algorithms come and go; the contract should not.

> **Ghost nodes:** `isGhost` (metadata-less) nodes are **excluded from the fit**
> at every level — HDBSCAN runs on the `m` embedded nodes only, then each ghost
> inherits the cluster of its nearest embedded citation neighbour (post-hoc). The
> Optimise multi-layer sweep does the same (slice → fit → expand). So ghosts
> never seed/split/merge a cluster directly; they only shape clusters *indirectly*
> by having moved the real nodes during fusion. Helpers in
> `clustering-cascade.js` (`buildGhostContext` / `runLevelOnEmbedded` /
> `expandGhostResult`); full detail in `doc/ghost-nodes.md`.

If you are about to add or modify a clustering algorithm, the rule is:

1. The algorithm produces a `ClusterResult` object that satisfies the
   contract in §1.
2. `validateClusterResult` (`app/src/contracts/cluster.js`) accepts the
   result without throwing.
3. Downstream consumers (`citations.js`, `citation-taste.js`,
   `neighbourhoods.js`, `clustering-debug.js`, `main.js`) keep working
   without changes.

If any of those three conditions can't be met, the contract changes
and this document is updated *first*, then code follows.

> **Multi-level note.** The toy's new shell wraps multiple
> `ClusterResult`s in a `state.clusterLevels` array (one per level)
> plus a `state.bridgeAnalysis` derivation. Per-level scope (`global`
> vs `within-parent`) controls how each level is computed. The
> contract below is unchanged — every level is a single ordinary
> `ClusterResult`. Spec: `doc/multi-level.md`.

---

## 1. The `ClusterResult` contract

Every clustering algorithm must return an object of this shape.

```ts
{
  method:    string,                  // algorithm id, e.g. "mutualKNN" / "hdbscan"
  params:    object,                  // params the algorithm actually ran with,
                                       //   after clamping / normalisation
  clusters: [
    {
      id:        int,                 // 0..numNormalClusters-1, OR -1 for noise
      centre:    [x, y, z],           // numeric 3-tuple, centroid of member basePos
      spread:    number,              // RMS distance of members from centre
      count:     int,                 // number of members (matches nodeCluster)
      colour:    string,              // hex string, "#RRGGBB"
      stability: number,              // ALWAYS present. NaN for algorithms that
                                       //   do not compute stability.
    },
    ...
  ],
  nodeCluster:    Int32Array,         // length n. nodeCluster[i] = cluster id of node i.
                                       //   Either in [0, numNormalClusters) or -1.
  structureEdges: [[i, j], ...],      // algorithm-specific debug edges:
                                       //   - mutualKNN → mutual k-NN edges
                                       //   - hdbscan   → MST edges
                                       //   Always undirected, always with i < j.
}
```

### Optional fields

- **`noiseFlags`** (optional, `Uint8Array(n)`) — per-node flag, 1 if the
  node was classified as noise by the algorithm before any absorption,
  0 otherwise. Algorithms that have no noise concept omit this entirely.
  This is independent of `nodeCluster[i]`: a node may have
  `noiseFlags[i] === 1` (was-noise) but `nodeCluster[i] === 2` (absorbed
  into cluster 2). Used by debug overlays so the user can see the
  algorithm's pre-absorption decisions.

### Field-by-field

- **`method`** — string id matching an entry in the algorithm registry.
  Used by the UI to know which params modal to open and by debug
  overlays to know what `structureEdges` *means*.

- **`params`** — the actual params after clamping. May differ from the
  user's input if e.g. K was clamped to `n - 1`. Consumers should read
  these for display ("running with k=8 (clamped from 12)").

- **`clusters`** — array of cluster metadata. Order:
  - Normal clusters first, in id order: index `c` has `id === c` for
    `c ∈ [0, numNormalClusters)`.
  - Noise pseudo-cluster (if any) last, with `id === -1`.

- **`clusters[c].id`** — contiguous from 0 for normal clusters. The
  noise entry, if present, has `id === -1`.

- **`clusters[c].centre`** — `[x, y, z]` numeric 3-tuple. Centroid of
  the member basePos coordinates. For the noise pseudo-cluster this is
  still computed over its members (or `[0, 0, 0]` if zero members; the
  contract treats this as a valid edge case).

- **`clusters[c].spread`** — RMS distance of members from `centre`.
  Recommended definition; not enforced — consumers only display it.

- **`clusters[c].count`** — number of members. Must satisfy
  `count === |{i : nodeCluster[i] === id}|` (the validator checks this).

- **`clusters[c].colour`** — hex string. Convention: normal clusters use
  `TABLEAU10[id mod 10]`. Noise uses a fixed grey (`#7a8090`).

- **`clusters[c].stability`** — ALWAYS present. `NaN` for algorithms
  that don't compute it. Consumers must guard with `Number.isFinite`
  before using.

- **`nodeCluster`** — `Int32Array` of length `n`. Every value is either
  in `[0, numNormalClusters)` (normal cluster) or `-1` (noise).
  `-1` is only allowed if the validator was called with
  `{ allowNoise: true }`.

- **`structureEdges`** — array of `[i, j]` pairs of node ids, always
  with `0 ≤ i < j < n`. Algorithm-specific meaning:
  - `mutualKNN` — pairs that mutually appear in each other's top-K.
  - `hdbscan`   — edges of the mutual-reachability MST.
  Used only by the clustering debug overlay; not a downstream
  dependency.

### Optional-field invariants

If `noiseFlags` is present, the validator checks:
- `noiseFlags instanceof Uint8Array`
- `noiseFlags.length === n`
- every entry is 0 or 1

### Invariants the validator checks

1. `result` is an object with all required top-level fields.
2. `clusters.length` matches the number of distinct cluster ids in
   `nodeCluster`, plus 1 if any `-1` appears.
3. `nodeCluster` has length `n`. Every value is either in
   `[0, numNormalClusters)` or `-1`.
4. `-1` in `nodeCluster` requires `allowNoise: true`.
5. For every normal cluster `c`, `clusters[c].id === c`.
6. If a noise cluster exists, it is the last entry of `clusters[]` and
   has `id === -1`.
7. For every cluster `c` (normal or noise),
   `clusters[c].count === |{i : nodeCluster[i] === clusters[c].id}|`.
8. `clusters[c].centre` is a 3-tuple of finite numbers (`[0,0,0]` is OK
   for empty / noise clusters).
9. `clusters[c].colour` matches `/^#[0-9a-fA-F]{6}$/`.
10. `clusters[c].stability` is present (may be `NaN`).
11. Every `structureEdges[k]` is a `[i, j]` with
    `Number.isInteger(i)`, `Number.isInteger(j)`, `0 ≤ i < j < n`.

### Invariants the contract deliberately does NOT enforce

- The *order* clusters appear in beyond "id `c` at index `c`, noise
  last." Algorithms may renumber however they like.
- *How* `spread` is computed.
- The *colour palette* (consumers display whatever the algorithm
  emits; only the format is checked).
- The *count* of `structureEdges` (algorithms with no debug-edge
  concept may emit `[]`; consumers must accept that).

---

## 2. Where this contract is consumed

Every consumer is listed here so that any future contract change can
be checked against the full impact surface.

### `app/src/citations.js`

- Reads `clusterResult.nodeCluster[i]` to decide intra vs cross.
- Treats `nodeCluster[i] === -1` (noise) by — **TBD when noise lands.
  Likely: each noise node is its own singleton from citations'
  perspective.**

### `app/src/citation-taste.js`

- Reads `clusterResult.clusters.length` and
  `clusterResult.clusters[c].centre`.
- Iterates `clusters[c]` for `c ∈ [0, length)`. Currently assumes all
  entries are valid clusters.
- **TBD when noise lands**: must skip the noise entry (id = -1) when
  building cluster taste, since neighbourhoods of "noise" don't have a
  meaningful taste set.

### `app/src/neighbourhoods.js`

- Reads `clusterResult.clusters.length` and
  `clusterResult.nodeCluster[i]`.
- Currently buckets nodes by cluster id, then runs mutual k-NN per
  bucket.
- **TBD when noise lands**: noise nodes either become their own
  singleton neighbourhood or are skipped entirely.

### `app/src/clustering-debug.js`

- Reads `clusterResult.clusters` (for centroid markers).
- Reads `clusterResult.structureEdges` (was `mutualEdges`) for the
  edge overlay.

### `app/src/main.js`

- Reads `clusterResult.clusters[c]` for legend (`.colour`, `.count`,
  `.spread`, plus `.stability` when present).
- Reads `clusterResult.nodeCluster[i]` for colour-by-cluster.
- Reads `clusterResult.method` to drive the Cluster ▾ menu state and
  decide which modal to open.

---

## 3. Algorithm registry

Every clustering algorithm registers itself in
`app/src/clustering-registry.js` with this shape:

```ts
{
  id:    string,                    // matches the `method` in ClusterResult
  label: string,                    // user-facing label for Cluster ▾ menu
  defaultParams: () => object,      // factory; returns fresh defaults
  infer:         (genResult, params) => ClusterResult,
  allowsNoise:   boolean,           // does the algorithm produce -1 ids?
  modalSchema:   ParamSchema[],     // declarative description of the modal UI
                                     //   (so we don't hand-write a modal per algo)
}
```

`modalSchema` is a list of one entry per parameter. Schema entry shape:

```ts
{
  key:    string,                   // matches a key in defaultParams()
  label:  string,                   // user-facing label
  kind:   "range" | "int",          // (we'll add more if needed)
  min:    number,
  max:    number,
  step:   number,
  format: (value) => string,        // for the value badge
  hint?:  string,                   // optional one-line description
}
```

This means **adding a new algorithm = registry entry only**. The Cluster ▾
menu and the modal are generated from the registry.

---

## 4. Currently-registered algorithms

Each subsection here is the source of truth for that algorithm's math
and behaviour. The implementation in `app/src/clustering*.js` should
agree with the spec; if they ever diverge, fix the code (or update the
doc and the changelog in §6).

### 4.1 Mutual k-NN

- **Module:** `app/src/clustering.js`
- **Registry id:** `mutualKNN`
- **`allowsNoise`:** `false` — every node lands in exactly one cluster.
- **Params:** `{ mutualK: int }` (default 5; clamped to `[1, n - 1]`).

**Algorithm.**

1. For each node `i`, find its top-`K` nearest neighbours in `basePos`
   by Euclidean distance. (Sort the `n - 1` candidates by squared
   distance, take the first `K`.)
2. Build an undirected graph where edge `(i, j)` exists iff
   `j ∈ topK(i)` *and* `i ∈ topK(j)` — both directions must agree.
3. Find connected components via union-find. Each component becomes a
   cluster, labelled `0..C-1`.

**Output specifics.**

- `nodeCluster[i]` always ≥ 0; never `-1`.
- `structureEdges` = the mutual k-NN edges that defined the components
  (one entry per `(i, j)` with `i < j`).
- `clusters[c].stability` = `NaN` for every cluster. Mutual k-NN has no
  stability concept.
- `clusters[c].centre` = mean of member `basePos`.
- `clusters[c].spread` = RMS distance of members from centre.
- `clusters[c].colour` = `TABLEAU10[c % 10]`.

**Why mutual.** A spatial bridge of a few nodes between two dense
regions doesn't produce mutual edges, because the bridge nodes' actual
nearest neighbours sit inside their home region rather than across the
gap. So dense clusters are not fused through narrow chains, the way
they would be under absolute-distance single-linkage.

**Effect of `K`.** Larger `K` = looser mutual constraint = more pairs
join = fewer, bigger clusters. `K = 1` typically leaves many
singletons; `K ≈ 20` typically merges most of the embedding into one
component.

**Known limitation.** Halo nodes — points sitting in the periphery of
a dense cluster — can end up as singleton components even though they
are geometrically clearly part of the cluster. The dense core's top-K
all point at each other inside the core, never out at the halo, so the
halo's proposed edges go unreciprocated. This is the "trap" that
motivated adding HDBSCAN (§4.2). The trade-off is real: mutual k-NN
refuses to chain narrow bridges between dense regions, at the cost of
being conservative about the periphery.

### 4.2 HDBSCAN

- **Module:** `app/src/clustering-hdbscan.js`
- **Registry id:** `hdbscan`
- **`allowsNoise`:** `false` (toy-app convention; see "Noise handling"
  below — every node still gets a non-negative cluster id, but the
  algorithm's pre-absorption decision is preserved in `noiseFlags`).
- **Params:**
  - `minSamples: int` (default 5; clamped to `[1, n - 1]`) — controls
    the core-distance smoothing.
  - `minClusterSize: int` (default 5; clamped to `[2, n]`) — smallest
    sub-cluster the condensation pass keeps.
  - `selectionMethod: "eom" | "leaf"` (default `"eom"`) — how the
    condensed tree's frontier of clusters is picked. See "Selection"
    below.
  - `selectionEpsilon: float ≥ 0` (default `0`, in `d_mreach` distance
    units) — post-selection merge threshold. Mirrors sklearn's
    `cluster_selection_epsilon`. See "Selection" below.
  - `noiseMode: "absorb" | "singletons"` (default `"absorb"`) —
    strategy for points the selection step left outside any stable
    cluster.

**Algorithm.** Five stages, each implemented in its own helper in
`clustering-hdbscan.js`.

**(1) Pairwise distances.** Compute the full Euclidean distance matrix
on `basePos`. `O(n²)`.

**(2) Core distance.** For each node `i`,
```
coreDist(i) = distance to its k-th nearest other node, k = minSamples
```
Inflates densities of points in sparse regions.

**(3) Mutual-reachability MST.** Define
```
d_mreach(i, j) = max(coreDist(i), coreDist(j), dist(i, j))
```
Build the minimum spanning tree on the complete graph weighted by
`d_mreach` using Prim's algorithm, computing weights lazily inside the
relaxation. Returns `n - 1` edges.

**(4) Dendrogram + condensed tree.** Sort the MST edges by weight
ascending; each merge becomes a binary tree node carrying its
`weight`. Traverse this dendrogram top-down to build the *condensed
tree*, gating splits on `minClusterSize`:

- **Both sides ≥ `minClusterSize`** → real split. Each child becomes
  its own condensed-tree node with `birthLambda = 1 / weight`.
- **Both sides < `minClusterSize`** → entire branch dies. All leaves
  beneath this dendrogram node fall out of the parent condensed
  cluster at `λ = 1 / weight`.
- **One side ≥ threshold, one side <** → persistence. The big side
  continues as the parent's condensed cluster; the small side's leaves
  fall out at `λ = 1 / weight`.

**(5) Stability + selection.** For each condensed cluster `C`:
```
stability(C) = Σ_{p ∈ C} (λ_p_falls_out − λ_birth(C))
```

The `selectionMethod` parameter picks the cluster frontier:

- **`eom` (default).** Walk the condensed tree bottom-up. At each
  node:
  - if `stability(C) > Σ children's selected stability`, **select C**
    and unselect every descendant;
  - otherwise **don't select C**; pass children's selection through.

  The root cluster is explicitly excluded from selection so we never
  fall back to "everything is one cluster." Standard EOM. Picks the
  *maximally stable* frontier and is tight when the data has clean
  density valleys. **Failure mode** — when the dendrogram is a long
  imbalanced chain (one giant cluster nibbling small pieces, common
  with overlapping Gaussians at high spread), every internal node has
  modest stability relative to its giant subtree, so EOM collapses
  to a giant cluster + a few stranded leaves. The internal sub-
  structure is real but invisible to EOM at every level.
- **`leaf`.** Pick every leaf of the condensed tree (clusters with
  no children), excluding the root. Predictable cluster count, no
  bifurcation, but produces lots of tiny clusters when
  `minClusterSize` is small. Designed to be paired with
  `selectionEpsilon` to control granularity.

After selection, **`selectionEpsilon`** runs as a post-merge step:

- For each selected cluster `C`, if its birth distance
  (`1 / birthLambda(C)`) is **less than** `selectionEpsilon`, walk up
  the condensed-tree parent chain to the first ancestor whose birth
  distance is at least `selectionEpsilon`. Never select the root —
  walks that would land on the root stop one short.
- Selections that walk up to the same ancestor are deduplicated.
- `selectionEpsilon = 0` disables the merge.

This mirrors sklearn's `cluster_selection_epsilon` exactly: it lets
the user say "ignore splits at scales finer than ε" without
abandoning the density-based selection. With `leaf` mode it gives a
smooth dial from "every leaf" (ε = 0) to "few coarse clusters"
(ε large).

Selected clusters form a frontier in the condensed tree; every leaf's
owning cluster is the deepest selected ancestor in that frontier.
Leaves with no selected ancestor are *noise*.

**Noise handling (Stage 5).** The EOM step produces a set of stable
labels `[0, numStableClusters)` plus possibly some noise points. The
`noiseMode` parameter resolves these:

- **`absorb` (default).** For each noise point `p` and each stable
  cluster `C`:
  ```
  λ_p_in_C = 1 / min_{q ∈ C} d_mreach(p, q)
  score(p, C) = λ_p_in_C · stability(C)      if λ_p_in_C ≥ birthLambda(C)
              = 0                              otherwise
  ```
  Assign `p` to the cluster with the highest score. If every score is
  zero, fall back to the cluster minimising `d_mreach(p, ·)` so
  "absorb" never leaves a point unassigned. This mirrors sklearn's
  `approximate_predict`.
- **`singletons`.** Each noise point becomes its own cluster, with
  `count = 1`, `spread = 0`, `colour = "#7a8090"` (noise grey),
  `stability = NaN`.

In both modes, `noiseFlags[i] = 1` iff EOM left point `i` outside any
stable cluster (i.e. *before* absorption). This survives in the
output regardless of `noiseMode` so debug overlays can show the
algorithm's pre-absorption decision.

**Output specifics.**

- `nodeCluster[i]` always ≥ 0. Despite the algorithm having a noise
  concept, `allowsNoise` stays `false` because both noise modes
  resolve every point to a non-negative id.
- `structureEdges` = the full MST under `d_mreach` (one entry per
  edge with `i < j`).
- `clusters[c].stability` = the EOM-extracted stability score for
  stable clusters; `NaN` for noise singletons (when `noiseMode =
  "singletons"`).
- `clusters[c].centre` / `.spread` / `.count` computed over the
  *resolved* membership (i.e. include absorbed noise members in
  absorb mode).
- `clusters[c].colour` = `TABLEAU10[c % 10]` for stable clusters;
  `"#7a8090"` for noise singletons.
- `noiseFlags: Uint8Array(n)` always present, regardless of mode.

**Effect of the knobs.**

- `minSamples` ↑ → `coreDist` is taken from a more distant neighbour,
  inflating distances in sparse regions more aggressively → more
  points get classified as noise / fewer "stable" sub-clusters
  survive condensation.
- `minClusterSize` ↑ → splits dissolve more readily into noise →
  fewer, larger surviving clusters.
- `selectionMethod`: `eom` is the classic stability-based frontier;
  `leaf` is the unbiased frontier (every condensed-tree leaf). When
  EOM bifurcates, switching to `leaf` is the typical recovery path.
- `selectionEpsilon` ↑ → fine clusters merge into coarser ancestors →
  fewer, larger surviving clusters. With `leaf` selection this is the
  smooth granularity dial; with `eom` it has weaker effect (EOM
  already prefers coarser frontiers most of the time).
- `noiseMode` is render-only with respect to the selection decision —
  it doesn't change *who* is noise, only *what label* noise points
  end up with.

**Algorithm-specific notes.**

- The EOM rule "select self iff `S(C) > Σ children selected
  stability`" with the strict inequality means ties go to the
  children — so the algorithm prefers finer clusters when equally
  stable. This is the standard convention and makes the toy match
  external HDBSCAN tools.
- The root-cluster exclusion is a toy-specific touch: without it the
  default-density-uniform synthetic data has its root cluster
  sometimes win EOM and the result collapses to "one big cluster."
  Sklearn behaves the same way (`allow_single_cluster = False` is the
  default).

---

## 4.3 Scaling characteristics

Both registered algorithms materialise pairwise distances and are
therefore O(n²) in time and memory.

- **Mutual k-NN (§4.1).** For each node, sorts the `n − 1` candidate
  distances to find its top-K. Cost: `O(n² log n)` time, `O(n)`
  working memory per node (no persistent matrix). Tolerable up to a
  few thousand nodes.
- **HDBSCAN (§4.2).** Stage 1 builds the **full pairwise distance
  matrix** explicitly (`O(n²)` time and memory). At `n = 800k` that
  is `640 GB` at f64 — infeasible. Stages 2–5 (core distance, MST,
  condensation, EOM) are then `O(n²)` or `O(n²)` with a `log n`
  factor for the MST.

Both are toy-scale only. See `doc/scaling.md` §2.2 for the real-data
options (sparse k-NN graph from ANN libraries, GPU HDBSCAN, or
graph-community methods like Leiden) and how each preserves or
sacrifices the contract above.

The cluster contract itself — `nodeCluster`, `clusters[].centre`,
`stability`, `noiseFlags` — has no scale dependency and carries over
unchanged regardless of which algorithm produces it.

---

## 5. Pipeline rerun semantics

The clustering layer sits between dim-reduction and neighbourhoods.
Any change to `state.layerParams.clustering` (method, level
configs, or any param) triggers `recluster()`, which:

1. Builds a small DAG: a `post` clustering-worker job consuming
   `dimredResult`, plus a `pre` job consuming
   `dimredResultPreFusion` when fusion is active.
2. Each worker runs the **multi-level cascade** via
   `clustering-cascade.js`'s shared `runClusterLevels` (the same
   pure module the main thread imports — one source of truth either
   side of the worker boundary).
3. Validates each level's `ClusterResult` against the contract.
4. Updates `state.clusterLevels`, aliases the finest level into
   `state.clusterResult`, computes `bridgeAnalysis` when ≥ 2 levels
   exist, and clears `state.evalResults.optimise` +
   `state.bootstrapStability` so stale Optimise scores and bootstrap
   results don't survive a config change. The bootstrap sidecar then
   re-populates `state.bootstrapStability` if the clustering modal's
   Stability toggle is on. Pre-fusion clustering is not a parallel
   lane — each `fusionBranch` card carries its own clustering card,
   so the engine runs one clustering per `recluster` call.
5. Cascades downstream: `reneighbour() → retaste() →
   resample() / resampleViaImport()`. The cascade stops at Layer 3
   (citation layout is opt-in; see `doc/blend.md` §3).

Switching algorithms re-runs the full clustering chain but **does
not** reset live node positions or the citation seed. The user can
compare algorithms on the same dataset by toggling the modal's
algorithm dropdown.

Worker architecture: see `doc/workers.md`. Multi-level cascade
spec: `doc/multi-level.md`.

---

## 6. Versioning the contract

If we ever need to break the contract, the steps are:

1. Update §1 of this document with the new contract.
2. Bump the contract version (add a `CLUSTER_CONTRACT_VERSION`
   constant in `app/src/contracts/cluster.js`).
3. Update `validateClusterResult` to enforce the new invariants.
4. Run every registered algorithm and update its `infer` to satisfy
   the new contract.
5. Update each consumer in §2 to read the new fields.
6. Update the changelog at the bottom of this section.

### Changelog

- **v1 (2026-05-07)** — initial contract. Renamed `mutualEdges` →
  `structureEdges`. Added optional `stability` (always present, may be
  NaN). Allowed `nodeCluster[i] === -1` for noise when
  `allowNoise: true`.
- **v1.1 (2026-05-07)** — added optional `noiseFlags: Uint8Array(n)`
  for algorithms that classify points as noise. Independent of
  `nodeCluster[i]`: a point may be both flagged as noise AND assigned
  to a cluster (when the algorithm uses soft absorption to fold noise
  into the nearest stable cluster). Mutual-k-NN omits this field;
  HDBSCAN always populates it.
- **v1.2 (2026-05-07)** — no contract change. Doc reorganisation:
  the per-algorithm math for both Mutual k-NN and HDBSCAN moved into
  §4 of this file (was previously split between `dynamics.md` §2 and
  source-code comments). `dynamics.md` §2 now points here. The
  `dynamics.md` controls table treats clustering-modal sliders as a
  single category rather than naming `mutualK` directly, since that
  param is no longer the only one (HDBSCAN has `minSamples`,
  `minClusterSize`, `noiseMode`).
