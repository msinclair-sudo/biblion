// Workflow-tree projection layer — Phase 2 slice 2.7.
//
// Bridges the new tree-shaped state.workflow with the legacy singular
// slots (state.dimredResult / state.clusterLevels / state._basePos /
// etc.) that every existing panel + viewer still reads.
//
// When the user selects a tree card, we walk the ancestry from the
// root to that card, collect each step's snapshotted result, and
// patch the legacy slots accordingly. Existing panels keep their
// existing read API; the underlying data is now selection-driven.
//
// Self-contained module:
//   - Inputs: stepId (from selectStep callers).
//   - Side effects: update() on state with the projected slots +
//     engineRevision bump (so viewers that watch engineRevision
//     re-paint).
//   - No reads outside workflow.js + state.js.

import { getState, update }    from "./state.js";
import { getStep, getStepAncestors } from "./workflow.js";

// Each step type knows which legacy state slots to project. The walk
// applies these projectors from root to selected step in order, so
// deeper ancestors overwrite shallower (which is the right semantics
// for the linear pipeline — clustering's result wins over dimred for
// state.clusterLevels, etc.; their result spaces don't overlap so the
// order doesn't matter in practice but keeping it explicit is cleaner).
const PROJECTORS = {
  data:           (step, patch) => projectData(step, patch),
  dimred:         (step, patch) => projectDimred(step, patch),
  fusionBranch:   (step, patch) => projectFusionBranch(step, patch),
  nodeDisplacement: (step, patch) => projectNodeDisplacement(step, patch),
  clustering:     (step, patch) => projectClustering(step, patch),
  multiLevel:       (step, patch) => projectMultiLevel(step, patch),
  multiLevelPicker: (step, patch) => projectMultiLevelPicker(step, patch),
  labelling:      (step, patch) => projectLabelling(step, patch),
  citations:      (step, patch) => projectCitations(step, patch),
  citationLayout: (step, patch) => projectCitationLayout(step, patch),
  alignment:      (step, patch) => projectAlignment(step, patch),
};

function projectData(step, patch) {
  // Data root is mostly descriptive in the migration; genResult /
  // embedding / dataSource etc. are already loaded into legacy state
  // and not re-projected here. (Switching data sources rebuilds the
  // workflow entirely via dataDescriptor.applyChange.)
  if (!step.result) return;
}

function projectDimred(step, patch) {
  const r = step.result;
  if (!r) return;
  // Migration-time results use field names like `basePos` / `basePos2d`
  // (no underscores) per workflow-migration.js. createAndRunStep
  // snapshots use the canonical underscore-prefixed legacy names.
  // Handle both.
  if (r.dimredResult)                patch.dimredResult         = r.dimredResult;
  if (r._basePos    !== undefined)   patch._basePos             = r._basePos;
  if (r.basePos     !== undefined && r._basePos === undefined) patch._basePos = r.basePos;
  if (r._basePos2d  !== undefined)   patch._basePos2d           = r._basePos2d;
  if (r.basePos2d   !== undefined && r._basePos2d === undefined) patch._basePos2d = r.basePos2d;
  if (r.dimredResultPreFusion !== undefined) patch.dimredResultPreFusion = r.dimredResultPreFusion;
  if (r._basePosPreFusion !== undefined)     patch._basePosPreFusion     = r._basePosPreFusion;
}

// Fusion-branch card — the pre/post-fusion fork router. Its dimred ancestor's
// projector already put the POST-fusion embedding into dimredResult/_basePos.
// For a POST branch that's correct → no-op. For a PRE branch, override those
// slots with the pre-fusion embedding (carried on the dimred card result), so
// a clustering card under the pre branch clusters the pre-fusion embedding
// with the same code. The walk runs root→selected, so this fires AFTER the
// dimred projector.
function projectFusionBranch(step, patch) {
  const endpoint = step.params && step.params.endpoint;
  if (endpoint !== "pre") return;   // post = the dimred projector's default
  // Find the dimred ancestor carrying both embeddings.
  const anc = getStepAncestors(step.id);
  let dimred = null;
  for (let i = anc.length - 1; i >= 0; i--) {
    if (anc[i].type === "dimred" && anc[i].result) { dimred = anc[i]; break; }
  }
  const r = dimred && dimred.result;
  if (!r) return;
  if (r.dimredResultPreFusion) patch.dimredResult = r.dimredResultPreFusion;
  if (r._basePosPreFusion !== undefined) patch._basePos = r._basePosPreFusion;
  // (2D pre-fusion basePos isn't separately stored today; the 2D viewer keeps
  // the post 2D until a pre-fusion 2D embedding is carried — acceptable for
  // Phase A, the 3D viewer + clustering use the swapped 3D/compression slots.)
}

// Node-displacement card → state.nodeDisplacement, the slot the displacement
// panel + the "displacement" viewer colour mode read.
function projectNodeDisplacement(step, patch) {
  const r = step.result;
  if (r && r.nodeDisplacement) patch.nodeDisplacement = r.nodeDisplacement;
}

function projectClustering(step, patch) {
  const r = step.result;
  if (!r) return;
  if (r.clusterLevels)                       patch.clusterLevels = r.clusterLevels;
  if (r.clusterResult)                       patch.clusterResult = r.clusterResult;
  if (r.bridgeAnalysis         !== undefined) patch.bridgeAnalysis = r.bridgeAnalysis;
}

// Multi-layer SWEEP card (producer, §9 producer/picker split). It does NOT
// commit a ladder — it only produces the scored candidates + curve. Project
// state.multiLevelSweep so the picker panel can draw the clickable
// reproducibility curve. clusterLevels are committed by the picker child, not
// here.
function projectMultiLevel(step, patch) {
  const r = step.result;
  if (!r) return;
  if (r.multiLevelSweep !== undefined) patch.multiLevelSweep = r.multiLevelSweep;
}

// Layer-PICKER card (picker, §9 producer/picker split) — projects the
// committed ladder (clusterLevels / clusterResult / bridgeAnalysis) the user
// chose, so the viewer's colour-by-layer mode + bridge/scoring panels read
// it. Its producer ancestor already projected state.multiLevelSweep (the
// curve), so the picker panel still has the candidates to render. No
// pre-fusion sibling (multi-level is a single ladder).
function projectMultiLevelPicker(step, patch) {
  const r = step.result;
  if (!r) return;
  if (r.clusterLevels)                patch.clusterLevels  = r.clusterLevels;
  if (r.clusterResult)                patch.clusterResult  = r.clusterResult;
  if (r.bridgeAnalysis !== undefined) patch.bridgeAnalysis = r.bridgeAnalysis;
  if (Array.isArray(r.pickedCounts))  patch.multiLevelPicked = r.pickedCounts;
}

// (projectBridgeAnalysis removed in cards.md Pass 2a, 2026-06-02. The
// bridgeAnalysis card type no longer exists; the picker's projector now
// surfaces state.bridgeAnalysis directly from its own result.)

// (projectCrossClusterCitations removed in J16, 2026-06-15. Cross-cluster
// citations is no longer a card type — it auto-computes after the layer ladder
// commits and the result is written straight to state.crossClusterCitations,
// read by the singleton cross-cluster panel. Nothing in the tree to project.)

// Labelling card → state.clusterLabels (keyed by level uid), the slot the
// scoring panel reads. The clustering-like ancestor already projected
// state.clusterLevels, which the labels key against.
function projectLabelling(step, patch) {
  const r = step.result;
  if (!r || !r.byLevel) return;
  patch.clusterLabels = r.byLevel;
}

function projectCitations(step, patch) {
  const r = step.result;
  if (!r) return;
  if (r.citationResult) patch.citationResult = r.citationResult;
}

function projectCitationLayout(step, patch) {
  const r = step.result;
  if (!r) return;
  if (r.citationLayout)                    patch.citationLayout        = r.citationLayout;
  if (r.alignedCitationLayout)             patch.alignedCitationLayout = r.alignedCitationLayout;
  if (r.alignmentCorrelation !== undefined) patch.alignmentCorrelation = r.alignmentCorrelation;
}

function projectAlignment(step, patch) {
  const r = step.result;
  if (!r) return;
  if (r.alignedCitationLayout) patch.alignedCitationLayout = r.alignedCitationLayout;
  if (r.alignmentCorrelation !== undefined) patch.alignmentCorrelation = r.alignmentCorrelation;
}

/**
 * Walk the ancestry from root → stepId, accumulate per-step
 * projections into a patch, and apply via `update`. Bumps
 * engineRevision so subscribers that watch it (viewer-3d/2d) re-paint.
 *
 * @param {string} stepId
 * @param {object} [opts]
 * @param {boolean} [opts.bumpRevision=true]
 *        When true (the default, used for user-driven selection), bump
 *        engineRevision so viewer-3d/2d re-paint. When false, stage the
 *        slots WITHOUT bumping — used to feed a queued job's engine input
 *        from its parent's result without disturbing whatever card the
 *        user is currently viewing (viewer-3d only rebuilds on an
 *        engineRevision change, see viewer-3d.js).
 * @returns {boolean} true if the patch was non-empty (i.e. data
 *                    actually changed), false otherwise.
 */
export function projectStepIntoLegacyState(stepId, opts = {}) {
  const { bumpRevision = true } = opts;
  // Cross-source comparison cards (slice 2.10) have no geometry of their
  // own — their parent is the *selected* card, not a geometry ancestor.
  // Show the CANDIDATE clustering's geometry instead (§10.O2): walk the
  // candidate refId's ancestry rather than the comparison card's parent
  // chain. refIds convention is [refStepId, candStepId].
  let walkId = stepId;
  const target = getStep(stepId);
  if (target && target.type === "fusionComparison") {
    const refIds = target.refIds || [];
    const candId = refIds[1] || refIds[0];
    if (candId && getStep(candId)) walkId = candId;
  }
  const ancestors = getStepAncestors(walkId);
  if (ancestors.length === 0) return false;
  const patch = {};
  for (const step of ancestors) {
    const projector = PROJECTORS[step.type];
    if (projector) projector(step, patch);
  }
  // Bump engineRevision so viewers re-paint. Even an empty projection
  // bumps because the user did select a step — they expect some
  // visual confirmation. Cheap. Skipped in silent mode (engine-input
  // staging) so a queued job doesn't yank the viewer off the card the
  // user is currently looking at.
  const hadData = Object.keys(patch).length > 0;
  if (bumpRevision) patch.engineRevision = (getState().engineRevision || 0) + 1;
  if (Object.keys(patch).length === 0) return false;
  update(patch);
  return hadData;
}
