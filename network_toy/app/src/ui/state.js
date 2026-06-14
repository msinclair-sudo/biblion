// Centralised state container.
//
// Tiny, vanilla, no framework. Subscribers register a function that
// runs whenever state changes. Mutations go through `update(patch)`
// which shallow-merges and notifies subscribers.
//
// State shape evolves as components come online. Slice naming is
// stable (so panels can subscribe to `state.clustering` even before
// a clustering module exists).
//
// See doc/ui.md §6.

const state = {
  // ── data source ──────────────────────────────────────────────
  // mode mirrors activeAlgorithm.dataSource (kept for backward-compat
  // with code that still reads dataSource.mode). Per-mode configs are
  // stashed under .configs so switching modes preserves each side's
  // user state. Citation-pacing knobs (density / intra / cross) live
  // alongside the toy generator's seed/nodeCount/origins/spread because
  // the data panel owns them UX-wise; the engine plumbs them into
  // Layer 3 params on reingest.
  dataSource: {
    mode: "sqlite",        // "sqlite"; mirrors activeAlgorithm.dataSource
    configs: {
      sqlite: {
        dataset: null,     // chosen from /api/datasets via the data-source picker
      },
    },
  },

  // ── pipeline outputs (one per layer; null until run) ─────────
  // Stored flat at state root for direct getter access from the
  // blend hook and per-panel rendering — mirrors the legacy main.js
  // shape so engine modules can be ported without restructuring.
  genResult:             null,    // Layer 1 output (data-source result):
                                  //   {nodes:[{id, t, basePos?, originId?, paperId?}], origins?, embedding?, basePos?}
                                  //   "genResult" is kept as the field name for legacy reasons; semantically
                                  //   it's the active data source's output (toy or real).
  _basePos:              null,    // Float32Array(n × 3) — flattened basePos, blend force input.
                                  //   Sourced from genResult.basePos / nodes[i].basePos directly (toy)
                                  //   or from Layer 1.5's viz sub-stage (real).
  _basePos2d:            null,    // Float32Array(n × 2) — viewer-2d input.
                                  //   Populated only when Layer 1.5's viz2d sub-stage produces a 2-d
                                  //   output (e.g. UMAP n_components=2). Null otherwise → viewer-2d
                                  //   shows its empty-state hint.
  embedding:             null,    // Real-data Layer 1 output: {d, data:Float32Array(n*d)} — high-dim
                                  //   feature vectors, set when the active data source supplied them.
                                  //   Layer 1.5 reads this as its noise-stage input. Null in toy mode.
  rawCitationEdges:      null,    // Citation graph cached at ingest time, populated by data sources
                                  //   that can supply edges directly (today: real-data via
                                  //   produceReal()). Flat number[] of length 2|E| in [src, dst, src,
                                  //   dst, …] form. Read-only outside the data-source layer —
                                  //   consumers: dimred fusion stage, Layer 3 imported-edges. Null
                                  //   when the source supplies no edges (fusion stage falls through
                                  //   as identity).
  dimredResult:          null,    // Layer 1.5 output: {method, params, n, d, data:Float32Array(n*d)}
                                  //   Layer 2 reads from this for distance computations.
  dimredResultPreFusion: null,    // Layer 1.5 *without* fusion applied — same shape as dimredResult.
                                  //   Populated only when fusion is non-identity; lets the cluster
                                  //   lane produce a parallel pre-fusion clusterLevels for A/B colour
                                  //   comparison. Null when fusion=identity (nothing to compare).
  _basePosPreFusion:     null,    // Float32Array(n × 3) — viz UMAP-3 result on the pre-fusion (noise-
                                  //   stage) embedding. Drives the fusion-comparison slider in the
                                  //   blend hook; nested with the existing basePos↔citation blend.
                                  //   Null when fusion=identity OR fusion is set but the cascade
                                  //   hasn't produced one yet.
  clusterLevels:         null,    // Layer 2 output: [{uid, scope, clusterResult}] one per level
  // Multi-layer-from-sweep diagnostics (§9 revamp): { curve, usedFallback }
  // where curve = [{count, size, stability, plateauWidth, selected}] — the
  // stability-vs-count series the multi-layer card's panel (Stage 4) draws.
  multiLevelSweep:       null,
  // (clusterLevelsPreFusion / clusterResultPreFusion removed — pre/post-fusion
  //  is now a workflow FORK; each branch clusters its own embedding into
  //  clusterLevels. See projectFusionBranch.)
  clusterResult:         null,    // Backward-compat alias for the FINEST level's clusterResult
                                  //   (used by panels that aren't yet level-aware)
  citationResult:        null,    // Layer 3 output: CitationResult contract
  citationLayout:        null,    // Layer 4 output: Float32Array(n × 3) raw layout positions
  alignedCitationLayout: null,    // Layer 5a output: Float32Array(n × 3) — blend force input
  alignmentCorrelation:  NaN,     // Layer 5a quality metric ∈ [0, 1]

  // Derived analysis on top of clusterLevels. Null when fewer than 2
  // levels exist. See bridge-analysis.js for shape.
  bridgeAnalysis:        null,

  // Per-layer bridge breakdown (every layer i ≥ 1 vs i − 1) from the bridge
  // card. { nLevels, byLayer:[{layer, coarseLevel, perCluster, bridgeCount}],
  // totalBridges } — see computeBridgeAnalysisAllLayers. Null until run.
  bridgeAllLayers:       null,

  // Per-cluster bootstrap-Jaccard stability for the LIVE single-level
  // clustering. Populated by engine.recluster when the clustering modal's
  // "Run bootstrap stability" toggle is on (cards.md Pass 2b: bootstrap
  // is no longer a standalone card; it's a sidecar to clustering). Shape:
  // { bootstrapResult, aggregate, cluster, settings, runtimeSec, capturedAt }
  // — the same shape the bootstrap panel rendered for the old card.
  bootstrapStability:    null,

  // Node displacement between the pre- and post-fusion branches:
  // { dist:Float32Array(n), correlation, max, mean, topMovers:[{id,dist}] }.
  // Drives the displacement panel + the "displacement" colour mode.
  nodeDisplacement:      null,

  // Per-layer cross-cluster citation flow matrix — projected onto state
  // whenever a crossClusterCitations card sits in the selected ancestry
  // chain (auto-spawned under multiLevelPicker, optionally added under
  // single-level clustering). Shape: { nLevels, totalEdges, byLayer:[…] };
  // see cross-cluster-citations.js. Children of a crossCluster card read
  // this slot for citation-aware analyses.
  crossClusterCitations: null,

  // Which (fineLevel, coarseLevel) pair the bridge analysis runs on.
  // When a field is null/invalid, the engine clamps it to the deepest
  // valid pair (fineLevel = last, coarseLevel = last - 1). The bridge
  // table panels surface dropdowns that write to this slice.
  bridgeConfig:          { fineLevel: null, coarseLevel: null },

  // Tree scoring (MLC §5). 1–5 scores per cluster, keyed by the LEVEL UID
  // (card-unique — multi-level cards use uidPrefix = stepId), so each
  // clustering branch keeps its own scores and they survive a save/load.
  //   clusterScores: { [levelUid]: { [clusterId]: 1..5 } }
  clusterScores:         {},

  // Cluster labels (MLC §7) produced by a labelling CARD and replayed here
  // by the projection layer when that card (or a downstream scoring card)
  // is selected. Static — computed once per labelling card; the stale-dot
  // mechanism flags re-runs when the upstream clustering changes. Keyed by
  // level uid; value is the multi-method labelClusters() output.
  //   clusterLabels: { [levelUid]: { methods, perCluster } }
  clusterLabels:         null,

  // Bumps every time the pipeline runs (full or partial).
  // Panels watch this to know when to rebuild their cached views.
  engineRevision:        0,

  // Layer-specific algorithm params. Populated lazily on first
  // pipeline run from each registry's defaultParams().
  layerParams: {
    dimred:        null,    // { noise: {method, params}, compression: {method, params} }
                            //   Layer 1.5 has two sequential stages; the engine runs them
                            //   in order. Default is identity for both = pass-through.
    neighbourhood: null,
    citations:     null,
    clustering:    null,    // { method, byAlgo: { algoId: params } }
    layout:        null,    // { method, params }
  },

  // ── pipeline freshness ───────────────────────────────────────
  // states: "not-run" | "stale" | "fresh" | "error"
  layerStates: {
    "data":      "not-run",
    "dimred":    "not-run",
    "clustering":"not-run",
    "citations": "not-run",
    "layout":    "not-run",
    "alignment": "not-run",
    "blend":     "not-run",
  },

  // ── active algorithm per pluggable layer ─────────────────────
  // populated as registries come online; placeholders for now
  activeAlgorithm: {
    "dataSource": "sqlite",      // "sqlite"; selects which datasource registry entry runs
    // dimred has three stages now (noise + compression + viz); the workflow
    // chart reads layerParams.dimred directly to summarise. activeAlgorithm
    // here holds only the compression-side method as a single legacy label.
    "dimred":     "identity",
    "clustering": "hdbscan",    // existing
    "citations":  "imported-edges",  // real-data default (corpus edges)
    "layout":     "mds",         // existing
  },

  // ── UI state ─────────────────────────────────────────────────
  // Each slot holds an array of tabs; one is active at a time.
  // Tabs are added/closed via the +/× buttons in the tab strip.
  panels: {
    primary: {
      activeTabId: "p-viewer-3d",
      tabs: [
        {
          id:     "p-viewer-3d",
          type:   "viewer-3d",
          config: {
            rotateSpeed: 0.3, zoomSpeed: 0.3, panSpeed: 0.3, smoothMotion: false,
            colourMode:  "cluster:finest",
          },
        },
      ],
    },
    secondary: {
      activeTabId: "s-node-table",
      tabs: [
        { id: "s-node-table", type: "node-table", config: { source: "auto" } },
      ],
    },
    bottom: {
      activeTabId: null,
      tabs: [],
    },
  },
  selection: { type: null, id: null },
  // ── search highlight (J09) ───────────────────────────────────
  // Set of ACTIVE-dataset nodeIds matched by the SQL library-search panel.
  // When non-empty, the "search" colour branch lights these and dims the rest.
  // Hits from ATTACHed non-active DBs have no node in the viz (list-only), so
  // they never appear here. STANDALONE for now: J25 (Wave 4) folds this into a
  // general node-highlight channel — search highlighting will then plug into
  // that instead of this dedicated Set.
  searchMatches: new Set(),
  // ── cart ─────────────────────────────────────────────────────
  // Papers collected (from clusters / selections) for export to a biblion
  // subset. Each item: { paperId, nodeId, source } (source = provenance, e.g.
  // "L2·c5"). Deduped by paperId. Identity + provenance only — the (deferred)
  // cart panel joins richer per-node data at render time, so nothing heavy is
  // stored here. Persisted (SCHEMA_VERSION 3).
  cart: [],
  filter: null,
  // Fusion-comparison slider (Layer 1.5 A/B). Interpolates basePos
  // between pre-fusion (semantic-only) and post-fusion (citation-aware)
  // positions. Inert when _basePosPreFusion is null — i.e. fusion is
  // identity (toy mode default) OR pre-fusion compute hasn't run yet.
  // 0 = pre-fusion semantic, 1 = post-fusion citation-aware embedding.
  fusionBlend: 1.0,

  // ── viewer-3d display toggles ────────────────────────────────
  // Which edge layers to draw, and their per-layer styling. Mirrors
  // the legacy main.js `state.view.*` shape so the colour / opacity
  // logic ports verbatim. All default OFF — the 3D viewer is dense
  // enough already; the user opts in to each overlay.
  //
  //   showCitations — Layer 3 edges (citationResult.citations)
  //   showBase      — semantic-distance edges (top-K closest pairs in basePos)
  //   showStructure — clusterResult.structureEdges (mutual-kNN / MST / top-k)
  //   citArrows     — directional arrowheads on citation edges only
  //   citOpacity    — 0..1 linear opacity for citation links
  //   baseDensity   — 0..1 fraction of all n*(n-1)/2 pairs to draw as base edges
  view: {
    showCitations: false,
    showBase:      false,
    showStructure: false,
    citArrows:     false,
    citOpacity:    0.15,
    baseDensity:   0.02,
    // Per-edge-kind colours. Defaults match the EDGE_STYLE table in
    // viewer-3d.js; the picker writes hex strings back here and the
    // renderer reads them on every linkMaterial/linkColour call.
    citColour:        "#8a8a8a",
    baseColour:       "#5a6878",
    structureColour:  "#5dd39e",
  },

  // ── persistence ──────────────────────────────────────────────
  // Project name from the most-recent save / load. Used by the
  // File ▾ menu's "Save" action (when null, falls through to
  // "Save as" which prompts for a name).
  projectName: null,

  // Latest results from the Cluster modal's Validate + Optimise
  // tabs. Persisted into save files so that reloading a project
  // restores the eval results without re-running.
  // Cleared by recluster() — stale results don't survive a
  // clustering config change.
  evalResults: {
    // DEPRECATED 2026-05-24 — Validate tab removed (§6.18.1). Slot
    // preserved on the read side so old project archives still
    // deserialise cleanly; no UI writes to it any more. The
    // bootstrap surface lives entirely inside Optimise now (via
    // the richness / stability scorers and target-range
    // runBootstrap). Will be dropped from the schema on the next
    // intentional bump.
    validate: null,
    optimise: null,   // {ranked, top, totalConfigs, completed, settings, scorerLabel, timestamp, runtime}
  },

  // ── Validation runs (§6.19). ────────────────────────────────────
  // First-class persistent entities for any analytical sweep /
  // validation the user explicitly saves. Each entry self-describes
  // (type, label, inputs snapshot, settings, results, timestamp,
  // scoreVersion). Survives save/load. Renderable in panels via the
  // panel-picker's "Validation runs" category (panel work pending).
  //
  // Shape (each entry):
  //   {
  //     id:           string,           // uid for panel binding
  //     type:         "optimise" | "dimSweep" | "bootstrapStability" |
  //                   "targetRange" | ...,
  //     label:        string,           // user-set or auto-generated
  //     timestamp:    string,           // ISO datetime
  //     inputs: {                        // snapshot at time-of-run
  //       dataSourceId:       string,    // "sqlite"
  //       dataSourceConfig:   object,    // subset, seed, etc.
  //       layerParamsSnapshot: object,   // dim/fusion/etc. active
  //     },
  //     settings:     object,           // type-specific knobs
  //     results:      object,           // type-specific (may contain TypedArrays)
  //     scoreVersion: int,              // bootstrap protocol at time of run
  //     runtimeSec:   number,           // wall time of the run
  //   }
  //
  // Mutate via saveValidationRun / deleteValidationRun / clearValidationRuns.
  // Default empty array — additive schema; older saves load with [].
  validationRuns: [],

  // ── Typed-job queue (workflow-tree-redesign Phase 1, slice A). ──────
  // First-class jobs with stable ids, types, status transitions, and
  // per-job cancellation. Mutated only through actions in ui/queue.js
  // — direct update({jobs: ...}) calls outside that module will race
  // the runner. (Slice 2.11: state.busy + mirroring removed; cards on
  // the workflow chart carry user-visible job status now.)
  //
  // Shape:
  //   {
  //     byId:      { [id]: Job },     // every job ever enqueued in this session
  //     order:     string[],          // creation order (id list); used for
  //                                    // pending discovery + UI listing
  //     runningId: string | null,     // id of the job currently executing
  //   }
  //
  // Job shape:
  //   {
  //     id, type, label,
  //     status:    "pending" | "running" | "done" | "failed" | "cancelled",
  //     result:    any | null,        // populated on done
  //     error:     string | null,     // populated on failed
  //     phase:     string | null,     // mid-flight status line (free text)
  //     progress:  number | null,     // 0..1 mid-flight progress fraction
  //     createdAt: ISO string,
  //     startedAt: ISO string | null,
  //     endedAt:   ISO string | null,
  //   }
  //
  // Default empty — additive schema; older saves load with the empty
  // shape. Not persisted across save/load in this slice (jobs are
  // ephemeral runtime state; their *results* live in validationRuns
  // when explicitly saved). Future slices may persist running queue
  // state so a reload can pick up mid-flight work — out of scope here.
  jobs: { byId: {}, order: [], runningId: null },

  // ── Workflow tree (workflow-tree-redesign Phase 2 slice 2.1). ───────
  // First-class store for the branching DAG of analysis cards.
  // Replaces the singular layerParams / dimredResult / clusterLevels /
  // etc. slots as the canonical source of truth, with those legacy
  // slots becoming back-compat projections from the selected card's
  // ancestry (Slice 2.7). Mutated only through ui/workflow.js — direct
  // update({workflow: ...}) calls outside that module will violate
  // invariants (parent/child consistency, single root, valid status
  // transitions, revision monotonicity).
  //
  // Shape:
  //   {
  //     steps:    { [id]: Step },     // every card ever created in this
  //                                    // project (settled cards stay until
  //                                    // explicit delete)
  //     rootId:   string | null,      // tree root; null = empty workflow
  //     selected: string | null,      // currently-selected card; drives
  //                                    // the viewer + panel back-compat
  //                                    // projections (Slice 2.7)
  //   }
  //
  // Step shape:
  //   {
  //     id:               string,
  //     type:             string,     // "data" | "dimred" | "clustering" | "optimise" | ...
  //     label:            string,
  //     params:           object,
  //     parentId:         string | null,    // null only for root
  //     childIds:         string[],         // insertion order
  //     refIds:           string[],         // cross-edges for fan-in (e.g.
  //                                          // a fusion-comparison card
  //                                          // referencing two clusterings)
  //
  //     status:           "pending" | "running" | "done" | "failed" | "cancelled",
  //     result:           any | null,
  //     error:            string | null,
  //     revision:         number,           // bumped on each setStepResult
  //     upstreamRevision: number | null,    // parent's revision stamped at
  //                                          // result time; stale check =
  //                                          // parent.revision !== this.upstreamRevision
  //
  //     progress:         { phase?: string, fraction?: number } | null,
  //     runtimeSec:       number | null,
  //
  //     createdAt:        ISO string,
  //     startedAt:        ISO string | null,
  //     endedAt:          ISO string | null,
  //   }
  //
  // Default empty — additive schema; older saves load with the empty
  // shape. Slice 2.2 will migrate populated legacy slots into a baseline
  // linear tree on first load.
  workflow: { steps: {}, rootId: null, selected: null },

  // ── UI prefs (J10 — dynamic layout) ──────────────────────────────────
  // Per-browser layout preferences: the live rail/slot sizes that drive
  // the #layout grid CSS vars, plus per-rail collapsed booleans. This is
  // deliberately a SELF-CONTAINED slice that does NOT travel with the
  // project save. Persistence is OPTION A from J10: a localStorage blob
  // (key UI_PREFS_KEY below), written on every change and hydrated on
  // boot — so persistence/serialise.js is untouched and layout is
  // per-browser, not per-project.
  //
  //   leftRailW / rightRailW / bottomH — pixel sizes mirrored to the
  //     --left-rail-w / --right-rail-w / --bottom-h vars on #layout.
  //   leftCollapsed / rightCollapsed   — when true the rail width is
  //     forced to 0 (a thin re-expand stub stays clickable); the prior
  //     width is preserved in the *W field so expand restores it.
  uiPrefs: {
    leftRailW:      280,
    rightRailW:     320,
    bottomH:        220,
    leftCollapsed:  false,
    rightCollapsed: false,
  },
};

// localStorage key for the OPTION A UI-prefs blob (see uiPrefs slice).
export const UI_PREFS_KEY = "networkToy.uiPrefs.v1";

const subscribers = new Set();

export function getState() {
  return state;
}

// Shallow-merge patch into state and notify subscribers.
// For nested updates pass a patch with the nested key replaced
// (e.g. update({ panels: { ...state.panels, primary: {...} } })).
export function update(patch) {
  Object.assign(state, patch);
  for (const fn of subscribers) {
    try { fn(state); }
    catch (e) { console.error("subscriber threw:", e); }
  }
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ── Cart helpers ────────────────────────────────────────────────────
// Append items (each { paperId, nodeId, source }), keeping the first occurrence
// of each paperId — re-adding a cluster that overlaps an earlier one is a no-op
// for the shared papers, and earlier provenance wins.
export function addToCart(items) {
  const seen = new Set(state.cart.map(it => it.paperId));
  const fresh = [];
  for (const it of items) {
    if (it.paperId == null || seen.has(it.paperId)) continue;
    seen.add(it.paperId);
    fresh.push(it);
  }
  if (fresh.length) update({ cart: [...state.cart, ...fresh] });
  return fresh.length;
}

export function removeFromCart(paperId) {
  update({ cart: state.cart.filter(it => it.paperId !== paperId) });
}

export function clearCart() {
  if (state.cart.length) update({ cart: [] });
}

// ── Panel/tab helpers ──────────────────────────────────────────────
// Slot shape: { activeTabId, tabs: [{ id, type, config }] }
// Each tab has a unique id within the slot; close removes by id and
// auto-switches active to a neighbour. Add returns the new tab id.

function genTabId(slot) {
  return `${slot}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function addTab(slot, type, config = {}) {
  const cur = state.panels[slot];
  if (!cur) throw new Error(`unknown slot "${slot}"`);
  const id = genTabId(slot);
  update({
    panels: {
      ...state.panels,
      [slot]: {
        activeTabId: id,
        tabs: [...cur.tabs, { id, type, config }],
      },
    },
  });
  return id;
}

export function closeTab(slot, tabId) {
  const cur = state.panels[slot];
  if (!cur) return;
  const tabs = cur.tabs.filter(t => t.id !== tabId);
  let activeTabId = cur.activeTabId;
  if (activeTabId === tabId) {
    activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
  }
  update({
    panels: { ...state.panels, [slot]: { activeTabId, tabs } },
  });
}

export function setActiveTab(slot, tabId) {
  const cur = state.panels[slot];
  if (!cur || cur.activeTabId === tabId) return;
  if (!cur.tabs.some(t => t.id === tabId)) return;
  update({
    panels: { ...state.panels, [slot]: { ...cur, activeTabId: tabId } },
  });
}

export function setTabConfig(slot, tabId, partialConfig) {
  const cur = state.panels[slot];
  if (!cur) return;
  const tabs = cur.tabs.map(t =>
    t.id === tabId ? { ...t, config: { ...t.config, ...partialConfig } } : t
  );
  update({
    panels: { ...state.panels, [slot]: { ...cur, tabs } },
  });
}

export function setLayerState(layer, layerState) {
  update({
    layerStates: { ...state.layerStates, [layer]: layerState },
  });
}

export function setActiveAlgorithm(layer, algoId) {
  update({
    activeAlgorithm: { ...state.activeAlgorithm, [layer]: algoId },
  });
}

export function setFusionBlend(alpha) {
  update({ fusionBlend: Math.max(0, Math.min(1, +alpha || 0)) });
}

// Switch the active data source. Mirrors mode into both the legacy
// dataSource.mode field and the activeAlgorithm.dataSource registry-
// active key so consumers reading either keep working. Per-mode
// configs are stashed under dataSource.configs[mode] and preserved
// across switches.
export function setDataSourceMode(mode) {
  update({
    dataSource:      { ...state.dataSource, mode },
    activeAlgorithm: { ...state.activeAlgorithm, dataSource: mode },
  });
}

// Update a key in a specific source's config bag. When `mode` is
// omitted, writes to whatever's currently active.
export function setDataSourceConfig(key, value, mode) {
  const m   = mode || state.dataSource.mode;
  const cur = state.dataSource.configs[m] || {};
  update({
    dataSource: {
      ...state.dataSource,
      configs: { ...state.dataSource.configs, [m]: { ...cur, [key]: value } },
    },
  });
}

export function bumpEngineRevision() {
  update({ engineRevision: state.engineRevision + 1 });
}

export function setLayerParams(layer, params) {
  update({
    layerParams: { ...state.layerParams, [layer]: params },
  });
}

export function setSelection(selection) {
  update({ selection: selection || { type: null, id: null } });
}

// ── Search highlight (J09) ──────────────────────────────────────────
// Light up a set of active-dataset nodeIds from the SQL search panel. We bump
// engineRevision so the viewers (which repaint on selection / engineRevision
// change) pick up the new "search" colour branch — there's no dedicated
// search-repaint hook in the viewers, and a colour-only bump is cheap at
// toy/dev-subset sizes. STANDALONE for now; J25 folds this into the general
// highlight channel.
export function setSearchMatches(nodeIds) {
  update({ searchMatches: new Set((nodeIds || []).filter((n) => Number.isInteger(n))) });
  bumpEngineRevision();
}

export function clearSearchMatches() {
  if (state.searchMatches && state.searchMatches.size === 0) return;
  update({ searchMatches: new Set() });
  bumpEngineRevision();
}

export function setProjectName(name) {
  update({ projectName: name || null });
}

// DEPRECATED 2026-05-24 — Validate tab removed (§6.18.1). Kept as a
// no-op export so any external caller in the wild doesn't crash; safe
// to delete once we're sure nothing references it.
export function setValidateResult(result) {
  update({ evalResults: { ...state.evalResults, validate: result || null } });
}

export function setOptimiseResult(result) {
  update({ evalResults: { ...state.evalResults, optimise: result || null } });
}

export function clearEvalResults() {
  update({ evalResults: { validate: null, optimise: null } });
}

// ── Validation runs (§6.19.1) ───────────────────────────────────
// First-class persistent entities. saveValidationRun appends; the
// caller supplies most fields, we stamp an id + timestamp if absent.
// Order is insertion order (newest at the end); UI can re-sort.

function makeValidationRunId() {
  return `vr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Append a validation run to state.validationRuns.
 *
 * @param {object} run  See state.validationRuns comment for shape.
 *                      `id` and `timestamp` are auto-stamped when absent.
 *                      Required: type, results. Recommended: label,
 *                      inputs, settings.
 * @returns {string}    The (possibly auto-generated) id of the saved run.
 */
export function saveValidationRun(run) {
  if (!run || typeof run !== "object") {
    throw new Error("[state] saveValidationRun: run must be an object");
  }
  if (!run.type || typeof run.type !== "string") {
    throw new Error("[state] saveValidationRun: run.type is required");
  }
  const stamped = {
    id:        run.id        || makeValidationRunId(),
    timestamp: run.timestamp || new Date().toISOString(),
    ...run,
  };
  update({ validationRuns: [...(state.validationRuns || []), stamped] });
  return stamped.id;
}

/** Remove a validation run by id. No-op if id not found. */
export function deleteValidationRun(id) {
  const cur = state.validationRuns || [];
  const next = cur.filter(r => r.id !== id);
  if (next.length !== cur.length) update({ validationRuns: next });
}

/** Remove every validation run. */
export function clearValidationRuns() {
  update({ validationRuns: [] });
}

// Update the bridge analysis pair (fineLevel and/or coarseLevel).
// Pass only the fields you want to change — others are preserved.
// The engine reads this slice on every recluster and re-derives
// bridgeAnalysis; callers also need to invoke recomputeBridgeAnalysis()
// when they want an immediate refresh without a full recluster.
export function setBridgeConfig(partial) {
  update({
    bridgeConfig: { ...state.bridgeConfig, ...(partial || {}) },
  });
}

// Tree scoring (MLC §5). Set / clear a cluster's 1–5 score, keyed by the
// level UID so it follows the clustering (and persists). value=null clears.
export function setClusterScore(levelUid, clusterId, value) {
  if (!levelUid) return;
  const all = { ...(state.clusterScores || {}) };
  const forLevel = { ...(all[levelUid] || {}) };
  if (value == null) delete forLevel[clusterId];
  else forLevel[clusterId] = value;
  all[levelUid] = forLevel;
  update({ clusterScores: all });
}

export function getClusterScore(levelUid, clusterId) {
  const all = state.clusterScores || {};
  const forLevel = all[levelUid];
  return forLevel ? forLevel[clusterId] : undefined;
}

// Patch the viewer-3d display flags (which edge layers + their styling).
// Partial update — pass only the fields you want to change. Triggers
// a state notification so viewer-3d picks up the new flags on its
// next update() callback.
export function setView(partial) {
  update({ view: { ...state.view, ...(partial || {}) } });
}

// ── UI prefs (J10) ──────────────────────────────────────────────────
// Read the current layout prefs slice. Returned object is the live
// reference; treat as read-only and mutate via setUiPrefs.
export function getUiPrefs() {
  return state.uiPrefs;
}

// Patch the layout prefs slice (partial). Persists the merged slice to
// localStorage (OPTION A) so it survives reload; failures there are
// swallowed — a missing/blocked Storage must not break the layout.
export function setUiPrefs(partial) {
  const next = { ...state.uiPrefs, ...(partial || {}) };
  update({ uiPrefs: next });
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next));
  } catch (e) {
    // Storage disabled / quota / private mode — layout still works in
    // memory; we just lose persistence for this session.
  }
}

// Hydrate the layout prefs slice from the localStorage blob on boot.
// Only known numeric/boolean fields are copied across (defends against a
// stale or hand-edited blob). Writes straight to state without a further
// localStorage round-trip. Returns the active slice.
export function hydrateUiPrefs() {
  let stored = null;
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (e) {
    stored = null;
  }
  if (stored && typeof stored === "object") {
    const cur = state.uiPrefs;
    const merged = { ...cur };
    for (const k of ["leftRailW", "rightRailW", "bottomH"]) {
      if (Number.isFinite(stored[k])) merged[k] = stored[k];
    }
    for (const k of ["leftCollapsed", "rightCollapsed"]) {
      if (typeof stored[k] === "boolean") merged[k] = stored[k];
    }
    update({ uiPrefs: merged });
  }
  return state.uiPrefs;
}
