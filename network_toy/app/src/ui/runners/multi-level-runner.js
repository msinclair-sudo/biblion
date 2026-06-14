// Multi-layer SWEEP runner — the producer half of the §9 producer/picker
// split (2026-06-01).
//
// Wraps engine.recomputeMultiLevelSweep, which:
//   Phase 1 (worker)  builds ONE HDBSCAN model + plateau candidates;
//   Phase 2 (main)    bootstrap-scores EVERY candidate (reproducibility).
//
// It does NOT select layers and does NOT build clusterLevels — selection is
// a manual click on the reproducibility curve in the picker card (which
// auto-spawns after this job; see multiLevelDescriptor). The lane writes
// state.multiLevelSweep = { candidates, curve, … }; we snapshot that into the
// card result so projection can replay it when the card is re-selected.

import { getState } from "../state.js";
import * as engine  from "../engine.js";

const SCORE_VERSION = 3;   // bumped: produce-only sweep, manual layer pick

/**
 * @param {object} opts
 * @param {{minSamples:number, selectionMethod:string}} opts.params  shared HDBSCAN params (leaf).
 * @param {number} [opts.floor=0.6]          reproducibility guide line on the curve.
 * @param {number} [opts.sizeGridCount=25]   Phase-1 grid resolution.
 * @param {object} [opts.bootstrapOpts]      { B, subsampleFrac }.
 * @param {string} opts.uidPrefix            unique per-card prefix for level uids.
 * @returns {(ctx:{signal,setPhase,setProgress}) => Promise<object>}
 */
export function buildMultiLevelJob({ params, floor, sizeGridCount, bootstrapOpts, uidPrefix }) {
  return async function runMultiLevelSweepJob(ctx) {
    ctx.setPhase    && ctx.setPhase("scanning resolutions");
    ctx.setProgress && ctx.setProgress(0.05);

    const out = await engine.recomputeMultiLevelSweep({
      params, floor, sizeGridCount,
      bootstrapOpts: bootstrapOpts || {},
      uidPrefix,
      abortSignal: ctx.signal,
      onProgress: (phase, idx, total) => {
        if (!total) return;
        // Phase 1 (worker) is opaque to us; Phase 2 is the bootstrap loop.
        if (phase === "phase2") {
          ctx.setPhase    && ctx.setPhase(`bootstrapping candidate ${idx} / ${total}`);
          ctx.setProgress && ctx.setProgress(0.2 + 0.75 * (idx / total));
        }
      },
    });

    if (!out.candidates || out.candidates.length === 0) {
      throw new Error(
        "No clusterable granularities found — try a different dim-reduction " +
        "or a smaller min-samples.");
    }
    ctx.setProgress && ctx.setProgress(1);

    const s = getState();
    return {
      capturedAt:      new Date().toISOString(),
      multiLevelSweep: s.multiLevelSweep,        // { candidates, curve, uidPrefix, floor }
      settings:        { ...params, floor },
      nCandidates:     out.candidates.length,
      scoreVersion:    SCORE_VERSION,
    };
  };
}
