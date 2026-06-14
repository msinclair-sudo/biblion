// Panel: next steps — Phase 2 slice 2.12.
//
// A per-card "what's next?" surface. Subscribes to the selected
// workflow step and offers the valid follow-on actions for that card's
// type, each opening the relevant modal (which forks a new card on
// Apply). This is the discoverable launcher for analysis cards
// (bootstrap / dim-sweep / cross-source comparison) that otherwise only
// appear via migration or by clicking an existing card.
//
// Explicitly a STATIC rule table per step type (doc §7 slice 2.12):
// no ML-driven suggestions, no compute-time estimation — just a lookup
// from step.type → list of follow-ons. Each action defers to a
// layer-descriptor's openModal() / rerunStep() so the panel owns no
// engine logic of its own.

import { getState, subscribe }            from "../state.js";
import { getSelectedStep, isStepStale }   from "../workflow.js";
import { nextStepsFor, runNextStepAction } from "../next-steps-rules.js";

export const ID          = "next-steps";
export const LABEL       = "Next steps";
export const DESCRIPTION = "Suggested follow-on actions for the selected workflow card — run a clustering, bootstrap its stability, compare two clusterings, sweep dimensions. Each opens the relevant modal and forks a new card.";
export const SINGLETON   = true;

export function mount(container, _state, _config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-next-steps";
  container.appendChild(wrap);

  function render() {
    wrap.innerHTML = "";

    const header = document.createElement("div");
    header.className = "panel-ns-header";
    const title = document.createElement("div");
    title.className = "panel-ns-title";
    title.textContent = "What's next?";
    header.appendChild(title);
    wrap.appendChild(header);

    const step = getSelectedStep();
    if (!step) {
      empty(wrap, "Select a card in the workflow tree to see suggested next steps.");
      return;
    }

    // Context line — which card these suggestions are for.
    const ctx = document.createElement("div");
    ctx.className = "panel-ns-context";
    const staleTag = isStepStale(step.id) ? " · upstream changed" : "";
    ctx.textContent = `Selected: ${step.label} (${step.type})${staleTag}`;
    wrap.appendChild(ctx);

    const rules = nextStepsFor(step.type);
    if (rules.length === 0) {
      empty(wrap, "No follow-on actions for this card type yet.");
      return;
    }

    const list = document.createElement("div");
    list.className = "panel-ns-list";
    for (const rule of rules) {
      list.appendChild(actionRow(step, rule));
    }
    wrap.appendChild(list);
  }

  function actionRow(step, rule) {
    const row = document.createElement("button");
    row.className = "panel-ns-action";
    row.type = "button";

    const lab = document.createElement("span");
    lab.className = "panel-ns-action-label";
    lab.textContent = `▸ ${rule.label}`;
    row.appendChild(lab);

    if (rule.hint) {
      const hint = document.createElement("span");
      hint.className = "panel-ns-action-hint";
      hint.textContent = rule.hint;
      row.appendChild(hint);
    }

    row.addEventListener("click", () => {
      try {
        runNextStepAction(step, rule);
      } catch (e) {
        console.error("[next-steps] action failed:", e);
      }
    });
    return row;
  }

  render();
  const unsub = subscribe(() => render());

  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}

function empty(wrap, text) {
  const el = document.createElement("div");
  el.className = "panel-ns-empty";
  el.textContent = text;
  wrap.appendChild(el);
}
