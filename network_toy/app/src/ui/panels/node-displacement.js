// Panel: node displacement (pre → post fusion). Shows how far each paper moved
// between the pre- and post-fusion embeddings — the papers whose citation
// context most disagrees with their semantic position sit at the top. Summary
// (alignment quality + max/mean), a top-movers table (id · title · distance),
// and a Download RIS of the top movers.
//
// Binds to the selected nodeDisplacement card; reads its result. Colour the
// viewer by "Fusion displacement" to see the movers in place.

import { getState, subscribe } from "../state.js";
import { getStep, getSelectedStep, getStepAncestors } from "../workflow.js";
import { getNodeText, getNodeRecord, hasSqliteText } from "../../datasource/sqlite.js";
import { formatRis } from "../../export/ris.js";
import { downloadText } from "../../export/cluster-export.js";

export const ID          = "node-displacement";
export const LABEL       = "Fusion displacement";
export const DESCRIPTION = "How far each paper moved between the pre- and post-fusion embeddings — ranks papers whose citation context shifted them most. Top-movers table + RIS export.";
export const SINGLETON   = true;

const TOP_SHOWN = 40;

export function mount(container, _state, config = {}) {
  const fixedStepId = (config && config.stepId) || null;

  function resolveResult() {
    let card = null;
    if (fixedStepId) card = getStep(fixedStepId);
    else {
      const sel = getSelectedStep();
      if (sel && sel.type === "nodeDisplacement") card = sel;
      else if (sel) {
        const anc = getStepAncestors(sel.id).filter(s => s.type === "nodeDisplacement");
        card = anc.length ? anc[anc.length - 1] : null;
      }
    }
    return card && card.result && card.result.nodeDisplacement;
  }

  function render() {
    container.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "disp-panel";
    const title = document.createElement("div");
    title.className = "disp-title";
    title.textContent = "Fusion displacement (pre → post)";
    wrap.appendChild(title);

    const nd = resolveResult();
    if (!nd || !nd.topMovers) {
      const e = document.createElement("div");
      e.className = "disp-empty";
      e.textContent = "No displacement run on this branch — add a “Node displacement” step from a fusion-branch card’s “+” (needs a graph-diffusion dim-reduction).";
      wrap.appendChild(e);
      container.appendChild(wrap);
      return;
    }

    const summary = document.createElement("div");
    summary.className = "disp-summary";
    const corr = Number.isFinite(nd.correlation) ? nd.correlation.toFixed(2) : "—";
    summary.textContent =
      `alignment ${corr} · max ${nd.max.toFixed(3)} · mean ${nd.mean.toFixed(3)} · ` +
      `colour the viewer by “Fusion displacement” to see them in place`;
    wrap.appendChild(summary);

    // Top-movers table.
    const table = document.createElement("table");
    table.className = "disp-table";
    table.innerHTML = "<thead><tr><th>#</th><th>title</th><th>moved</th></tr></thead>";
    const tb = document.createElement("tbody");
    const movers = nd.topMovers.slice(0, TOP_SHOWN);
    for (const m of movers) {
      const tr = document.createElement("tr");
      const txt = hasSqliteText() ? (getNodeText(m.id) || "") : "";
      const titleStr = txt ? txt.split(". ")[0].slice(0, 90) : `node ${m.id}`;
      tr.innerHTML = `<td>${m.id}</td><td class="disp-cell-title"></td><td>${m.dist.toFixed(3)}</td>`;
      tr.querySelector(".disp-cell-title").textContent = titleStr;
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    wrap.appendChild(table);

    // Download the top movers as RIS.
    if (hasSqliteText()) {
      const btn = document.createElement("button");
      btn.className = "disp-export";
      btn.textContent = `Download top ${movers.length} movers (RIS)`;
      btn.addEventListener("click", () => {
        const records = [], notes = [];
        for (const m of movers) {
          const rec = getNodeRecord(m.id);
          if (!rec) continue;
          records.push(rec);
          notes.push(`fusion displacement ${m.dist.toFixed(3)} (pre→post)`);
        }
        if (records.length) downloadText(formatRis(records, notes), "fusion-displacement-top-movers.ris");
      });
      wrap.appendChild(btn);
    }

    container.appendChild(wrap);
  }

  render();
  const unsub = subscribe(() => render());
  return { update() { render(); }, destroy() { unsub(); container.innerHTML = ""; } };
}
