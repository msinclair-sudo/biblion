// Scoring-card prep runner (MLC §5).
//
// The scoring card sits downstream of a labelling card. "Preparing the
// data" = snapshotting what the scoring panel needs to work through:
//   - the level ladder (uid + cluster count per level), from the
//     clustering-like card the labelling card hangs off;
//   - the labels per level, from the labelling card's result;
//   - an (initially empty) scores map that LIVES ON THIS CARD — the
//     1–5 scores move into the scoring card and travel with its branch
//     (per the agreed data model), rather than the global keyed store.
//
// Static like the other analysis cards: if the upstream labelling /
// clustering changes, the card goes stale (red dot) and is re-prepped.
// The actual scoring UI is a separate panel (panels/scoring.js); this
// runner only assembles the inputs.

import { getStep, findClusterLevels } from "../workflow.js";

/**
 * @param {object} opts
 * @param {string} opts.parentLabellingStepId  Labelling card id.
 * @returns {(ctx:{signal,setPhase,setProgress}) => Promise<object>}
 */
export function buildScoringPrepJob({ parentLabellingStepId }) {
  return async function runScoringPrepJob(ctx) {
    const labelling = getStep(parentLabellingStepId);
    if (!labelling) {
      throw new Error(`[scoring-runner] parent labelling step "${parentLabellingStepId}" no longer exists`);
    }
    const labelsByLevel = (labelling.result && labelling.result.byLevel) || {};

    // Level ladder = nearest clustering ancestor above the labelling card
    // (a bridge card may sit between labelling and the picker).
    const levels = findClusterLevels(parentLabellingStepId).levels;

    ctx.setPhase && ctx.setPhase("preparing levels");
    const levelSummary = levels.map(l => ({
      uid:       l.uid,
      nClusters: (l.clusterResult && l.clusterResult.clusters.length) || 0,
      nLabelled: (labelsByLevel[l.uid] && labelsByLevel[l.uid].perCluster.length) || 0,
    }));
    ctx.setProgress && ctx.setProgress(1);

    return {
      capturedAt:        new Date().toISOString(),
      levelSummary,                       // [{uid, nClusters, nLabelled}]
      labelsByLevel,                      // { [levelUid]: { methods, perCluster } }
      labelMethods:      (labelling.result && labelling.result.methods) || [],
      // 1–5 scores live HERE, keyed by level uid → cluster id. Empty until
      // the scoring panel writes them (panel design pending).
      scores:            {},
      nLevels:           levels.length,
    };
  };
}
