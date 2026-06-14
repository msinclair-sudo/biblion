// Data info panel — top of the left rail.
//
// Inline quick-edit + status surface for the active data source.
// Source SELECTION lives in the workflow-chart's Data card → modal
// (see modals/data-source-modal.js); this panel is just the
// fast-iteration UI for whatever's currently active: read-only stats
// + Reload ▶ (hitting Reload re-runs reingest against the same subset).

import { getState, subscribe, setLayerState } from "./state.js";
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

  root.appendChild(renderRealMode(state));
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

function stat(labelText, valueText) {
  const row = document.createElement("div");
  row.className = "data-panel-stat";
  const lab = document.createElement("label"); lab.textContent = labelText;
  const val = document.createElement("span");  val.textContent  = valueText;
  row.appendChild(lab);
  row.appendChild(val);
  return row;
}

function formatInt(n) {
  return Number(n).toLocaleString("en-US");
}
