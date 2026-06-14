// Cluster-labelling config modal (MLC §7).
//
// Pick which label methods to run; Apply forks a `labelling` card under
// the selected clustering-like ancestor and labels every level of its
// ladder. Methods that can't run on this data (e.g. the text methods
// before paper titles are materialised) are listed but disabled with a
// reason. Mirrors bootstrap-modal's shape.

import { openModal } from "./modal.js";

export function openLabellingModal(descriptor) {
  const active = descriptor.getActive();   // { hasClustering, nLevels, methods:[{id,label,available,reason}], selected:[ids] }

  const body = document.createElement("div");
  body.className = "labelling-modal-body";

  if (!active.hasClustering) {
    const empty = document.createElement("div");
    empty.className = "labelling-modal-empty";
    empty.textContent = "Add a clustering or multi-layer card first, then label its clusters.";
    body.appendChild(empty);
    return openModal({ title: descriptor.label, body, actions: [{ label: "Close" }] });
  }

  // Working selection — committed only on Apply. Start from the descriptor's
  // suggested default (all available methods).
  const selected = new Set(active.selected);

  const ctx = document.createElement("div");
  ctx.className = "labelling-modal-context";
  ctx.textContent = `Labels every level (${active.nLevels}) of the parent ladder. Labelling is static — re-run the card if the upstream clustering changes.`;
  body.appendChild(ctx);

  const list = document.createElement("div");
  list.className = "labelling-modal-methods";
  body.appendChild(list);

  for (const m of active.methods) {
    const row = document.createElement("label");
    row.className = "labelling-modal-method" + (m.available ? "" : " unavailable");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = m.available && selected.has(m.id);
    cb.disabled = !m.available;
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(m.id); else selected.delete(m.id);
    });
    row.appendChild(cb);
    const name = document.createElement("span");
    name.className = "labelling-modal-method-name";
    name.textContent = m.label;
    row.appendChild(name);
    if (!m.available && m.reason) {
      const why = document.createElement("span");
      why.className = "labelling-modal-method-why";
      why.textContent = m.reason;
      why.title = m.reason;
      row.appendChild(why);
    }
    list.appendChild(row);
  }

  return openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply",
        primary: true,
        onClick: () => {
          const methods = [...selected];
          if (methods.length === 0) return false;   // need at least one method — keep open
          descriptor.applyChange({ methods })
            .catch(e => console.error("[labelling-modal] applyChange failed:", e));
        },
      },
    ],
  });
}
