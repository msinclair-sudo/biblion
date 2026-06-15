// Fusion / cross-source comparison runner — Phase 2 slice 2.10.
//
// Compares two clustering cards (a reference + a candidate) of the same
// network and produces a per-level FusionCompareResult. Generalises the
// original pre/post-fusion comparison (§6.19 step 8) to ANY two cluster
// cards — the comparison maths (eval/fusion-compare.js) is already
// source-agnostic.
//
// Like the bootstrap / dim-sweep runners:
//   - reads both clusterings from the upstream cards' snapshots
//     (immutable per §10.D1), NOT live state, so re-selecting a card
//     mid-flight can't pull the rug out;
//   - forwards onProgress + abortSignal through queue.js's ctx;
//   - returns a result the fusion-comparison panel renders directly in
//     saved mode (result.comparison.perLevel), and auto-saves a
//     matching validationRun for the panel picker / back-compat.
//
// The descriptor (layer-descriptors.js) creates the step, parents it
// under the selected card, wires the two source cards as refIds, then
// enqueues a job whose fn is runFusionComparisonJob(...).

import { getState, saveValidationRun } from "../state.js";
import { getStep }                     from "../workflow.js";
import { compareFusionPartitions }     from "../../eval/fusion-compare.js";

const TOP_MOVERS_N = 25;
const SCORE_VERSION = 1;

/**
 * Build a queue-job fn that compares two clustering cards.
 *
 * @param {object} opts
 * @param {string} opts.refStepId   Step id of the reference clustering card.
 * @param {string} opts.candStepId  Step id of the candidate clustering card.
 * @returns {(ctx: {signal, setPhase, setProgress}) => Promise<object>}
 */
export function buildFusionComparisonJob({ refStepId, candStepId }) {
  return async function runFusionComparisonJob(ctx) {
    const ref  = getStep(refStepId);
    const cand = getStep(candStepId);
    if (!ref)  throw new Error(`[fusion-comparison-runner] ref clustering step "${refStepId}" no longer exists`);
    if (!cand) throw new Error(`[fusion-comparison-runner] candidate clustering step "${candStepId}" no longer exists`);

    const refLevels  = (ref.result  && ref.result.clusterLevels)  || [];
    const candLevels = (cand.result && cand.result.clusterLevels) || [];
    if (refLevels.length === 0 || candLevels.length === 0) {
      throw new Error("[fusion-comparison-runner] both clusterings must have at least one level");
    }
    const nLevels = Math.min(refLevels.length, candLevels.length);

    const t0 = performance.now();
    const perLevel = [];
    for (let lvl = 0; lvl < nLevels; lvl++) {
      if (ctx.signal && ctx.signal.aborted) throw abortError();
      ctx.setPhase    && ctx.setPhase(`L${lvl + 1} / ${nLevels}`);
      ctx.setProgress && ctx.setProgress(nLevels > 0 ? lvl / nLevels : 0);

      const refCr  = refLevels[lvl].clusterResult;
      const candCr = candLevels[lvl].clusterResult;
      if (!refCr || !candCr) {
        throw new Error(`[fusion-comparison-runner] missing clusterResult at L${lvl}`);
      }
      if (refCr.nodeCluster.length !== candCr.nodeCluster.length) {
        throw new Error(
          `[fusion-comparison-runner] partition length mismatch at L${lvl} ` +
          `(${refCr.nodeCluster.length} vs ${candCr.nodeCluster.length}) — the two ` +
          `clusterings must be over the same node set (same data root)`);
      }
      perLevel.push(compareFusionPartitions(refCr, candCr, { topMoversN: TOP_MOVERS_N }));
    }
    const runtimeSec = (performance.now() - t0) / 1000;
    ctx.setProgress && ctx.setProgress(1);

    const refLabel  = ref.label  || "ref";
    const candLabel = cand.label || "cand";
    const label = `compare · ${refLabel} vs ${candLabel}`;
    const comparison = { perLevel, nLevels };

    const cardResult = {
      capturedAt:  new Date().toISOString(),
      comparison,
      refLabel, candLabel,
      refStepId, candStepId,
      settings:    { topMoversN: TOP_MOVERS_N },
      runtimeSec,
      ranAt:       new Date().toISOString(),
      label,
      scoreVersion: SCORE_VERSION,
    };

    // Best-effort auto-save to validationRuns. The card is the canonical
    // store (§10.D1); validationRuns is the transitional duplicate that
    // feeds the panel picker + legacy lookups.
    try {
      const live = getState();
      const ds   = live.dataSource;
      const mode = (ds && ds.mode) || "sqlite";
      const cfg  = (ds && ds.configs && ds.configs[mode]) || {};
      const savedId = saveValidationRun({
        type: "fusionComparison",
        label,
        inputs: {
          dataSourceId:     mode,
          dataSourceConfig: cfg,
          refStepId, candStepId,
        },
        settings: { topMoversN: TOP_MOVERS_N },
        results:  { comparison, refLabel, candLabel },
        scoreVersion: SCORE_VERSION,
        runtimeSec,
      });
      cardResult.validationRunId = savedId;
    } catch (e) {
      console.warn("[fusion-comparison-runner] saveValidationRun failed (continuing):", e);
    }

    return cardResult;
  };
}

function abortError() {
  if (typeof DOMException === "function") return new DOMException("aborted", "AbortError");
  const e = new Error("aborted"); e.name = "AbortError"; return e;
}
