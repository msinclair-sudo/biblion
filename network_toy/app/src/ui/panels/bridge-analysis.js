// Panel: bridge analysis (MLC §6).
//
// Renders bridge-analysis.js output for the selected multi-level (or any
// multi-level) clustering: each FINE cluster histogrammed against a chosen
// COARSE parent level. A dominance threshold τ (default 0.8, adjustable)
// splits the fine clusters into two sections:
//   - Encapsulated — one dominant parent (spanCount==1 OR dominantFraction
//     ≥ τ). The clean case.
//   - Bridges — members drawn from ≥2 coarse parents with no parent above τ.
//     The straddling case the multi-level workflow is about.
//
// Reads live state.clusterLevels + state.bridgeAnalysis. The fine/coarse
// pair lives in state.bridgeConfig (changing it re-runs the cheap
// recomputeBridgeAnalysis lane); τ is a display threshold applied locally
// over the already-computed share breakdown. Clicking a row selects that
// cluster in the viewers.

import { getState, subscribe, setSelection, setBridgeConfig } from "../state.js";
import { recomputeBridgeAnalysis }                            from "../engine.js";

export const ID          = "bridge-analysis";
export const LABEL       = "Bridge analysis";
export const DESCRIPTION = "Fine clusters split into encapsulated (one dominant parent) vs bridges (spanning ≥2 coarse parents below the dominance threshold τ).";
export const SINGLETON   = true;

const DEFAULT_TAU = 0.8;

export function mount(container, _state, _config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-bridge";
  container.appendChild(wrap);

  // τ is panel-local display state (persists across re-renders).
  let tau = DEFAULT_TAU;

  function render() {
    wrap.innerHTML = "";
    const s = getState();
    const levels = s.clusterLevels || [];
    const ba = s.bridgeAnalysis;

    const header = document.createElement("div");
    header.className = "panel-bridge-header";
    const title = document.createElement("div");
    title.className = "panel-bridge-title";
    title.textContent = "Bridge analysis";
    header.appendChild(title);

    if (levels.length < 2) {
      wrap.appendChild(header);
      wrap.appendChild(empty(
        "Bridge analysis needs at least two clustering levels. Run an " +
        "Optimise multi-layer clustering (the + under a dim-reduction card), " +
        "or add a second level in the Clustering modal."));
      return;
    }
    if (!ba) {
      wrap.appendChild(header);
      wrap.appendChild(empty("Bridge analysis not yet computed."));
      return;
    }

    // ── Pair selector ──
    const pairBar = document.createElement("div");
    pairBar.className = "panel-bridge-pairbar";
    pairBar.appendChild(label("Fine:"));
    const fineSelect = select("panel-bridge-pair-select");
    for (let i = 1; i < levels.length; i++) {
      fineSelect.appendChild(option(i, `L${i}`, i === ba.fineLevel));
    }
    fineSelect.addEventListener("change", () => {
      const fine = parseInt(fineSelect.value, 10);
      const curCoarse = ba.coarseLevel;
      const coarse = (Number.isInteger(curCoarse) && curCoarse < fine) ? curCoarse : fine - 1;
      setBridgeConfig({ fineLevel: fine, coarseLevel: coarse });
      recomputeBridgeAnalysis();
    });
    pairBar.appendChild(fineSelect);

    pairBar.appendChild(label("Coarse:"));
    const coarseSelect = select("panel-bridge-pair-select");
    for (let j = 0; j < ba.fineLevel; j++) {
      coarseSelect.appendChild(option(j, `L${j}`, j === ba.coarseLevel));
    }
    coarseSelect.addEventListener("change", () => {
      setBridgeConfig({ coarseLevel: parseInt(coarseSelect.value, 10) });
      recomputeBridgeAnalysis();
    });
    pairBar.appendChild(coarseSelect);
    header.appendChild(pairBar);

    // ── τ slider ──
    const tauBar = document.createElement("div");
    tauBar.className = "panel-bridge-taubar";
    tauBar.appendChild(label("Dominance τ:"));
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0.5"; slider.max = "1"; slider.step = "0.05";
    slider.value = String(tau);
    slider.className = "panel-bridge-tau-slider";
    const tauVal = document.createElement("span");
    tauVal.className = "panel-bridge-tau-val";
    tauVal.textContent = tau.toFixed(2);
    slider.addEventListener("input", () => {
      tau = parseFloat(slider.value);
      tauVal.textContent = tau.toFixed(2);
      render();                       // local re-bucket, no engine recompute
    });
    tauBar.appendChild(slider);
    tauBar.appendChild(tauVal);
    header.appendChild(tauBar);
    wrap.appendChild(header);

    // ── Bucket fine clusters by τ at the coarse level ──
    const fine = levels[ba.fineLevel].clusterResult;
    const bridges = [];
    const encapsulated = [];
    for (const p of ba.perCluster) {
      const at = p.byLevel[ba.coarseLevel];
      const dom = at ? at.dominantFraction : 1;
      const span = at ? at.spanCount : 1;
      const isBridge = span >= 2 && dom < tau;
      const fc = fine && fine.clusters[p.fineId];
      const row = {
        fineId:  p.fineId,
        count:   p.memberCount,
        span,
        dom,
        colour:  fc ? fc.colour : "#888",
        byLevel: p.byLevel,
      };
      (isBridge ? bridges : encapsulated).push(row);
    }

    const summary = document.createElement("div");
    summary.className = "panel-bridge-summary";
    summary.textContent =
      `${bridges.length} bridge${bridges.length === 1 ? "" : "s"} · ` +
      `${encapsulated.length} encapsulated · ` +
      `L${ba.fineLevel} → L${ba.coarseLevel} parents · τ=${tau.toFixed(2)}`;
    wrap.appendChild(summary);

    renderSection(wrap, `Bridges (span ≥ 2, dominant < ${tau.toFixed(2)})`, bridges, ba, s);
    renderSection(wrap, `Encapsulated (dominant ≥ ${tau.toFixed(2)})`, encapsulated, ba, s);
  }

  // One sortable section table (shared shape for both buckets).
  function renderSection(parent, heading, rows, ba, s) {
    const h = document.createElement("div");
    h.className = "panel-bridge-section-head";
    h.textContent = `${heading} — ${rows.length}`;
    parent.appendChild(h);

    if (rows.length === 0) {
      parent.appendChild(empty("(none at this τ / pair)"));
      return;
    }

    const table = document.createElement("table");
    table.className = "panel-bridge-table";
    parent.appendChild(table);

    const baseCols = [
      { key: "colour", label: "",                         align: "left",  sortable: false, value: () => 0 },
      { key: "fineId", label: `L${ba.fineLevel} id`,      align: "right", sortable: true,  value: r => r.fineId },
      { key: "count",  label: "count",                    align: "right", sortable: true,  value: r => r.count },
      { key: "span",   label: `span @L${ba.coarseLevel}`, align: "right", sortable: true,  value: r => r.span },
      { key: "dom",    label: "dominant",                 align: "right", sortable: true,  value: r => r.dom,
        render: r => `${Math.round(r.dom * 100)}%` },
    ];
    const shareCols = [];
    for (let j = 0; j < ba.fineLevel; j++) {
      shareCols.push({
        key: `lvl${j}`, label: `L${j} shares`, align: "left", sortable: false, value: () => 0,
        render: r => {
          const at = r.byLevel.find(x => x.coarseLevel === j);
          return at ? formatShares(at.shares) : "";
        },
      });
    }
    const cols = [...baseCols, ...shareCols];

    let sortKey = "count", sortDir = "desc";
    function rebuild() {
      table.innerHTML = "";
      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      for (const col of cols) {
        const th = document.createElement("th");
        th.textContent = col.label;
        th.style.textAlign = col.align;
        if (col.sortable) {
          th.classList.add("sortable");
          if (col.key === sortKey) th.classList.add("sorted-" + sortDir);
          th.addEventListener("click", () => {
            if (sortKey === col.key) sortDir = sortDir === "asc" ? "desc" : "asc";
            else { sortKey = col.key; sortDir = "desc"; }
            rebuild();
          });
        }
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);

      const sorted = rows.slice().sort((a, b) => {
        const col = cols.find(c => c.key === sortKey);
        if (!col) return 0;
        const av = col.value(a), bv = col.value(b);
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (sortDir === "asc" ? 1 : -1);
      });

      const sel = s.selection || {};
      const isSelected = (r) => sel.type === "cluster" && sel.level === ba.fineLevel && sel.id === r.fineId;

      const tbody = document.createElement("tbody");
      for (const r of sorted) {
        const tr = document.createElement("tr");
        tr.className = "panel-bridge-row";
        if (isSelected(r)) tr.classList.add("selected");
        for (const col of cols) {
          const td = document.createElement("td");
          td.style.textAlign = col.align;
          if (col.key === "colour") {
            const swatch = document.createElement("span");
            swatch.className = "panel-bridge-swatch";
            swatch.style.background = r.colour;
            td.appendChild(swatch);
          } else if (col.render) {
            td.innerHTML = col.render(r);
          } else {
            td.textContent = String(col.value(r));
          }
          tr.appendChild(td);
        }
        tr.addEventListener("click", () => {
          if (isSelected(r)) setSelection({ type: null, id: null });
          else setSelection({ type: "cluster", level: ba.fineLevel, id: r.fineId });
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    rebuild();
  }

  render();
  const unsub = subscribe(() => render());
  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}

function empty(text) {
  const e = document.createElement("div");
  e.className = "panel-bridge-empty";
  e.textContent = text;
  return e;
}
function label(text) {
  const l = document.createElement("label");
  l.className = "panel-bridge-pairbar-label";
  l.textContent = text;
  return l;
}
function select(cls) {
  const s = document.createElement("select");
  s.className = cls;
  return s;
}
function option(value, text, selected) {
  const o = document.createElement("option");
  o.value = String(value);
  o.textContent = text;
  if (selected) o.selected = true;
  return o;
}
function formatShares(shares) {
  if (!Array.isArray(shares) || shares.length === 0) return "";
  return shares.map(sh => `${sh.id}:${Math.round(sh.fraction * 100)}%`).join("  ");
}
