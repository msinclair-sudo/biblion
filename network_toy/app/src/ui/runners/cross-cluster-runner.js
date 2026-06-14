// Cross-cluster citation runner — an "analysis layer" card.
//
// Reads the clustering ladder from the nearest clustering ancestor of its
// attach parent, and the citation edges from live state (rawCitationEdges,
// populated at ingest for sources that carry edges — biblion does). Computes
// the per-layer cross-cluster citation flow (computeCrossClusterAllLayers) and
// returns it for the panel. Edges-only, cheap (O(|E|) per layer) — no worker.
//
// Fails fast when there are no citation edges (toy data without imported
// citations) so the card shows a clear message instead of an empty matrix.

import { getState } from "../state.js";
import { getStep, findClusterLevels } from "../workflow.js";
import { computeCrossClusterAllLayers } from "../cross-cluster-citations.js";

/**
 * @param {object} opts
 * @param {string} opts.parentStepId   Clustering-like card id (levels walk up).
 * @returns {(ctx:{signal,setPhase,setProgress}) => Promise<object>}
 */
export function buildCrossClusterJob({ parentStepId }) {
  return async function runCrossClusterJob(ctx) {
    const parent = getStep(parentStepId);
    if (!parent) {
      throw new Error(`[cross-cluster-runner] parent step "${parentStepId}" no longer exists`);
    }
    const levels = findClusterLevels(parentStepId).levels;
    if (levels.length === 0) {
      throw new Error("[cross-cluster-runner] no clustering levels found above this card");
    }
    const edges = getState().rawCitationEdges;
    if (!Array.isArray(edges) || edges.length === 0) {
      throw new Error(
        "Cross-cluster citation degree needs citation edges — load a dataset " +
        "with citations (e.g. the biblion corpus); the toy has none unless " +
        "synthetic citations were generated.");
    }

    ctx.setPhase    && ctx.setPhase("mapping edges to clusters");
    ctx.setProgress && ctx.setProgress(0.3);
    const result = computeCrossClusterAllLayers(levels, edges);
    ctx.setProgress && ctx.setProgress(1);

    return {
      capturedAt:        new Date().toISOString(),
      crossClusterCitations: result,         // { nLevels, totalEdges, byLayer }
      nLevels:           result ? result.nLevels : 0,
      totalEdges:        result ? result.totalEdges : 0,
    };
  };
}
