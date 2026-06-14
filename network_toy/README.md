# Network Dynamics Demonstrator

An interactive 3D toy for comparing **multiple arrangements of the
same network**: a spatial embedding, a layout derived purely from
the citation topology, and — when the data carries citations — a
**fused** embedding that lets citation context reshape the topic
map before clustering. Two independent sliders blend between
endpoints deterministically, so you can ask both "do these two
views agree?" *and* "what changes when citations inform the
embedding itself?" in one interactive surface.

Built as a teaching / demo aid for network-science intuition.
Lets you ask "what does this dataset look like as positions vs. as
a graph?" and watch the answer fade between the two — then ask
"what does it look like when we fold the citation graph back into
the embedding?" and watch *that* answer too. Works on a toy
Gaussian-mixture dataset (n ≈ 400) for fast exploration, or on a
SPECTER2-embedding subset of real research papers (n = 1000+;
5000-paper BFS subset is the current load-bearing fixture).

## Running

The app is a static web page that uses ES modules, so it must be
served over HTTP (not opened as `file://`).

```bash
# from the project root
python -m http.server 8000
# open http://localhost:8000/app/
```

No build step. All dependencies (`three`, `3d-force-graph`,
`force-graph`, `umap-js`, `fflate`) load from CDNs (unpkg + esm.sh)
via an import map.

## What you do with it

The current shell is at `http://localhost:8000/app/`. The original
v3 demo shell is preserved at `http://localhost:8000/app/legacy.html`.

The app **starts empty** — there's no data until you add it. Begin at
the workflow chart's **+ Add data source** (left rail) and build out
from there; see *Workflow chart* below.

### Topbar: **File ▾**

Save / Save as… / Load… write or read a `.zip` archive of the
**entire project state** — every dim-reduction output, every
cluster level, every bridge analysis, every Optimise sweep
result. Loading a saved project skips the engine cascade, so you
pick up exactly where you left off without re-running anything.

### Workflow chart (left rail)

The **primary surface**: a branching tree of analysis cards you grow
yourself. It starts **empty** — the toy no longer auto-runs a pipeline
on boot. You build it up one step at a time:

1. Click **+ Add data source** → pick toy or real → Apply. A single
   **data card** appears (spinning blue while it loads, then a green
   dot). For real data the viewer stays empty until you add a viz
   reduction.
2. Each card has a **+** at its base → an "Add step" menu of the valid
   next steps (e.g. from data → dim-reduction; from dim-reduction →
   clustering / dim-sweep; from clustering → bootstrap / compare / dim
   sweep / citation layout). Picking one opens its modal; Apply forks a
   **new child card**.
3. So you build out granularly: data → dim-reduction → clustering, each
   an explicit step. Adding dim-reduction does **not** auto-run
   clustering — you stay in control of each layer.

Per card:

- **Click** a card → selects it; the 3D viewer + every panel switch to
  that card's result. (Click no longer opens the modal.)
- **⚙ gear** (bottom-right) → opens the card's config modal. Apply forks
  a new sibling with the new params (the old card stays browsable —
  cards are immutable once done).
- **+** (base) → add a downstream step.
- **↻** (appears on stale cards, amber dashed border) → re-run with the
  same params when an upstream card changed.

Branching is native: fork two clusterings from the same dim-reduction
and compare them with a **cross-source comparison** card (dashed edges
link it to the two clusterings it compares). A **Next steps** panel
mirrors the per-card "+" menu for the selected card.

The card types and what each configures:

- **Data** — pick between the toy Gaussian-mixture generator and
  the real SPECTER2 paper subset (random 1000-paper or BFS-carved
  5000-paper). Real data brings its own publication years
  (`t ∈ [0, 1]` normalised over the subset's year range) and a
  citation edge list cached at ingest for the fusion stage to
  consume.
- **Dim reduce** — **five**-stage dim-reduction layer.
  1. **Noise** reduction (PCA-100).
  2. **Fusion** (optional) — citation-aware re-embedding via
     graph diffusion. Pulls papers that cite each other closer
     in feature space while keeping each anchored to its
     original SPECTER2 vector. Default identity (no fusion).
  3. **Compression** (UMAP-100, clustering input — bumped from 50 after §6.9 ARI dim-sweep validation showed ARI(50, 100) = 0.806 < 0.9 threshold on BFS-5000; see `doc/dim-sweep-results.md`).
  4. **Viz** (UMAP-3, basePos for the 3D viewer / blend).
  5. **Viz2d** (UMAP-2, the 2D viewer's input).
  Each stage's algorithm is independent; UMAP fits get distinct
  seeds so they don't sync. When fusion is non-identity, the
  pipeline ALSO runs compression + viz on the pre-fusion data so
  the A/B comparison slider has both endpoints.
- **Clustering** — tabbed modal: **Configure** (algorithm + per-level
  params + a "Stability (bootstrap)" section — bootstrap runs as a
  sidecar to clustering, not as a separate card) and **Optimise**
  (sweeps). When fusion ran, the workflow forks into pre/post-fusion
  branches (see `cards.md`) — cluster each branch independently to get
  the "Color by pre-fusion cluster" mode.
- **Cit. layout** — citation-driven 3D arrangement (FR, MDS, or
  UMAP-on-citation-graph). **Opt-in**: the pipeline cascade
  stops at Layer 3 and does not auto-run this layer. Open the
  modal, pick an algorithm, hit Apply. The status dot shows
  orange (stale) until you do.

Status indicator on each card: green dot (done) / amber dashed border
(stale) / **blue spinner** (running) / grey (pending) / red (error).

### Data sources

**Toy generator** — synthetic 3-d Gaussian-mixture cloud. Knobs:
seed, node count, number of groups, group spread.

**Real (SPECTER2 dev subset)** — loads a slice of the full
SPECTER2 768-d embedding. Two carved subsets available:

- `dev_subset_1000` — random 1000-paper sample (seed 42). Useful
  as a minimal smoke fixture; citation topology is shattered
  (~3 within-subset edges).
- `dev_subset_bfs_5000` — BFS-carved 5000-paper subset (default).
  Preserves topology (~12 k within-subset edges, 100% node
  coverage). This is what fusion + UMAP-on-graph are tested on.

Both come with `paper_years.json` for `t ∈ [0, 1]` normalisation
(newest → 1, oldest → 0) and `citation_edges.json` for the
fusion stage. Toy and real are mutually exclusive — switching
modes drops the other side's state. Real mode leaves the viewers
empty by default — pick a 3-d (or 2-d) viz reduction in the
dim-reduction modal to render.

### Dim-reduction (Layer 1.5)

Five sequential / sibling sub-stages:

```text
embedding ─▶ noise ─▶ fusion ─┬─▶ compression ──▶ clustering input
                              │
                              ├─▶ viz          ──▶ 3D viewer + blend
                              │
                              └─▶ viz2d        ──▶ 2D viewer
```

Each algorithm declares which sub-stages it's eligible for via a
`family` tag. Locked defaults (see `doc/dim-sweep-results.md` for the
empirical validation behind the 100-d compression pick):

- **PCA** in noise → `n_components = 100`
- **Graph diffusion** in fusion → `alpha = 0.3, iterations = 4` (real-data only)
- **UMAP** in compression → `n_components = 100, n_neighbors = 50, min_dist = 0`
- **UMAP** in viz (3-d) → `n_components = 3, n_neighbors = 15, min_dist = 0.1`
- **UMAP** in viz2d (2-d) → `n_components = 2, n_neighbors = 15, min_dist = 0.1`

Picking an algorithm drops the user at these locked-default
values for that slot.

### Citation-aware fusion (the new stage)

Optional Layer 1.5 sub-stage. When enabled, each paper's
embedding vector is iteratively mixed with the mean of its
citation neighbours' vectors (APPNP-style anchored graph
diffusion: `X' = (1−α)X + α·D⁻¹A·X'`). The original SPECTER2
vector stays anchored at all α<1, so no paper drifts away
entirely.

Effect: downstream clustering, basePos, and the 2D viewer all
operate on a citation-informed representation. Communities that
agree across semantic and citation signals tighten; communities
that disagree may split or merge. Requires real-data mode
(citations imported at ingest); toy mode falls through as
identity because citations are generated *after* clustering
there.

### Fusion-comparison slider

When fusion is non-identity, a second slider — labelled `fusion`
— appears in the left rail under Blend. It interpolates between
**pre-fusion basePos** (UMAP-3 on the noise-stage output) and
**post-fusion basePos** (UMAP-3 on the fusion-stage output). The
two endpoints are Procrustes-aligned (whole-graph rotation + match-
RMS scale + translation) so the interpolation walks a clean
straight-line path between each node's two locations instead of
corkscrewing through arbitrary UMAP rotations.

Pair it with the **Color by pre-fusion cluster** mode in the
viewer's colour-mode dropdown to see exactly which papers were
reorganised by citation context — colours stay constant (defined
by pre-fusion clusters), positions drift.

### Multi-level clustering

The Clustering modal's **Configure** tab supports a stack of
clustering levels. Each level has its own params; non-root levels
also have a scope toggle:

- **global** — re-cluster the whole dataset at this level's
  params (often a finer resolution).
- **within parent** — run the algorithm within each previous-
  level cluster's members only.

Mix freely. Add levels with **+ Add level**, remove with **×**.
Same algorithm shared across all levels.

### Optimise multi-layer (auto multi-level)

Instead of stacking levels by hand, the **+** under a dim-reduction card
offers **Optimise multi-layer clustering**: run HDBSCAN *once* and extract
a coarse→fine ladder of layers from its condensed tree (no repeated
sweeps). Set the granularity (min cluster size / min samples) and a layer
cap (≤ 5); the natural resolution shelves are discovered automatically.

Noise-stripped points are absorbed into the nearest live cluster over the
MST, so a fine cluster can draw members from **two coarse parents** — a
genuine *bridge*. The result is a multi-level clustering card; the viewer's
colour-by-layer mode shows each level. (The dominant distance-matrix cost
fans out across your CPU cores.)

Two panels consume it (add them from any panel slot's `+`):

- **Bridge analysis** — each fine cluster vs a chosen coarse parent level,
  split by a dominance threshold **τ** (default 0.8) into *Encapsulated*
  (one dominant parent) and *Bridges* (spans ≥2 parents below τ).
- **Tree scoring** — score clusters **1–5, layer by layer**. The top layer
  first; descending a layer filters the finer clusters by a slider on their
  dominant parent's score (children of well-scored parents only), with
  bridges in their own section. Scores persist with the project. Cluster
  labels come from a multi-method module (representative paper + year on
  real data; the text methods — TF-IDF, c-TF-IDF, KeyBERT, and **Stratified**
  multi-resolution labels — light up once paper titles are materialised, e.g.
  via the SQLite biblion source). Stratified describes each cluster across five
  generality bands at once (anchor → signature), with band edges fitted to the
  dataset's own term-frequency distribution.

Full design + math in `doc/multi-level.md`.

### Optimise tab

Sweep `algorithms × parameters` and rank by a chosen scorer:

- **Match to known groups (ARI)** — Adjusted Rand Index vs the toy
  generator's ground-truth origins. Toy-only. Shown alongside the
  Bayes-optimal ARI ceiling for the generated mixture (e.g.
  "0.85 (92% of 0.92)") so you can read the achieved ARI as a
  fraction of optimal rather than as a raw number.
- **Cluster count × reproducibility** — `nClusters × meanJaccard`.
  Penalises both extremes: one mega-cluster scores low, hundreds of
  noise-fragments score low, the balanced middle wins.
- **Number of clusters** — raw count. Use when you trust the
  algorithm's geometry and want to push toward more clusters.
- **Cluster reproducibility** — bootstrap-Jaccard mean (size-weighted).
  Beware: a 1-cluster partition scores ~1.0 mechanically.

In toy mode, an **Automatic** option picks ARI for you (ground truth
exists). In real mode there's no auto-pick — you choose explicitly,
because each scorer answers a different question.

**Noise handling** dropdown (affects bootstrap-based scorers):
*Exclude* drops noise points from both ref and bootstrap;
*Treat noise as a cluster* matches noise-vs-noise like any pair;
*Penalise* scales aggregates by `(1 − noise fraction)` so noisier
clusterings lose stability proportionally. Scores under different
modes are not directly comparable — pick one and stick to it.

Three sweep modes:

- **Resolution only** — just the parameters that control granularity
  (e.g. HDBSCAN's `min_cluster_size`, mutual k-NN's `mutualK`). Fast;
  good default for cross-algorithm comparison.
- **Full grid** — cartesian product of every parameter on every
  enabled algorithm. Slow; use when you want to characterise an
  algorithm's whole surface, not pick a winner.
- **Target range** — looks for the most stable params that produce
  a user-specified cluster-count band (e.g. "between 20 and 40
  clusters"). Two-phase: Latin-hypercube probe per algorithm, then
  ±step neighbourhood refine around any config that landed in the
  band. Much cheaper than the cartesian sweeps when you already
  know the cluster count you're aiming for. Optionally rank
  Phase-2 candidates by bootstrap-Jaccard reproducibility instead
  of by proximity to the band's midpoint.

**Sweep against** (target-range only, fusion-active only):
optimise against Post-fusion (citation-aware), Pre-fusion
(semantic-only), or Both. Both runs the sweep twice and tags each
result row with its source, so you can compare which params win on
each representation side by side.

Results table shows every config swept, **sortable columns**, with
per-row **Apply** that drops the config into a level you pick
(`L0 / L1 / … / + New level`). The cascade runs in the background;
the bottom status bar carries the progress.

The bootstrap-Jaccard stability check (Hennig 2007, thresholds
stable ≥ 0.85 / doubtful 0.60–0.85 / unstable < 0.60) is reachable
inside Optimise via the "Cluster richness" / "Cluster
reproducibility" scorers and via the target-range sweep's "Rank by
reproducibility" toggle.

### Validation runs (saved sweeps + saved validations)

Some sweeps are expensive (a full HDBSCAN × parameter grid on
BFS-5000 can take ten minutes). Each result is per-dataset — you
need to revalidate when the corpus changes. To avoid throwing away
that work, the Optimise tab has a **Save this run** button that
appears after a sweep completes. It persists the swept table as a
**validation run** that:

- survives a project save/load,
- shows up in the `+ Add panel` picker under a **Validation runs**
  section,
- opens into a dedicated panel rendering the same sortable table,
  with per-row **Apply** still working,
- carries an inputs snapshot (the data fixture + layerParams active
  at the time of the sweep) so future-you (or a collaborator
  opening the project) sees the conditions the run was produced
  under.

The use case is *"resource without recalculating"*: come back next
week, open the saved sweep, try a different row from the rank,
re-cluster — without re-running the whole 10-minute sweep.

The same mechanism hosts other validations (dim-sweep, fusion comparison
deltas, etc.). The user-facing pattern is always: run → Save this run →
re-open from the picker.

Bootstrap stability runs as a **sidecar to clustering** — toggle it on
in the Clustering modal's Stability section and the result lands in the
bootstrap-stability panel automatically. See `cards.md` for the live
card palette + ordering.

### Bridge analysis (Layer 2.5)

When ≥ 2 clustering levels exist, the toy automatically computes,
for any chosen `(fineLevel, coarseLevel)` pair, each fine
cluster's share breakdown against every coarser level. Surfaces
as `bridge` and `boundaryScore` colour modes in both viewers and
as `bridge` / `boundaryScore` sources in the node table (with the
fine / coarse level-pair selector + per-level share columns).

### 3D viewer (primary panel)

Live blend visualisation. Top-left: **Colour by:** dropdown
selects what drives node colour:

- Cluster (per level)
- **Cluster — pre-fusion** (one entry per level; only present when
  fusion is non-identity — paints nodes by their *pre-fusion* cluster
  IDs so you can drag the fusion slider and watch which papers
  reorganised)
- Origin (toy generator's ground-truth groups)
- Time (`t`-gradient: viridis)
- In-degree (citation in-degree: viridis)
- Bridge (binary: fine clusters whose members span ≥2 coarse parents)
- Boundary score (gradient: `1 − dominantFraction` at the
  chosen `(fineLevel, coarseLevel)` pair)

Top-right: **⚙** opens camera-speed settings (0–1 sliders, no
inertia by default).

### 2D viewer panel

Canvas-based 2D scatter. Same colour-by dropdown, same colour
rules as the 3D viewer (shared resolver under the hood). Reads a
separate 2-d basePos from the viz2d sub-stage. Add it via the
`+` button on any panel slot. Stays empty until viz2d has run.

### Node table (legend)

A mode-aware table that doubles as the legend for whatever's
colouring the viewers. Source dropdown: **Auto** follows the
viewer's colour mode, or pin to a specific source. Continuous
gradients display a min↔max gradient bar.

### Blend slider (left rail bottom)

Sweeps `α: 0 → 1`. At α=0 you see the embedding (basePos); at
α=1 you see the citation-driven layout (per-component aligned to
basePos so the two views share scale/orientation); in between is
a per-frame linear interpolation. **Inert until you explicitly
apply a Citation Layout algorithm** — the cascade no longer
auto-runs that layer.

When fusion is non-identity, a second `fusion` row appears with
its own slider; the two compose as a nested lerp inside the
blend hook. The four corners of `(fusion, α)`-space are:

|              | α=0                          | α=1                                   |
|--------------|------------------------------|---------------------------------------|
| fusion=0     | pre-fusion semantic basePos  | citation layout aligned to pre-fusion |
| fusion=1     | post-fusion (citation-aware) | citation layout aligned to post-fusion|

Round-trip is exact for each slider independently. 3D-only.

### Edge-display controls (left rail, below blend)

Per-edge-kind toggles + colour pickers + numeric sliders. State
lives in `state.view` and persists across project save/load.

- **Citation edges** — show / arrows / opacity slider (0.05–1.00) /
  colour. Drawn from the `CitationResult.edges` list (Layer 3).
- **Base edges** — show / density slider (0–0.2) / colour. Visual
  scaffold drawn between basePos-near neighbours; purely visual —
  does not affect the blend.
- **Cluster skeleton** — show / colour. Renders the
  `structureEdges` set the active clustering algorithm produced
  (mutual-k-NN: reciprocal-k-NN edges; HDBSCAN: MST projection).

### In-flight feedback (per-card)

Modals close immediately on Apply — they don't block waiting for the
work — and feedback lives **on the cards** themselves (the old bottom
busy-bar was retired). A running card shows a **blue spinner** in place
of its status dot; queued cards show a small **position badge** (1, 2,
…). Jobs run one at a time, FIFO. Cancel a running job and the card goes
to a cancelled state.

### Multi-tab panels

Every slot — primary, secondary, bottom — has tabs. Click `+` to
add a new panel via a picker modal. The picker has two sections:

- **Panel types** — every registered panel type:
  - **3D viewer** / **2D viewer** (singletons — one each) — live
    blend visualisation with shared colour-mode dropdown.
  - **Node table** — mode-aware legend table.
  - **Optimise results** — latest Optimise sweep table; updates
    when you run a new sweep. Per-row Apply lands the chosen
    config into the active clustering.
  - **Bootstrap stability** — singleton that auto-binds to
    `state.bootstrapStability` (the sidecar computed by the
    clustering modal's Stability section). Falls back to a saved
    validationRun when one is picked. Per-cluster reproducibility
    table + aggregate strip.
  - **Method receipt** (singleton) — auto-generated defensibility
    paragraph describing the active clustering's methodology
    (algorithm, params, bootstrap protocol, fixture, Bayes-
    optimal ARI ceiling for toy). Copy-to-clipboard.
  - **Bridge analysis** (singleton) — Layer 2.5 multi-level
    boundary derivation, with (fine, coarse) level-pair selector.
- **Validation runs** — every saved run from
  `state.validationRuns` (newest first). Picking one instantiates
  the appropriate renderer bound to that specific run; the same
  saved run can be pinned in multiple panels for side-by-side
  comparison.

`×` on a tab closes it. Singletons are filtered out of the picker
when already mounted somewhere.

## Architecture

Six-layer pipeline of pure functions. Each layer takes the
previous layer's public contract and produces its own — adding
a new algorithm is one new entry in the relevant registry, no
other file changes needed.

The heavy lanes (dim-reduction, clustering, citation layout) each
build a small **DAG** of work and run it via module Web Workers
(`runDAG` in `app/src/workers/dag.js`). Sibling sub-stages
(`compression` / `viz` / `viz2d`, optionally doubled when fusion is
active) execute in parallel; cancellation cascades through the DAG
via `AbortSignal`. The main thread stays responsive at BFS-5000 +
HDBSCAN; the bottom status bar carries all in-flight feedback.

```text
datasource/registry.js        Layer 1    pluggable data source
                                          → {nodes, origins?, embedding?, basePos?, citationEdges?}
        ↓
dimred/registry.js            Layer 1.5  five-stage dim-reduction
                                          noise → fusion → (compression, viz, viz2d)
                                          → dimredResult (+ dimredResultPreFusion)
                                          → _basePos     (+ _basePosPreFusion)
                                          → _basePos2d
        ↓
clustering-registry.js        Layer 2    pluggable clustering (mutual k-NN, HDBSCAN, CC)
                                          → ClusterResult contract (multi-level)
                                          → clusterLevelsPreFusion (when fusion active)
        ↓
citations/registry.js         Layer 3    taste-network (toy) or imported-edges (real)
                                          → CitationResult contract
        ↓                                 CASCADE STOPS HERE (citation layout is opt-in)
citation-layout/registry.js   Layer 4    citation-driven 3D arrangement (FR / MDS / UMAP-on-graph)
        ↓                                 user explicitly applies via the Citation Layout modal
blend/align.js                Layer 5a   similarity alignment:
                                          alignByComponent — per-component, citation → basePos
                                          alignGlobal      — whole-graph, preFusion → postFusion
                                          → alignedCitationLayout + alignmentCorrelation
blend/blend.js                Layer 5b   per-frame nested lerp:
                                          effective = lerp(preFusion, postFusion, fusionBlend)
                                          live      = lerp(effective, alignedCitation, blend)
```

Math reference for each layer is in `doc/`. Start with
`doc/dynamics.md` for the index.

Doc highlights:

- `cards.md` — **live card palette** (Mermaid + semantics): which cards exist, how they auto-spawn, where they attach. Single source of truth for ordering — keep in sync if you add a card type.
- `doc/dimred.md` — Layer 1.5 sub-stages, registry contract, engine orchestration, slot-aware defaults
- `doc/fusion.md` — Layer 1.5 fusion sub-stage: graph-diffusion algorithm, fusion-comparison slider, pre-fusion cluster colour mode, A/B comparison semantics
- `doc/clustering.md` — Layer 2 contract + algorithms
- `doc/citations.md` — Layer 3 contract + taste-network (toy) + imported-edges (real)
- `doc/citation-layout.md` — Layer 4 algorithms (FR, MDS / SMACOF, UMAP-on-graph) + which to pick at which scale
- `doc/blend.md` — Layer 5 alignment + per-frame blend; covers per-component vs whole-graph (alignGlobal) Procrustes, the nested-lerp formula, and the opt-in cascade policy
- `doc/multi-level.md` — multi-level clustering + bridge analysis derivation
- `doc/ui-architecture.md` — shell architecture: state container, engine orchestrator, workflow chart (tree-aware renderer), panel system, modals, queue + per-card job status
- `doc/workers.md` — DAG-orchestrated module workers: runDAG, lane shape, cancellation, transferables
- `doc/eval.md` — Optimise tab: bootstrap-Jaccard, scorers, the three sweep modes (resolution / full / target-range with LHS), known limitations
- `doc/scaling.md` — toy-vs-real-data scaling analysis (`n ≈ 400` toy, `n = 810 k` real)
- `doc/dim-sweep-results.md` — empirical evidence for the locked compression default (UMAP-100); also confirms UMAP-after-PCA is not redundant. Re-run via `validation/dim_sweep_validation.py` when fixtures or algorithms change.
- `validation/README.md` — convention for research-validation scripts (tracked, real-data fixtures) vs `scratch/` (gitignored, toy fixtures only)

## File layout

```text
app/                              static page + ES modules
  index.html                      importmap + boot
  legacy.html                     v3-stage-X archive shell
  styles/main.css
  src/
    rng.js                        shared seeded PRNG (mulberry32 + Box-Muller)
    generation.js                 toy Gaussian-mixture generator
    datasource/                   Layer 1 — pluggable data source
      registry.js
      contract.js
      toy.js                      wraps generation.js
      real.js                     fetches SPECTER2 dev_subset .npy
    dimred/                       Layer 1.5 — pluggable dim-reduction
      registry.js
      contract.js
      identity.js
      pca.js
      umap.js                     wraps umap-js
      graph-diffusion.js          fusion stage — APPNP-style citation-aware re-embedding
    clustering-registry.js        Layer 2 dispatcher
    clustering.js                 L2: mutual k-NN
    clustering-hdbscan.js         L2: HDBSCAN
    clustering-cc.js              L2: connected components
    clustering-cascade.js         shared multi-level cascade (used by engine + clustering-worker)
    citations/                    Layer 3
      registry.js
      contract.js
      taste-network.js            L3: toy synthetic citation generator
      imported-edges.js           L3: real-data citation importer (consumes state.rawCitationEdges)
      importers/
        registry.js
        json-file.js              fetches literture-network/artifacts/<subset>/citation_edges.json
    neighbourhoods.js             taste-network's stage 1
    citation-taste.js             taste-network's stages 2 + 3
    citations.js                  taste-network's stage 4
    base-edges.js                 visual base-edge selection
    citation-layout/              Layer 4
      registry.js
      contract.js
      fr.js                       L4: Fruchterman–Reingold
      mds.js                      L4: MDS / SMACOF
      umap-graph.js               L4: UMAP on the citation graph (precomputed k-NN)
    blend/                        Layer 5
      align.js                    L5a: alignByComponent + alignGlobal (Procrustes)
      blend.js                    L5b: per-frame nested lerp (blend × fusionBlend)
    eval/                         bootstrap-Jaccard + sweep strategies
      jaccard.js                  jaccardSimilarity + bipartiteMatchJaccard (Hungarian)
      bootstrap.js                bootstrapStability — parallel B-iter via workers (deterministic)
      scorers.js                  ari / stability / numClusters / richness
      sweep.js                    sweepAcrossAlgorithms + runTargetRangeSweep
      lhs.js                      Latin-hypercube sampler (drives the target-range probe)
      run-infer-remote.js         worker-backed algo.infer helper (single-job dispatch)
      bayes-ari.js                Bayes-optimal ARI ceiling for the toy mixture (§6.18.10 B5)
      ari.js, kmeans.js           legacy eval helpers
      layout-sweep.js             legacy citation-layout sweep
    contracts/
      cluster.js                  ClusterResult validator
    persistence/                  .zip save/load
      manifest.js                 SCHEMA_VERSION
      serialise.js
      deserialise.js
    workers/                      DAG-orchestrated module workers
      worker-runner.js            generic runInWorker(workerUrl, payload, {signal, transferList})
      dag.js                      runDAG — topo-sort + parallel-batch + AbortSignal
      dimred-worker.js            dispatches on algo (identity/pca/umap/graph-diffusion)
      clustering-worker.js        runs the full multi-level cascade per job
      layout-worker.js            FR / MDS / UMAP-on-graph
    ui/                           new shell
      main.js                     boot
      state.js                    state container + actions (incl. validationRuns slot, §6.19)
      engine.js                   pipeline orchestrator (async; lanes are DAGs over workers)
      workflow-chart.js
      panel-system.js
      data-panel.js
      topbar.js                   File / Data / Workflow / Help menus
      workflow.js                 state.workflow tree — card CRUD, stale, selection
      workflow-projection.js      project a selected card into the legacy state slots
      workflow-migration.js       legacy state -> baseline tree (load path)
      queue.js                    typed-job queue (enqueueJob; per-card status)
      next-steps-rules.js         per-type "what's next" rule table (panel + card +)
      bridge-analysis.js
      gradients.js
      viewer-shared/
        colour-modes.js           shared colour resolver for both viewers
      panels/
        registry.js
        viewer-3d.js              3d-force-graph
        viewer-2d.js              force-graph (canvas-based)
        node-table.js
        validation-run-optimise.js   Optimise results: live (default) or saved run
        method-receipt.js         auto-generated defensibility paragraph
        bootstrap-stability.js    bootstrap-Jaccard on the applied clustering (live + saved)
        bridge-analysis.js        Layer 2.5 bridge clusters; fine/coarse level-pair selector
        placeholder.js
      modals/
        modal.js
        algorithm-modal.js
        clustering-modal.js       tabbed Configure / Optimise
        clustering-tabs/
          configure-tab.js
          optimise-tab.js
          optimise-results-renderer.js  shared table renderer (modal + saved-run panel)
        dimred-modal.js           five-stage (noise / fusion / compression / viz / viz2d)
        data-source-modal.js
        panel-picker.js           panel types + saved validation runs (§6.19)
        layer-descriptors.js
    main.js                       legacy boot + UI glue (drives legacy.html)
literture-network/                real-data pipeline (Python)
  artifacts/
    expanded_embeddings.npy       full SPECTER2 (810 k × 768)
    dev_subset/                   1000-paper random subset
      expanded_embeddings.npy     subset embedding (n × 768, float32)
      expanded_embeddings_paper_index.json   row → paper_id
      paper_years.json            row → publication year (drives node.t)
      citation_edges.json         induced citation-edge subgraph (carved separately)
      subset_meta.json            provenance (seed, indices_into_source, …)
    dev_subset_bfs/               5000-paper BFS-carved subset (default real-mode fixture)
      (same shape as dev_subset; ~12 k edges, 100% node coverage, years 1954–2026)
  citgraphv2/output/
    edges.csv                     raw directed citation network
    nodes.csv                     paper metadata (includes `year` column)
  scripts/
    make_dev_subset.py            carve random embedding subset (+ paper_years.json)
    make_dev_subset_bfs.py        carve BFS connectivity-aware subset (+ paper_years.json)
    make_subset_citation_edges.py carve induced citation-edge subgraph for a subset
validation/                       research scripts that produce shipped evidence (tracked)
  README.md                       convention + script index (distinct from scratch/)
  dim_sweep_validation.py         §6.9 — is UMAP-50 enough compression?
  compression_redundancy_check.py §6.9 follow-up — is UMAP-after-PCA redundant?
cards.md                          live card palette (Mermaid + ordering rules)
doc/
  dynamics.md                     layer index
  dimred.md                       Layer 1.5 — five sub-stages + slot-aware defaults
  fusion.md                       Layer 1.5 fusion sub-stage + comparison slider
  clustering.md                   Layer 2 contract + algorithms
  citations.md                    Layer 3 contract + taste-network + imported-edges
  citation-layout.md              Layer 4 algorithms (FR / MDS / UMAP-on-graph)
  blend.md                        Layer 5 alignment + per-frame blend
  multi-level.md                  multi-level clustering + bridge analysis
  ui-architecture.md              shell architecture (state, engine, workflow chart, queue, modals)
  workers.md                      DAG-orchestrated worker port + cancellation
  eval.md                         Optimise tab: bootstrap, scorers, sweep modes
  scaling.md                      toy-vs-real-data scaling
  data-ingest.md                  Layer 1 datasource contract + the three live sources
  biblion_data_model_and_query_guide.md   biblion SQLite schema + query recipes
  dim-sweep-results.md            empirical evidence backing locked compression default
  citation-edge-salvage.md        parked design note — citation-edge recovery over filtered nodes
```

## Branches

- `main` — historical v1 (original spring force).
- `v2` — adds HDBSCAN clustering and the cluster-eval modal;
  still uses the spring / PBD layout solver. Final v2 commit is
  `v2 stage 6: PBD layout solver replacing spring physics`.
- `v3` — current. Replaces the constraint solver entirely with
  deterministic blend between precomputed arrangements, adds
  MDS + UMAP-on-citation-graph as additional layout algorithms,
  adds the alignment-correlation metric and cross-algorithm
  layout sweep, plus the major v3 features documented in `doc/`
  (multi-level clustering, bridge analysis, data-source +
  dim-reduction layers, two viewers, save/load, optimisation +
  validation, citation-aware embedding fusion + comparison
  slider, opt-in citation layout).
