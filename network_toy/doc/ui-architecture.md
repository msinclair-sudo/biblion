# UI architecture

This document specifies the new shell at `app/src/ui/`. The legacy
shell (`app/legacy.html` + `app/src/main.js` + `app/src/*-debug.js`)
is preserved but no longer the primary entry point; everything new
goes through this architecture.

The UI architecture has four pillars:

1. **State container** — single `state` object, vanilla
   `getState / update / subscribe` plus typed actions.
2. **Engine orchestrator** — pure-function pipeline lanes that
   read inputs from `state`, run engine modules (unchanged from
   the legacy), write results back to `state`.
3. **Layered visual layout** — workflow chart (left rail) + panel
   system (three slots) + topbar / blend slider, all wired via
   subscribers.
4. **Registry-based extensibility** — every layer (clustering,
   layout, dim-reduction) and every panel type plugs in via a
   one-entry registration.

Reading order: the rest of the doc follows the data flow — state
first, engine second, UI surfaces third.

---

## 1. File layout

```
app/
  index.html                — new shell entry
  legacy.html               — archive of the v3-stage-X shell, fully working
  styles/main.css           — grid layout + all UI styling
  src/
    ui/
      main.js               — bootstrap; mounts each subsystem into its DOM slot
      state.js              — single state container + actions
      engine.js             — pipeline orchestrator (regenerate / recluster / …); each
                              heavy lane builds a DAG and awaits runDAG (see workers.md)
      bridge-analysis.js    — multi-scale boundary derivation (Layer 2.5)
      gradients.js          — shared colour-stop arrays + interp + linear-gradient CSS
      queue.js              — typed FIFO job queue (enqueueJob + cancelJob); see §12
      workflow.js           — state.workflow CRUD (step nodes + status + revision stamps)
      workflow-chart.js     — tree-aware SVG renderer of state.workflow (see §4)
      workflow-migration.js — bootstrap a baseline tree from legacy state slots
      workflow-projection.js — back-compat: project a selected step's snapshot into legacy slots
      topbar.js             — File / Data / Workflow / Help menus
      data-panel.js         — top-left data info / toy params
      panel-system.js       — manages primary / secondary / bottom slots; tabs + ± buttons
      viewer-shared/
        colour-modes.js     — shared colour resolver used by both viewer-3d and viewer-2d
      panels/
        registry.js         — panel-type registry
        viewer-3d.js        — live blend (3d-force-graph); colour-mode dropdown + camera settings
        viewer-2d.js        — 2D scatter (force-graph canvas); same colour-mode dropdown
        node-table.js       — mode-aware legend table (the right-side panel)
        validation-run-optimise.js — Optimise results panel; dual-mode (live state.evalResults.optimise OR config.runId → state.validationRuns) (§6.19.3)
        method-receipt.js   — auto-generated defensibility paragraph (singleton) (§6.19.6)
        bootstrap-stability.js — bootstrap-Jaccard runner + per-cluster results; dual-mode (§6.19.5)
        bridge-analysis.js  — bridge clusters with (fine, coarse) level-pair selector (singleton) (§6.19.7)
        placeholder.js      — empty-slot hint
      modals/
        modal.js            — generic dialog (header / body / footer / Esc / backdrop close)
        algorithm-modal.js  — single-level algorithm picker + params editor
        clustering-modal.js — tabbed clustering modal (Configure / Optimise)
        clustering-tabs/
          configure-tab.js  — multi-level config editor
          optimise-tab.js   — sweep modes (Resolution / Full grid / Target range) + Save-this-run button
          optimise-results-renderer.js — shared table renderer (modal + saved-run panel)
        dimred-modal.js     — five-stage (noise / fusion / compression / viz / viz2d)
        data-source-modal.js — data-source registry picker + per-source params
        panel-picker.js     — "Add panel" modal: panel types + saved validation runs (§6.19)
        layer-descriptors.js — per-workflow-node binding {label, openModal(), applyChange}
    workers/                — module workers driven by runDAG (see doc/workers.md)
      worker-runner.js
      dag.js
      dimred-worker.js
      clustering-worker.js
      layout-worker.js
    clustering-cascade.js   — multi-level cascade extracted from engine.js so the
                              clustering worker can call the same code
    persistence/
      manifest.js, serialise.js, deserialise.js — .zip project save/load
    (engine modules unchanged: generation.js, blend/, clustering*, citations/, etc.)
```

Engine modules in `app/src/` (outside `ui/`) are pure functions and
never read or write `state` directly. The orchestrator in
`ui/engine.js` calls them with explicit args and stores results
back. This is the same separation the legacy `main.js` used; the
new shell just moves the orchestration to its own file.

---

## 2. State container (`ui/state.js`)

A single `state` object, mutated via `update(patch)` (shallow
merge) which fires every registered subscriber. All UI components
subscribe and re-render when their relevant slice changes.

### State shape

The shape evolves as features land; what's stable today:

```js
state = {
  // Data source (toy params / real load metadata)
  dataSource: { mode: "toy" | "real", config: {...} },

  // ── pipeline outputs (one slot per layer, null until run) ──
  genResult:             null,         // Layer 1
  _basePos:              null,         // Float32Array(n × 3)
  clusterLevels:         null,         // Layer 2 — multi-level array
  clusterResult:         null,         // alias for finest level (legacy panels)
  neighbourhoodResult:   null,         // taste-network internal
  tasteResult:           null,         // taste-network internal
  citationResult:        null,         // Layer 3
  citationLayout:        null,         // Layer 4 raw
  alignedCitationLayout: null,         // Layer 5a
  alignmentCorrelation:  NaN,          // Layer 5a quality metric
  bridgeAnalysis:        null,         // Layer 2.5 derivation (≥2 cluster levels only); populated by the multi-layer picker's commit job
  bootstrapStability:    null,         // sidecar to single-level clustering; populated by engine.recluster when the clustering modal's Stability toggle is on
  crossClusterCitations: null,         // projected from a crossClusterCitations card ancestor on selection; descendants read this slot

  // Bumps every time the pipeline produces fresh data.
  // Panels track this to know when to rebuild graphData.
  engineRevision: 0,

  // Per-layer state freshness — historical; not authoritative since
  // workflow-tree slice 2.6. The chart computes stale from the tree's
  // revision stamps now (see §4).
  layerStates: { data: "not-run", clustering: "not-run", … },

  // Per-layer params (per-algorithm shape — see "Layer params" below).
  layerParams: { neighbourhood, taste, citations, clustering, layout },

  // ── Workflow tree (Phase 2 of workflow-tree-redesign) ──
  // Branching DAG of every step the user has run. The chart renders
  // from this; legacy "current" slots above are read-only projections
  // from the selected step's ancestry (workflow-projection.js).
  workflow: {
    steps:    { [id]: Step },
    rootId:   string | null,
    selected: string | null,
  },

  // ── Typed-job queue (§12) ──
  jobs: {
    byId:      { [id]: Job },
    order:     string[],
    runningId: string | null,
  },

  // ── First-class persistent entities (§6.19) ──
  validationRuns: [],   // saved analytical sweeps; transitional
                        // duplicate of certain cards' results

  // ── UI state ──
  panels: {
    primary:   { activeTabId, tabs: [{ id, type, config }] },
    secondary: { activeTabId, tabs: [{ id, type, config }] },
    bottom:    { activeTabId, tabs: [{ id, type, config }] },
  },
  selection: { type, level?, id, … },
  filter:    null,
  blend:     0.0,
};
```

### Layer params

Each layer's params live under `state.layerParams[layer]`. Shape
varies because layers evolved at different times:

- **Clustering** is multi-level:
  ```js
  layerParams.clustering = {
    method: "mutualKNN",
    levels: [
      { uid: "abc123", params: { mutualK: 5 }, scope: "global" | "within-parent" },
      ...
    ],
  }
  ```
  See `doc/multi-level.md` for the engine flow.

- **Layout** is single-level:
  ```js
  layerParams.layout = { method: "fruchterman-reingold", params: { ... } }
  ```

- **Neighbourhood / taste / citations** are flat param objects
  (defaults from each engine module's `default*Params()`).

### Actions

Mutations are typed helpers — `update(patch)` is the lowest-level
and rarely called directly:

| Action | What it does |
|--------|--------------|
| `update(patch)` | shallow-merge into state; notify subscribers |
| `subscribe(fn)` | register listener; returns unsubscribe |
| `setLayerState(layer, "fresh"\|"stale"\|"not-run"\|"error")` | drives workflow-chart status dots |
| `setActiveAlgorithm(layer, algoId)` | per-layer active algo (display only — engine reads `layerParams`) |
| `setBlend(α)` | clamps to [0, 1]; drives blend hook |
| `setDataSourceMode("toy"\|"real")` | mode toggle |
| `setToyParam(key, value)` | writes `dataSource.config[key]` |
| `setLayerParams(layer, params)` | replaces layer params wholesale |
| `setSelection({type, level?, id})` | selection sync target |
| `bumpEngineRevision()` | manual bump (engine usually does this) |
| **Panel/tab actions** | |
| `addTab(slot, type, config)` | append + activate; returns new tab id |
| `closeTab(slot, tabId)` | removes + auto-switches active to a neighbour |
| `setActiveTab(slot, tabId)` | switch focus |
| `setTabConfig(slot, tabId, partialConfig)` | merge into a tab's config (used by viewer-3d for camera settings, node-table for source) |

### Subscriber pattern

Every subsystem mounts then subscribes:

```js
import { getState, subscribe } from "./state.js";

export function mountFoo() {
  render(getState());
  subscribe((state) => render(state));
}
```

Subscribers are called with the full state on every `update()`.
Each subscriber decides what's changed (typically by tracking the
last-seen reference to a slice it cares about — `if (s.clusterResult
!== lastClusterResult) ...`).

---

## 3. Engine orchestrator (`ui/engine.js`)

Same lane structure as legacy `main.js`:

```
reingest()      Layer 1 (data-source produce)    → redimred()
    ↓
redimred()      Layer 1.5 (five sub-stages)      → recluster()
    ↓
recluster()     Layer 2 (multi-level cascade)    → reneighbour()
    ↓
reneighbour()   taste-network stage 1             → retaste()
    ↓
retaste()       taste-network stages 2 + 3        → resample() / resampleViaImport()
    ↓
resample()      Layer 3 final stage               → markCitationLayoutStale()
                                                  (cascade STOPS here; citation layout
                                                   is opt-in — see doc/blend.md §3)

relayoutCitations()  Layer 4 + Layer 5a          (writes alignedCitationLayout +
                                                  alignmentCorrelation); fires only on
                                                  explicit user Apply in the Citation
                                                  Layout modal
```

Each lane is its own exported (async) function; calling a deeper
lane without re-running upstream is the granular re-run mechanism
(e.g. changing the layout algorithm calls `relayoutCitations()`
only, not the full cascade).

### Lanes are DAGs over module workers

The three heavy lanes (`redimred`, `recluster`,
`relayoutCitations`) build a small **DAG** of work and await
`runDAG(...)` over module Web Workers in `app/src/workers/`.
Sibling sub-stages (compression / viz / viz2d, optionally doubled
when fusion is active) execute in parallel; cancellation cascades
through the DAG via `AbortSignal`; `clustering-cascade.js`'s pure
helpers are shared between the engine and the clustering worker so
there's one source of truth either side of the worker boundary.

Full spec: `doc/workers.md`.

### Lane discipline

Two requirements every async lane must satisfy — both were the
showstopper bugs documented in `RESUMING.md`:

1. **`setLayerState("X", "running")` at the start of the lane**, so
   the workflow chart's status dot reads as in-flight (orange,
   pulsing) until the lane completes.
2. **`engineRevision` bump in the terminal `update({...})`**, so
   the 3D viewer's `update(s)` sees `dataChanged === true` and
   rebuilds graphData. Without this the clustering DID change but
   the viewer keeps painting the old result.

The lane is wrapped by the descriptor's step-bound queue job
(slice 2.4 step↔job binding); the workflow chart shows a spinner on
the bound card while the lane runs (§12).

`recluster()` is multi-level and runs an extra step:
1. For each level in `layerParams.clustering.levels`, infer either
   globally (`scope === "global"`) or within parents
   (`scope === "within-parent"`, stitched via `clusterWithinParents()`).
2. After the loop, run `computeBridgeAnalysis()` if ≥ 2 levels exist.
3. Update `state.clusterLevels`, `state.clusterResult` (alias for
   the finest level), and `state.bridgeAnalysis`.

See `doc/multi-level.md` for the bridge analysis details.

`relayoutCitations()` writes both the raw layout output AND the
aligned-to-basePos version, plus the `alignmentCorrelation` quality
metric. Each call also bumps `engineRevision` so panels re-render.

---

## 4. Workflow chart (`ui/workflow-chart.js`)

Tree-aware SVG renderer of `state.workflow` — the typed branching
DAG that lives in `ui/workflow.js`. It's the primary analysis
surface; the live card palette + ordering rules live in code
(`ui/next-steps-rules.js` + `modals/layer-descriptors.js`).

### What it renders

Every step in `state.workflow.steps` becomes a card. The renderer
walks `rootId` and lays out subtrees with a Reingold-Tilford-ish
algorithm — siblings spread horizontally, depth maps to vertical
position. Cards carry:

- A status dot (one of `not-run` / `pending` / `running` / `fresh` /
  `cancelled` / `error`).
- A label (the descriptor's display name) plus a small monospace
  sub-line (algorithm + key params; e.g. `mutualKNN · 2 levels`,
  `B=10`, `2d × 1s`).
- Overlays driven by the bound queue job (slice 2.4):
  - **Spinner** on running cards.
  - **Queue-position badge** on pending cards (`2 in queue ahead`).
- An amber dashed border + ↻ button on stale cards (slice 2.6).

### Stale is computed

A card is `stale` when its `upstreamRevision` ≠ its parent's
`revision`. The renderer walks the tree on each subscribe-tick.
Each call to `setStepResult` bumps the card's `revision`, which
makes every descendant compute as stale until they're re-run.
(`state.layerStates` still exists for historical reasons; nothing
reads it as authoritative any more — the chart computes from the
tree's revision stamps instead.)

Clicking the ↻ button calls `rerunStep(stepId)` in
`ui/modals/layer-descriptors.js`, which reads the stale step's
stored params and dispatches to the matching descriptor's
`applyChange` — creates a NEW sibling card under the (now fresh)
canonical parent.

### Card click → select + modal

`onCardClick(step)` does two things:

1. `selectStep(step.id)` — updates `state.workflow.selected`. The
   back-compat projection layer (`workflow-projection.js`) then
   walks the selection's ancestry and populates the legacy state
   slots (`dimredResult`, `clusterLevels`, `_basePos`, …) from each
   ancestor's snapshot, so the viewer + every panel re-paint to
   the selected card's data.

2. If the step type maps to a descriptor (`DESCRIPTOR_BY_TYPE`),
   opens its modal pre-populated with the step's params. The
   user's Apply forks a new sibling card with the edited params —
   the original card is never mutated (§10.D1 immutable-once-done).

Analysis cards (`dimSweep`, `fusionComparison`, `labelling`, …) map to
their own config modals + queue runners. `save` / `load` cards have no
modal (they're history markers). Bootstrap stability and bridge analysis
are *not* separate cards: bootstrap runs as a sidecar to `clustering`
(knobs in the clustering modal's Stability section), and bridge
computes inside the multi-layer picker's commit job, surfacing on
`state.bridgeAnalysis`. See `ui/next-steps-rules.js` +
`modals/layer-descriptors.js` for the live palette + ordering.

### Auto-migration on mount

If `state.workflow` is empty when the chart mounts, the renderer
calls `migrateLegacyToWorkflowIfNeeded()` to bootstrap a baseline
linear tree from the populated legacy state slots. Idempotent;
subsequent state changes re-render but do NOT re-migrate.

---

## 5. Panel system (`ui/panel-system.js`)

Three slots — `primary`, `secondary`, `bottom` — each holds an
array of tabs. One tab is active at a time per slot.

### Tab strip

For each tab: clickable label + small × close button. After all
tabs: a `+` button that opens the **panel-picker modal** showing
registered panel types. Far right of the strip is the slot label
(italic, non-interactive).

### Panel registry (`panels/registry.js`)

```js
{
  id:          "viewer-3d",
  label:       "3D viewer",
  description: "Live blend visualisation; per-frame interpolation between basePos and aligned citation layout.",
  mount:       (container, state, config, tabContext) => ({ update, destroy }),
  singleton:   true,    // optional — picker filters this if already mounted somewhere
}
```

The panel module exports `ID`, `LABEL`, `DESCRIPTION`, `mount`, and
optionally `SINGLETON`. The registry's `register()` reads each.

### Panel module contract

```js
export function mount(container, state, config = {}, tabContext = null) {
  // tabContext = { slot, tabId } — used for setTabConfig persistence

  // Build DOM into `container`. Panel may subscribe to state itself
  // (panel-system also calls update() on every subscriber tick).

  return {
    update(state) { /* re-render based on new state */ },
    destroy()     { /* clean up timers, GL contexts, etc. */ },
  };
}
```

The panel-system tracks per-slot `{ panelsRef, instance, tabId }`.
Tabs are re-rendered only when `state.panels[slot]` reference
changes (cheap). Active panel is re-mounted only when its tab id
changes; otherwise its `update()` runs every state tick.

### Built-in panels

| ID | Panel | Notes |
|----|-------|-------|
| `placeholder` | shows "No panel — click + to add" | used for empty slots |
| `viewer-3d` | live blend (3d-force-graph); colour-mode + camera-speed overlays | **singleton** (one WebGL ctx max). Reads `state._basePos`. |
| `viewer-2d` | 2D scatter (force-graph canvas); same colour-mode dropdown | **singleton**. Reads `state._basePos2d` (populated by Layer 1.5's viz2d sub-stage); empty-state hint until then. Shares colour resolution with viewer-3d via `viewer-shared/colour-modes.js`. |
| `node-table` | mode-aware legend (cluster / cluster-pre-fusion / origin / inDeg / t / bridge / boundaryScore) | see "Node table" below |
| `validation-run-optimise` | Optimise results (live or saved) | **Dual-mode** — no `config.runId` → reads `state.evalResults.optimise` (live; auto-updates after each sweep). `config.runId` set → renders matching `state.validationRuns` entry. Uses the shared `optimise-results-renderer.js`. Per-row Apply re-infers (no `_cr` persisted in v1). |
| `method-receipt` | auto-generated defensibility paragraph (§6.19.6) | **Singleton**. Assembles a copy-paste-ready paragraph from active state — clustering algo + params, dim-reduction pipeline, bootstrap protocol, fixture, Bayes-optimal ARI ceiling (toy only). Updates on every state change. Copy-to-clipboard button. |
| `bootstrap-stability` | bootstrap-Jaccard on the applied clustering | **Singleton.** Auto-binds to `state.bootstrapStability` (the sidecar from the clustering modal's Stability section). Falls back to a saved `validationRuns` entry (`config.runId`) for older projects. |
| `bridge-analysis` | Layer 2.5 bridge derivation | **Singleton**. Reads `state.bridgeAnalysis` (populated by the multi-layer picker's commit job — no separate bridge card). Pair selector for `(fineLevel, coarseLevel)`; sortable per-fine-cluster table with per-coarser-level share columns. Click a row → selects that cluster in the viewers. |
| `multilayer-curve` | reproducibility curve + bridge heatmap for the multi-layer sweep | **Singleton**. Routes to the `primary` slot via `SLOT_FOR_CARD_TYPE`. Two-column body — left: stability vs cluster count; right: bridges-per-(child, parent) heatmap. Bottom: live readout of bridge counts between adjacent picks. Curve dots and heatmap rows/cols cross-bind on click. |
| `cross-cluster` | per-layer directed citation flow | **Singleton**. Auto-spawns under `multiLevelPicker` when the ladder commits + citation edges exist; sits as parent of `labelling` so descendants inherit its data via projection (`state.crossClusterCitations`). Panel routes to the `secondary` slot. |

### Adding a new panel type

1. Create `panels/<id>.js` exporting `ID`, `LABEL`, `DESCRIPTION`,
   `mount`, optionally `SINGLETON`, optionally
   `HIDE_FROM_TYPE_LIST` (set when the panel only makes sense
   bound to specific config, like the validation-run renderers
   that need a `runId`).
2. Register in `panels/registry.js`:
   ```js
   import * as MyPanel from "./my-panel.js";
   register(MyPanel);
   ```

The panel-picker modal automatically lists it under *Panel types*.
For panels that render a specific `state.validationRuns` entry,
also extend `panelTypeForRun(run)` in `modals/panel-picker.js` so
the picker's *Validation runs* section knows which renderer
matches each run type.

---

## 6. Modal infrastructure (`ui/modals/`)

### `modal.js` — generic dialog

```js
const m = openModal({
  title:   "...",
  body:    domNodeOrFunction,
  actions: [
    { label: "Cancel" },
    { label: "Apply", primary: true, onClick: () => { /* commit */ } },
  ],
  onClose: () => { /* optional cleanup */ },
});
m.close();
```

Behaviour:
- Mounts into `#modal-root`.
- Backdrop click closes.
- Escape key closes (top-most modal only, if nested).
- Action `onClick` may return `false` to keep the modal open;
  any other return value (including `undefined`) closes.

### `algorithm-modal.js` — single-level

Used for layers with one parameter set per algorithm (citation
layout). Renders:
- Algorithm dropdown
- Description callout
- Params editor built from the algorithm's `modalSchema`
- Cancel / Apply

### `clustering-modal.js` — tabbed

Two tabs sharing one modal frame: **Configure / Optimise**. Each
tab is its own module in `modals/clustering-tabs/`:

- `configure-tab.js` — multi-level config editor. N levels stacked,
  each with its own params + (for L1+) a scope toggle + × close
  button; `+ Add level` appends. Spec: `doc/multi-level.md`.
- `optimise-tab.js` — three sweep modes (Resolution only / Full
  grid / Target range) + per-row Apply with level picker. Spec:
  `doc/eval.md` §7.2.

Both share the `.cm-tab-*` CSS rhythm. Apply / Run buttons hand
off to the typed-job queue (§12); the modal closes immediately
and the cascade runs in the background with the chart card
spinning until completion.

> A third **Validate** tab existed until 2026-05-24 (§6.18.1) —
> bootstrap-Jaccard on the currently-applied clustering. Removed
> because the same engine (`eval/bootstrap.js`) is reachable from
> Optimise via the richness / stability scorers and the
> target-range sweep's `runBootstrap` flag.

### `panel-picker.js`

Lists registered panel types when the user clicks the `+` button
in any tab strip. Filters singletons that are already mounted
somewhere (via `state.panels` scan).

### `layer-descriptors.js`

Maps workflow-chart node IDs to per-layer modal openers:

```js
getLayerDescriptor("clustering") → {
  label: "Configure: Clustering",
  openModal: () => openClusteringModal(...),
  listAlgos, getActive, applyChange,
}
```

Adding a new pluggable layer = one descriptor function + a
workflow-chart node entry.

---

## 7. Gradients module (`ui/gradients.js`)

Single source of truth for continuous-colour palettes shared by
viewer-3d (per-node colouring) and node-table (per-row swatches +
legend bar). Exports:

- Stop arrays: `T_STOPS`, `INDEG_STOPS` (viridis), `BOUNDARY_STOPS`
- Colour functions: `tGradient(t)`, `inDegGradient(t)`,
  `boundaryScoreGradient(t)` — all return `rgb(r, g, b)` strings
- `cssLinearGradient(stops)` — for the legend bar's CSS background

If a palette ever needs to change, edit the stop array once;
both surfaces pick it up automatically.

---

## 8. Selection types

`state.selection` is typed:

```js
{ type: null, id: null }                                   // no selection
{ type: "cluster", level: N, id: cid }                     // cluster at level N
{ type: "origin",  id: oid }                               // generator origin
{ type: "node",    id: nodeId }                            // single paper / node
{ type: "tBin",    binIdx: i }                             // time bin (no viewer effect yet)
```

`viewer-3d`'s `nodeColour` dim-routes by type; the same node match
function gates dimming for cluster / origin / node. Adding a new
selection type = one new branch in `nodeMatchesSelection()`.

The node-table's row builders set the `_select()` thunk per row;
clicking a row calls `setSelection(thunk())`. Clicking the same
row again toggles back to `{type: null, id: null}`.

---

## 9. Node table (the legend) — `panels/node-table.js`

The right-side panel that doubles as a legend for whatever's
colouring the 3D viewer. Source dropdown at top:

| Source | What rows represent |
|--------|---------------------|
| `auto` | follows the active 3D viewer's `colourMode` |
| `cluster:finest` | one row per cluster at the finest level |
| `cluster:N` | one row per cluster at level N |
| `bridge` | one row per bridge fine-cluster (≥2 coarse parents) |
| `boundaryScore` | one row per fine cluster sorted by `1 − dominantFraction` |
| `origin` | one row per Gaussian-mixture origin |
| `t` | 10 t-bins |
| `inDeg` | top-50 nodes by citation in-degree |

### Per-source schema

Each row builder returns:

```js
{
  title:       string,             // displayed in the headbar status
  unitLabel:   string,             // for the footer's "X bridges" / "X clusters"
  columns: [{ key, label, kind: "colour"|"int"|"float"|"text", sortable }],
  rows: [{ _key, _select, [colKey]: value, ... }],
  defaultSort: { key, dir },
  selectionKey: (row, sel) => boolean,    // for highlight matching
  gradient?: { stops, min, max, label },  // optional — renders the legend bar
}
```

### Adding a new source

1. Write a builder fn in `node-table.js` returning the shape above.
2. Add an entry to `sourceOptionsFor(state)` (with whatever
   availability check makes sense — e.g. only if `bridgeAnalysis`
   exists).
3. Wire it in `buildTableData(s, source)`.

If the source is a continuous gradient, return the optional
`gradient` field — the table renders a `LABEL · MIN ▬▬▬ MAX`
legend bar at the top. Hidden for categorical sources.

---

## 10. Patterns: how to add things

### A new clustering algorithm

1. New module `app/src/<algo>.js` exporting an `infer(genResult, params)`.
2. Entry in `app/src/clustering-registry.js`:
   `{ id, label, description, allowsNoise, defaultParams, infer, modalSchema }`.

The clustering modal's algorithm dropdown auto-lists it. The
multi-level engine cascade calls it. The workflow chart updates
its label. The node-table's `cluster:N` source still works.

### A new colour mode

1. Add the entry to `getColourModeOptions(state)` and `baseColourFor`
   / `nodeColourFor` in `viewer-shared/colour-modes.js` — both
   viewer-3d and viewer-2d delegate to the shared resolver, so one
   edit covers both panels.
2. (Optional) Add a matching node-table source via `sourceOptionsFor`
   so the legend tracks the viewer.
3. (Optional) If continuous-gradient, return a `gradient` descriptor
   from the source builder.

### A new panel type

See §5 above.

### A new pluggable layer

1. New module in `app/src/<layer>/registry.js` (registry pattern).
2. New descriptor in `ui/modals/layer-descriptors.js` — bind
   `openModal()` to the right modal kind (single-level or
   multi-level), implement `listAlgos / getActive / applyChange`.
3. Add the workflow chart node to `NODES` array in
   `workflow-chart.js`.
4. Add an engine lane in `ui/engine.js` that runs this layer + a
   case in `activeAlgorithmFor()` for the chart's algo label.

---

## 11. Adding to the docs

When a new layer or major feature lands:

- Add a section here (or a new `doc/<feature>.md`) describing the
  state shape, contract, and UI surfaces.
- Update `doc/dynamics.md` (the layer index) if it's a new pipeline
  layer.
- Update the rule table in `ui/next-steps-rules.js` (and
  `modals/layer-descriptors.js`) if the feature adds, removes, or
  re-parents a workflow card type.

Documentation conventions:
- Single source of truth per concept. Cross-link rather than
  duplicate.
- Code excerpts use the actual file's symbols (don't invent fake
  function names just for the doc).
- Patterns ("how to add X") belong in this file or the relevant
  layer doc; specs belong in their own files.

---

## 12. Typed-job queue + per-card status (`ui/queue.js`)

A single-threaded **FIFO queue** runs all async work. Every modal
Apply, every save / load, every analysis card creates a job; the
runner picks the head, sets its status to `running`, invokes the
job's `fn`, then publishes the result. User-visible feedback lives
on the **workflow chart** — each step's card shows a spinner while
its job runs and a queue-position badge while it's pending.

Phase 2 slice 2.11 retired the legacy `busy.js` queue + bottom
busy-bar. There is no global status strip any more — the chart is
the single source of truth for in-flight work.

### Why per-card, not a global bar

A user with three clustering siblings and a bootstrap queued
against the middle one needs to see *which* card is running, not
just "something is running". Cards already exist as the unit of
work (slice 2.4 step↔job binding); spinners on cards
re-use that surface for the running indicator. Pending jobs that
haven't started yet show a small position badge on their card
("2 in queue ahead").

### State shape

```js
state.jobs = {
  byId:      { [id]: Job },        // every job ever enqueued this session
  order:     string[],             // creation order
  runningId: string | null,        // currently-executing job
};

type Job = {
  id, type, label,
  stepId:    string | null,        // bound chart card, if any
  status:    "pending" | "running" | "done" | "failed" | "cancelled",
  result:    any | null,           // populated on done
  error:     string | null,        // populated on failed
  phase:     string | null,        // mid-flight phase label
  progress:  number | null,        // 0..1
  createdAt, startedAt, endedAt,
};
```

### API (`ui/queue.js`)

```js
import { enqueueJob, cancelJob } from "./queue.js";

// Enqueue a typed job. When stepId is set, the queue runner
// MIRRORS lifecycle onto the bound chart card:
//   running  → updateStepStatus(stepId, "running")
//   done     → setStepResult(stepId, result)
//   failed   → updateStepStatus(stepId, "failed", { error })
//   cancel   → updateStepStatus(stepId, "cancelled")
// Phase/progress are forwarded via updateStepProgress.
const { id, promise } = enqueueJob({
  type:  "bootstrapStability",
  label: "Bootstrap · B=10",
  stepId,
  fn:    async (ctx) => {
    ctx.setPhase("running");
    return await runTheJob({ signal: ctx.signal });
  },
});

await promise;          // resolves with fn's return value

// Per-job cancel: aborts the AbortController; the job's fn must
// observe signal.aborted for the abort to take effect mid-flight.
cancelJob(id);
```

### Failure + cancel semantics

- A throwing `fn` rejects the returned promise + sets job status
  to `failed`. The queue continues with the next pending job.
- `cancelJob(id)` on a pending job marks it cancelled and dequeues.
  On a running job, aborts the controller; the fn must check
  `ctx.signal.aborted` or wire the signal into its async hops
  (`runInWorker(..., {signal})`).
- `AbortError` rejections are conventionally swallowed by callers
  (cancel is user-initiated; surfacing an error would be noise).

### Wired into

- **Modal Apply paths** — every layer descriptor's `applyChange`
  enqueues a step-bound job and returns the promise. Modals close
  immediately; the chart card spins.
- **Analysis cards** — bootstrap, dim-sweep, and Optimise sweeps
  each enqueue their own step-bound job (slice 2.9).
- **Save / Load** — both create cards under the workflow root and
  enqueue a job to do the actual serialise / deserialise (slice
  2.9.c).

### What we deliberately didn't build

- No global bottom status bar (retired in slice 2.11).
- No progress bar with %. UMAP is the worst offender; no per-step
  timing model yet. Per-epoch progress reporting is a §6.11 Slice 4
  follow-up.
- No toast notifications. Failure already pops `window.alert`;
  success is self-evident from the card going `done`.
- No `pointer-events: none` lockout — workers + the queue handle
  back-to-back actions gracefully.
