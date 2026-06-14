// Data info panel — top of the left rail.
//
// Inline quick-edit + status surface for the active data source.
// Source SELECTION lives in the workflow-chart's Data card → modal
// (see modals/data-source-modal.js); this panel is just the
// fast-iteration UI for whatever's currently active: read-only stats
// + Reload ▶ (hitting Reload re-runs reingest against the same dataset).
//
// The only source today is the biblion `sqlite` corpus: the panel
// names the actually-connected dataset (id from the active config,
// stats from the last ingest's genResult.params) rather than a baked-in
// label.

import { getState, subscribe, setLayerState } from "./state.js";
import * as engine from "./engine.js";

export function mountDataPanel() {
  const root = document.getElementById("data-panel");
  if (!root) return;
  render(root);

  // Re-render when the connected dataset changes (picker) OR when a
  // pipeline run completes (engineRevision bump) so the stats drawn from
  // genResult.params appear once an ingest has run.
  subscribe((state) => {
    if (root.dataset.sig !== panelSig(state)) render(root);
  });
}

// Signature of everything the panel renders from, so we only rebuild when
// the displayed identity / stats actually change.
function panelSig(state) {
  const cfg = (state.dataSource.configs && state.dataSource.configs.sqlite) || {};
  return `${state.dataSource.mode}|${cfg.dataset || ""}|${state.engineRevision}`;
}

function render(root) {
  const state = getState();
  root.dataset.sig = panelSig(state);
  root.innerHTML = "";

  root.appendChild(renderSqliteMode(state));
}

function renderSqliteMode(state) {
  const cfg     = (state.dataSource.configs && state.dataSource.configs.sqlite) || {};
  const gen     = state.genResult;
  // Identity comes from the active config (set the moment a dataset is
  // picked) and is enriched by the last ingest's params once it has run.
  const params  = gen && gen.params;
  const dataset = (params && params.dataset) || cfg.dataset || null;
  const wrap    = document.createElement("div");

  // Title = the connected dataset id, not a hardcoded "Real data".
  wrap.appendChild(title(dataset || "No dataset connected"));

  const emb   = state.embedding;
  const nodes = gen && gen.nodes;
  if (dataset && emb && nodes) {
    wrap.appendChild(stat("Papers",    formatInt(nodes.length)));
    wrap.appendChild(stat("Embedding", emb.d ? `${emb.d}-d` : "—"));
    if (params) {
      if (Array.isArray(params.yearRange)) {
        wrap.appendChild(stat("Years", `${params.yearRange[0]}–${params.yearRange[1]}`));
      }
      if (Number.isFinite(params.edgesKept)) {
        wrap.appendChild(stat("Citations", formatInt(params.edgesKept)));
      }
      if (params.nGhost) {
        wrap.appendChild(stat("Ghosts", formatInt(params.nGhost)));
      }
    }
  } else {
    const hint = document.createElement("div");
    hint.className = "data-panel-hint";
    hint.textContent = dataset
      ? `Dataset "${dataset}" selected. Run the Data card in the workflow chart to ingest it; the viewer stays empty until a 3-d viz reduction runs.`
      : "Open the Data card in the workflow chart to connect a biblion dataset. The viewer stays empty until a 3-d viz reduction runs.";
    wrap.appendChild(hint);
  }

  const actions = document.createElement("div");
  actions.className = "data-panel-actions";
  const reloadBtn = document.createElement("button");
  reloadBtn.textContent = "Reload ▶";
  reloadBtn.title = "Re-run the pipeline against the currently-connected dataset.";
  reloadBtn.disabled = !dataset;
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
