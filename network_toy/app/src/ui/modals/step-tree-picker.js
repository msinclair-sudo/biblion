// Step-tree picker — Phase 2 slice 2.10.
//
// A small reusable helper for choosing a workflow step from the tree.
// First cut is a flat lineage-labelled <select> (one entry per matching
// card, annotated with its ancestry so the user can tell sibling
// clusterings apart). A richer collapsible-tree widget can replace the
// internals later without changing callers.
//
// Currently the only consumer is the fusion-comparison modal (pick two
// clustering cards to compare), but the API is generic over step type.

import { listSteps, getStepAncestors } from "../workflow.js";

// Step types that materialise a clusterLevels[] ladder — both are
// comparable as ref / cand in a cross-clustering comparison. Kept in
// sync with CLUSTERING_LIKE_TYPES in layer-descriptors.js.
const COMPARABLE_TYPES = ["clustering", "multiLevel"];

/**
 * Clustering-like cards (clustering OR multi-layer) that carry a
 * materialised result (clusterLevels), each annotated with a human
 * lineage label. These are the cards a cross-clustering comparison can
 * use as ref / cand.
 *
 * @returns {Array<{id, label, lineage, step}>} in tree (BFS) order.
 */
export function listComparableClusterings() {
  return COMPARABLE_TYPES
    .flatMap(t => listSteps({ type: t }))
    .filter(s => s.result && Array.isArray(s.result.clusterLevels) && s.result.clusterLevels.length > 0)
    .map(s => ({ id: s.id, label: s.label, lineage: lineageLabel(s.id), step: s }));
}

/**
 * A compact lineage string for a step: the chain of ancestor types from
 * root to the step (e.g. "data › dimred › clustering"). Lets the user
 * disambiguate sibling cards of the same type in a flat picker.
 *
 * @param {string} stepId
 * @returns {string}
 */
export function lineageLabel(stepId) {
  const anc = getStepAncestors(stepId);
  return anc.map(s => s.type).join(" › ");
}

/**
 * Build a <select> over a list of step options. Each option shows the
 * card label + its lineage. onChange receives the selected step id.
 *
 * @param {object} opts
 * @param {Array<{id, label, lineage}>} opts.options
 * @param {string}   [opts.initialId]   pre-selected option id
 * @param {(id: string) => void} opts.onChange
 * @returns {HTMLSelectElement}
 */
export function buildStepSelect({ options, initialId, onChange }) {
  const sel = document.createElement("select");
  sel.className = "step-picker-select";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.id;
    o.textContent = opt.lineage ? `${opt.label}  (${opt.lineage})` : opt.label;
    if (opt.id === initialId) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange && onChange(sel.value));
  return sel;
}
