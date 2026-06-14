# Citation generation — contract and algorithms

This document is the source of truth for how the citation-generation
layer is shaped, what every algorithm must produce, and how downstream
code interacts with it. Algorithms come and go; the contract should
not.

If you are about to add or modify a citation-generation algorithm, the
rule is:

1. The algorithm produces a `CitationResult` object that satisfies the
   contract in §1.
2. `validateCitationResult` / `assertCitationResult`
   (`app/src/citations/contract.js`) accepts the result without
   throwing.
3. Downstream consumers (`citation-layout/`, `blend/align.js`,
   `citations-debug.js`, `main.js`) keep working without changes.

If any of those three conditions can't be met, the contract changes
and this document is updated *first*, then code follows.

---

## 1. The `CitationResult` contract

Every citation-generation algorithm must return an object of this
shape.

```ts
{
  method:    string,                  // algorithm id, e.g. "taste-network"
  params:    object,                  // params the algorithm actually ran with,
                                       //   after clamping / normalisation
  hasCit:    Uint8Array(n²),          // symmetric flag, 1 iff (i, j) cited
  inDeg:     Int32Array(n),           // incoming-citation count per node
  citations: { source, target }[],    // every citation as (newer → older)
  edges:     [number, number][],      // same set as citations, normalised i < j
  pools:     object,                  // per-algorithm diagnostic counters; opaque
}
```

### Field-by-field

- `method` — must match the `id` of the registry entry that produced
  the result. Used for debug status lines and any algorithm-specific
  branching downstream (there is none today).
- `params` — the params the algorithm actually used after any clamping
  or normalisation. Useful for the status line and for reproducibility
  audits.
- `hasCit[i * n + j]` — a symmetric flag matrix. `1` iff `(i, j)` is a
  citation pair (regardless of direction). Symmetric:
  `hasCit[i*n+j] === hasCit[j*n+i]`. Diagonal entries are unspecified
  and consumers must not rely on them.
- `inDeg[j]` — incoming-citation count for node `j` (count of `i`
  such that `i → j` is in `citations`). Used for "colour by in-degree"
  rendering and nothing else; never read by the layout pipeline.
- `citations` — list of directed citations `{ source, target }`.
  Conventionally `t[source] > t[target]` (newer cites older), but the
  contract does not enforce direction; layout / alignment code only
  reads the undirected pair.
- `edges` — an `[i, j]` list with `i < j` for every citation pair, in
  arbitrary order. Equivalent information to `citations` modulo
  direction, but pre-normalised so consumers don't have to filter for
  ordering. The citation-layout module (Layer 4) iterates this.
- `pools` — algorithm-specific diagnostic counters surfaced in the
  citations-modal status line. Opaque to anything outside the
  algorithm + the diagnostic display. Examples: pre-/post-filter
  pair counts, per-category budgets.

### Invariants the validator checks

- `method` is a non-empty string.
- `params` is an object.
- `hasCit` is a `Uint8Array` of length `n²`.
- `inDeg` is an `Int32Array` of length `n`.
- `citations` and `edges` are arrays.
- `hasCit` is symmetric (sampled check, not exhaustive — `n²/256`
  samples per call, enough to catch a bug at any call but cheap).

The validator deliberately does **not** check things like
"`citations.length === count of 1s in hasCit / 2`" — that's a deeper
internal consistency that's the algorithm's responsibility, not a
contract requirement.

---

## 2. Where this contract is consumed

The `CitationResult` is the only thing downstream layers see. They
must not reach into algorithm-specific internals (taste sets,
neighbourhood ids, intermediate stages, etc.) — those are
implementation details of whichever algorithm was registered.

### `app/src/citation-layout/` (Layer 4)

Reads `edges` (preferred) or `citations` to build the FR / MDS layout.
The layout module never sees how citations were generated; it only
sees which pairs were cited.

### `app/src/blend/align.js` (Layer 5a)

Reads `edges` (or computes adjacency from `hasCit`) to determine
connected components for the per-component Kabsch alignment. Doesn't
look at citation direction — alignment is undirected.

### `app/src/citations-debug.js`

Reads `inDeg` for the "colour by in-degree" render mode and `citations`
for drawing arrows. Render-only, no effect on layout.

### `app/src/main.js`

Stores the result on `state.citationResult`. Triggers
`relayoutCitations()` on change so Layer 4 + 5a recompute.

---

## 3. Algorithm registry

Every citation-generation algorithm registers itself in
`app/src/citations/registry.js` with this shape:

```ts
{
  id:    string,                    // matches the `method` in CitationResult
  label: string,                    // user-facing label
  description: string,              // one-paragraph description
  defaultParams: () => object,      // factory; returns fresh defaults
  infer:         (genResult, clusterResult, params) => CitationResult,
  modalSchema:   ParamSchema[],     // declarative description of the settings UI
}
```

Adding a new algorithm = registry entry + algorithm module. No other
file should grow a switch on algorithm id.

The `modalSchema` array currently isn't consumed by the citation
settings modal — that modal is hand-crafted in `app/index.html` for the
single algorithm registered today. When a second algorithm is added we
migrate the citation modal to be registry-rendered (mirroring how the
cluster modal works since v2 stage 5). For now `modalSchema` can be
left as `[]`.

---

## 4. Currently-registered algorithms

Each subsection here is the source of truth for that algorithm's
behaviour. The implementation should agree; if they diverge, fix
the code (or update this doc + the changelog in §6).

### 4.1 Taste Network

- **Module:** `app/src/citations/taste-network.js`, internally chaining
  `app/src/neighbourhoods.js` + `app/src/citation-taste.js` +
  `app/src/citations.js`.
- **Registry id:** `taste-network`
- **Default params:** union of all four sub-stages' defaults — see §4.1.7.

Citations are directed edges `i → j` meaning "i cites j", subject to
`t_i > t_j` (newer cites older). The algorithm produces them in **four
pure stages**, each with its own seed. The four stages are
implementation detail — the rest of the program sees only the
`CitationResult` contract.

**Why four stages, not the single-pool approach used in v1.** In v1
cross-cluster citations were drawn from one global pool weighted by
`1/d⁴`. That meant cross-citation targets were biased toward *spatial
neighbours*, not *thematic neighbours*. This algorithm separates the
two: cluster-level "taste" decides *which* clusters get cited; spatial
proximity inside a cluster decides *which intra-cluster pair* gets
cited.

The three new ideas:

1. **Neighbourhoods.** Inside each cluster, members partition into
   small mutual-k-NN groups. Within-neighbourhood pairs are likely to
   cite each other; cross-neighbourhood-same-cluster pairs are not.
2. **Per-neighbourhood taste.** Each neighbourhood picks a small set
   of "favourite" cross-clusters it tends to cite. Neighbourhoods
   within the same cluster mostly agree (with drift). Whether the
   favourite is geometrically close is irrelevant.
3. **Triangle transitivity.** If two clusters both cite a third, they
   become more likely to cite each other.

#### 4.1.1 Stage 1 — Within-cluster neighbourhoods

Mutual k-NN connected components, but run **per cluster**, restricted
to that cluster's members and their basePos coordinates only.

**Input.** Generation result + cluster result + `neighbourK` (default 3).

**Algorithm.**
1. For each cluster `c`, take its member set `M_c`.
2. For each `i ∈ M_c`, find its top-`K` nearest neighbours in
   `M_c \ {i}` by Euclidean basePos distance.
3. Build the mutual k-NN graph on `M_c` only and find connected
   components.

Output: `nodeNeighbourhood[i]` for every node, plus per-neighbourhood
metadata `{ id, clusterId, members, centroid, count }`. Neighbourhood
IDs are unique across the whole dataset.

**Why this captures the two requirements automatically.**
- Sparse cluster (large σ relative to size) → top-K neighbours sit
  far apart → fewer mutual edges → many small / singleton
  neighbourhoods → fewer same-neighbourhood pairs → fewer intra-cluster
  citations.
- Two dense lobes inside one cluster, separated by sparse space → the
  bridge nodes' top-K are inside their home lobe → no mutual edges
  across the gap → the lobes stay as separate neighbourhoods →
  independent taste.

#### 4.1.2 Stage 2 — Neighbourhood taste, with distance-decaying shared-taste pass

For each neighbourhood `Ng` belonging to cluster `c`, draw a small
"taste set" `T(Ng) ⊂ clusters \ {c}`.

**Knobs.** `tasteSeed`, `favouritesMean` (default 1.5),
`sharedTaste` (default 0.7), `tasteRange` (default
`R_GLOBAL · 0.3 ≈ 18` scene units).

**Pass 1 — independent draws.** For each `Ng`:
```
favCount  ~  max(1, Poisson(favouritesMean))     (Knuth's algorithm; integer-valued)
favCount  =  min(favCount, numClusters - 1)
T(Ng)_1   =  sampleWithoutReplacement(otherClusters_for(c), favCount)
```

**Pass 2 — distance-decaying shared-taste tilt.** Each neighbourhood
`Ng ∈ c` redraws its taste with a prior that gives more weight to
taste choices made by *spatially-near* sibling neighbourhoods (in the
same cluster). The vote of each sibling `Ng'` is weighted by a
Gaussian kernel on the centroid distance:

```
r(Ng, Ng')         =  ‖centroid(Ng) − centroid(Ng')‖           (Euclidean, scene units)
K(Ng, Ng')         =  exp(− r² / (2 · tasteRange²))            (Gaussian kernel)

popularity(Ng, d)  =  Σ_{Ng' ∈ c, Ng' ≠ Ng}  K(Ng, Ng') · 1[d ∈ T(Ng')_1]

P(Ng picks d in pass 2)  ∝  1  +  sharedTaste · popularity(Ng, d)
```

Sample `favCount` entries (same count as pass 1, deterministic)
without replacement using these weights.

**Why absolute `tasteRange`, not a fraction of cluster spread.** A
sparse cluster has its neighbourhoods spread further apart in scene
units. With absolute `tasteRange`, distant neighbourhoods of a sparse
cluster get small `K` and behave independently. This bakes in the
requirement *"the more sparse a cluster is → less shared taste"*.
Using a relative scale (`σ = tasteRange · clusterSpread`) would
normalise that effect away.

**Effect.**
- `sharedTaste = 0`  ⇒ pass 2 == pass 1 regardless of geometry
  (independent neighbourhoods).
- `sharedTaste` large  ⇒ neighbourhoods agree, but only with their
  close-by siblings.
- `tasteRange` very large compared to cluster scale ⇒ kernel ≈ 1
  everywhere, behaviour collapses to the uniform-shared-taste model
  (every sibling votes equally).
- `tasteRange` very small ⇒ kernel ≈ 0 between distinct
  neighbourhoods, behaviour collapses back to pass 1 (independent
  draws).

#### 4.1.3 Stage 3 — Triangle transitivity (mixed cluster + neighbourhood)

Stage 3 scores triangles at the **cluster** level, but applies the
swap at the **neighbourhood** level with a weight reflecting how
*representative* each neighbourhood is of its cluster. Peripheral
neighbourhoods are tilted less than central ones.

**Cluster-level taste.**
```
T_cluster(c)  =  ⋃_{Ng ∈ c}  T(Ng)_2
```

**Triangle scoring.** For each ordered cluster pair `(c, d)`, `c ≠ d`:
```
triangleScore(c, d)  =  #{c'  ≠ c, d  :  d ∈ T_cluster(c')  ∧  c ∈ T_cluster(c')}
```
(Number of third clusters that cite *both* `c` and `d`. High score ⇒
closing this triangle is well-supported.)

**Representativeness weight.** A neighbourhood close to its cluster's
centroid is "core" to that cluster's identity; a neighbourhood at the
edge is "peripheral." Weight each `Ng ∈ c` by:
```
ρ(Ng)  =  exp(− r(Ng, c)² / (2 · tasteRange²))
       where  r(Ng, c) = ‖centroid(Ng) − centroid(c)‖
```
Same Gaussian kernel and same `tasteRange` as stage 2 — peripheral
neighbourhoods (those further from the cluster centroid) attenuate,
central neighbourhoods get full weight.

**Pass 3 — triangle swap.** For each `Ng ∈ c`, sample a candidate
target `d` proportional to:
```
weight(d)  ∝  triangleScore(c, d)        for d ∉ T(Ng)_2 ∪ {c}
weight(d)  =  0                          otherwise
```
Then with probability `transitiveBoost · ρ(Ng) · (score / maxScore)`,
swap one entry of `T(Ng)_2` with `d`. The `score / maxScore` factor
normalises against the strongest signal in the dataset, so the
acceptance probability is `≤ transitiveBoost · ρ(Ng) ≤ 1` (since
`transitiveBoost`, `ρ`, and the score ratio are each in `[0, 1]`).

**At most one swap per neighbourhood per pass.** The pass runs once
over the whole dataset, in deterministic order, with `tasteSeed`.

**Knobs.** `transitiveBoost` (default 0.4). `0` ⇒ pass is a no-op.
The kernel range is shared with stage 2 (`tasteRange`) — there's no
separate knob.

The output of stage 3 is the final taste set `T(Ng)` for every
neighbourhood. From here on, taste is fixed.

#### 4.1.4 Stage 4 — Pair sampling

Now we draw the actual citation edges. For every ordered pair `(i, j)`
with `t_i > t_j` we compute a per-pair rate, then sample.

**Knobs.** `samplingSeed`, `density d`, `intraRate r_in`,
`crossRate r_cr`, `epsilonIntra ε_in` (default 0.05),
`epsilonCross ε_cr` (default 0.01).

**Per-pair base rate.**

Let `c_i = cluster(i)`, `c_j = cluster(j)`,
`Ng_i = neighbourhood(i)`, `Ng_j = neighbourhood(j)`.

```
intra-cluster (c_i == c_j):
   if Ng_i == Ng_j:           rate(i, j)  =  1                  (full intra rate)
   else:                      rate(i, j)  =  ε_in               (soft cross-neighbourhood)

cross-cluster (c_i ≠ c_j):
   if c_j ∈ T(Ng_i):          rate(i, j)  =  1                  (taste-matched)
   else:                      rate(i, j)  =  ε_cr               (soft off-taste)
```

The `1/d⁴` distance weight from v1 is **gone**. Cross-cluster
targeting is uniform across the target cluster's members — which
member you pick is a coin flip; *which cluster* you target is what
taste decides. Intra spatial proximity is handled by neighbourhood
membership rather than a continuous distance weight.

**Budget enforcement.** Sum the rates per category and scale to hit
the user's targets:

```
sum_intra  =  Σ_{intra pairs}    rate(i, j)
sum_cross  =  Σ_{cross pairs}    rate(i, j)

fracIntra  =  min(1, d · r_in)
fracCross  =  min(1, d · r_cr)

target_intra  =  fracIntra · #{valid intra pairs}
target_cross  =  fracCross · #{valid cross pairs}

scale_intra   =  target_intra / sum_intra        (clamped to [0, 1])
scale_cross   =  target_cross / sum_cross        (clamped to [0, 1])
```

**Sampling.** For every valid pair, include it with probability
`rate(i, j) · scale_category`. Single Bernoulli draw per pair;
`mulberry32(samplingSeed)` is the only source of randomness here. No
rejection sampling, no "pick exactly N" — that would re-introduce
coupling between pairs. The expected count matches the user's budget;
the variance is small at large pool sizes.

**Saturation.** `r_in = 1, d = 1, ε_in = 0` ⇒ every same-neighbourhood
intra pair is cited; cross-neighbourhood-same-cluster pairs are
skipped.

#### 4.1.5 Outputs into the contract

`hasCit`, `inDeg`, `citations`, `edges`, `pools` are produced from
stage 4. The intermediate stages 1–3 emit data internal to the
algorithm (`nodeNeighbourhood`, `tasteByNeighbourhood`,
`tasteByCluster`); these are NOT part of the public contract — they
exist only to be consumed by later stages of the same algorithm
chain.

The `citations-debug.js` overlay reads the final
`tasteByNeighbourhood` from a separate `state.tasteResult` slot
(maintained by main.js for the current chain, not from the registry's
public output). When a future algorithm doesn't have a "taste"
concept, that overlay won't have anything to draw — which is correct,
the overlay is taste-network-specific.

#### 4.1.6 Scaling characteristics

The taste-network algorithm has multiple `O(n²)` and `O(n² · K)`
components that are toy-scale only. From hot to cold:

- **Stage 4 pair enumeration (`citations.js`).** Iterates every
  ordered pair `(i, j)` with `t_i > t_j`. Cost: `O(n²)`. At
  `n = 800k` that is `3.2 × 10¹¹` enumerations — infeasible without
  locality-aware candidate generation.
- **`hasCit: Uint8Array(n²)`** in the `CitationResult` contract.
  At `n = 800k` that is a `640 GB` allocation. The contract assumes
  this is the canonical pair-membership representation; at scale it
  must be replaced with a sparse equivalent (CSR, hash set keyed on
  `i*n + j`, or per-source sorted target lists).
- **Stage 1 neighbourhood mutual k-NN (`neighbourhoods.js`).** Per
  cluster, builds the local pairwise distance matrix. Cost: `Σ_c
  m_c²` where `m_c` is cluster `c`'s size. At scale this depends on
  cluster-size distribution — a single giant cluster makes it `O(n²)`,
  many small clusters make it tractable. Same fix as global k-NN
  clustering (§4.3 of `clustering.md`): ANN-based candidate sets.
- **Stage 2 sibling kernel (`citation-taste.js`).** For each
  neighbourhood, sums a Gaussian kernel over every sibling
  neighbourhood in the same cluster. Cost: `O(NG_c²)` per cluster,
  where `NG_c` is the number of neighbourhoods in cluster `c`. Small
  in practice (`NG_c << m_c`); not a scaling cliff.
- **Stage 3 triangle scoring.** `O(numClusters² · max(|T_cluster|))`.
  Bounded by cluster count, not node count. Not a scaling cliff.

The intra/cross decomposition and the cluster-level taste model are
still useful conceptual frames for *analysing* observed citation
patterns at scale, even when the four-stage *generative* model is no
longer used. See `doc/scaling.md` §2.3 for the real-data port — the
short version is that real citations are observed, so Layer 3 is
skipped entirely; what carries over is the analysis vocabulary.

#### 4.1.7 Default params

The full bag of defaults handed to `infer`:

| Key               | Default | Stage   |
| ----------------- | ------- | ------- |
| `neighbourK`      | 3       | 1       |
| `tasteSeed`       | 23      | 2 + 3   |
| `favouritesMean`  | 1.5     | 2       |
| `sharedTaste`     | 0.7     | 2       |
| `tasteRange`      | 18      | 2 + 3   |
| `transitiveBoost` | 0.4     | 3       |
| `samplingSeed`    | 17      | 4       |
| `density`         | 0       | 4       |
| `intraRate`       | 0       | 4       |
| `crossRate`       | 0       | 4       |
| `epsilonIntra`    | 0.05    | 4       |
| `epsilonCross`    | 0.01    | 4       |

Density / rates default to 0 so a freshly-generated network has no
citations until the user dials them up. The other knobs are tuned so
the staged taste model produces interesting structure at typical
density values (≥ 0.3).

### 4.2 Imported edges (real-data path)

- **Module:** `app/src/citations/imported-edges.js`, with the
  fetch-side importer at `app/src/citations/importers/json-file.js`.
- **Registry id:** `imported-edges`
- **Default params:** `{ importer: "json-file" }`
- **Async:** yes — the importer does I/O.

Materialises a **pre-existing citation graph** carved from
`citgraphv2` into the same `CitationResult` shape that
taste-network produces, so every downstream consumer (citation
layout, Layer 5a alignment, viewer-3d edge rendering, in-degree
colour mode) is source-agnostic.

#### 4.2.1 When this algorithm runs

Picked automatically by `engine.reingest()` when the active data
source is `real`. The toy default stays at `taste-network`.

The `imported-edges` algorithm declares two flags on its registry
entry that drive the engine's cascade:

- `needsNeighbourhoods: false` — short-circuits past the
  `reneighbour()` / `retaste()` / `resample()` lanes. The
  algorithm runs through a dedicated `resampleViaImport()` lane
  that just calls `infer()` and materialises.
- `needsBasePos: false` — unlike taste-network, doesn't need a
  Euclidean basePos to reason about. The cascade reaches Layer 3
  even on the real-data ingest path where basePos starts null
  (it gets populated later when the user picks a 3-d viz
  reduction).

#### 4.2.2 Inputs

- Embedding subset metadata (just `nodes.length` — i.e. n).
- `dataSourceParams.subset` — the registered subset id (today:
  `"dev_subset_1000"` or `"dev_subset_bfs_5000"`).

Importer maps subset id → directory name inline (`SUBSET_DIRS` in
`importers/json-file.js`) and fetches
`/literture-network/artifacts/<dir>/citation_edges.json`.

The same file is *also* fetched at ingest time by `produceReal()`
and cached in `state.rawCitationEdges` for the Layer 1.5 fusion
stage (see `doc/fusion.md` §4). Layer 3 currently re-fetches the
same URL; HTTP cache covers the wire cost. Tightening this to
read from `state.rawCitationEdges` is a follow-up.

#### 4.2.3 Direction handling

`citgraphv2`'s on-disk convention: `source_key → target_key`
means "source is cited by target" (DB convention). The toy's
`CitationResult.citations` convention is the inverse: `source`
did the citing, `target` got cited. The materialiser flips
direction on the way in:

```
For each (a, b) in the imported edge list  // "a is cited by b"
  citations.push({ source: b, target: a })  // toy: b cites a
  inDeg[a]++                                // a was cited
  hasCit[a*n + b] = 1; hasCit[b*n + a] = 1
  edges.push(min(a,b), max(a,b))
```

The fusion stage's diffusion is direction-agnostic (symmetric A
∨ Aᵀ) so it doesn't care which direction the JSON stores.

#### 4.2.4 No clustering, no neighbourhoods, no sampling

The topology is **given, not inferred**. `cluster_result`,
`neighbourhoodResult`, `tasteResult` are not consumed; the
materialise function takes `(genResult, rawEdges, paramsEcho)`
and writes the full `CitationResult` directly. `pools` is
populated with diagnostic counters (`imported`, `dropped`,
`selfLoops`) rather than taste-network's category buckets.

#### 4.2.5 Scaling

`O(|E|)` materialisation + `O(n²)` for the `hasCit` matrix. At
BFS-5000 with |E|=12 268, `hasCit` is 25 MB and materialisation
is sub-second. The `hasCit` cost is the same scaling-cliff
liability taste-network has — a sparse-storage replacement
(`CSR(rowPtr,colInd)`) is the planned upgrade when n outgrows the
toy. See `doc/scaling.md` for the broader storage-at-scale picture.

---

## 5. Pipeline rerun semantics

Each stage of the taste-network algorithm is its own pure function
with its own seed; the registry's `infer` runs all four in sequence
on every call. Externally (from main.js's perspective), a citation
recompute always re-runs the full algorithm, but **main.js owns
sub-stage caches** for granular re-runs:

| User action                                             | Stages re-run                                  |
| ------------------------------------------------------- | ---------------------------------------------- |
| `nodeCount`, `pointsOfOrigin`, `spreadScale`, `seed`    | generation → clustering → all 4 citation stages |
| any clustering modal change (algorithm or its params)   | clustering → all 4 citation stages              |
| `neighbourK`                                            | stage 1 → 2 → 3 → 4                            |
| `favouritesMean`, `sharedTaste`, `transitiveBoost`, `tasteSeed`, *Randomize taste* | stage 2 → 3 → 4 |
| `density`, `intraRate`, `crossRate`, `ε_intra`, `ε_cross`, `samplingSeed`, *Randomize sampling* | stage 4 only |

This sub-stage granularity is currently implemented by main.js calling
`inferNeighbourhoods` / `buildCitationTaste` / `generateCitations`
directly for the granular re-run lanes (`reneighbour() → retaste() →
resample()`), and only routing through the registry's `infer` at boot
and after generation changes. When v3.x migrates the citation modal to
be registry-rendered, the sub-stage caches will move into the
algorithm module itself (the registry will gain an optional
"sub-stages" interface, similar to how clustering's `infer` is
single-shot but most cluster algorithms internally compute distances
once per regen).

After any citation re-run, downstream layers re-run via
`relayoutCitations()`:

- citation graph changed → Layer 4 (citation-layout) recomputes
  `state.citationLayout`
- → Layer 5a (alignment) recomputes `state.alignedCitationLayout` +
  `state.alignmentCorrelation`
- → Layer 5b (blend) sees the new arrays through its getters; next
  d3-force-3d tick reflects them.

---

## 6. Versioning the contract

The contract above is the "public interface" of the citation-
generation layer. Adding a new algorithm should never require changing
it.

If the contract DOES need to change (e.g., adding a required
diagnostic field, or splitting `citations` into directed and
undirected variants), update this doc first, bump the changelog below,
update `app/src/citations/contract.js`, then update existing
algorithms to satisfy the new contract.

### Changelog

- **v3 stage 1**: contract introduced. Public shape:
  `{ method, params, hasCit, inDeg, citations, edges, pools }`.
  Algorithm: `taste-network` (lifted byte-identical from the v2
  citation pipeline). Validator covers shape + sampled hasCit
  symmetry.
