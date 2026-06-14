// Data-source modal — pick the active source + edit its params.
//
// Same pattern as algorithm-modal but keyed off the data-source
// registry (Layer 1) rather than a per-layer descriptor. The
// workflow-chart's "Data" node opens this; clicking Apply runs
// engine.reingest() against the chosen source, dropping every
// downstream artifact.
//
// Apply runs heavy work (real source fetches over the network +
// runs the full pipeline cascade), so the button shows "Running…"
// and the modal stays open until the work completes.

import { openModal } from "./modal.js";
// enqueueBusy removed (slice 2.9.c) — descriptor.applyChange runs the
// engine cascade directly; nesting it in a busy job double-queues.

export function openDataSourceModal(descriptor) {
  const active = descriptor.getActive();
  const sources = descriptor.listSources();

  // Working copy — committed only on Apply.
  let chosenId     = active.method;
  let chosenParams = { ...active.params };

  const body = document.createElement("div");
  body.className = "datasource-modal-body";

  // Source switcher.
  const sourceRow = document.createElement("div");
  sourceRow.className = "datasource-modal-source-row";

  const sourceLabel = document.createElement("label");
  sourceLabel.textContent = "Source";
  sourceRow.appendChild(sourceLabel);

  const sourceSelect = document.createElement("select");
  for (const s of sources) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label || s.id;
    if (s.id === chosenId) opt.selected = true;
    sourceSelect.appendChild(opt);
  }
  sourceRow.appendChild(sourceSelect);
  body.appendChild(sourceRow);

  // Description + params.
  const desc = document.createElement("div");
  desc.className = "datasource-modal-desc";
  body.appendChild(desc);

  const paramsHost = document.createElement("div");
  paramsHost.className = "datasource-modal-params";
  body.appendChild(paramsHost);

  function renderForSource(sourceId) {
    const source = sources.find(s => s.id === sourceId);
    if (!source) return;

    if (sourceId === active.method) {
      chosenParams = { ...active.params };
    } else {
      chosenParams = { ...source.defaultParams() };
    }
    chosenId = sourceId;

    desc.textContent = source.description || "";

    paramsHost.innerHTML = "";
    if (!source.modalSchema || source.modalSchema.length === 0) {
      const none = document.createElement("div");
      none.className = "datasource-modal-noparams";
      none.textContent = "No tuneable parameters.";
      paramsHost.appendChild(none);
      return;
    }
    for (const field of source.modalSchema) {
      paramsHost.appendChild(renderField(field, chosenParams));
    }
  }

  sourceSelect.addEventListener("change", () => {
    renderForSource(sourceSelect.value);
  });
  renderForSource(chosenId);

  const modalHandle = openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply",
        primary: true,
        onClick: () => {
          // Apply commits the source choice + closes the modal. The
          // descriptor's applyChange clears the workflow + runs the
          // reingest cascade; cascade phases publish via setBusyPhase
          // (engine.js) until slice 2.11 removes the busy bar entirely.
          descriptor.applyChange(chosenId, chosenParams)
            .catch(e => console.error("[datasource-modal] applyChange failed:", e));
        },
      },
    ],
  });
  return modalHandle;
}

function renderField(field, params) {
  const row = document.createElement("div");
  row.className = "datasource-modal-row";

  const label = document.createElement("label");
  label.textContent = field.label || field.key;
  row.appendChild(label);

  let readout = null;
  const input = buildInput(field, params, () => {
    if (readout) readout.textContent = formatField(field, params[field.key]);
  });
  row.appendChild(input);

  if (field.kind === "range" || field.kind === "int") {
    readout = document.createElement("span");
    readout.className = "datasource-modal-readout";
    readout.textContent = formatField(field, params[field.key]);
    row.appendChild(readout);
  }

  if (field.hint) {
    const h = document.createElement("div");
    h.className = "datasource-modal-hint";
    h.textContent = field.hint;
    row.appendChild(h);
  }
  return row;
}

function buildInput(field, params, onChange) {
  const cur = params[field.key];
  if (field.kind === "select") {
    const sel = document.createElement("select");
    for (const opt of (field.options || [])) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (cur === opt.value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      params[field.key] = sel.value;
      onChange();
    });
    return sel;
  }
  const input = document.createElement("input");
  input.type = "range";
  input.min   = String(field.min  ?? 0);
  input.max   = String(field.max  ?? 100);
  input.step  = String(field.step ?? 1);
  input.value = String(cur ?? field.min ?? 0);
  input.addEventListener("input", () => {
    const v = field.kind === "int" ? parseInt(input.value, 10) : parseFloat(input.value);
    params[field.key] = v;
    onChange();
  });
  return input;
}

function formatField(field, value) {
  if (field.format) {
    try { return field.format(value); }
    catch (_) { /* fall through */ }
  }
  if (field.kind === "int") return String(value);
  const n = +value;
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10)  return n.toFixed(1);
  return n.toFixed(2);
}
