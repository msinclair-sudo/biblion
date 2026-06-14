// Fusion / cross-source comparison config modal — Phase 2 slice 2.10.
//
// Picks a reference + candidate clustering card (any two clusterings of
// the same network) and, on Apply, creates a `fusionComparison` card
// wiring the two as refIds + enqueues a queue.js job. The panel renders
// saved-mode against the new card's result once the job lands.
//
// Mirrors bootstrap-modal / dim-sweep-modal: config UI in the body,
// Cancel + Apply in the footer; Apply hands off to the descriptor.

import { openModal }      from "./modal.js";
import { buildStepSelect } from "./step-tree-picker.js";

export function openFusionComparisonModal(descriptor) {
  const active = descriptor.getActive();   // { hasEnough, options, defaultRefId, defaultCandId }

  const body = document.createElement("div");
  body.className = "fusion-comparison-modal-body";

  if (!active.hasEnough) {
    const empty = document.createElement("div");
    empty.className = "fusion-comparison-modal-empty";
    empty.textContent = "Cross-source comparison needs at least two clustering cards. Open the Clustering modal → Apply twice (different algorithm or params) to create two clusterings, then return here to compare them.";
    body.appendChild(empty);
    return openModal({
      title: descriptor.label,
      body,
      actions: [{ label: "Close" }],
    });
  }

  let refStepId  = active.defaultRefId;
  let candStepId = active.defaultCandId;

  const intro = document.createElement("div");
  intro.className = "fusion-comparison-modal-intro";
  intro.textContent = "Compare two clusterings of the same network: ARI / NMI / macro-Jaccard, a per-cluster best-match table, and the papers that moved most. The viewer shows the candidate's geometry.";
  body.appendChild(intro);

  // cards.md placeholder warning: cross-branch comparison only makes sense
  // when both clusterings used the same algorithm + params; otherwise the
  // similarity scores conflate "branches genuinely disagree" with "different
  // clustering knobs". Calling out at point-of-use rather than gating it,
  // so a power user with matched settings can still get value.
  const warnBanner = document.createElement("div");
  warnBanner.className = "fusion-comparison-modal-warn-banner";
  warnBanner.textContent =
    "⚠ Placeholder · pending further work. Only meaningful when both branches " +
    "were clustered with the SAME algorithm and parameters — otherwise the " +
    "similarity scores conflate 'branches disagree' with 'different settings'.";
  body.appendChild(warnBanner);

  const cfg = document.createElement("div");
  cfg.className = "fusion-comparison-modal-cfg";
  body.appendChild(cfg);

  cfg.appendChild(pickerRow("Reference", active.options, refStepId, (id) => { refStepId = id; }));
  cfg.appendChild(pickerRow("Candidate", active.options, candStepId, (id) => { candStepId = id; }));

  const warn = document.createElement("div");
  warn.className = "fusion-comparison-modal-warn";
  body.appendChild(warn);

  const modal = openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Compare",
        primary: true,
        onClick: () => {
          if (!refStepId || !candStepId || refStepId === candStepId) {
            warn.textContent = "Pick two different clustering cards.";
            return false;   // keep the modal open (modal.js convention)
          }
          descriptor.applyChange({ refStepId, candStepId })
            .catch(e => console.error("[fusion-comparison-modal] applyChange failed:", e));
        },
      },
    ],
  });
  return modal;
}

function pickerRow(labelText, options, initialId, onChange) {
  const row = document.createElement("div");
  row.className = "fusion-comparison-modal-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  row.appendChild(lab);
  row.appendChild(buildStepSelect({ options, initialId, onChange }));
  return row;
}
