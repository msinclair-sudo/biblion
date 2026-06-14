// Layer-picker Apply runner — the picker half of the §9 producer/picker
// split (2026-06-01).
//
// The producer card (multi-level sweep) leaves state.multiLevelSweep =
// { candidates, curve, … } with every candidate's clusterResult retained.
// The picker card's panel lets the user click granularities on the
// reproducibility curve; its Apply enqueues THIS job, which commits the
// picked cluster counts into the live clusterLevels[] ladder (no sweep
// re-run — commitMultiLevelLayers reads the cached candidates) and snapshots
// the committed ladder into the picker card's result so re-selecting it
// re-projects the same layers.

import { getState } from "../state.js";
import * as engine  from "../engine.js";

/**
 * @param {object} opts
 * @param {number[]} opts.pickedCounts   cluster counts the user clicked.
 * @param {string}   opts.uidPrefix      level-uid prefix (the producer's stepId).
 * @returns {(ctx) => Promise<object>}
 */
export function buildMultiLevelPickerJob({ pickedCounts, uidPrefix }) {
  return async function runMultiLevelPickerJob(ctx) {
    ctx.setPhase    && ctx.setPhase("committing layers");
    ctx.setProgress && ctx.setProgress(0.3);

    const { levels } = engine.commitMultiLevelLayers(pickedCounts, { uidPrefix });
    if (!levels || levels.length === 0) {
      throw new Error("No layers picked — click at least one point on the curve before applying.");
    }
    ctx.setProgress && ctx.setProgress(1);

    const s = getState();
    return {
      capturedAt:     new Date().toISOString(),
      clusterLevels:  s.clusterLevels,
      clusterResult:  s.clusterResult,
      bridgeAnalysis: s.bridgeAnalysis,
      pickedCounts:   [...pickedCounts].sort((a, b) => a - b),
      nLevels:        levels.length,
    };
  };
}
