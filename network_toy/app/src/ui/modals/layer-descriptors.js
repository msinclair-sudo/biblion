// Per-layer descriptors that the workflow chart consumes.
//
// Each layer exposes:
//   { label, openModal: () => modalHandle, applyChange(args) → Promise }
//
// Phase 2 slice 2.5: applyChange now CREATES A NEW TREE STEP and
// enqueues a step-bound job that runs the existing engine function.
// The card represents the work that happened with these params; old
// cards stay browsable. The legacy state slots (state.dimredResult,
// state.clusterLevels, …) continue to reflect the most recent apply —
// the back-compat projection layer (slice 2.7) will swap those slots
// based on the selected card.
//
// New layer kinds plug in here without touching workflow-chart.js.

import { listDataSources, getDataSource }           from "../../datasource/registry.js";
import { getNodeText, hasSqliteText }               from "../../datasource/sqlite.js";
import { listAlgorithms as listDimredAlgos,
         getAlgorithm   as getDimredAlgo }         from "../../dimred/registry.js";
import { listAlgorithms as listClusteringAlgos,
         getAlgorithm   as getClusteringAlgo }     from "../../clustering-registry.js";
import { listAlgorithms as listLayoutAlgos,
         getAlgorithm   as getLayoutAlgo }         from "../../citation-layout/registry.js";
import { getState, update, setDataSourceMode, setDataSourceConfig } from "../state.js";
import { createStep, listSteps, clearWorkflow, getStep,
         getStepAncestors, getSelectedStep, selectStep,
         findClusterLevels, rearmStep }           from "../workflow.js";
import { enqueueJob, listJobs, cancelJob }        from "../queue.js";
import { openAlgorithmModal }                       from "./algorithm-modal.js";
import { openClusteringModal }                      from "./clustering-modal.js";
import { openDimredModal }                          from "./dimred-modal.js";
import { openDataSourceModal }                      from "./data-source-modal.js";
// bootstrap is no longer a card type (cards.md Pass 2b, 2026-06-03);
// it runs as a sidecar to clustering. eval/bootstrap.js + the runner remain
// callable, but nothing in this module imports them.
import { openDimSweepModal, DIMSWEEP_DEFAULTS,
         defaultNoiseConfig, defaultCompressionConfig,
         defaultClusteringConfig }                  from "./dim-sweep-modal.js";
import { buildDimSweepJob }                         from "../runners/dim-sweep-runner.js";
import { openFusionComparisonModal }                from "./fusion-comparison-modal.js";
import { buildFusionComparisonJob }                 from "../runners/fusion-comparison-runner.js";
import { openMultiLevelModal }                      from "./multi-level-modal.js";
import { buildMultiLevelJob }                       from "../runners/multi-level-runner.js";
import { buildMultiLevelPickerJob }                 from "../runners/multi-level-picker-runner.js";
// bridge analysis is no longer a card type (cards.md Pass 2a, 2026-06-02);
// the algorithm + runner remain available for the picker's commit job, but
// nothing here imports them anymore.
import { openLabellingModal }                       from "./labelling-modal.js";
import { buildLabellingJob }                        from "../runners/cluster-labels-runner.js";
import { listLabelMethods }                         from "../../labelling/cluster-labels.js";
import { buildScoringPrepJob }                      from "../runners/scoring-runner.js";
import { buildExportPrepJob }                       from "../runners/export-runner.js";
import { buildCrossClusterJob }                     from "../runners/cross-cluster-runner.js";
import { buildFusionBranchJob }                     from "../runners/fusion-branch-runner.js";
import { buildNodeDisplacementJob }                 from "../runners/node-displacement-runner.js";
import { listComparableClusterings }                from "./step-tree-picker.js";
import * as engine                                  from "../engine.js";

// editStepId !== null puts the descriptor in "edit this card in place"
// mode (the ⚙ gear path): Apply overwrites the given card rather than
// forking a new one. null (the default, used by the "+" path) keeps the
// fork-a-new-card behaviour. Data is excluded — switching data source
// rebuilds the whole tree, so there's no in-place edit for the root.
export function getLayerDescriptor(nodeId, editStepId = null) {
  switch (nodeId) {
    case "data":       return dataDescriptor();
    case "dimred":     return dimredDescriptor(editStepId);
    case "fusionBranch": return fusionBranchDescriptor(editStepId);
    case "nodeDisplacement": return nodeDisplacementDescriptor(editStepId);
    case "clustering": return clusteringDescriptor(editStepId);
    case "layout":     return layoutDescriptor(editStepId);
    case "dimSweep":   return dimSweepDescriptor(editStepId);
    case "fusionComparison": return fusionComparisonDescriptor(editStepId);
    case "multiLevel": return multiLevelDescriptor(editStepId);
    case "multiLevelPicker": return multiLevelPickerDescriptor(editStepId);
    case "labelling":  return labellingDescriptor(editStepId);
    case "scoring":    return scoringDescriptor(editStepId);
    case "export":     return exportDescriptor(editStepId);
    case "crossClusterCitations": return crossClusterDescriptor(editStepId);
    default:           return null;
  }
}

// Cancel any still-live (pending/running) queue jobs bound to a step —
// used before an in-place edit re-runs it, so we don't leave a stale job
// racing the fresh one for the same card.
function cancelBoundJobs(stepId) {
  for (const j of listJobs()) {
    if (j.stepId === stepId && (j.status === "pending" || j.status === "running")) {
      cancelJob(j.id);
    }
  }
}

// Resolve the step a job will bind to: edit-in-place reuses editStepId
// (re-armed with the new params/label, children kept); otherwise a fresh
// card is forked under parentId. Returns the step id to enqueue against.
function beginStep({ editStepId, type, label, params, parentId, refIds = [] }) {
  if (editStepId && getStep(editStepId)) {
    cancelBoundJobs(editStepId);
    rearmStep(editStepId, { params, label, ...(refIds.length ? { refIds } : {}) });
    return editStepId;
  }
  return createStep({ type, label, params, parentId, refIds });
}

// ── parent-step lookup ───────────────────────────────────────────────
//
// For each layer type, the canonical parent in the workflow tree:
//   dimred         → data
//   clustering     → dimred
//   citations      → clustering  (toy-only branch)
//   citationLayout → citations OR clustering (whichever exists)
//
// We pick the most recently-created step of the parent type — that's
// the "active" branch the user has been working on. listSteps walks
// the tree in BFS-from-root order, so the LAST entry is the latest.
//
// Returns null if no matching parent exists (e.g. dimred step before
// the data root has been migrated). Caller falls back to "no-tree"
// mode if returning null.
function findCanonicalParent(childType) {
  // Fork-aware: clustering attaches under the SELECTED fusion branch when one
  // is in the lineage (so a pre/post branch carries its own clustering), else
  // the canonical dimred. Keeps the fork's two branches independent.
  if (childType === "clustering") {
    const branch = findSelectedAncestorOfType("fusionBranch");
    if (branch) return branch;
  }
  const parentTypeMap = {
    dimred:         "data",
    clustering:     "dimred",
    citationLayout: "citations",
  };
  const parentType = parentTypeMap[childType];
  if (!parentType) return null;
  const candidates = listSteps({ type: parentType });
  if (candidates.length > 0) return candidates[candidates.length - 1].id;
  // citationLayout's natural parent is "citations"; fall back to
  // clustering if citations isn't on the tree (real-data without
  // imported edges).
  if (childType === "citationLayout") {
    const clust = listSteps({ type: "clustering" });
    if (clust.length > 0) return clust[clust.length - 1].id;
  }
  return null;
}

// Step types that materialise a clusterLevels[] ladder and so are
// interchangeable as the "clustering" a downstream analysis (bootstrap,
// compare, …) attaches to. A multi-layer card IS a clustering output, so
// it gets the same downstream affordances. Future analysis layers that
// produce their own partitions can join this set.
// The PICKER (not the producer sweep) materialises clusterLevels[], so it's
// the clustering-equivalent that downstream analyses attach to.
const CLUSTERING_LIKE_TYPES = ["clustering", "multiLevelPicker"];

// Analysis cards (bootstrap / dim-sweep / future) attach to the
// nearest matching ancestor of the SELECTED step — not "latest of
// type". The user's mental model is "I'm looking at this clustering;
// run a bootstrap on it"; with branching, "latest" picks the wrong
// sibling when the user has scrolled back.
//
// targetType may be a single type string or an array of acceptable
// types (e.g. CLUSTERING_LIKE_TYPES so bootstrap can sit under either a
// clustering or a multi-layer card).
//
// Returns the ancestor step id, or null if no ancestor of the target
// type exists in the selected step's lineage.
function findSelectedAncestorOfType(targetType) {
  const types = Array.isArray(targetType) ? targetType : [targetType];
  const sel = getSelectedStep();
  if (!sel) return null;
  // Include the selection itself — running a bootstrap from a
  // clustering card should attach right under that card.
  const lineage = [...getStepAncestors(sel.id)];
  for (let i = lineage.length - 1; i >= 0; i--) {
    if (types.includes(lineage[i].type)) return lineage[i].id;
  }
  return null;
}

// For analysis cards that hang off a clustering ladder (labelling, scoring,
// export, future siblings), the auto-spawned crossClusterCitations card
// should become their effective parent so its citation-flow data is
// projected into state on selection (children read it via projection).
// Returns the crossCluster's id when one exists under `clusteringId`, else
// returns `clusteringId` itself (the legacy attach point). Pass-through when
// clusteringId is null.
function preferCrossClusterChild(clusteringId) {
  if (!clusteringId) return clusteringId;
  const xcc = listSteps({ type: "crossClusterCitations" })
    .find(c => c.parentId === clusteringId);
  return xcc ? xcc.id : clusteringId;
}

// Create a tree step + enqueue a step-bound job that runs `engineFn`.
// engineFn is an async function — typically it patches state.layerParams
// then calls one of the engine.* functions. The job's fn closes over
// the patched params; the queue runner mirrors lifecycle onto the step.
//
// Slice 2.7: after engineFn returns, we SNAPSHOT the relevant state
// slots into the step's result based on its type. Each card holds a
// ref to the exact result objects it produced (the engine creates
// fresh objects on each Apply, so refs don't alias). The projection
// layer (workflow-projection.js) replays these into legacy state slots
// when the user selects the card.
//
// Returns the job's promise (resolves with the engine result when the
// step completes; rejects on failure or cancel). Modals await this so
// their Running… indicator stays visible until completion (modals that
// close on Apply just call it without awaiting).
function createAndRunStep({ type, label, params, engineFn, editStepId = null }) {
  let stepId;
  if (editStepId && getStep(editStepId)) {
    // Gear edit: overwrite THIS card in place (same id / parent /
    // children); just update params + re-run.
    stepId = beginStep({ editStepId, type, label, params });
  } else {
    const parentId = findCanonicalParent(type);
    if (parentId == null) {
      // No tree yet (e.g. legacy boot path before migration runs). Fall
      // back to the legacy behaviour: just call engineFn without
      // creating a step. The chart will be silent for this work; an
      // explicit migration on the next state change will rebuild.
      return engineFn();
    }
    stepId = createStep({ type, label, params, parentId });
  }
  // Make the freshly-applied card the active selection so the next "+"
  // (and selection-driven descriptors like multiLevel / dimSweep) resolve
  // their parent to THIS card rather than to a stale earlier selection.
  // Mirrors dataDescriptor / multiLevelDescriptor, which already select.
  selectStep(stepId);
  const { promise } = enqueueJob({
    type, label,
    stepId,
    fn: async (_ctx) => {
      await engineFn();
      // Snapshot the relevant state slots into the step's result, so
      // the projection layer can replay them back when this card is
      // selected later. Each engine function creates fresh objects, so
      // these refs aren't shared with other steps' results.
      return snapshotResultForType(type);
    },
  });
  return promise;
}

// Per-type snapshot — picks the state slots that "belong" to this
// layer's output. Refs are captured at the moment the engine function
// returns; subsequent Apply on a SIBLING produces a new result with
// fresh refs, so the old card's refs stay intact (immutable per §10.D1).
function snapshotResultForType(type) {
  const s = getState();
  if (type === "dimred") {
    return {
      capturedAt:            new Date().toISOString(),
      dimredResult:          s.dimredResult,
      _basePos:              s._basePos,
      _basePos2d:            s._basePos2d,
      dimredResultPreFusion: s.dimredResultPreFusion,
      _basePosPreFusion:     s._basePosPreFusion,
      // Fusion produced a SECOND (pre-fusion) embedding → this dimred card
      // can fork into pre/post branches. Identity fusion leaves this false.
      fusionActive:          !!s.dimredResultPreFusion,
    };
  }
  if (type === "clustering") {
    return {
      capturedAt:             new Date().toISOString(),
      clusterLevels:          s.clusterLevels,
      clusterResult:          s.clusterResult,
      bridgeAnalysis:         s.bridgeAnalysis,
    };
  }
  if (type === "citationLayout") {
    return {
      capturedAt:            new Date().toISOString(),
      citationLayout:        s.citationLayout,
      alignedCitationLayout: s.alignedCitationLayout,
      alignmentCorrelation:  s.alignmentCorrelation,
    };
  }
  // Other types use the sentinel — the migration helper or per-type
  // builder already populated their result blob.
  return { capturedAt: new Date().toISOString() };
}

// ── descriptors ─────────────────────────────────────────────────────

function dataDescriptor() {
  const desc = {
    label: "Configure: Data source",
    listSources: () => listDataSources(),
    getActive: () => {
      const s = getState();
      const mode = s.dataSource.mode;
      const params = (s.dataSource.configs && s.dataSource.configs[mode]) || getDataSource(mode).defaultParams();
      return { method: mode, params: { ...params } };
    },
    // UI #2 granular build-out: adding/switching a data source ingests
    // the data ONLY (no dimred/clustering cascade) and creates just the
    // data card. The user then adds dim-reduction + clustering via the
    // per-card + buttons. Single root (§10.D1), so we wipe the tree and
    // create a fresh data root.
    //
    // The data card is created UP FRONT and bound to a queue job that
    // runs the ingest. That way a card appears immediately (with a
    // spinner) during a possibly-slow real-data load, the card surfaces
    // a failed status if the ingest throws (instead of failing
    // silently), and we don't depend on the migration-retry race firing
    // mid-ingest. Mirrors the bootstrap / dim-sweep runner pattern.
    applyChange: async (sourceId, params) => {
      setDataSourceMode(sourceId);
      for (const k of Object.keys(params)) {
        setDataSourceConfig(k, params[k], sourceId);
      }
      clearWorkflow();

      const cfg = (getState().dataSource.configs && getState().dataSource.configs[sourceId]) || {};
      // Card label = the chosen dataset id (data/-driven picker). Falls back to
      // the source id for any source that doesn't carry a `dataset` param.
      const label = cfg.dataset ? `Data · ${cfg.dataset}` : sourceId;
      const stepId = createStep({
        type:     "data",
        label,
        params:   { mode: sourceId, ...cfg },
        parentId: null,                       // data is always the root
      });
      selectStep(stepId);

      const { promise } = enqueueJob({
        type:  "data",
        label: `Load · ${label}`,
        stepId,
        fn: async (_ctx) => {
          await engine.ingestDataOnly();
          const s = getState();
          const n = s.genResult && s.genResult.nodes ? s.genResult.nodes.length : 0;
          // Result slot for the data card — informational; projectData
          // is a no-op (genResult etc. already live in the legacy slots).
          return {
            capturedAt:   new Date().toISOString(),
            n,
            hasEmbedding: !!s.embedding,
            hasCitations: !!(s.rawCitationEdges && s.rawCitationEdges.length),
            hasBasePos:   !!s._basePos,
          };
        },
      });
      promise.catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[data-descriptor] ingest failed:", e);
      });
      return promise;
    },
    openModal: () => openDataSourceModal(desc),
  };
  return desc;
}

function dimredDescriptor(editStepId = null) {
  const desc = {
    label: "Configure: Dim-reduction",
    listAlgos: (slot) => listDimredAlgos(slot),
    getActive: () => {
      // When editing a card (gear), prefill from THAT card's stored
      // params; otherwise fall back to the last-applied live params.
      const editStep = editStepId ? getStep(editStepId) : null;
      const lp = (editStep && editStep.params) || getState().layerParams.dimred;
      const fallbackParams = (algoId) => getDimredAlgo(algoId).defaultParams();
      const noiseM  = lp && lp.noise       ? lp.noise.method       : "identity";
      const fusionM = lp && lp.fusion      ? lp.fusion.method      : "identity";
      const compM   = lp && lp.compression ? lp.compression.method : "identity";
      const vizM    = lp && lp.viz         ? lp.viz.method         : "identity";
      const viz2dM  = lp && lp.viz2d       ? lp.viz2d.method       : "identity";
      return {
        noise:       {
          method: noiseM,
          params: (lp && lp.noise && lp.noise.params) || fallbackParams(noiseM),
        },
        fusion:      {
          method: fusionM,
          params: (lp && lp.fusion && lp.fusion.params) || fallbackParams(fusionM),
        },
        compression: {
          method: compM,
          params: (lp && lp.compression && lp.compression.params) || fallbackParams(compM),
        },
        viz: {
          method: vizM,
          params: (lp && lp.viz && lp.viz.params) || fallbackParams(vizM),
        },
        viz2d: {
          method: viz2dM,
          params: (lp && lp.viz2d && lp.viz2d.params) || fallbackParams(viz2dM),
        },
      };
    },
    applyChange: async ({ noise, fusion, compression, viz, viz2d }) => {
      const dimredParams = { noise, fusion, compression, viz, viz2d };
      const label = `Dim-reduce · ${compression.method} → ${viz.method}`;
      const promise = createAndRunStep({
        type:   "dimred",
        label,
        params: dimredParams,
        editStepId,
        engineFn: async () => {
          const s = getState();
          update({ layerParams: { ...s.layerParams, dimred: dimredParams } });
          // cascade:false — adding a dimred card doesn't auto-run
          // clustering (UI #2 granular build-out); the user adds a
          // clustering card via the + button.
          try { await engine.redimred({ cascade: false }); }
          catch (e) { console.error("[dimred-descriptor] redimred failed:", e); throw e; }
        },
      });
      // A non-identity fusion produces a SECOND (pre-fusion) embedding, so this
      // dimred card forks into a pre branch + a post branch. The branch cards
      // are pure routers (their jobs are trivial stamps — fusion-branch-runner)
      // and the FIFO queue keeps them behind the dimred job, so we spawn them
      // EAGERLY here — as soon as Apply is hit — rather than waiting for
      // engine.redimred() to resolve. They sit pending under the dimred card
      // while it computes, which lets the user queue clustering on either branch
      // before dim-reduction finishes. The branches are keyed on the fusion
      // param (known up front from the modal config); identity fusion → no fork.
      //
      // Once both branches exist we also auto-spawn a nodeDisplacement card
      // under the dimred (Pass 1d) — it's a property of the fork itself
      // (needs only the two branches' positions, no clustering), so it
      // shouldn't sit behind a manual "+". It needs the resolved dimred result,
      // so it (and the POST selection) waits for the promise to land below.
      const spawnNodeDispIfMissing = (dimredCard) => {
        // The ND card now parents on the POST fusion branch (not the dimred), so
        // detect an existing one by whether its post-branch parent lives under
        // this dimred fork.
        const branchIds = new Set(
          listSteps({ type: "fusionBranch" })
            .filter(b => b.parentId === dimredCard.id)
            .map(b => b.id)
        );
        const existingND = listSteps({ type: "nodeDisplacement" })
          .find(d => branchIds.has(d.parentId));
        if (existingND) return;
        nodeDisplacementDescriptor().applyChange()
          .catch(e => { if (!(e && e.name === "AbortError")) console.error("[dimred-descriptor] auto node-displacement failed:", e); });
      };
      // The dimred card was just created (and selected) by createAndRunStep, or
      // re-armed in place under the gear edit; resolve its id synchronously so
      // we can hang placeholder branches off it now. (Legacy no-tree fallback:
      // createAndRunStep ran engineFn without a step — getSelectedStep won't be
      // a dimred — so the guard below skips the fork, matching old behaviour.)
      const dimredCard = editStepId ? getStep(editStepId) : getSelectedStep();
      const fusionActive = fusion && fusion.method && fusion.method !== "identity";
      if (dimredCard && dimredCard.type === "dimred" && fusionActive) {
        const existing = listSteps({ type: "fusionBranch" })
          .filter(b => b.parentId === dimredCard.id);
        // Re-run path: branches already in place — don't double-spawn. The
        // placeholder/refresh happens via the existing cards (and the dimred
        // job re-running refreshes the result they project on selection).
        if (!existing.length) {
          fusionBranchDescriptor().applyChange({ endpoint: "pre",  parentId: dimredCard.id })
            .catch(() => {});
          fusionBranchDescriptor().applyChange({ endpoint: "post", parentId: dimredCard.id })
            .catch(() => {});
        }
      }
      // When the dimred job lands and fusion really did yield a second
      // embedding, finish the fork: select the POST branch (the fused result)
      // and ensure the cross-branch nodeDisplacement card exists. The branch
      // cards themselves were already spawned eagerly above.
      promise.then(() => {
        const card = listSteps({ type: "dimred" })
          .find(d => dimredCard && d.id === dimredCard.id)
          || listSteps({ type: "dimred" }).slice(-1)[0];
        if (!card || !(card.result && card.result.fusionActive)) return;
        const post = listSteps({ type: "fusionBranch" })
          .find(b => b.parentId === card.id && b.params && b.params.endpoint === "post");
        if (post) selectStep(post.id);
        spawnNodeDispIfMissing(card);
      }).catch(() => { /* dimred failure already logged */ });
      return promise;
    },
    openModal: () => openDimredModal(desc),
  };
  return desc;
}

// Fusion-branch card — the pre/post-fusion fork. When a dim-reduction card
// ran fusion (graph-diffusion → a second pre-fusion embedding), the workflow
// forks into a pre branch + a post branch under it (auto-spawned by the dimred
// descriptor). Each branch is a ROUTER: selecting it (or any descendant)
// projects its endpoint's embedding into the legacy dimredResult/_basePos
// slots (projectFusionBranch), so a clustering card under the branch clusters
// that embedding with the same code. No config modal.
function fusionBranchDescriptor(editStepId = null) {
  const editStep = () => (editStepId ? getStep(editStepId) : null);
  const desc = {
    label: "Fusion branch",
    getActive: () => {
      const es = editStep();
      const parentId = es ? es.parentId : findSelectedAncestorOfType("dimred");
      const dimred = parentId ? getStep(parentId) : null;
      return {
        hasDimred: parentId != null,
        fusionActive: !!(dimred && dimred.result && dimred.result.fusionActive),
        parentId,
      };
    },
    // endpoint ∈ {"pre","post"}; parentId given by the auto-spawn (the dimred
    // card). Falls back to the nearest dimred ancestor if invoked manually.
    applyChange: async ({ endpoint, parentId } = {}) => {
      const ep = endpoint === "pre" ? "pre" : "post";
      const pid = parentId || (editStep() ? editStep().parentId : findSelectedAncestorOfType("dimred"));
      if (!pid) throw new Error("[fusion-branch-descriptor] no dim-reduction ancestor to fork");
      const label = ep === "pre" ? "Pre-fusion" : "Post-fusion";
      const stepId = beginStep({
        editStepId,
        type:   "fusionBranch",
        label,
        params: { endpoint: ep },
        parentId: pid,
      });
      const { promise } = enqueueJob({
        type:  "fusionBranch",
        label,
        stepId,
        fn:    buildFusionBranchJob({ endpoint: ep }),
      });
      promise.catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[fusion-branch-descriptor] job failed:", e);
      });
      return promise;
    },
    openModal: () => {},
  };
  return desc;
}

// Find the pre + post fusion-branch pair under the dimred ancestor of a
// selected step (or the selected branch itself). Returns { dimredId, preId,
// postId } or null when the pair isn't both present.
function resolveBranchPair(fromStepId) {
  const start = fromStepId ? getStep(fromStepId) : getSelectedStep();
  if (!start) return null;
  // The dimred ancestor that owns the fork.
  const anc = getStepAncestors(start.id);
  let dimredId = null;
  for (let i = anc.length - 1; i >= 0; i--) {
    if (anc[i].type === "dimred") { dimredId = anc[i].id; break; }
  }
  if (!dimredId) return null;
  const branches = listSteps({ type: "fusionBranch" }).filter(b => b.parentId === dimredId);
  const pre  = branches.find(b => b.params && b.params.endpoint === "pre");
  const post = branches.find(b => b.params && b.params.endpoint === "post");
  if (!pre || !post) return null;
  return { dimredId, preId: pre.id, postId: post.id };
}

// Node-displacement card — a cross-branch comparison. Branches off BOTH fusion
// branches: it measures how far each node moved between the pre- and post-fusion
// layouts (align + per-node distance), so it has two incoming lineage edges.
// The single-parentId tree model carries only one solid edge, so we parent the
// card on the POST branch (the fused result, also the selected lineage) and
// carry the PRE branch as a ref-edge — workflow-chart promotes both to primary
// (solid) edges for nodeDisplacement (no dimred spine edge). The job reads its
// endpoints from the explicit pre/post branch ids below, not from parentId, so
// re-parenting onto a branch leaves the displacement computation unchanged.
function nodeDisplacementDescriptor(editStepId = null) {
  const editStep = () => (editStepId ? getStep(editStepId) : null);
  // Reconstruct the branch pair from an existing ND step (gear edit): parentId
  // is the post branch, refIds[0] is the pre branch.
  const pairFromStep = (es) =>
    (es && es.parentId && es.refIds && es.refIds.length === 1)
      ? { dimredId: null, preId: es.refIds[0], postId: es.parentId }
      : null;
  const desc = {
    label: "Run: Node displacement (pre → post)",
    getActive: () => {
      const es = editStep();
      const pair = pairFromStep(es) || resolveBranchPair();
      return { hasPair: !!pair, pair };
    },
    applyChange: async () => {
      const es = editStep();
      const pair = pairFromStep(es) || resolveBranchPair();
      if (!pair) {
        throw new Error("[node-displacement] needs both pre + post fusion branches (run a graph-diffusion dim-reduction first)");
      }
      const label = "Node displacement";
      const stepId = beginStep({
        editStepId,
        type:   "nodeDisplacement",
        label,
        // Parent on the post branch; the pre branch rides as a ref-edge that the
        // chart promotes to a second solid incoming edge.
        parentId: pair.postId,
        refIds: [pair.preId],
      });
      selectStep(stepId);
      const { promise } = enqueueJob({
        type:  "nodeDisplacement",
        label,
        stepId,
        fn:    buildNodeDisplacementJob({ preBranchId: pair.preId, postBranchId: pair.postId }),
      });
      promise.catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[node-displacement] job failed:", e);
      });
      return promise;
    },
    openModal: () => desc.applyChange()
      .catch(e => console.error("[node-displacement] applyChange failed:", e)),
  };
  return desc;
}

// Bootstrap defaults bundled into the clustering modal (cards.md Pass 2b).
// Bootstrap is no longer a standalone card; engine.recluster runs it as a
// sidecar when bootstrap.enabled, populating state.bootstrapStability for
// the panel. Single-level only — multi-level (multiLevel sweep + picker)
// has its own per-granularity bootstrap built into the curve.
export const CLUSTERING_BOOTSTRAP_DEFAULTS = {
  enabled:       true,
  B:             10,
  subsampleFrac: 0.5,
  minMembers:    3,             // matches eval/bootstrap.js DEFAULT_MIN_MEMBERS
  noiseHandling: "exclude",     // "exclude" | "asCluster" | "penalise"
};

function clusteringDescriptor(editStepId = null) {
  const desc = {
    label: "Configure: Clustering",
    listAlgos: () => listClusteringAlgos(),
    getActive: () => {
      const editStep = editStepId ? getStep(editStepId) : null;
      const lp = (editStep && editStep.params) || getState().layerParams.clustering;
      return {
        method: lp ? lp.method : "mutualKNN",
        levels: lp ? lp.levels : [
          { uid: "L0", params: getClusteringAlgo("mutualKNN").defaultParams(), scope: "global" },
        ],
        // Bootstrap settings ride alongside in the same params bag. When the
        // card was saved before Pass 2b lp.bootstrap is undefined → defaults.
        bootstrap: (lp && lp.bootstrap) ? { ...CLUSTERING_BOOTSTRAP_DEFAULTS, ...lp.bootstrap }
                                        : { ...CLUSTERING_BOOTSTRAP_DEFAULTS },
      };
    },
    // applyChange(algoId, levels, opts?)
    // opts.precomputedCr — passed through to engine.recluster() so per-row
    //   Apply from the Optimise tab can skip the L0 algo.infer when the
    //   sweep already produced a matching cr (A3, §6.18.3).
    // opts.bootstrap — overrides the active settings (the modal passes the
    //   working bootstrap section); falls back to defaults.
    applyChange: async (algoId, levels, opts = {}) => {
      const bootstrap = opts.bootstrap
        ? { ...CLUSTERING_BOOTSTRAP_DEFAULTS, ...opts.bootstrap }
        : { ...CLUSTERING_BOOTSTRAP_DEFAULTS };
      const clusteringParams = { method: algoId, levels, bootstrap };
      const lvlCount = (levels || []).length;
      const label = lvlCount > 1
        ? `Clustering · ${algoId} · ${lvlCount} levels`
        : `Clustering · ${algoId}`;
      return createAndRunStep({
        type:   "clustering",
        label,
        params: clusteringParams,
        editStepId,
        engineFn: async () => {
          const s = getState();
          update({ layerParams: { ...s.layerParams, clustering: clusteringParams } });
          try {
            await engine.recluster({
              precomputedCr: opts.precomputedCr || null,
              bootstrap,
            });
          }
          catch (e) { console.error("[clustering-descriptor] recluster failed:", e); throw e; }
        },
      });
    },
    openModal: () => openClusteringModal(desc),
  };
  return desc;
}

// Slice 2.6: fork a stale step. Reads the step's stored params,
// dispatches to the matching descriptor's applyChange. Creates a new
// sibling card under the canonical parent (which is now the *fresh*
// upstream — that's the whole point of re-running). Returns the
// descriptor's promise so callers can await completion.
//
// Unknown step types throw — only the layer types we know how to
// re-run get this affordance.
export function rerunStep(stepId) {
  const step = getStep(stepId);
  if (!step) throw new Error(`[rerunStep] unknown stepId "${stepId}"`);
  if (step.type === "dimred") {
    const p = step.params || {};
    return dimredDescriptor().applyChange({
      noise:       p.noise,
      fusion:      p.fusion,
      compression: p.compression,
      viz:         p.viz,
      viz2d:       p.viz2d,
    });
  }
  if (step.type === "clustering") {
    const p = step.params || {};
    return clusteringDescriptor().applyChange(p.method, p.levels || [], {
      bootstrap: p.bootstrap,                  // preserve the card's settings
    });
  }
  if (step.type === "citationLayout") {
    const p = step.params || {};
    return layoutDescriptor().applyChange(p.method, p.params || {});
  }
  // bootstrapStability card type removed in Pass 2b — rerun handled inside
  // clusteringDescriptor (re-running a clustering re-runs its bootstrap
  // sidecar).
  if (step.type === "dimSweep") {
    const p = step.params || {};
    return dimSweepDescriptor().applyChange({
      dims:             p.dims  || DIMSWEEP_DEFAULTS.dims,
      seeds:            p.seeds || DIMSWEEP_DEFAULTS.seeds,
      verdictThreshold: Number.isFinite(p.verdictThreshold) ? p.verdictThreshold : DIMSWEEP_DEFAULTS.verdictThreshold,
    });
  }
  if (step.type === "fusionComparison") {
    const p = step.params || {};
    return fusionComparisonDescriptor().applyChange({
      refStepId:  p.refStepId,
      candStepId: p.candStepId,
    });
  }
  if (step.type === "multiLevel") {
    const p = step.params || {};
    return multiLevelDescriptor().applyChange({
      minSamples: p.minSamples,
      floor:      p.floor,
      B:          p.B,
    });
  }
  if (step.type === "labelling") {
    const p = step.params || {};
    return labellingDescriptor().applyChange({ methods: p.methods || [] });
  }
  if (step.type === "scoring") {
    return scoringDescriptor().applyChange();
  }
  if (step.type === "export") {
    return exportDescriptor().applyChange();
  }
  if (step.type === "crossClusterCitations") {
    return crossClusterDescriptor().applyChange();
  }
  if (step.type === "nodeDisplacement") {
    return nodeDisplacementDescriptor(step.id).applyChange();
  }
  throw new Error(`[rerunStep] type "${step.type}" not re-runnable`);
}

function layoutDescriptor(editStepId = null) {
  const desc = {
    label: "Configure: Citation layout",
    listAlgos: () => listLayoutAlgos(),
    getActive: () => {
      const editStep = editStepId ? getStep(editStepId) : null;
      const lp = (editStep && editStep.params) || getState().layerParams.layout;
      const method = lp ? lp.method : "fruchterman-reingold";
      const params = lp && lp.params ? lp.params : getLayoutAlgo(method).defaultParams();
      return { method, params };
    },
    applyChange: async (algoId, params) => {
      const layoutParams = { method: algoId, params };
      const label = `Citation layout · ${algoId}`;
      return createAndRunStep({
        type:   "citationLayout",
        label,
        params: layoutParams,
        editStepId,
        engineFn: async () => {
          const s = getState();
          update({ layerParams: { ...s.layerParams, layout: layoutParams } });
          try { await engine.relayoutCitations(); }
          catch (e) { console.error("[layout-descriptor] relayoutCitations failed:", e); throw e; }
        },
      });
    },
    openModal: () => openAlgorithmModal(desc),
  };
  return desc;
}

// (bootstrapDescriptor removed in cards.md Pass 2b, 2026-06-03. Bootstrap
// is now a sidecar inside clusteringDescriptor — knobs in the clustering
// modal's Stability section, run by engine.recluster after HDBSCAN
// completes, result on state.bootstrapStability. eval/bootstrap.js +
// bootstrap-runner.js stay callable.)

// Dim-sweep — Phase 2 slice 2.9.b.
//
// Parents under the SELECTED dimred ancestor. Sweep dims / seeds /
// verdictThreshold come from the modal; noise / compression /
// clustering configs default to the validation-script protocol
// (PCA / UMAP / HDBSCAN) — rerun via the chart's ↻ honours whatever
// the step recorded.
function dimSweepDescriptor(editStepId = null) {
  const editStep = () => (editStepId ? getStep(editStepId) : null);
  const resolveParent = () => {
    const es = editStep();
    return es ? es.parentId : findSelectedAncestorOfType("dimred");
  };
  const desc = {
    label: "Run: Dim sweep",
    getActive: () => {
      const parentId = resolveParent();
      const es = editStep();
      const p = (es && es.params) || {};
      const live = getState();
      const hasStage0Input = !!(
        (live.embedding && live.embedding.data) ||
        (live._basePos instanceof Float32Array)
      );
      const n = live.genResult ? live.genResult.nodes.length : 0;
      const d = (live.embedding && live.embedding.d)
                || (live._basePos ? 3 : 0);
      return {
        hasDimred:       parentId != null,
        hasStage0Input,
        n, d,
        summary:         "PCA noise · UMAP compression · HDBSCAN (minClusterSize=15, minSamples=5)",
        // When editing, prefill from the card's recorded sweep params.
        dimsText:        (p.dims  || DIMSWEEP_DEFAULTS.dims).join(", "),
        seedsText:       (p.seeds || DIMSWEEP_DEFAULTS.seeds).join(", "),
        threshold:       Number.isFinite(p.verdictThreshold) ? p.verdictThreshold : DIMSWEEP_DEFAULTS.verdictThreshold,
        parentId,
      };
    },
    // settings: { dims, seeds, verdictThreshold } — algo defaults
    // baked here so the modal stays minimal.
    applyChange: async (settings) => {
      const parentId = resolveParent();
      if (!parentId) {
        throw new Error("[dim-sweep-descriptor] no dimred ancestor to sweep against");
      }
      const fullSettings = {
        dims:             settings.dims,
        seeds:            settings.seeds,
        verdictThreshold: settings.verdictThreshold,
        noise:            settings.noise       || defaultNoiseConfig(),
        compression:      settings.compression || defaultCompressionConfig(),
        clustering:       settings.clustering  || defaultClusteringConfig(),
      };
      const label = `Dim sweep · ${fullSettings.dims.length}d × ${fullSettings.seeds.length}s`;
      const stepId = beginStep({
        editStepId,
        type:   "dimSweep",
        label,
        params: { ...fullSettings },
        parentId,
      });
      selectStep(stepId);
      const { promise } = enqueueJob({
        type:  "dimSweep",
        label,
        stepId,
        fn:    buildDimSweepJob({
          parentDimredStepId: parentId,
          settings: { ...fullSettings },
        }),
      });
      promise.catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[dim-sweep-descriptor] job failed:", e);
      });
      return promise;
    },
    openModal: () => openDimSweepModal(desc),
  };
  return desc;
}

// Fusion / cross-source comparison — Phase 2 slice 2.10.
//
// Compares ANY two clustering cards (a reference + a candidate) of the
// same network, generalising the original pre/post-fusion comparison.
// Both source clusterings are wired as refIds (the DAG fan-in edges,
// §10.D4); the comparison card parents under the SELECTED clustering
// ancestor (analysis-card convention, §10.O2). The viewer shows the
// candidate's geometry via the projection special-case.
function fusionComparisonDescriptor(editStepId = null) {
  const editStep = () => (editStepId ? getStep(editStepId) : null);
  const desc = {
    label: "Run: Compare clusterings",
    getActive: () => {
      const options = listComparableClusterings();
      const es = editStep();
      const ep = (es && es.params) || {};
      const selClust = findSelectedAncestorOfType(CLUSTERING_LIKE_TYPES);
      // When editing, prefill the same pair the card recorded (if still present).
      const defaultRefId  = (ep.refStepId && options.some(o => o.id === ep.refStepId))
        ? ep.refStepId
        : (selClust && options.some(o => o.id === selClust))
          ? selClust
          : (options[0] && options[0].id) || null;
      const defaultCandId = (ep.candStepId && options.some(o => o.id === ep.candStepId) && ep.candStepId !== defaultRefId)
        ? ep.candStepId
        : (options.find(o => o.id !== defaultRefId) || {}).id || null;
      return {
        hasEnough:     options.length >= 2,
        options,
        defaultRefId,
        defaultCandId,
      };
    },
    applyChange: async ({ refStepId, candStepId }) => {
      if (!refStepId || !candStepId) {
        throw new Error("[fusion-comparison-descriptor] both ref and cand cluster cards are required");
      }
      if (refStepId === candStepId) {
        throw new Error("[fusion-comparison-descriptor] ref and cand must be different cards");
      }
      const ref  = getStep(refStepId);
      const cand = getStep(candStepId);
      if (!ref  || !CLUSTERING_LIKE_TYPES.includes(ref.type)) {
        throw new Error("[fusion-comparison-descriptor] ref must be an existing clustering or multi-layer card");
      }
      if (!cand || !CLUSTERING_LIKE_TYPES.includes(cand.type)) {
        throw new Error("[fusion-comparison-descriptor] cand must be an existing clustering or multi-layer card");
      }
      // Parent = the edited card's own parent, or the selected
      // clustering-like ancestor; fall back to the ref card so there's
      // always a valid parent. Both clusterings are refIds, not the parent.
      const es = editStep();
      const parentId = (es && es.parentId)
        || findSelectedAncestorOfType(CLUSTERING_LIKE_TYPES)
        || refStepId;
      const label = `compare · ${ref.label} vs ${cand.label}`;
      const stepId = beginStep({
        editStepId,
        type:   "fusionComparison",
        label,
        params: { refStepId, candStepId },
        parentId,
        refIds: [refStepId, candStepId],
      });
      selectStep(stepId);
      const { promise } = enqueueJob({
        type:  "fusionComparison",
        label,
        stepId,
        fn:    buildFusionComparisonJob({ refStepId, candStepId }),
      });
      promise.catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[fusion-comparison-descriptor] job failed:", e);
      });
      return promise;
    },
    openModal: () => openFusionComparisonModal(desc),
  };
  return desc;
}

// Multi-level ("Optimise multi-layer") clustering — §9 revamp.
//
// Sweeps HDBSCAN resolution, bootstrap-scores each granularity's
// reproducibility, and keeps the most stable partitions at distinct cluster
// counts as a coarse→fine ladder (eval/multilayer-sweep.js). Parents under
// the SELECTED dimred ancestor (the ladder is itself a clustering output).
// Lands clusterLevels[] in the legacy slots so the viewer + bridge/scoring
// panels read it, plus state.multiLevelSweep for the stability-vs-count panel.
function multiLevelDescriptor(editStepId = null) {
  const editStep = () => (editStepId ? getStep(editStepId) : null);
  const resolveParent = () => {
    const es = editStep();
    if (es) return es.parentId;
    // Fork-aware: attach under the selected fusion branch if one is in the
    // lineage (the branch carries the embedding), else the dimred card.
    return findSelectedAncestorOfType("fusionBranch")
        || findSelectedAncestorOfType("dimred");
  };
  const desc = {
    label: "Optimise: Multi-layer clustering",
    getActive: () => {
      const parentId = resolveParent();
      const live = getState();
      const n = live.genResult ? live.genResult.nodes.length : 0;
      const es = editStep();
      const ep = (es && es.params) || {};
      return {
        hasDimred: parentId != null,
        n,
        // When editing, prefill the card's recorded params.
        defaults: {
          // Default minSamples 15 (was 5): probed on biblion n~3109, ms=5
          // over-fragments to 137 leaves; ms~15 gives a cleaner, more
          // reproducible ladder. See doc/multilevel-card-split-plan.md.
          minSamples: Number.isFinite(ep.minSamples) ? ep.minSamples : 15,
          floor:      Number.isFinite(ep.floor)      ? ep.floor      : 0.6,
          B:          Number.isFinite(ep.B)          ? ep.B          : 10,
        },
        parentId,
      };
    },
    applyChange: async ({ minSamples, floor, B }) => {
      const parentId = resolveParent();
      if (!parentId) {
        throw new Error("[multi-level-descriptor] no dimred ancestor to cluster against");
      }
      // leaf, not eom: probed on biblion, eom collapses to ~2 clusters at
      // every resolution; leaf gives a real coarse→fine ladder. Hardcoded
      // for the multi-layer sweep (single-run clustering keeps its eom
      // default). See doc/multilevel-card-split-plan.md.
      const params = { minSamples, selectionMethod: "leaf" };
      const label = "Multi-layer sweep";
      const stepId = beginStep({
        editStepId,
        type:   "multiLevel",
        label,
        params: { minSamples, floor, B },
        parentId,
      });
      selectStep(stepId);
      const { promise } = enqueueJob({
        type:  "multiLevel",
        label,
        stepId,
        // uidPrefix = stepId keeps each card's level uids globally unique
        // (scoring keys scores by levelUid across the whole workflow).
        fn:    buildMultiLevelJob({ params, floor, bootstrapOpts: { B }, uidPrefix: stepId }),
      });
      // When the sweep finishes, auto-spawn a picker card under it (the user
      // clicks granularities on the curve to choose layers). One picker per
      // producer; a re-run (gear edit) reuses the existing picker child.
      promise.then(() => {
        const existing = listSteps({ type: "multiLevelPicker" })
          .find(st => st.parentId === stepId);
        if (existing) { selectStep(existing.id); return; }
        const pickerId = createStep({
          type:   "multiLevelPicker",
          label:  "Pick layers",
          params: {},
          parentId: stepId,
        });
        selectStep(pickerId);
      }).catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[multi-level-descriptor] job failed:", e);
      });
      return promise;
    },
    openModal: () => openMultiLevelModal(desc),
  };
  return desc;
}

// Layer-picker card (picker half of the §9 producer/picker split). Auto-
// spawned under a multi-layer SWEEP card. It has no config modal — its UI is
// the clickable reproducibility curve (the multilayer-picker panel). The
// panel calls applyChange({pickedCounts}) when the user hits Apply; that
// commits the picked granularities into clusterLevels[] (no sweep re-run —
// commitMultiLevelLayers reads the producer's cached candidates).
function multiLevelPickerDescriptor(editStepId = null) {
  const step = () => (editStepId ? getStep(editStepId) : getSelectedStep());
  const desc = {
    label: "Pick layers",
    // The panel reads getActive() to render the curve + current picks.
    getActive: () => {
      const st = step();
      const producer = st && st.parentId ? getStep(st.parentId) : null;
      const sweep = (producer && producer.result && producer.result.multiLevelSweep) || null;
      const prevPicks = (st && st.result && Array.isArray(st.result.pickedCounts))
        ? st.result.pickedCounts : [];
      return {
        stepId:     st ? st.id : null,
        producerId: producer ? producer.id : null,
        sweep,                         // { candidates, curve, uidPrefix, floor }
        curve:      sweep ? sweep.curve : [],
        floor:      sweep ? sweep.floor : 0.6,
        uidPrefix:  (sweep && sweep.uidPrefix) || (producer ? producer.id : "ML"),
        prevPicks,
      };
    },
    // pickedCounts = the cluster counts the user clicked. Enqueues a tiny
    // job that commits them; the picker card's result snapshots the ladder.
    applyChange: async ({ pickedCounts }) => {
      const st = step();
      if (!st) throw new Error("[multi-level-picker] no picker card to apply to");
      const producer = st.parentId ? getStep(st.parentId) : null;
      const sweep = producer && producer.result && producer.result.multiLevelSweep;
      const uidPrefix = (sweep && sweep.uidPrefix) || (producer ? producer.id : "ML");
      const counts = Array.isArray(pickedCounts) ? pickedCounts : [];
      const label = `Layers · ${counts.length} picked`;
      const stepId = beginStep({
        editStepId: st.id,
        type:   "multiLevelPicker",
        label,
        params: { pickedCounts: counts },
      });
      selectStep(stepId);
      const { promise } = enqueueJob({
        type:  "multiLevelPicker",
        label,
        stepId,
        fn:    buildMultiLevelPickerJob({ pickedCounts: counts, uidPrefix }),
      });
      // Once the ladder is committed, auto-spawn the cross-cluster citations
      // card. Mirrors how the sweep auto-spawns this picker; re-pick reuses
      // the existing card. Bridge analysis is no longer a card type
      // (cards.md Pass 2a) — bridges are computed inside the picker's
      // commit job and surfaced on state.bridgeAnalysis for the panel.
      promise.then(() => {
        const picker = step();
        if (!picker) return;

        // Cross-cluster citations — no params; needs the committed ladder.
        // Gated on citation edges existing in live state: toy data without
        // synthetic citations has none, and the runner would fail. Real-data
        // sources (biblion) ship edges at ingest, so the auto-spawn fires
        // there. Users can still manually add the card on toy data once
        // they've generated citations.
        const edges = getState().rawCitationEdges;
        const hasEdges = Array.isArray(edges) && edges.length > 0;
        if (hasEdges) {
          const existingXcc = listSteps({ type: "crossClusterCitations" })
            .find(b => b.parentId === picker.id);
          if (!existingXcc) {
            crossClusterDescriptor().applyChange()
              .catch(e => { if (!(e && e.name === "AbortError")) console.error("[multi-level-picker] auto cross-cluster failed:", e); });
          }
        }
      }).catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[multi-level-picker] commit failed:", e);
      });
      return promise;
    },
    // No config modal — the picker's UI is the clickable curve panel. The
    // "Pick layers" next-step action routes here; resolve to the picker card
    // (the selected one, or the one under the selected producer) and select
    // it so its panel comes forward. If the producer's picker was deleted,
    // recreate it.
    openModal: () => {
      const sel = getSelectedStep();
      if (sel && sel.type === "multiLevelPicker") { selectStep(sel.id); return; }
      // Selected a producer (or a descendant): find/create its picker.
      let producer = sel;
      while (producer && producer.type !== "multiLevel") {
        producer = producer.parentId ? getStep(producer.parentId) : null;
      }
      if (!producer) return;
      const existing = listSteps({ type: "multiLevelPicker" })
        .find(st => st.parentId === producer.id);
      if (existing) { selectStep(existing.id); return; }
      const pickerId = createStep({
        type: "multiLevelPicker", label: "Pick layers", params: {}, parentId: producer.id,
      });
      selectStep(pickerId);
    },
  };
  return desc;
}

// (bridgeAnalysis card type removed in cards.md Pass 2a, 2026-06-02. The
// algorithm + runner remain; the picker's commit job populates
// state.bridgeAnalysis directly, and the singleton bridge-analysis panel
// reads it from there as before.)

// Cluster labelling (MLC §7) — the "analysis layer" that names clusters so
// a human can score them. Attaches under a clustering-like card and labels
// EVERY level of its ladder by the chosen methods, storing the result in
// the card branch. Static: re-run (red dot) when the upstream clustering
// changes. A downstream scoring card consumes these labels.
function labellingDescriptor(editStepId = null) {
  const editStep = () => (editStepId ? getStep(editStepId) : null);
  // Attach under the SELECTED card when it has a clustering ladder reachable;
  // otherwise fall back to the nearest clustering-like ancestor. preferCross-
  // ClusterChild bumps the attach point down to the auto-spawned crossCluster
  // card when one exists, so labelling becomes a child of crossCluster and
  // can read its citation-flow data via projection.
  const resolveParent = () => {
    const es = editStep();
    if (es) return es.parentId;
    const sel = getSelectedStep();
    if (sel && findClusterLevels(sel.id).levels.length) {
      return preferCrossClusterChild(sel.id);
    }
    return preferCrossClusterChild(findSelectedAncestorOfType(CLUSTERING_LIKE_TYPES));
  };
  const desc = {
    label: "Run: Cluster labelling",
    getActive: () => {
      const parentId = resolveParent();
      if (!parentId) return { hasClustering: false, nLevels: 0, methods: [], selected: [] };
      // Levels come from the nearest clustering ancestor (may be above the
      // direct parent if a bridge card sits between).
      const levels = findClusterLevels(parentId).levels;
      const nLevels = levels.length || 0;
      // Availability is data-dependent — probe with the same ctx the runner
      // will use (embedding + node table from live state).
      const s = getState();
      const probeCtx = {
        embedding: s.embedding || (s._basePos ? { d: 3, data: s._basePos } : null),
        nodes:     (s.genResult && s.genResult.nodes) || [],
        getText:   hasSqliteText() ? getNodeText : undefined,
      };
      const methods = listLabelMethods(probeCtx);
      const es = editStep();
      const prev = es && es.params && Array.isArray(es.params.methods) ? es.params.methods : null;
      // Default selection: the card's prior pick (edit) or every available method.
      const selected = (prev || methods.filter(m => m.available).map(m => m.id))
        .filter(id => methods.some(m => m.id === id && m.available));
      return { hasClustering: true, nLevels, methods, selected, parentId };
    },
    applyChange: async ({ methods }) => {
      const parentId = resolveParent();
      if (!parentId) {
        throw new Error("[labelling-descriptor] no clustering ancestor to label");
      }
      const params = { methods: [...methods] };
      const label = `Labels · ${methods.length} method${methods.length === 1 ? "" : "s"}`;
      const stepId = beginStep({
        editStepId,
        type:   "labelling",
        label,
        params,
        parentId,
      });
      selectStep(stepId);
      const { promise } = enqueueJob({
        type:  "labelling",
        label,
        stepId,
        fn:    buildLabellingJob({ parentStepId: parentId, methods }),
      });
      promise.catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[labelling-descriptor] job failed:", e);
      });
      return promise;
    },
    openModal: () => openLabellingModal(desc),
  };
  return desc;
}

// Scoring card (MLC §5) — sits downstream of a labelling card and preps the
// data the scoring panel works through (level ladder + labels + an empty
// per-card scores map; the 1–5 scores live on this card). Unlike the other
// cards it has NO config modal: picking it from the "+" just preps and
// selects the card. The interactive scoring happens in the `scoring` PANEL
// (opened from the panel "+" picker), which binds to the selected card.
function scoringDescriptor(editStepId = null) {
  const editStep = () => (editStepId ? getStep(editStepId) : null);
  const resolveParent = () => {
    const es = editStep();
    return es ? es.parentId : findSelectedAncestorOfType("labelling");
  };
  const desc = {
    label: "Prepare: Scoring",
    getActive: () => {
      const parentId = resolveParent();
      return { hasLabelling: parentId != null, parentId };
    },
    applyChange: async () => {
      const parentId = resolveParent();
      if (!parentId) {
        throw new Error("[scoring-descriptor] no labelling ancestor — add a labelling card first");
      }
      const label = "Scoring";
      const stepId = beginStep({
        editStepId,
        type:   "scoring",
        label,
        params: {},
        parentId,
      });
      selectStep(stepId);
      const { promise } = enqueueJob({
        type:  "scoring",
        label,
        stepId,
        fn:    buildScoringPrepJob({ parentLabellingStepId: parentId }),
      });
      promise.catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[scoring-descriptor] prep failed:", e);
      });
      return promise;
    },
    // No config modal — picking the card preps it directly.
    openModal: () => desc.applyChange()
      .catch(e => console.error("[scoring-descriptor] applyChange failed:", e)),
  };
  return desc;
}

// Export card (RIS) — sits downstream of a scoring card. Like scoring it has
// NO config modal: picking it just preps + selects the card; the interactive
// picking (level / score threshold / single cluster) + Download RIS live in
// the `export-ris` PANEL, which binds to the selected card and reads the
// scored clustering above it.
function exportDescriptor(editStepId = null) {
  const editStep = () => (editStepId ? getStep(editStepId) : null);
  const resolveParent = () => {
    const es = editStep();
    if (es) return es.parentId;
    // Prefer a scoring card (export by score); fall back to any clustering-
    // like card (export a single cluster without scores). The clustering-
    // fallback path bumps through any auto-spawned crossCluster card so the
    // export sees its citation-flow data via projection.
    const sel = getSelectedStep();
    if (sel) {
      if (sel.type === "scoring")                     return sel.id;
      if (findClusterLevels(sel.id).levels.length)    return preferCrossClusterChild(sel.id);
    }
    return findSelectedAncestorOfType("scoring")
        || preferCrossClusterChild(findSelectedAncestorOfType(CLUSTERING_LIKE_TYPES));
  };
  const desc = {
    label: "Prepare: Export (RIS)",
    getActive: () => {
      const parentId = resolveParent();
      return { hasUpstream: parentId != null, parentId };
    },
    applyChange: async () => {
      const parentId = resolveParent();
      if (!parentId) {
        throw new Error("[export-descriptor] no scoring/clustering ancestor to export from");
      }
      const label = "Export (RIS)";
      const stepId = beginStep({
        editStepId,
        type:   "export",
        label,
        params: {},
        parentId,
      });
      selectStep(stepId);
      const { promise } = enqueueJob({
        type:  "export",
        label,
        stepId,
        fn:    buildExportPrepJob(),
      });
      promise.catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[export-descriptor] prep failed:", e);
      });
      return promise;
    },
    openModal: () => desc.applyChange()
      .catch(e => console.error("[export-descriptor] applyChange failed:", e)),
  };
  return desc;
}

// Cross-cluster citation degree card — an "analysis layer" attaching under a
// clustering-like card (the picker). Computes, for every layer, how much each
// cluster cites every other (directed flow matrix + in/out degree + top
// links). No config modal — it always runs all layers; picking it preps +
// selects the card, and the cross-cluster panel renders the result.
function crossClusterDescriptor(editStepId = null) {
  const editStep = () => (editStepId ? getStep(editStepId) : null);
  const resolveParent = () => {
    const es = editStep();
    return es ? es.parentId : findSelectedAncestorOfType(CLUSTERING_LIKE_TYPES);
  };
  const desc = {
    label: "Run: Cross-cluster citations",
    getActive: () => {
      const parentId = resolveParent();
      if (!parentId) return { hasClustering: false, nLevels: 0 };
      const levels = findClusterLevels(parentId).levels;
      const hasEdges = Array.isArray(getState().rawCitationEdges) && getState().rawCitationEdges.length > 0;
      return { hasClustering: true, nLevels: levels.length, hasEdges, parentId };
    },
    applyChange: async () => {
      const parentId = resolveParent();
      if (!parentId) {
        throw new Error("[cross-cluster-descriptor] no clustering ancestor to analyse");
      }
      const label = "Cross-cluster citations";
      const stepId = beginStep({
        editStepId,
        type:   "crossClusterCitations",
        label,
        params: {},
        parentId,
      });
      selectStep(stepId);
      const { promise } = enqueueJob({
        type:  "crossClusterCitations",
        label,
        stepId,
        fn:    buildCrossClusterJob({ parentStepId: parentId }),
      });
      promise.catch((e) => {
        if (e && e.name === "AbortError") return;
        console.error("[cross-cluster-descriptor] job failed:", e);
      });
      return promise;
    },
    openModal: () => desc.applyChange()
      .catch(e => console.error("[cross-cluster-descriptor] applyChange failed:", e)),
  };
  return desc;
}
