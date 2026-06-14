// Panel-picker modal: shown when the user clicks the "+" tab in any
// slot. Lists two sections:
//   1. Panel types — every registered panel type that isn't a singleton
//      already mounted somewhere AND isn't hidden via HIDE_FROM_TYPE_LIST.
//   2. Validation runs (§6.19) — every saved run in
//      state.validationRuns, opened via the panel type appropriate to
//      its `type` field (e.g. "optimise" → validation-run-optimise).
//
// Picking either calls `onPick(typeId, config)` and closes. The
// caller (panel-system) uses config to bind the new panel (e.g.
// runId for validation-run-* panels).

import { openModal }        from "./modal.js";
import { listPanelTypes }   from "../panels/registry.js";
import { getState }         from "../state.js";

// Hide singletons that already have a tab anywhere in panels.
function isSingletonAlreadyMounted(typeId) {
  const panels = getState().panels;
  for (const slot of Object.keys(panels)) {
    for (const tab of panels[slot].tabs) {
      if (tab.type === typeId) return true;
    }
  }
  return false;
}

// Map a ValidationRun.type to the panel-type id that renders it.
// Extend as new run renderers come online.
function panelTypeForRun(run) {
  if (run.type === "optimise")           return "validation-run-optimise";
  if (run.type === "targetRange")        return "validation-run-optimise";   // same renderer
  if (run.type === "bootstrapStability") return "bootstrap-stability";       // dual-mode panel
  if (run.type === "dimSweep")           return "dim-sweep";                  // dual-mode panel
  return null;
}

export function openPanelPickerModal(slot, onPick) {
  const body = document.createElement("div");
  body.className = "panel-picker-list";

  let modal = null;

  // ── Section 1: panel types. ──
  const types = listPanelTypes()
    .filter(t => t.id !== "placeholder")
    .filter(t => !t.hideFromTypeList)
    .filter(t => !(t.singleton && isSingletonAlreadyMounted(t.id)));
  if (types.length > 0) {
    const heading = document.createElement("div");
    heading.className = "panel-picker-section-heading";
    heading.textContent = "Panel types";
    body.appendChild(heading);
    for (const t of types) {
      body.appendChild(makeCard(t.label, t.description, () => {
        onPick(t.id);
        if (modal) modal.close();
      }));
    }
  }

  // ── Section 2: validation runs. ──
  const runs = (getState().validationRuns || [])
    .map(r => ({ run: r, typeId: panelTypeForRun(r) }))
    .filter(x => x.typeId);   // skip runs whose renderer isn't registered yet
  if (runs.length > 0) {
    const heading = document.createElement("div");
    heading.className = "panel-picker-section-heading";
    heading.textContent = "Validation runs";
    body.appendChild(heading);
    // Newest first feels more useful than insertion order.
    runs.sort((a, b) => (b.run.timestamp || "").localeCompare(a.run.timestamp || ""));
    for (const { run, typeId } of runs) {
      const label = run.label || `(unlabelled ${run.type})`;
      const dt    = run.timestamp ? new Date(run.timestamp).toLocaleString() : "";
      const desc  = `${run.type} · saved ${dt}`;
      body.appendChild(makeCard(label, desc, () => {
        onPick(typeId, { runId: run.id });
        if (modal) modal.close();
      }));
    }
  }

  if (types.length === 0 && runs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel-picker-empty";
    empty.textContent = "No panel types or saved runs available.";
    body.appendChild(empty);
  }

  modal = openModal({
    title: `Add panel — ${slot}`,
    body,
    actions: [
      { label: "Cancel" },
    ],
  });

  return modal;
}

function makeCard(labelText, descText, onClick) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "panel-picker-item";

  const label = document.createElement("div");
  label.className = "panel-picker-item-label";
  label.textContent = labelText;
  item.appendChild(label);

  if (descText) {
    const desc = document.createElement("div");
    desc.className = "panel-picker-item-desc";
    desc.textContent = descText;
    item.appendChild(desc);
  }

  item.addEventListener("click", () => {
    try { onClick(); }
    catch (e) { console.error("[panel-picker] onClick failed:", e); }
  });

  return item;
}
