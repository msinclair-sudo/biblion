// Bootstrap-stability runner — Phase 2 slice 2.9.a.
//
// Wraps the eval/bootstrap.js engine in a queue-job-shaped function
// and ties it back to the workflow tree:
//   - reads its ref-clustering from the upstream clustering card's
//     snapshot (immutable per §10.D1), NOT from live state — so re-
//     selecting another card mid-flight can't pull the rug out;
//   - forwards onProgress + abortSignal through queue.js's ctx;
//   - returns a result shape matching the saved validationRun the
//     bootstrap-stability panel renders, so saved-mode rendering
//     stays a one-line change.
//
// The descriptor (layer-descriptors.js) creates the step + parents
// it under the clustering card, then enqueues a job whose fn is
// runBootstrapJob(...) with the parent's snapshot baked in.

import { getState, saveValidationRun } from "../state.js";
import { getStep }                     from "../workflow.js";
import { bootstrapStability, SCORE_VERSION } from "../../eval/bootstrap.js";
import { getAlgorithm as getClusteringAlgo } from "../../clustering-registry.js";

/**
 * Build a queue-job fn that runs a bootstrap against the given parent
 * clustering card's snapshot. The fn closes over the parent step id so
 * its inputs are stable regardless of state mutations later.
 *
 * @param {object} opts
 * @param {string} opts.parentClusteringStepId  Step id of the clustering card.
 * @param {object} opts.settings                {B, subsampleFrac, minMembers, noiseHandling}
 * @returns {(ctx: {signal, setPhase, setProgress}) => Promise<object>}
 */
export function buildBootstrapJob({ parentClusteringStepId, settings }) {
  return async function runBootstrapJob(ctx) {
    const parent = getStep(parentClusteringStepId);
    if (!parent) {
      throw new Error(`[bootstrap-runner] parent clustering step "${parentClusteringStepId}" no longer exists`);
    }
    // Pull the ref clustering from the parent card's snapshot. Falls
    // back to live state if the snapshot is missing (legacy migrated
    // cards from before slice 2.7 won't have a snapshot — best-effort).
    const snap = parent.result || {};
    const refLevels = snap.clusterLevels || getState().clusterLevels || [];
    if (refLevels.length === 0) {
      throw new Error("[bootstrap-runner] parent clustering has no levels");
    }
    const refCr = refLevels[0].clusterResult;
    if (!refCr) throw new Error("[bootstrap-runner] parent clustering level 0 has no clusterResult");

    // Algorithm + per-level params come from the parent's recorded
    // params (the clustering card stores {method, levels}); resolving
    // from live state would tie us to the currently-selected card.
    //
    // A multi-layer card runs HDBSCAN but stores {minSamples,
    // minClusterSize, capLayers} rather than {method, levels} — so map it
    // onto the hdbscan algo with those params for the resampled re-clusters.
    const parentParams = parent.params || {};
    let algoId, levelParams;
    if (parent.type === "multiLevel") {
      algoId = "hdbscan";
      levelParams = {
        ...getClusteringAlgo("hdbscan").defaultParams(),
        minSamples:     parentParams.minSamples,
        minClusterSize: parentParams.minClusterSize,
      };
    } else {
      algoId      = parentParams.method;
      levelParams = (parentParams.levels || [])[0] && (parentParams.levels || [])[0].params;
    }
    const algo = getClusteringAlgo(algoId);

    // genResult + dimredResult are not held on the clustering card
    // (they're upstream); use live state. Bootstrap is deterministic in
    // (refCr + dimredResult + algo), so this is correct as long as the
    // user hasn't switched data sources mid-run — which clears the
    // workflow anyway.
    const live = getState();

    const t0 = performance.now();
    ctx.setPhase && ctx.setPhase(`0 / ${settings.B}`);

    let result;
    try {
      result = await bootstrapStability({
        refClusterResult: refCr,
        genResult:        live.genResult,
        dimredResult:     live.dimredResult,
        algo,
        params:           levelParams,
        B:                settings.B,
        subsampleFrac:    settings.subsampleFrac,
        minMembers:       settings.minMembers,
        noiseHandling:    settings.noiseHandling,
        seed:             12345,
        onProgress:       (it, total) => {
          ctx.setPhase   && ctx.setPhase(`${it} / ${total}`);
          ctx.setProgress && ctx.setProgress(total > 0 ? it / total : 0);
        },
        abortSignal:      ctx.signal,
      });
    } catch (e) {
      // Re-throw — queue.js distinguishes AbortError + records it.
      throw e;
    }
    const runtimeSec = (performance.now() - t0) / 1000;

    // Build the saved-validation-run shape so the panel (saved-mode)
    // renders directly off card.result without translation. Auto-save
    // to validationRuns preserves the existing pre-slice-2.9 entry
    // points (panel picker; back-compat lookups) until 2.11 retires
    // validationRuns in favour of cards.
    const algoTag  = algoId;
    const ds       = live.dataSource;
    const mode     = (ds && ds.mode) || "toy";
    const cfg      = (ds && ds.configs && ds.configs[mode]) || {};
    const subsetTag = mode === "real"
      ? (cfg.subset || "real")
      : `toy n=${live.genResult ? live.genResult.nodes.length : "?"}`;
    const label    = `bootstrap ${algoTag} · ${subsetTag} · B=${settings.B}`;
    const cluster  = {
      label:     describeCluster(refCr, algoId),
      nClusters: refCr.clusters ? refCr.clusters.length : 0,
    };

    const cardResult = {
      capturedAt:      new Date().toISOString(),
      bootstrapResult: result,
      aggregate:       result.aggregate,
      cluster,
      settings:        { ...settings },
      runtimeSec,
      ranAt:           new Date().toISOString(),
      label,
      scoreVersion:    SCORE_VERSION,
    };

    // Best-effort auto-save to validationRuns. The card is the canonical
    // store (§10.D1); validationRuns is the transitional duplicate.
    try {
      const savedId = saveValidationRun({
        type: "bootstrapStability",
        label,
        inputs: {
          dataSourceId:        mode,
          dataSourceConfig:    cfg,
          layerParamsSnapshot: live.layerParams,
          parentStepId:        parentClusteringStepId,
        },
        settings: { ...settings },
        results: {
          bootstrapResult: result,
          aggregate:       result.aggregate,
          cluster,
        },
        scoreVersion: SCORE_VERSION,
        runtimeSec,
      });
      cardResult.validationRunId = savedId;
    } catch (e) {
      console.warn("[bootstrap-runner] saveValidationRun failed (continuing):", e);
    }

    return cardResult;
  };
}

function describeCluster(refCr, algoId) {
  try {
    const a = getClusteringAlgo(algoId);
    return a && a.label ? a.label : algoId;
  } catch (_) {
    return algoId || "(unknown)";
  }
}
