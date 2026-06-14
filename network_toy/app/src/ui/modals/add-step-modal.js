// "Add step" modal — UI #2. Opened by the per-card "+" button on the
// workflow chart. Lists the valid downstream steps for the card's type
// (from the shared next-step rule table); picking one opens that
// descriptor's config modal, which forks a new child card on Apply.

import { openModal }                          from "./modal.js";
import { addStepRulesFor, runNextStepAction } from "../next-steps-rules.js";

export function openAddStepModal(step) {
  const rules = addStepRulesFor(step.type);

  const body = document.createElement("div");
  body.className = "add-step-modal-body";

  if (rules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "add-step-modal-empty";
    empty.textContent = "No further steps available from this card.";
    body.appendChild(empty);
    return openModal({ title: "Add step", body, actions: [{ label: "Close" }] });
  }

  let modal;
  for (const rule of rules) {
    const btn = document.createElement("button");
    btn.className = "add-step-option";
    btn.type = "button";
    const lab = document.createElement("span");
    lab.className = "add-step-option-label";
    lab.textContent = rule.label;
    btn.appendChild(lab);
    if (rule.hint) {
      const hint = document.createElement("span");
      hint.className = "add-step-option-hint";
      hint.textContent = rule.hint;
      btn.appendChild(hint);
    }
    btn.addEventListener("click", () => {
      if (modal) modal.close();
      // Hand off to the descriptor modal (forks a new card on Apply).
      runNextStepAction(step, rule);
    });
    body.appendChild(btn);
  }

  modal = openModal({
    title: `Add step after "${step.label}"`,
    body,
    actions: [{ label: "Cancel" }],
  });
  return modal;
}
