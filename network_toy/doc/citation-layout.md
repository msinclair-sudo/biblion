# Citation-driven layout

This document is the math + algorithm reference for Layer 4 of v3
(citation-layout) and the alignment step that lives in Layer 5
(blend). The two together produce `alignedCitationLayout`, the α=1
endpoint of the blend described in `dynamics.md` §4.

The defining constraint is encapsulation:

- The **layout module** (`app/src/citation-layout/`) sees only the
  citation graph + per-node timestamps + a layout seed. It does not
  see basePos, clusters, or how citations were generated.
- The **alignment module** (`app/src/blend/align.js`) is the only
  place in the codebase where citationPos and basePos meet.

Two-stage pipeline:

```
citation graph + t + seed
    │
    ▼
citation-layout/{fr|mds|umap-graph}.js  →  citationPos   (algorithm of choice)
    │
    ▼
blend/align.js                          →  alignedCitationPos
                                            (per-component similarity
                                             alignment to basePos)
```

The layout module exposes a registry; today there are **three**
algorithms with different flavours:

| id                       | flavour       | what it preserves                                            |
|--------------------------|---------------|---------------------------------------------------------------|
| `fruchterman-reingold`   | cladogram     | topology only; edge LENGTHS are arbitrary force balance       |
| `mds-graph-distance`     | dendrogram    | per-pair distance ≈ graph-shortest-path distance              |
| `umap-graph`             | manifold      | **local** citation neighbourhoods (1-hop, padded with 2-hop)  |

User picks via the **Citation Layout ▾** modal. Each algorithm
suits a different scale and density regime — see §6 below.

**Opt-in policy.** As of §6.16 the cascade no longer auto-runs
this layer. After Layer 3 emits a citationResult, layout /
alignment / blend are marked stale and the workflow chart shows
orange dots. `relayoutCitations()` only runs when the user
applies in the Citation Layout modal. See `doc/blend.md` §3.

---

## 1. Layout: Fruchterman–Reingold in 3D (cladogram)

`app/src/citation-layout/fr.js`. Standard FR in 3D with two additions:
a **time-axis radial anchor** that biases older nodes toward the
centre, and a **hard outer wall** that prevents pathological
self-repelling clouds (sparse graphs with many isolated nodes) from
inflating without bound.

### 1.1 Forces

Let `n` be the node count, `R = worldR` the working half-extent
(default 60, matching basePos), and

```
k  =  (volume / n)^(1/3)              volume = (2R)³
```

`k` is the FR ideal edge length. Connected pairs equilibrate at
`d = k`; disconnected pairs equilibrate at infinity (held back by
repulsion and the anchor).

Each iteration accumulates three force contributions per node:

#### Repulsion (every pair)

For every unordered pair `(i, j)`:

```
f_rep(d)  =  k² / d
```

Direction: from `j` toward `i`, applied with opposite sign on `j`.
For `d` near zero we kick the pair apart with a tiny random direction
so future iterations have a usable gradient.

#### Attraction (citation edges only)

For every edge `(u, v)` in the citation graph:

```
f_att(d)  =  d² / k
```

Direction: from `u` toward `v`, opposite sign on `v`. Citation edges
are treated as undirected — t-ordering is folded into the radial
anchor, not the attraction.

#### Time-axis radial anchor (Hooke's law toward origin)

For every node `i`:

```
ka_i      =  max(T_FLOOR, 1 − t_i) · tBias       (T_FLOOR = 0.2)
f_anchor  =  ka_i · |position_i|                 toward origin
```

Force linear in radius. This is what gives the layout a cladogram
feel — older nodes (low `t`) feel a stronger pull and end up more
central, younger nodes drift outward under repulsion. Floor at 0.2
keeps even `t = 1` nodes anchored enough that pure-repulsion runaway
is impossible.

The cladogram is **unrooted** — radial only, no privileged axis.
Time bias does not introduce any preferred orientation.

Hooke's law (linear in `r`) was chosen over a constant-magnitude
anchor because constant-magnitude is overwhelmed by repulsion sums in
many-isolated-node graphs — equilibrium becomes unbounded. Hooke
scales with `r`, so equilibrium is finite for any cloud size.

### 1.2 Cooling + clamp

Per-iteration max displacement decays linearly:

```
temp(iter)  =  R · initialTempFraction  +
               (R · finalTempFraction − R · initialTempFraction) · iter / (iters − 1)
```

with defaults `initialTempFraction = 0.20`, `finalTempFraction = 0.005`.
Each node's accumulated displacement is capped at `temp` before being
applied — standard FR cooling, prevents oscillation.

After applying displacement, every node is clamped to the outer wall:

```
wallR  =  R · outerWallFraction          (default 1.5)

if  |position_i|  >  wallR:
    position_i  ←  position_i  ·  wallR / |position_i|
```

The wall is a backstop. For connected, normally-cited graphs the
soft anchor handles equilibrium and the wall never activates. For
sparse graphs (e.g. citation density 0.05, 60% isolated nodes) the
self-repelling-cloud equilibrium is far outside `R`; the wall snaps
those nodes onto a peripheral shell at `r = wallR`.

### 1.3 Determinism + seeding

Initial positions are uniform in the cube `[−R/3, R/3]³`, sampled
with `mulberry32` seeded from the citation seed (XOR'd with a marker
constant so it doesn't accidentally collide with other seeded
modules). The full algorithm is byte-deterministic for a given
`(n, edges, t, seed, params)` tuple — same inputs always produce the
same `Float32Array` output.

### 1.4 Cost

`O(iterations · (n² + |E|))`. For `n = 400, iterations = 200,
|E| = 2500` that's around 32 M floating-point ops; expect ~1 s on
modern V8 (hardware-dependent). Recomputed only when the citation
graph or layout params change — cached as `state.citationLayout`.

The `n²` term is the all-pairs repulsion sum and is the binding cost
at scale. See `doc/scaling.md` §2.5 for what this means at 800k+ and
what alternatives exist (Barnes–Hut, SGD-based force-directed, or
abandoning FR for MDS / spectral).

---

## 2. Layout: MDS on graph distance (dendrogram)

`app/src/citation-layout/mds.js`. Multidimensional scaling, where
the target distance for every pair is the **graph-shortest-path
distance** times a scale factor:

```
target_ij  =  scaleD · d_ij
```

Per-component: each connected component is its own MDS problem.
Cross-component pairs are deliberately omitted from the stress
function (no path → no graph distance to preserve). Singletons
land at origin and are then translated to basePos by the alignment
step.

### 2.1 Why MDS

FR is *cladogram-flavoured* — it tells you which nodes are
connected, but edge LENGTHS are arbitrary force balance. A 1–2–3
chain ends up with `|x_1 − x_3|` set by repulsion vs. attraction in
the 1↔3 pair (which has no edge between them in FR's view), not by
the fact that 1 and 3 are graph distance 2 apart.

MDS is *dendrogram-flavoured* — pairwise 3D distances reflect
pairwise graph distances. The 1–2–3 chain falls out collinear with
`|x_1 − x_3| = 2 · |x_1 − x_2|`, exactly because `d(1, 3) = 2`.
Verified: `scratch/v3_phase7_acceptance.mjs` chain test gets
ratio 1.995.

For larger graphs, exact ratio preservation is bounded by the
intrinsic dimensionality of the graph relative to 3D (Phase 7
acceptance: ratio for `d=2` pairs / `d=1` pairs is 1.68 on the
seed=42 dense graph, instead of the chain test's 1.995 — graphs
with high effective dimension can't be embedded in 3D without
distortion).

### 2.2 SMACOF Guttman update

Stress:
```
σ  =  Σ_pairs ( |x_i − x_j|  −  scaleD · d_ij )²
```

Each iteration applies the Guttman transform — for every node `i`,
replace `x_i` with the centroid of "ideal positions for i" derived
from each pair:

```
new_x_i  =  (1 / (m−1))  ·  Σ_{j≠i}  [ x_j  +  (t_ij / |x_i−x_j|) · (x_i − x_j) ]
```

This is the standard SMACOF update; monotonically decreases stress
on a quadratic majorant; no learning rate or temperature needed.
Degree-normalised by construction (the `1/(m−1)` factor) so dense
components don't blow up like a naïve gradient-descent would.

For coincident pairs (`|x_i − x_j| = 0`), the limit of
`(t_ij / |x_i−x_j|) · (x_i − x_j)` is 0, so the contribution is just
`x_j`. Implemented as a special-case branch.

Atomic Jacobi-style update: read all `x` from the previous
iteration, compute all new `x`, then swap. No iteration-order bias.

### 2.3 Cost

`O(iterations · m²)` per component for the SMACOF inner loop;
`O(m · (m + |E_c|))` for the per-component BFS. For
`n = 184, iterations = 200` that's around 7 M floating-point ops on
typical synthetic data; sub-second wall time on modern V8.

The cost scales with **largest component size**, not total `n` —
this is the major structural advantage over FR. Cross-component
pairs are deliberately omitted from the stress function, so a graph
with many small components is much cheaper than a single giant
component of the same total size. See `doc/scaling.md` §2.5 for
what this means at 800k+ when most citation graphs have a giant
component, and what the alternatives are (pivot/landmark MDS,
spectral layout, t-SNE / UMAP).

The component BFS also materialises an `m × m` distance matrix per
component. At `m = 700k` (a giant connected component) that is
`~2 PB` at i32 — same scaling cliff as the full-graph distance
matrix in HDBSCAN.

### 2.4 Initial positions + seeding

Random in a cube of half-extent `scaleD/2`, seeded from the citation
seed XOR'd with a marker constant. Deterministic for a given
`(n, edges, t, seed, params)` tuple.

`t` is accepted in the input contract for symmetry with FR but
ignored — MDS doesn't have a time-bias mechanism (graph distance
is the only structure it preserves). If you want time stratification
of the layout, use FR.

---

## 3. Layout: UMAP on the citation graph (manifold)

`app/src/citation-layout/umap-graph.js`. Third entry, registered
to address the two failure modes the other algorithms exhibit on
sparse large-scale citation networks:

- **FR collapses to a uniform spherical shell** at density
  ≲ 0.005 — repulsion dominates and the outer wall clamps
  everyone to the boundary (see §1.2 and §5).
- **MDS produces nested orbital shells** at n ≳ 5000 — the
  graph-distance matrix's top eigendirections dominate the
  SMACOF stress, and the m²-BFS cost becomes prohibitive.

UMAP on the citation graph avoids both by **discarding the
global distance regime entirely** and preserving only local
neighbourhoods — exactly the property MDS-at-scale loses.

### 3.1 Why it works for citation graphs

The citation literature converges on community / cluster
structure as the most worth preserving in a visualisation (see
VOSviewer's LinLog-modularity, CiteSpace's modified spring
embedder, the broader graph-embedding family node2vec /
DeepWalk). Stress-minimising and force-directed methods fail on
sparse graphs because they assume the distance matrix is
informative; for n=5000 with average degree ≈ 5, long shortest
paths are unreliable and small perturbations swing distances by
factors of 2 or more.

UMAP's fuzzy-simplicial-set construction reads only the **direct
neighbour list** per node (k-NN) and lets larger structure emerge
from local overlaps. Citation adjacency *is* the k-NN graph: each
paper's "neighbours" are the papers it cites + the papers that
cite it.

### 3.2 Adjacency preparation

Symmetrise (A ∨ Aᵀ) so the algorithm treats direction-agnostic.
Direction encodes time/flow but contains no positional meaning —
two papers in a citation relationship belong near each other
regardless of who cites whom.

```
For each citation edge (u, v):
  adj[u].add(v)
  adj[v].add(u)
```

### 3.3 Building the precomputed k-NN graph

`nNeighbors` total slots per node (default 15, umap-js
convention: includes self at index 0 with distance 0). Filled by
BFS-layer expansion from the source node:

```
For each source s:
  visited = {s}
  output[s][0] = (s, distance 0)        # self
  frontier = adj[s]                      # layer 1
  hop = 1, slot = 1
  while slot < nNeighbors and frontier non-empty:
    for v in frontier:
      output[s][slot++] = (v, distance hop)
      mark v visited
      if slot == nNeighbors: break
    frontier = unvisited neighbours of last frontier
    hop += 1
  if slot < nNeighbors:
    pad remaining slots with random unvisited nodes
    at distance lastHop + 1
```

Two interpretive notes:

- **Distance = hop count.** UMAP's fuzzy-set construction reads
  these as ascending — the algorithm doesn't care about the
  numeric scale, just the ordering and the local connectivity.
  Hop 1 vs hop 2 is informative; absolute numbers are not.
- **Padding for low-degree nodes.** Papers with degree < 14 get
  the rest of their k-NN slots filled with 2-hop or 3-hop
  neighbours via BFS, then with random unvisited nodes at a
  distance just past the last real hop. UMAP downweights these
  via the fuzzy-set normalisation; they prevent isolated-corner
  embeddings without dominating the structure.

### 3.4 UMAP fit

Feeds umap-js's `setPrecomputedKNN(knnIndices, knnDistances)`
API directly, then calls `fit(X)` with a dummy `X` (single-feature
index vectors — UMAP doesn't consult X when k-NN is precomputed).
nComponents = 3 for the 3D viewer.

```js
const umap = new UMAP({
  nComponents: 3,
  nNeighbors:  kTotal,
  minDist:     params.minDist,
  nEpochs:     params.iterations,
  random:      mulberry32(seed ^ 0x9E3779B9),
});
umap.setPrecomputedKNN(knnIndices, knnDistances);
const Y = umap.fit(X);     // X is dummy index vectors
```

Determinism: `mulberry32(seed)` flows in via the `random`
parameter. Same `(n, edges, seed, params)` → byte-identical
output across re-runs.

### 3.5 Output centring + scale

UMAP outputs in roughly `[-5, 10]` per axis with no canonical
orientation. We centre at origin and multiply by a configurable
`scaleD` so the output sits at a coordinate range comparable to
FR / MDS before per-component alignment (`doc/blend.md` §1)
scales it to basePos's extent:

```
out[i] = scale · (Y[i] − centroid(Y))
```

The whole-graph alignment in Layer 5a then takes care of the
final visible scale.

### 3.6 Parameters

| Param        | Default | Range       | Effect                                                                                   |
|--------------|---------|-------------|------------------------------------------------------------------------------------------|
| `nNeighbors` | 15      | [4, 50]     | k-NN size (includes self). Higher = global structure; lower = local communities tighter |
| `minDist`    | 0.1     | [0.0, 1.0]  | Minimum embedded distance between tight-cluster points. Lower = tighter packing         |
| `iterations` | 500     | [50, 2000]  | UMAP optimisation epochs. 500 converges in ~3 s at n=5000 with precomputed k-NN          |

### 3.7 Cost

`O(|E| + n · k)` for k-NN construction (BFS expansion) +
`O(iterations · n · k)` for UMAP optimisation. At n=5000,
|E|=12 268, k=15, iterations=500: ~5–15 s wall time on modern V8,
main-thread synchronous. The Web Worker port that wraps the heavy
dim-reduction algorithms (see `doc/workers.md`) applies here too.

### 3.8 Failure modes

- **Highly disconnected graphs** — UMAP can't bridge components
  except by accident; small components float as separate
  "blobs" with no metric relationship to the giant component.
  Per-component alignment in Layer 5a places each at its basePos
  centroid; the gaps between them are basePos-determined, not
  citation-determined. Honest — there's no citation evidence to
  span the gap.
- **Hub papers (high in-degree).** They sit between many
  communities semantically and topologically — UMAP places them
  at the boundary regions. After alignment, these are the nodes
  that travel the most distance when the fusion-comparison
  slider drags from α=0 to α=1. That's the algorithm's payoff;
  see `doc/fusion.md` §6 for the cluster A/B colour-mode that
  visualises this.

---

## 4. Alignment to basePos

The layout produced by either §1 or §2 sits in its own coordinate
frame (orientation, centroid, and scale picked by the algorithm's
internal force / stress balance, not by anything basePos says). The
alignment step that brings it into basePos's frame — per-component
similarity transform with match-RMS scaling — lives in the **blend**
layer, not the layout layer, by encapsulation: the layout module
never sees basePos.

**See `doc/blend.md` §1** for the alignment math: union-find on the
citation graph, per-component Kabsch via Horn's quaternion, the
match-RMS scale formula and why it's preferred over the textbook
Procrustes-optimal scale (which collapses partially-correlated
sources toward the target centroid), and the alignment correlation
coefficient that falls out for free as a quality metric.

`alignByComponent({ basePos, citationPos, edges, n })` returns
`{ aligned, correlation }`. main.js caches both on
`state.alignedCitationLayout` and `state.alignmentCorrelation`.

---

## 5. Output contract

`Float32Array(n × 3)`. Every value finite. Indexed by data-node id:

```
alignedCitationLayout[i*3]   = x
alignedCitationLayout[i*3+1] = y
alignedCitationLayout[i*3+2] = z
```

Validators in `app/src/citation-layout/contract.js`. The blend force
hook (`app/src/blend/blend.js`) consumes this array verbatim alongside
basePos and lerps each frame.

---

## 6. Failure modes worth knowing about

These are layout-side failure modes. Alignment-side failure modes
(component overlap, two-node degeneracy, coincident-points) are
documented in `doc/blend.md` §1.7.

**Which algorithm for which scale / density:**

- **FR** — toy (n ≤ 400) and small dense graphs. The cladogram
  flavour is most informative when the time anchor has meaningful
  variation (`t` values spread across [0, 1]); on real-data with
  paper_years.json populated, FR makes sense again. On sparse
  large graphs (n=5000, density ≈ 0.001) it collapses to a sphere.
- **MDS** — toy and small connected components where intrinsic
  graph dimensionality ≤ 3. At n ≳ 1000 the m²-BFS cost becomes
  prohibitive and the layout degenerates into nested orbital
  shells.
- **UMAP-on-graph** — real-data (n = 1000+) sparse citation
  networks. Best choice for the BFS-5000 fixture and anything
  larger. Discards global distances; preserves local
  neighbourhoods only.

- **Very sparse graphs** (most nodes isolated) produce a layout
  where most nodes sit near origin and the few connected components
  float slightly off. After alignment they end up at their basePos
  positions; the blend then does very little and the visualisation
  is roughly basePos at any α. This is honest: a graph with no
  citations has no citation-driven topology to render.

- **The FR outer wall activates** when a self-repelling cloud's
  natural equilibrium exceeds `R · outerWallFraction` (default
  `1.5 · R`). Nodes pile onto the wall surface. With `tBias` high
  enough this never happens for realistic graphs; tune higher if
  you see a peripheral shell where none belongs. MDS doesn't have a
  wall — it's bounded by graph diameter directly.

- **MDS in 3D can't always satisfy every graph-distance target**
  for graphs whose effective dimension is greater than 3 (which is
  most non-trivial citation networks). Stress doesn't go to zero;
  the layout is the best 3D projection. Empirically:
  `dist=2 / dist=1` ratio comes out below 2.0 (~1.7 in our test
  graph) instead of exactly 2.0. The chain test in
  `scratch/v3_phase7_acceptance.mjs` gets 1.99 because a 3-node
  path IS embeddable in 1D.
