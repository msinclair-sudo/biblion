// Dim-sweep config modal — Phase 2 slice 2.9.b.
//
// Compact replacement for the panel's old live tab. Exposes the three
// sweep axes that matter for the verdict (dims, seeds, threshold) and
// fixes the noise / compression / clustering algos to the validation-
// script defaults (PCA / UMAP / HDBSCAN with the n<10k-friendly
// minClusterSize). Users who want different algos can edit step.params
// and rerun via the chart's ↻ button.

import { openModal } from "./modal.js";
import { getAlgorithm as getDimredAlgo } from "../../dimred/registry.js";
import { getAlgorithm as getClusteringAlgo } from "../../clustering-registry.js";
import { estimateDimSweepCost } from "../runners/dim-sweep-runner.js";

const DEFAULT_DIMS  = [30, 50, 100, 200];
const DEFAULT_SEEDS = [42, 43, 44];
const DEFAULT_THRESHOLD = 0.9;

export function openDimSweepModal(descriptor) {
  const active = descriptor.getActive();

  let working = {
    dimsText:  active.dimsText  || DEFAULT_DIMS.join(", "),
    seedsText: active.seedsText || DEFAULT_SEEDS.join(", "),
    threshold: Number.isFinite(active.threshold) ? active.threshold : DEFAULT_THRESHOLD,
  };

  const body = document.createElement("div");
  body.className = "dim-sweep-modal-body";

  if (!active.hasDimred) {
    const empty = document.createElement("div");
    empty.className = "dim-sweep-modal-empty";
    empty.textContent = "Apply a dim-reduction first (Dim-reduce modal → Apply), then return here to run a sweep.";
    body.appendChild(empty);
    return openModal({
      title: descriptor.label,
      body,
      actions: [{ label: "Close" }],
    });
  }
  if (!active.hasStage0Input) {
    const empty = document.createElement("div");
    empty.className = "dim-sweep-modal-empty";
    empty.textContent = "No embedding / basePos available on live state to feed the noise stage. Run the dim-reduce lane first.";
    body.appendChild(empty);
    return openModal({
      title: descriptor.label,
      body,
      actions: [{ label: "Close" }],
    });
  }

  const ctx = document.createElement("div");
  ctx.className = "dim-sweep-modal-context";
  ctx.textContent = `Stage-0 input: n=${active.n}, d=${active.d}. Compression / noise / clustering defaults: ${active.summary}.`;
  body.appendChild(ctx);

  const cfgHost = document.createElement("div");
  cfgHost.className = "dim-sweep-modal-cfg";
  body.appendChild(cfgHost);

  const estimate = document.createElement("div");
  estimate.className = "dim-sweep-modal-estimate";
  cfgHost.appendChild(textRow("Dims",       working.dimsText,
    "Comma-separated target dims for the compression stage. Validation default: 30, 50, 100, 200.",
    (v) => { working.dimsText = v; refreshEstimate(); }));
  cfgHost.appendChild(textRow("Seeds",      working.seedsText,
    "Comma-separated seeds. Validation default: 42, 43, 44 (3 seeds × 4 dims = 12 runs).",
    (v) => { working.seedsText = v; refreshEstimate(); }));
  cfgHost.appendChild(numberRow("Verdict threshold", 0, 1, 0.05, working.threshold,
    "Pass/fail boundary for the verdict on the chosen dim pair. Default 0.9 (ARI dim-sweep paper).",
    (v) => { working.threshold = v; }));
  cfgHost.appendChild(estimate);
  refreshEstimate();

  function refreshEstimate() {
    const dims  = parseIntList(working.dimsText);
    const seeds = parseIntList(working.seedsText);
    if (dims.length < 2 || seeds.length < 1) {
      estimate.dataset.warn = "true";
      estimate.textContent = "Enter at least 2 dims and 1 seed.";
      return;
    }
    delete estimate.dataset.warn;
    const sec = estimateDimSweepCost({ n: active.n, dims, seeds });
    estimate.textContent = `${dims.length * seeds.length} runs (${dims.length} dims × ${seeds.length} seeds) · estimated ${formatDuration(sec)} wall time.`;
  }

  const modal = openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply",
        primary: true,
        onClick: () => {
          const dims  = parseIntList(working.dimsText);
          const seeds = parseIntList(working.seedsText);
          if (dims.length < 2 || seeds.length < 1) {
            // Bad config — keep modal open + flash the estimate.
            estimate.dataset.warn = "true";
            estimate.textContent = "Need at least 2 dims and 1 seed.";
            return false;
          }
          descriptor.applyChange({
            dims,
            seeds,
            verdictThreshold: working.threshold,
          }).catch(e => console.error("[dim-sweep-modal] applyChange failed:", e));
        },
      },
    ],
  });
  return modal;
}

// ── stage-0 default configs (mirror the panel's old cloneAlgoConfig). ─

export function defaultNoiseConfig() {
  return cloneAlgoConfig("pca", "noise");
}
export function defaultCompressionConfig() {
  return cloneAlgoConfig("umap", "compression");
}
export function defaultClusteringConfig() {
  const a = getClusteringAlgo("hdbscan");
  const params = a && a.defaultParams ? a.defaultParams() : {};
  // §6.9 finding — at n<10k the locked HDBSCAN defaults degenerate to
  // 2-cluster partitions; lower thresholds give a meaningful signal.
  return {
    method: "hdbscan",
    params: { ...params, minClusterSize: 15, minSamples: 5 },
  };
}

function cloneAlgoConfig(algoId, slot) {
  const a = getDimredAlgo(algoId);
  if (!a) return { method: algoId, params: {} };
  const params = a.defaultParamsForSlot ? a.defaultParamsForSlot(slot) : (a.defaultParams ? a.defaultParams() : {});
  return { method: algoId, params: { ...params } };
}

// ── input helpers ─────────────────────────────────────────────────

function textRow(labelText, init, hint, onInput) {
  const row = document.createElement("div");
  row.className = "dim-sweep-modal-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  if (hint) lab.title = hint;
  row.appendChild(lab);
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = init;
  inp.style.width = "240px";
  inp.addEventListener("input", () => onInput(inp.value));
  row.appendChild(inp);
  return row;
}

function numberRow(labelText, min, max, step, init, hint, onChange) {
  const row = document.createElement("div");
  row.className = "dim-sweep-modal-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  if (hint) lab.title = hint;
  row.appendChild(lab);
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = String(min); inp.max = String(max); inp.step = String(step);
  inp.value = String(init);
  inp.style.width = "80px";
  inp.addEventListener("change", () => {
    let v = parseFloat(inp.value);
    if (!Number.isFinite(v)) v = init;
    if (v < min) v = min; if (v > max) v = max;
    inp.value = String(v);
    onChange(v);
  });
  row.appendChild(inp);
  return row;
}

export function parseIntList(text) {
  if (!text) return [];
  return text.split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => parseInt(s, 10))
    .filter(v => Number.isFinite(v) && v > 0);
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${sec.toFixed(0)} s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

export const DIMSWEEP_DEFAULTS = {
  dims:             DEFAULT_DIMS.slice(),
  seeds:            DEFAULT_SEEDS.slice(),
  verdictThreshold: DEFAULT_THRESHOLD,
};
