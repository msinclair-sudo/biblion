// Bridge-analysis runner — first of the "analysis layer" cards.
//
// Bridges are a PER-LAYER relationship (§9): for every committed layer i ≥ 1,
// each cluster in layer i is checked against the clusters in the layer
// immediately above it (i − 1). This runner computes that across ALL layers
// in one pass (computeBridgeAnalysisAllLayers), rather than a single
// fine→coarse pair. It positions the bridge step in the pipeline
// (picker → bridge → labelling → scoring).
//
// Like the other analysis runners it:
//   - reads its clustering from the parent card's snapshot (immutable per
//     §10.D1), NOT from live state;
//   - returns a result the bridge-analysis panel renders. For the viewer's
//     `bridge` / `boundaryScore` colour modes (which paint per-node arrays at
//     a single comparison level) we also surface the FINEST layer's pair view
//     as `bridgeAnalysis`, so projection into state.bridgeAnalysis keeps the
//     viewer working; the all-layers breakdown rides alongside as `byLayer`.
//
// The derivation is cheap (O(n) per layer) — no worker. A parent with <2
// levels has no layer to compare, so we fail fast with a clear message.

import { getStep }                          from "../workflow.js";
import { computeBridgeAnalysis,
         computeBridgeAnalysisAllLayers }   from "../bridge-analysis.js";

/**
 * @param {object} opts
 * @param {string} opts.parentStepId   Clustering-like card id (the picker).
 * @returns {(ctx:{signal,setPhase,setProgress}) => Promise<object>}
 */
export function buildBridgeAnalysisJob({ parentStepId }) {
  return async function runBridgeAnalysisJob(ctx) {
    const parent = getStep(parentStepId);
    if (!parent) {
      throw new Error(`[bridge-analysis-runner] parent step "${parentStepId}" no longer exists`);
    }
    const snap   = parent.result || {};
    const levels = snap.clusterLevels || [];
    if (levels.length < 2) {
      throw new Error(
        "Bridge analysis needs at least two clustering levels — run it on a " +
        "multi-layer ladder, not a single partition.");
    }

    ctx.setPhase    && ctx.setPhase("per-layer parent shares");
    ctx.setProgress && ctx.setProgress(0.2);

    // All layers (i ≥ 1 vs i − 1).
    const allLayers = computeBridgeAnalysisAllLayers(levels);
    // Finest-layer pair view for the viewer's per-node colour modes +
    // state.bridgeAnalysis projection (back-compat with the singleton panel).
    const finest = computeBridgeAnalysis(levels, {
      fineLevel:   levels.length - 1,
      coarseLevel: levels.length - 2,
    });
    ctx.setProgress && ctx.setProgress(1);

    return {
      capturedAt:        new Date().toISOString(),
      bridgeAnalysis:    finest,        // single-pair view (viewer / legacy panel)
      bridgeAllLayers:   allLayers,     // { nLevels, byLayer:[…], totalBridges }
      params:            { fineLevel: finest.fineLevel, coarseLevel: finest.coarseLevel },
      nBridges:          allLayers.totalBridges,
      nLevels:           levels.length,
    };
  };
}
