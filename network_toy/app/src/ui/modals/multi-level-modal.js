// Multi-level ("Optimise multi-layer") clustering config modal — §9 revamp.
//
// No longer one HDBSCAN run cut by persistence. Instead it sweeps HDBSCAN
// resolution, bootstrap-scores each granularity's REPRODUCIBILITY, and keeps
// the most stable partitions at distinct cluster counts as the coarse→fine
// layers (eval/multilayer-sweep.js). The user sets the shared density
// (minSamples), how many layers to keep at most, the reproducibility floor,
// and the bootstrap budget. Apply creates a `multiLevel` card under the
// selected dimred ancestor and enqueues the sweep.

import { openModal } from "./modal.js";

export function openMultiLevelModal(descriptor) {
  const active = descriptor.getActive();   // { hasDimred, n, defaults, parentId }

  const body = document.createElement("div");
  body.className = "multi-level-modal-body";

  if (!active.hasDimred) {
    const empty = document.createElement("div");
    empty.className = "multi-level-modal-empty";
    empty.textContent =
      "Multi-layer clustering needs a dim-reduction card to run on. Add a " +
      "dim-reduction step first (the + under a data card), then return here.";
    body.appendChild(empty);
    return openModal({ title: descriptor.label, body, actions: [{ label: "Close" }] });
  }

  const intro = document.createElement("div");
  intro.className = "multi-level-modal-intro";
  intro.textContent =
    "Sweeps HDBSCAN (leaf) across cluster resolutions and scores how " +
    "reproducible each granularity is (bootstrap-Jaccard). It then opens a " +
    "picker showing the stability-vs-count curve, where you click the " +
    "granularities you want as your coarse→fine layers.";
  body.appendChild(intro);

  const d = active.defaults;
  const cfg = document.createElement("div");
  cfg.className = "multi-level-modal-cfg";
  body.appendChild(cfg);

  const minSamples = numberRow(cfg, "Min samples",
    d.minSamples, 1, Math.max(1, (active.n || 1000) - 1), 1,
    "HDBSCAN density smoothing (k for core distance). Shared across all layers.");
  const floor = numberRow(cfg, "Reproducibility floor",
    d.floor, 0, 1, 0.05,
    "A granularity must score at least this mean-Jaccard to become a layer " +
    "(0.6 = Hennig's 'doubtful' boundary). Lower to keep shakier levels.");
  const B = numberRow(cfg, "Bootstrap iterations",
    d.B, 3, 40, 1,
    "Resamples per candidate granularity. More = steadier scores, slower run.");

  return openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Run",
        primary: true,
        onClick: () => {
          descriptor.applyChange({
            minSamples: clampNum(minSamples.value, 1, (active.n || 1000) - 1, d.minSamples, true),
            floor:      clampNum(floor.value, 0, 1, d.floor, false),
            B:          clampNum(B.value, 3, 40, d.B, true),
          }).catch(e => console.error("[multi-level-modal] applyChange failed:", e));
        },
      },
    ],
  });
}

function numberRow(parent, labelText, value, min, max, step, hint) {
  const row = document.createElement("div");
  row.className = "multi-level-modal-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  row.appendChild(lab);
  row.appendChild(input);
  if (hint) {
    const h = document.createElement("div");
    h.className = "multi-level-modal-hint";
    h.textContent = hint;
    row.appendChild(h);
  }
  parent.appendChild(row);
  return input;
}

function clampNum(raw, min, max, fallback, asInt) {
  let v = asInt ? parseInt(raw, 10) : parseFloat(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}
