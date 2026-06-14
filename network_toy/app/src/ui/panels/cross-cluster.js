// Panel: cross-cluster citation degree. For a chosen level, shows how much
// each cluster cites every other — a directed cluster×cluster flow matrix
// (heatmap), a per-cluster in/out/intra degree table, and the strongest
// inter-cluster links. A raw/normalised toggle switches the matrix between
// citation counts and row-out fractions (a→b / a's total out-citations).
//
// Binds to the selected `crossClusterCitations` card (or one in the selected
// lineage) and reads its result.

import { getState, subscribe } from "../state.js";
import { getStep, getSelectedStep, getStepAncestors } from "../workflow.js";
import { renderHeatmap }       from "../charts/heatmap.js";

export const ID          = "cross-cluster";
export const LABEL       = "Cross-cluster citations";
export const DESCRIPTION = "Directed cluster→cluster citation flow per level: a heatmap matrix, per-cluster in/out degree, and the strongest inter-cluster links.";
export const SINGLETON   = true;

export function mount(container, _state, config = {}) {
  const fixedStepId = (config && config.stepId) || null;
  let ui = { level: 0, normalised: false };
  let seededFor = null;

  function resolveResult() {
    // J16: cross-cluster citations is no longer a card. It auto-computes after
    // the layer ladder commits and writes state.crossClusterCitations, which a
    // singleton (no-stepId) panel reads directly — mirrors bridge analysis.
    // The card-bound lookup below is kept only for legacy saved workflows that
    // still carry a crossClusterCitations step; new runs hit the state path.
    let card = null;
    if (fixedStepId) card = getStep(fixedStepId);
    else {
      const sel = getSelectedStep();
      if (sel && sel.type === "crossClusterCitations") card = sel;
      else if (sel) {
        const anc = getStepAncestors(sel.id).filter(s => s.type === "crossClusterCitations");
        card = anc.length ? anc[anc.length - 1] : null;
      }
    }
    const cc = (card && card.result && card.result.crossClusterCitations)
      || getState().crossClusterCitations;
    return { card, cc };
  }

  function render() {
    container.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "xcc-panel";

    const title = document.createElement("div");
    title.className = "xcc-title";
    title.textContent = "Cross-cluster citations";
    wrap.appendChild(title);

    const { cc } = resolveResult();
    if (!cc || !Array.isArray(cc.byLayer) || cc.byLayer.length === 0) {
      wrap.appendChild(empty(
        "No cross-cluster citations yet — they auto-compute once a layer ladder " +
        "is committed and the dataset carries citation edges. On toy data " +
        "without citations, generate them first, then re-pick the layers."));
      container.appendChild(wrap);
      return;
    }

    if (seededFor !== cc) { ui.level = 0; seededFor = cc; }
    if (ui.level >= cc.byLayer.length) ui.level = cc.byLayer.length - 1;
    const L = cc.byLayer[ui.level];

    // ── controls: level + raw/normalised ──
    const ctrl = document.createElement("div");
    ctrl.className = "xcc-ctrl";
    const lvlLab = document.createElement("label");
    lvlLab.textContent = "Level";
    ctrl.appendChild(lvlLab);
    const lvlSel = document.createElement("select");
    lvlSel.className = "xcc-select";
    cc.byLayer.forEach((b, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `L${b.layer} · ${b.k} clusters`;
      if (i === ui.level) o.selected = true;
      lvlSel.appendChild(o);
    });
    lvlSel.addEventListener("change", () => { ui.level = Number(lvlSel.value); render(); });
    ctrl.appendChild(lvlSel);

    const normBtn = document.createElement("button");
    normBtn.className = "xcc-norm-btn" + (ui.normalised ? " active" : "");
    normBtn.textContent = ui.normalised ? "Normalised" : "Raw counts";
    normBtn.title = "Toggle between citation counts and a→b as a fraction of a's out-citations";
    normBtn.addEventListener("click", () => { ui.normalised = !ui.normalised; render(); });
    ctrl.appendChild(normBtn);
    wrap.appendChild(ctrl);

    const summary = document.createElement("div");
    summary.className = "xcc-summary";
    const totalUsed = L.edgesUsed || 0;
    summary.textContent = `${L.k} clusters · ${totalUsed} citations mapped` +
      (L.edgesDropped ? ` · ${L.edgesDropped} to/from noise` : "");
    wrap.appendChild(summary);

    // ── matrix heatmap ──
    const labels = L.clusterIds.map(id => `c${id}`);
    let matrix = L.matrix;
    let vmax = 1, fmt = (v) => v ? String(v) : "";
    if (ui.normalised) {
      matrix = L.matrix.map(row => {
        const out = row.reduce((a, b) => a + b, 0) || 1;
        return row.map(v => v / out);
      });
      vmax = 1;
      fmt = (v) => v ? v.toFixed(2) : "";
    } else {
      vmax = Math.max(1, ...L.matrix.flat());
    }
    const heatHost = document.createElement("div");
    heatHost.className = "xcc-heatmap";
    wrap.appendChild(heatHost);
    renderHeatmap(heatHost, {
      matrix, rowLabels: labels, colLabels: labels,
      vmin: 0, vmax,
      cellSize: Math.max(18, Math.min(40, Math.floor(360 / Math.max(1, L.k)))),
      legendLabel: ui.normalised ? "out-fraction" : "citations",
      formatCell: fmt,
      cellTitle: (r, c, v) => `${r} → ${c}: ${ui.normalised ? v.toFixed(3) : v}`,
    });
    const axisNote = document.createElement("div");
    axisNote.className = "xcc-axis-note";
    axisNote.textContent = "row → column (citing → cited)";
    wrap.appendChild(axisNote);

    // ── per-cluster degree table ──
    const table = document.createElement("table");
    table.className = "xcc-table";
    table.innerHTML =
      "<thead><tr><th>cluster</th><th>size</th><th>out</th><th>in</th><th>intra</th></tr></thead>";
    const tb = document.createElement("tbody");
    for (const pc of L.perCluster) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>c${pc.id}</td><td>${pc.size}</td><td>${pc.outDeg}</td><td>${pc.inDeg}</td><td>${pc.intra}</td>`;
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    wrap.appendChild(table);

    // ── top inter-cluster links ──
    if (L.topLinks && L.topLinks.length) {
      const lh = document.createElement("div");
      lh.className = "xcc-links-head";
      lh.textContent = "Top inter-cluster links";
      wrap.appendChild(lh);
      const ul = document.createElement("div");
      ul.className = "xcc-links";
      for (const lk of L.topLinks.slice(0, 8)) {
        const li = document.createElement("div");
        li.className = "xcc-link";
        li.textContent = `c${lk.a} → c${lk.b}: ${lk.count}`;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }

    container.appendChild(wrap);
  }

  render();
  const unsub = subscribe(() => render());
  return { update() { render(); }, destroy() { unsub(); container.innerHTML = ""; } };
}

function empty(text) {
  const e = document.createElement("div");
  e.className = "xcc-empty";
  e.textContent = text;
  return e;
}
