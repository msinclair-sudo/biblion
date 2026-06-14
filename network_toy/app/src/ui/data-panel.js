// Data info panel — top of the left rail.
//
// Inline quick-edit + status surface for the active data source.
// Source SELECTION lives in the workflow-chart's Data card → modal
// (see modals/data-source-modal.js); this panel is just the
// fast-iteration UI for whatever's currently active. For the toy
// generator that means inline sliders + Generate ▶; for real data
// it's read-only stats + Reload ▶ (hitting Reload re-runs reingest
// against the same subset).

import { getState, subscribe, setDataSourceConfig, setLayerState } from "./state.js";
import * as engine from "./engine.js";

export function mountDataPanel() {
  const root = document.getElementById("data-panel");
  if (!root) return;
  render(root);

  subscribe((state) => {
    if (root.dataset.mode !== state.dataSource.mode) {
      render(root);
    }
  });
}

function render(root) {
  const state = getState();
  root.dataset.mode = state.dataSource.mode;
  root.innerHTML = "";

  if (state.dataSource.mode === "toy") {
    root.appendChild(renderToyMode(state));
  } else {
    root.appendChild(renderRealMode(state));
  }
}

function renderToyMode(state) {
  const cfg = state.dataSource.configs.toy;
  const wrap = document.createElement("div");
  wrap.appendChild(title("Toy data"));

  wrap.appendChild(numberRow("Seed",    "seed",       cfg.seed));
  wrap.appendChild(numberRow("Nodes",   "nodeCount",  cfg.nodeCount));
  wrap.appendChild(numberRow("Origins", "origins",    cfg.origins));
  wrap.appendChild(rangeRow ("Spread",  "spread",     cfg.spread,    0.1, 3.0, 0.05));
  wrap.appendChild(rangeRow ("Density", "density",    cfg.density,   0.0, 1.0, 0.01));
  wrap.appendChild(rangeRow ("Intra",   "intraRate",  cfg.intraRate, 0.0, 1.0, 0.01));
  wrap.appendChild(rangeRow ("Cross",   "crossRate",  cfg.crossRate, 0.0, 1.0, 0.01));

  const actions = document.createElement("div");
  actions.className = "data-panel-actions";

  const genBtn = document.createElement("button");
  genBtn.textContent = "Generate ▶";
  genBtn.title = "Re-run Layer 1 (toy generator) and cascade.";
  genBtn.addEventListener("click", fireReingest);
  actions.appendChild(genBtn);

  wrap.appendChild(actions);
  return wrap;
}

function renderRealMode(state) {
  const cfg   = state.dataSource.configs.real;
  const wrap  = document.createElement("div");
  wrap.appendChild(title("Real data"));

  // Read-only summary. Subset is chosen + applied via the Data card
  // modal in the workflow chart, not here.
  wrap.appendChild(stat("Subset", cfg.subset || "—"));

  const emb   = state.embedding;
  const nodes = state.genResult && state.genResult.nodes;
  if (emb && nodes) {
    wrap.appendChild(stat("Papers",    formatInt(nodes.length)));
    wrap.appendChild(stat("Embedding", emb.d ? `${emb.d}-d` : "—"));
  } else {
    const hint = document.createElement("div");
    hint.className = "data-panel-hint";
    hint.textContent = "Open the Data card in the workflow chart to load a subset. Viewer stays empty until a 3-d viz reduction runs.";
    wrap.appendChild(hint);
  }

  const actions = document.createElement("div");
  actions.className = "data-panel-actions";
  const reloadBtn = document.createElement("button");
  reloadBtn.textContent = "Reload ▶";
  reloadBtn.title = "Re-run the pipeline against the currently-selected subset.";
  reloadBtn.addEventListener("click", fireReingest);
  actions.appendChild(reloadBtn);
  wrap.appendChild(actions);

  return wrap;
}

function fireReingest() {
  // engine.reingest is async; we don't await — fire-and-forget so the
  // UI stays responsive while the real source fetches.
  Promise.resolve(engine.reingest()).catch(e => {
    console.error("[data-panel] reingest failed:", e);
    setLayerState("data", "error");
  });
}

/* ── small builders ─────────────────────────────────────────────────── */

function title(text) {
  const el = document.createElement("div");
  el.className = "data-panel-title";
  const dot = document.createElement("span");
  dot.className = "dot";
  el.appendChild(dot);
  const span = document.createElement("span");
  span.textContent = text;
  el.appendChild(span);
  return el;
}

function numberRow(labelText, key, value) {
  const row = document.createElement("div");
  row.className = "data-panel-row";

  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);

  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) setDataSourceConfig(key, v);
  });
  row.appendChild(input);

  return row;
}

function rangeRow(labelText, key, value, min, max, step) {
  const row = document.createElement("div");
  row.className = "data-panel-row";
  row.style.gridTemplateColumns = "70px 1fr 36px";

  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  row.appendChild(input);

  const readout = document.createElement("span");
  readout.className = "value-readout";
  readout.textContent = formatNum(value);
  row.appendChild(readout);

  input.addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    readout.textContent = formatNum(v);
    setDataSourceConfig(key, v);
  });

  return row;
}

function stat(labelText, valueText) {
  const row = document.createElement("div");
  row.className = "data-panel-stat";
  const lab = document.createElement("label"); lab.textContent = labelText;
  const val = document.createElement("span");  val.textContent  = valueText;
  row.appendChild(lab);
  row.appendChild(val);
  return row;
}

function formatNum(v) {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}

function formatInt(n) {
  return Number(n).toLocaleString("en-US");
}
