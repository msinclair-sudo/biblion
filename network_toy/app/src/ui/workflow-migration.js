// Workflow-tree migration — Phase 2 slice 2.2.
//
// Reconstructs `state.workflow` from the legacy singular slots
// (layerParams, dimredResult, clusterLevels, …) so users who land on
// the new tree-aware surface get a populated tree on first boot or
// after loading a pre-tree project.
//
// Self-contained module: defined inputs + outputs, no reaching into
// other modules' internals beyond their published APIs.
//
// Two-phase: planning is pure (takes a state snapshot, returns a plan
// — testable in isolation); applying is the side-effecting glue that
// calls workflow.js CRUD APIs to materialise the plan. The split lets
// us unit-test the planner without spinning up state mutations.
//
// What the migration emits:
//
//   - **Always** (the universal spine):
//     `data → dimred → clustering`. Every project with a loaded source
//     has these in some form.
//
//   - **Citations branch** (`citations → layout → alignment`)
//     appended off the clustering card. These only exist when the
//     corresponding state slots are populated — i.e. when the user
//     imports citation edges + applies citation layout.
//
//   - **Saved ValidationRuns** as auxiliary children of their nearest
//     matching ancestor (e.g. a `type: "optimise"` run attaches under
//     the clustering card whose params match the run's
//     `inputs.layerParamsSnapshot.clustering`). Best-effort match —
//     when no good ancestor is found, the run attaches under the
//     clustering card (the default destination).
//
// What the migration explicitly does NOT do:
//   - Doesn't run any algorithms. Migrated cards arrive `status: done`
//     with their existing result; no re-clustering / re-fitting.
//   - Doesn't touch the legacy state slots. They stay populated;
//     Slice 2.7 builds the back-compat projection layer that syncs
//     them from the workflow.
//   - Doesn't enforce a schema bump. Older saves continue to load
//     unchanged; the migration runs additively after deserialise.

import { getState } from "./state.js";
import {
  createStep, setStepResult, updateStepStatus, selectStep,
  getRootStep, STEP_STATUS,
} from "./workflow.js";

// ── pure planner ─────────────────────────────────────────────────────

/**
 * Inspect a state snapshot and return an ordered list of card-creation
 * specs. Pure — doesn't read getState, doesn't mutate anything. The
 * spec order matches the intended creation order; later specs may
 * reference earlier ones by `parentRef` (a logical name, not an id).
 *
 * Spec shape:
 *   {
 *     ref:       string,            // logical name for parentRef linking
 *     type:      string,            // step type
 *     label:     string,
 *     params:    object,
 *     parentRef: string | null,     // logical name of parent spec; null = root
 *     refRefs:   string[],          // logical names for cross-edges (refIds)
 *     result:    any,               // step's result blob (status: done)
 *   }
 *
 * @param {object} state             A snapshot of state (typically
 *                                   getState() at call time). Reads
 *                                   genResult, dataSource, layerParams,
 *                                   dimredResult, clusterLevels,
 *                                   citationResult, citationLayout,
 *                                   alignedCitationLayout,
 *                                   alignmentCorrelation, _basePos,
 *                                   _basePos2d.
 * @returns {object[]}               Ordered list of card specs. Empty
 *                                   when the snapshot has no genResult
 *                                   (degenerate state).
 */
export function inferBaselineTree(state) {
  if (!state || !state.genResult) return [];

  const plan = [];
  const dataSourceId = (state.dataSource && state.dataSource.mode) || "real";
  const dataSourceCfg = (state.dataSource && state.dataSource.configs && state.dataSource.configs[dataSourceId]) || {};

  // ── data card (root) — always emitted when genResult exists.
  const nNodes = state.genResult.nodes ? state.genResult.nodes.length : 0;
  const dataLabel = `Real · ${dataSourceCfg.subset || "(unknown subset)"} (n=${nNodes})`;
  plan.push({
    ref:       "data",
    type:      "data",
    label:     dataLabel,
    params:    { mode: dataSourceId, ...dataSourceCfg },
    parentRef: null,
    refRefs:   [],
    result:    {
      n: nNodes,
      hasEmbedding:    !!state.embedding,
      hasCitations:    !!(state.rawCitationEdges && state.rawCitationEdges.length),
      hasBasePos:      !!state._basePos,
      originsCount:    (state.genResult.origins && state.genResult.origins.length) || 0,
    },
  });

  const lp = state.layerParams || {};

  // ── dimred card — emitted only once a dim-reduction result exists.
  // UI #2 granular build-out: a data-only ingest has no dimred yet, so
  // the data card stands alone until the user adds dim-reduction via the
  // per-card + button. (Pre-UI-#2 the cascade always ran, so genResult
  // never existed without dimredResult — this gate is a no-op for full-
  // cascade callers, which still get all three spine cards.)
  let dimredEmitted = false;
  if (state.dimredResult) {
    const dimredCfg = lp.dimred || {};
    plan.push({
      ref:       "dimred",
      type:      "dimred",
      label:     describeDimredLabel(dimredCfg),
      params:    dimredCfg,
      parentRef: "data",
      refRefs:   [],
      // Result carries refs to the existing state slots (not a deep
      // copy) — the projection layer (Slice 2.7) reads these back into
      // the legacy slots when this card is selected.
      result:    {
        dimredResult: state.dimredResult,
        basePos:      state._basePos,
        basePos2d:    state._basePos2d,
      },
    });
    dimredEmitted = true;
  }

  // ── clustering card — only when a clustering result exists AND a
  // dimred card is present to parent it.
  if (dimredEmitted && state.clusterLevels) {
    const clusteringCfg = lp.clustering || {};
    plan.push({
      ref:       "clustering",
      type:      "clustering",
      label:     describeClusteringLabel(clusteringCfg, state.clusterLevels),
      params:    clusteringCfg,
      parentRef: "dimred",
      refRefs:   [],
      result:    { clusterLevels: state.clusterLevels },
    });
  }

  // ── citations branch (real data with imported edges).
  // Conditional: only when the corresponding state slot carries a
  // result. The presence/absence of state.citationResult is the
  // authoritative signal — real-mode-without-imports never populates it.
  if (state.citationResult) {
    const citationsCfg = lp.citations || {};
    plan.push({
      ref:       "citations",
      type:      "citations",
      label:     describeCitationsLabel(citationsCfg, state.citationResult),
      params:    citationsCfg,
      parentRef: "clustering",
      refRefs:   [],
      result:    { citationResult: state.citationResult },
    });

    if (state.citationLayout) {
      const layoutCfg = lp.layout || {};
      plan.push({
        ref:       "citationLayout",
        type:      "citationLayout",
        label:     describeLayoutLabel(layoutCfg),
        params:    layoutCfg,
        parentRef: "citations",
        refRefs:   [],
        result:    { citationLayout: state.citationLayout },
      });

      if (state.alignedCitationLayout) {
        plan.push({
          ref:       "alignment",
          type:      "alignment",
          label:     `Alignment · ρ=${Number.isFinite(state.alignmentCorrelation) ? state.alignmentCorrelation.toFixed(2) : "?"}`,
          params:    {},
          parentRef: "citationLayout",
          refRefs:   [],
          result:    {
            alignedCitationLayout: state.alignedCitationLayout,
            alignmentCorrelation:  state.alignmentCorrelation,
          },
        });
      }
    }
  }

  // ── Saved ValidationRuns as auxiliary children.
  // Each run attaches under the clustering card (the default), unless
  // its type indicates a different anchor. Specifically:
  //   - "optimise" / "bootstrapStability" / "targetRange" → clustering
  //   - "dimSweep"                                         → dimred
  //   - "fusionComparison"                                 → clustering
  //                                                          (refRefs:
  //                                                          two clustering
  //                                                          cards — but
  //                                                          we only have
  //                                                          one in the
  //                                                          baseline tree;
  //                                                          fan-in expands
  //                                                          when Phase 2.10
  //                                                          lands)
  // Best-effort; nothing breaks if the anchor isn't a perfect match.
  const runs = state.validationRuns || [];
  for (const run of runs) {
    const anchorRef = anchorForRunType(run.type);
    plan.push({
      ref:       `vr-${run.id}`,
      type:      run.type,
      label:     run.label || `(unlabelled ${run.type})`,
      params:    run.settings || {},
      parentRef: anchorRef,
      refRefs:   [],
      result:    run.results || null,
      meta:      { fromValidationRun: run.id, branchId: run.branchId || null,
                   scoreVersion: run.scoreVersion, runtimeSec: run.runtimeSec,
                   savedAt: run.timestamp },
    });
  }

  return plan;
}

function anchorForRunType(type) {
  if (type === "dimSweep") return "dimred";
  // optimise / bootstrapStability / targetRange / fusionComparison /
  // unknown → clustering. Safe default; never produces a tree that
  // violates parent-child relations.
  return "clustering";
}

function describeDimredLabel(cfg) {
  if (!cfg) return "Dim-reduction";
  const noise       = cfg.noise && cfg.noise.method;
  const compression = cfg.compression && cfg.compression.method;
  const viz         = cfg.viz && cfg.viz.method;
  const parts = [];
  if (noise && noise !== "identity")             parts.push(`noise=${noise}`);
  if (compression && compression !== "identity") parts.push(`compress=${compression}`);
  if (viz && viz !== "identity")                 parts.push(`viz=${viz}`);
  return parts.length > 0 ? `Dim-reduce · ${parts.join(", ")}` : "Dim-reduce · identity";
}

function describeClusteringLabel(cfg, levels) {
  if (!cfg || !cfg.method) return "Clustering";
  const lvlCount = Array.isArray(levels) ? levels.length : 0;
  return lvlCount > 0
    ? `Clustering · ${cfg.method} · ${lvlCount} level${lvlCount === 1 ? "" : "s"}`
    : `Clustering · ${cfg.method}`;
}

function describeCitationsLabel(cfg, citationResult) {
  const method = cfg && cfg.method;
  const nEdges = citationResult && citationResult.citations
    ? citationResult.citations.length
    : 0;
  return method
    ? `Citations · ${method} (${nEdges} edges)`
    : `Citations · ${nEdges} edges`;
}

function describeLayoutLabel(cfg) {
  return cfg && cfg.method ? `Citation layout · ${cfg.method}` : "Citation layout";
}

// ── side-effecting applier ───────────────────────────────────────────

/**
 * Walks a plan from inferBaselineTree() and creates the corresponding
 * cards via workflow.js's CRUD API. Cards arrive in spec order;
 * `parentRef` is resolved against earlier specs in the same plan.
 *
 * Each card with a non-null `result` is set to status:done with
 * setStepResult; cards with null result stay pending.
 *
 * Sets `state.workflow.selected` to the clustering card (or the leaf
 * of the universal spine when clustering isn't yet populated) — the
 * user's default focal point.
 *
 * @param {object[]} plan
 * @returns {{ idsByRef: object, createdIds: string[] }}
 *          Map of plan-ref → created step id, plus the flat list.
 */
export function applyTreePlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) {
    return { idsByRef: {}, createdIds: [] };
  }
  const idsByRef = {};
  const createdIds = [];
  for (const spec of plan) {
    const parentId = spec.parentRef ? idsByRef[spec.parentRef] : null;
    const refIds = (spec.refRefs || []).map(r => idsByRef[r]).filter(Boolean);
    const id = createStep({
      type:     spec.type,
      label:    spec.label,
      params:   spec.params || {},
      parentId,
      refIds,
    });
    idsByRef[spec.ref] = id;
    createdIds.push(id);

    if (spec.result != null) {
      // Card has a materialised result already — transition pending →
      // running → done via setStepResult.
      updateStepStatus(id, STEP_STATUS.RUNNING);
      setStepResult(id, spec.result);
    }
    // Cards without a result stay pending (the dimred / clustering
    // baseline emitted before the user actually ran anything would
    // sit here — rare in practice since boot regenerates).
  }

  // Pick a sensible default selection: the clustering card if it
  // exists, else the leaf of whatever we built.
  const defaultSelectionRef = idsByRef.clustering || idsByRef.dimred || idsByRef.data;
  if (defaultSelectionRef) selectStep(defaultSelectionRef);

  return { idsByRef, createdIds };
}

// ── entry point ──────────────────────────────────────────────────────

/**
 * Run the migration if (and only if) `state.workflow` is empty.
 * Idempotent: calling twice on an already-populated workflow is a
 * no-op. Reads getState() internally; caller doesn't need to pass
 * state.
 *
 * Wiring (planned for slice 2.3 once the renderer needs the tree):
 *   - persistence/deserialise.js: call after restoring legacy slots.
 *   - main.js boot path: call after the initial regenerate completes.
 *
 * @returns {boolean}   true if migration ran; false if skipped
 *                      (workflow was already non-empty, or state was
 *                      degenerate — no genResult to migrate from).
 */
export function migrateLegacyToWorkflowIfNeeded() {
  if (getRootStep() != null) return false;       // already populated
  const state = getState();
  const plan = inferBaselineTree(state);
  if (plan.length === 0) return false;           // nothing to migrate
  applyTreePlan(plan);
  return true;
}
