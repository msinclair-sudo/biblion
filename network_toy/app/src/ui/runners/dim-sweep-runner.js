// Dim-sweep runner — Phase 2 slice 2.9.b.
//
// Wraps eval/dim-sweep.js's runDimSweep in a queue-job shape and ties
// it back to the workflow tree:
//   - parent is the SELECTED dimred ancestor (the snapshot is what we
//     feed into the noise stage if `embedding` isn't on live state);
//   - dims / seeds / threshold + algo configs come from card params,
//     so re-running with `rerunStep` is deterministic;
//   - returns a result blob the dim-sweep panel renders verbatim,
//     mirroring the validationRun `results.sweep + results.verdict`
//     shape so saved-mode rendering stays unchanged.

import { getState, saveValidationRun } from "../state.js";
import { getStep }                     from "../workflow.js";
import { runDimSweep, dimSweepVerdict, estimateDimSweepCost }
  from "../../eval/dim-sweep.js";

/**
 * Build a queue-job fn that runs a dim-sweep against the given parent
 * dimred card. Reads stage-0 input from live state (embedding /
 * basePos) since the dimred card's snapshot only carries the post-
 * reduction result, not the pre-noise input.
 *
 * @param {object} opts
 * @param {string} opts.parentDimredStepId  Step id of the dimred card.
 * @param {object} opts.settings            {dims[], seeds[], noise, compression, clustering, verdictPair, verdictThreshold}
 * @returns {(ctx) => Promise<object>}
 */
export function buildDimSweepJob({ parentDimredStepId, settings }) {
  return async function runDimSweepJob(ctx) {
    const parent = getStep(parentDimredStepId);
    if (!parent) {
      throw new Error(`[dim-sweep-runner] parent dimred step "${parentDimredStepId}" no longer exists`);
    }

    const live  = getState();
    const input = pickStage0Input(live);
    if (!input) {
      throw new Error("[dim-sweep-runner] no embedding / _basePos on live state to feed the noise stage");
    }

    const t0 = performance.now();
    ctx.setPhase && ctx.setPhase("starting…");

    const sweep = await runDimSweep({
      input,
      genResult:   live.genResult,
      dims:        settings.dims,
      seeds:       settings.seeds,
      noise:       settings.noise,
      compression: settings.compression,
      clustering:  settings.clustering,
      abortSignal: ctx.signal,
      onProgress:  (stage, done, total) => {
        ctx.setPhase && ctx.setPhase(
          (typeof done === "number" && typeof total === "number")
            ? `${done} / ${total} · ${stage}`
            : stage
        );
        if (typeof done === "number" && typeof total === "number" && total > 0) {
          ctx.setProgress && ctx.setProgress(done / total);
        }
      },
    });
    const runtimeSec = (performance.now() - t0) / 1000;

    const pair      = settings.verdictPair || defaultVerdictPair(settings.dims);
    const threshold = Number.isFinite(settings.verdictThreshold) ? settings.verdictThreshold : 0.9;
    const verdict   = dimSweepVerdict(sweep, pair[0], pair[1], threshold);

    const ds   = live.dataSource;
    const mode = (ds && ds.mode) || "toy";
    const cfg  = (ds && ds.configs && ds.configs[mode]) || {};
    const subsetTag = mode === "real"
      ? (cfg.subset || "real")
      : `toy n=${live.genResult ? live.genResult.nodes.length : "?"}`;
    const compTag = settings.compression && settings.compression.method;
    const clusTag = settings.clustering  && settings.clustering.method;
    const label   = `dimsweep ${compTag}-{${settings.dims.join("/")}} ${clusTag} · ${subsetTag}`;

    const cardResult = {
      capturedAt:  new Date().toISOString(),
      sweep,
      verdict,
      settings:    { ...settings, verdictPair: pair.slice(), verdictThreshold: threshold },
      runtimeSec,
      ranAt:       new Date().toISOString(),
      label,
      scoreVersion: 1,
    };

    try {
      const savedId = saveValidationRun({
        type: "dimSweep",
        label,
        inputs: {
          dataSourceId:        mode,
          dataSourceConfig:    cfg,
          layerParamsSnapshot: live.layerParams,
          parentStepId:        parentDimredStepId,
        },
        settings: {
          dims:             settings.dims,
          seeds:            settings.seeds,
          noise:            settings.noise,
          compression:      settings.compression,
          clustering:       settings.clustering,
          verdictPair:      pair.slice(),
          verdictThreshold: threshold,
        },
        results: { sweep, verdict },
        scoreVersion: 1,
        runtimeSec,
      });
      cardResult.validationRunId = savedId;
    } catch (e) {
      console.warn("[dim-sweep-runner] saveValidationRun failed (continuing):", e);
    }

    return cardResult;
  };
}

// ── helpers (mirrored from the panel's old live mode) ──────────────

function pickStage0Input(s) {
  if (!s.genResult) return null;
  const n = s.genResult.nodes.length;
  if (s.embedding && s.embedding.data instanceof Float32Array) {
    return { n, d: s.embedding.d, data: s.embedding.data };
  }
  if (s._basePos instanceof Float32Array) {
    return { n, d: 3, data: s._basePos };
  }
  return null;
}

function defaultVerdictPair(dims) {
  if (dims.includes(50) && dims.includes(100)) return [50, 100];
  if (dims.length < 2) return [dims[0], dims[0]];
  return [dims[dims.length - 2], dims[dims.length - 1]];
}

// Useful as a UI helper too — exported so the modal can render a
// cost-estimate banner without re-importing eval/dim-sweep.
export { estimateDimSweepCost };
