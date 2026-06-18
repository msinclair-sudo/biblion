// Shared widget / field-row kit (J12).
//
// Each modal and panel used to hand-roll its own form controls
// (label/control rows, selects, range sliders, number inputs) and a
// matching one-off `*-modal-row` grid in main.css. The grids were
// near-identical (e.g. `algorithm-modal-row` and `dimred-modal-row` were
// byte-for-byte the same: `110px 1fr 50px`, same label/readout/hint
// styling). This module extracts those builders so surfaces are composed
// from the same pieces and styled by ONE spacing language (the `.kit-*`
// classes in styles/main.css).
//
// Scope: a small, pure-DOM builder layer. It sits ON TOP OF the existing
// contracts (modals/modal.js `openModal`, panels/registry.js
// `mount → {update, destroy}`) and does not touch them. It is a pure
// refactor target — same controls, same wiring, same DOM effects; only
// the construction is shared.
//
// Why a `className` override on most builders: a couple of surfaces want
// the shared affordance (control look, gaps) but a bespoke wrapper class
// for an outer grid they keep. The override lets a file migrate its
// controls without being forced to also migrate its container layout in
// the same step (the no-big-bang rule).

// el(tag, opts) — terse element builder used by the rest of the kit.
//   opts: { className, text, attrs, style, children, on }
//     on: { event: handler, ... }  (addEventListener for each)
export function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, String(v));
  if (opts.style) for (const [k, v] of Object.entries(opts.style)) node.style[k] = v;
  if (opts.on) for (const [ev, fn] of Object.entries(opts.on)) node.addEventListener(ev, fn);
  if (opts.children) for (const c of opts.children) if (c) node.appendChild(c);
  return node;
}

// preserveScroll(scrollEl, rebuild) — run rebuild() (which wipes and
// repopulates scrollEl's content, e.g. `tbody.innerHTML = ""` + re-fill)
// without losing the user's scroll position. The scroll wrapper persists
// across rebuilds; only its children are replaced, so emptying it collapses
// the content height to 0 and the browser clamps scrollTop to 0. Re-pin
// scrollTop after the synchronous rebuild restores the height.
export function preserveScroll(scrollEl, rebuild) {
  if (!scrollEl) { rebuild(); return; }
  const top = scrollEl.scrollTop;
  const left = scrollEl.scrollLeft;
  rebuild();
  // Clamp so a now-shorter list doesn't restore past the new bottom.
  scrollEl.scrollTop = Math.min(top, Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight));
  scrollEl.scrollLeft = left;
}

// select(options, { value, onChange, className }) — a styled <select>.
//   options: [{ value, label }] | [{ id, label }]  (id accepted as value)
// Returns the <select> element; the caller decides where to mount it.
export function select(options = [], { value = undefined, onChange = null, className = "kit-select" } = {}) {
  const sel = el("select", { className });
  for (const opt of options) {
    const val = opt.value !== undefined ? opt.value : opt.id;
    const o = el("option", { text: opt.label != null ? opt.label : val });
    o.value = val;
    if (value !== undefined && val === value) o.selected = true;
    sel.appendChild(o);
  }
  if (onChange) sel.addEventListener("change", () => onChange(sel.value, sel));
  return sel;
}

// slider(field, value, onInput, { className }) — a range <input> driven by
// a field descriptor `{ min, max, step }`. `onInput` receives the parsed
// numeric value (int when field.kind === "int", else float).
export function slider(field, value, onInput, { className = undefined } = {}) {
  const input = el("input", { className });
  input.type = "range";
  input.min = String(field.min ?? 0);
  input.max = String(field.max ?? 100);
  input.step = String(field.step ?? 1);
  input.value = String(value ?? field.min ?? 0);
  if (onInput) {
    input.addEventListener("input", () => {
      const v = field.kind === "int" ? parseInt(input.value, 10) : parseFloat(input.value);
      onInput(v, input);
    });
  }
  return input;
}

// numberInput({ min, max, step, value, onChange, width, className }) — a
// number <input>. `onChange` fires on change with the raw string value;
// callers clamp/parse to taste (kept raw to preserve existing per-call
// validation, e.g. multi-level-modal's clampNum).
export function numberInput({ min, max, step, value, onChange = null, width = undefined, className = undefined } = {}) {
  const input = el("input", { className });
  input.type = "number";
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  if (step !== undefined) input.step = String(step);
  if (value !== undefined) input.value = String(value);
  if (width) input.style.width = width;
  if (onChange) input.addEventListener("change", () => onChange(input.value, input));
  return input;
}

// textInput({ value, onInput, width, className }) — a text <input>.
export function textInput({ value = "", onInput = null, width = undefined, className = undefined } = {}) {
  const input = el("input", { className });
  input.type = "text";
  input.value = String(value);
  if (width) input.style.width = width;
  if (onInput) input.addEventListener("input", () => onInput(input.value, input));
  return input;
}

// toggle({ checked, onChange, className }) — a checkbox <input>.
export function toggle({ checked = false, onChange = null, className = undefined } = {}) {
  const input = el("input", { className });
  input.type = "checkbox";
  input.checked = !!checked;
  if (onChange) input.addEventListener("change", () => onChange(input.checked, input));
  return input;
}

// fieldRow({ label, control, readout, hint, rowClass, labelClass, readoutClass, hintClass })
//   The canonical label + control [+ readout] [+ hint] grid row used by
//   the param editors. Defaults emit the shared `.kit-field-row` language;
//   pass overrides only when a surface keeps a bespoke wrapper class.
//   `readout` may be a string (a span is created and returned via
//   `.readout`) or an element. Returns { row, readout } so callers can
//   update the readout in place on input.
export function fieldRow({
  label,
  control,
  readout = null,
  hint = null,
  rowClass = "kit-field-row",
  labelClass = undefined,
  readoutClass = "kit-readout",
  hintClass = "kit-hint",
} = {}) {
  const row = el("div", { className: rowClass });

  const lab = el("label", { className: labelClass, text: label });
  row.appendChild(lab);

  if (control) row.appendChild(control);

  let readoutEl = null;
  if (readout != null) {
    if (readout instanceof Node) {
      readoutEl = readout;
    } else {
      readoutEl = el("span", { className: readoutClass, text: readout });
    }
    row.appendChild(readoutEl);
  }

  if (hint) {
    row.appendChild(el("div", { className: hintClass, text: hint }));
  }

  return { row, readout: readoutEl };
}

// formatNumber(field, value) — shared readout formatter for slider/int
// rows. Honours an optional field.format(value); otherwise scales the
// number of decimals by magnitude. Mirrors the formatField that several
// modals had copy-pasted verbatim.
export function formatNumber(field, value) {
  if (field && typeof field.format === "function") {
    try { return field.format(value); } catch (_) { /* fall through */ }
  }
  if (field && field.kind === "int") return String(value);
  const n = +value;
  if (!Number.isFinite(n)) return "—"; // em dash
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// paramRow(field, params, { rowClass, ... }) — the full "schema field →
// row" builder shared by algorithm-modal and dimred-modal. Reads/writes
// `params[field.key]` and keeps a readout in sync. `field`:
//   { key, label, kind: "select"|"range"|"int", options?, min/max/step?,
//     hint?, format? }
// Returns the row element.
export function paramRow(field, params, {
  rowClass = "kit-field-row",
  readoutClass = "kit-readout",
  hintClass = "kit-hint",
  selectClass = undefined,
} = {}) {
  let readoutEl = null;
  const syncReadout = () => {
    if (readoutEl) readoutEl.textContent = formatNumber(field, params[field.key]);
  };

  let control;
  if (field.kind === "select") {
    control = select(field.options || [], {
      value: params[field.key],
      className: selectClass,
      onChange: (v) => { params[field.key] = v; },
    });
  } else {
    control = slider(field, params[field.key], (v) => {
      params[field.key] = v;
      syncReadout();
    });
  }

  const showReadout = field.kind === "range" || field.kind === "int";
  if (showReadout) {
    readoutEl = el("span", { className: readoutClass, text: formatNumber(field, params[field.key]) });
  }

  const { row } = fieldRow({
    label: field.label || field.key,
    control,
    readout: readoutEl,
    hint: field.hint,
    rowClass,
    readoutClass,
    hintClass,
  });
  return row;
}
