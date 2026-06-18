// Node table — the legend for whatever's currently colouring the
// 3D viewer.
//
// Source modes:
//   "auto"            — follows the active 3D viewer's colourMode
//   "cluster:N"       — clusters at level N (one row per cluster)
//   "cluster:finest"  — legacy alias for the last level; resolved in
//                       clusterRows but no longer offered as a source
//                       option
//   "origin"          — generator origins (one row per Gaussian centre)
//   "inDeg"           — top-N nodes by citation in-degree
//   "t"               — 10 time bins
//
// Each mode emits {columns, rows} via a small builder. The renderer
// is generic — sortable headers, colour-swatch cells, click-to-select
// row handlers. Selection emits a typed object that viewer-3d uses
// for dimming:
//
//   {type: "cluster", level: N, id: cid}
//   {type: "origin",  id: oid}
//   {type: "node",    id: nodeId}
//   {type: "nodes",   key, ids}   — any grouping/bin row (e.g. year bins):
//                                   carries the resolved node ids directly so
//                                   selecting it selects those nodes, whatever
//                                   the table view.

import {
  getState, setSelection, setTabConfig, setBridgeConfig,
  addToCart, clearCart,
} from "../state.js";
import { recomputeBridgeAnalysis } from "../engine.js";
import { getIdByRow } from "../../datasource/sqlite.js";
import { downloadText } from "../../export/cluster-export.js";
import {
  tGradient, inDegGradient, boundaryScoreGradient,
  T_STOPS, INDEG_STOPS, BOUNDARY_STOPS, cssLinearGradient,
} from "../gradients.js";
import { preserveScroll } from "../widgets.js";

export const ID = "node-table";
export const LABEL = "Node table";
export const DESCRIPTION = "Legend for the active colouring. Set Source to Auto to follow the 3D viewer, or pin to a specific source (cluster level, origin, in-degree, time).";

const TOP_N_INDEG = 50;
const T_BINS      = 10;

export function mount(container, _state, config = {}, tabContext = null) {
  container.innerHTML = "";

  // Working source — committed to tab config when changed.
  let source = config.source || "auto";

  // Sort state local to this panel; reset on source change.
  let sortKey = null;
  let sortDir = "desc";

  const root = document.createElement("div");
  root.className = "node-table-root";
  container.appendChild(root);

  // ── header bar ──────────────────────────────────────────────────
  const headBar = document.createElement("div");
  headBar.className = "node-table-headbar";

  const sourceLabel = document.createElement("label");
  sourceLabel.className = "node-table-headbar-label";
  sourceLabel.textContent = "Source:";
  headBar.appendChild(sourceLabel);

  const sourceSelect = document.createElement("select");
  sourceSelect.className = "node-table-source-select";
  headBar.appendChild(sourceSelect);

  const statusEl = document.createElement("span");
  statusEl.className = "node-table-status";
  headBar.appendChild(statusEl);

  root.appendChild(headBar);

  // ── cart bar ────────────────────────────────────────────────────
  // Minimal commit surface for the cluster→cart→biblion-subset round-trip.
  // Add the selected cluster's papers to the cart, then export ids as JSON to
  // feed `biblion advanced subset make <name> --ids-file <file>`. This is the
  // temporary home until the (deferred) cart data-wrangle panel owns it.
  const cartBar = document.createElement("div");
  cartBar.className = "node-table-cartbar";

  const cartAddBtn = document.createElement("button");
  cartAddBtn.className = "node-table-cart-btn";
  cartAddBtn.textContent = "+ Add cluster to cart";
  cartBar.appendChild(cartAddBtn);

  const cartCountEl = document.createElement("span");
  cartCountEl.className = "node-table-cart-count";
  cartBar.appendChild(cartCountEl);

  const cartExportBtn = document.createElement("button");
  cartExportBtn.className = "node-table-cart-btn";
  cartExportBtn.textContent = "Export cart ids";
  cartBar.appendChild(cartExportBtn);

  const cartClearBtn = document.createElement("button");
  cartClearBtn.className = "node-table-cart-btn";
  cartClearBtn.textContent = "Clear";
  cartBar.appendChild(cartClearBtn);

  root.appendChild(cartBar);

  cartAddBtn.addEventListener("click", () => {
    const added = addSelectedClusterToCart(getState());
    if (added != null) cartAddBtn.textContent = `+ Added ${added}`;
    setTimeout(() => { cartAddBtn.textContent = cartAddLabel(getState()); }, 1200);
  });
  cartExportBtn.addEventListener("click", () => exportCart(getState()));
  cartClearBtn.addEventListener("click", () => clearCart());

  // ── bridge pair selector (visible only for bridge / boundaryScore) ──
  const pairBar = document.createElement("div");
  pairBar.className = "node-table-pairbar";
  pairBar.style.display = "none";

  const fineLabel = document.createElement("label");
  fineLabel.className = "node-table-pairbar-label";
  fineLabel.textContent = "Fine:";
  pairBar.appendChild(fineLabel);

  const fineSelect = document.createElement("select");
  fineSelect.className = "node-table-pair-select";
  pairBar.appendChild(fineSelect);

  const coarseLabel = document.createElement("label");
  coarseLabel.className = "node-table-pairbar-label";
  coarseLabel.textContent = "Coarse:";
  pairBar.appendChild(coarseLabel);

  const coarseSelect = document.createElement("select");
  coarseSelect.className = "node-table-pair-select";
  pairBar.appendChild(coarseSelect);

  root.appendChild(pairBar);

  fineSelect.addEventListener("change", () => {
    const fine = parseInt(fineSelect.value, 10);
    const cur  = getState().bridgeConfig || {};
    const coarse = (Number.isInteger(cur.coarseLevel) && cur.coarseLevel < fine)
      ? cur.coarseLevel
      : fine - 1;
    setBridgeConfig({ fineLevel: fine, coarseLevel: coarse });
    recomputeBridgeAnalysis();
  });

  coarseSelect.addEventListener("change", () => {
    setBridgeConfig({ coarseLevel: parseInt(coarseSelect.value, 10) });
    recomputeBridgeAnalysis();
  });

  // ── gradient legend (continuous-source legends only) ────────────
  const gradientBar = document.createElement("div");
  gradientBar.className = "node-table-gradient";
  gradientBar.style.display = "none";   // shown only when buildTableData returns one
  root.appendChild(gradientBar);

  // ── empty state hint ────────────────────────────────────────────
  const empty = document.createElement("div");
  empty.className = "node-table-empty";
  root.appendChild(empty);

  // ── scrollable table ────────────────────────────────────────────
  const wrap = document.createElement("div");
  wrap.className = "node-table-scroll";
  root.appendChild(wrap);

  const table = document.createElement("table");
  table.className = "node-table";
  wrap.appendChild(table);
  const thead = document.createElement("thead");
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  const footer = document.createElement("div");
  footer.className = "node-table-footer";
  root.appendChild(footer);

  let lastSourceKey = null;
  let lastEngineRev = -1;
  let lastViewerMode = null;

  sourceSelect.addEventListener("change", () => {
    source = sourceSelect.value;
    if (tabContext) setTabConfig(tabContext.slot, tabContext.tabId, { source });
    sortKey = null;
    fullRender();
  });

  function fullRender() {
    const s = getState();
    rebuildSourceOptions(s);
    const effective = effectiveSource(s, source);
    rebuildPairBar(s, effective);
    const data = buildTableData(s, effective);
    statusEl.textContent = data.title || "";
    if (lastSourceKey !== effective) {
      lastSourceKey = effective;
      sortKey = data.defaultSort ? data.defaultSort.key : null;
      sortDir = data.defaultSort ? data.defaultSort.dir : "desc";
    }
    renderGradient(data.gradient);
    renderHeader(data.columns);
    preserveScroll(wrap, () => renderRows(data.columns, data.rows, data.selectionKey));
    footer.textContent = `${data.rows.length} ${data.unitLabel || "rows"}`;
    refreshCartBar(s);
  }

  // ── cart bar helpers ────────────────────────────────────────────
  function selectedCluster(s) {
    const sel = s.selection;
    if (!sel || sel.type !== "cluster") return null;
    const lvl = (s.clusterLevels || [])[sel.level];
    if (!lvl || !lvl.clusterResult) return null;
    return { level: sel.level, id: sel.id, cr: lvl.clusterResult };
  }

  function cartAddLabel(s) {
    const c = selectedCluster(s);
    return c ? `+ Add L${c.level}·c${c.id} to cart` : "+ Add cluster to cart";
  }

  function refreshCartBar(s) {
    const n = (s.cart || []).length;
    cartCountEl.textContent = n ? `cart: ${n}` : "cart empty";
    cartExportBtn.disabled = n === 0;
    cartClearBtn.disabled = n === 0;
    const c = selectedCluster(s);
    cartAddBtn.disabled = !c;
    cartAddBtn.textContent = cartAddLabel(s);
  }

  // Gather the selected cluster's members → cart. Returns the count added, or
  // null if no cluster is selected.
  function addSelectedClusterToCart(s) {
    const c = selectedCluster(s);
    if (!c) return null;
    const source = `L${c.level}·c${c.id}`;
    const items = [];
    const nc = c.cr.nodeCluster;
    const nodes = (s.genResult && s.genResult.nodes) || [];
    for (let nodeId = 0; nodeId < nc.length; nodeId++) {
      if (nc[nodeId] !== c.id) continue;
      // Prefer the node's own paperId (survives a project reload); getIdByRow
      // only works while the live sqlite handle is present (see scoring.js).
      const node = nodes[nodeId];
      const paperId = (node && node.paperId != null) ? node.paperId : getIdByRow(nodeId);
      if (paperId != null) items.push({ paperId, nodeId, source });
    }
    return addToCart(items);
  }

  function exportCart(s) {
    const cart = s.cart || [];
    if (cart.length === 0) return;
    const payload = { papers: cart.map(it => ({ id: it.paperId, source: it.source })) };
    downloadText(JSON.stringify(payload, null, 2), "cart-ids.json", "application/json");
  }

  function rebuildPairBar(s, effective) {
    const isBridgeSource = effective === "bridge" || effective === "boundaryScore";
    const levels = s.clusterLevels || [];
    if (!isBridgeSource || levels.length < 2) {
      pairBar.style.display = "none";
      return;
    }
    pairBar.style.display = "flex";

    const cfg = s.bridgeConfig || {};
    const fine   = Number.isInteger(cfg.fineLevel)   ? cfg.fineLevel   : levels.length - 1;
    const coarse = Number.isInteger(cfg.coarseLevel) ? cfg.coarseLevel : fine - 1;

    // Fine-level options: any level except the very first (need ≥1 coarser).
    fineSelect.innerHTML = "";
    for (let i = 1; i < levels.length; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `L${i}`;
      if (i === fine) opt.selected = true;
      fineSelect.appendChild(opt);
    }

    // Coarse-level options: any level strictly above (idx < fine).
    coarseSelect.innerHTML = "";
    for (let i = 0; i < fine; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `L${i}`;
      if (i === coarse) opt.selected = true;
      coarseSelect.appendChild(opt);
    }
  }

  function renderGradient(gradient) {
    if (!gradient) {
      gradientBar.style.display = "none";
      gradientBar.innerHTML = "";
      return;
    }
    gradientBar.style.display = "grid";
    gradientBar.innerHTML = "";
    // DOM order = visual order (4-column grid):
    //   [label] [min] [bar] [max]
    const lab = document.createElement("span");
    lab.className = "node-table-gradient-label";
    lab.textContent = gradient.label || "";
    gradientBar.appendChild(lab);

    const minLab = document.createElement("span");
    minLab.className = "node-table-gradient-min";
    minLab.textContent = formatGradientNumber(gradient.min);
    gradientBar.appendChild(minLab);

    const bar = document.createElement("span");
    bar.className = "node-table-gradient-bar";
    bar.style.background = cssLinearGradient(gradient.stops);
    gradientBar.appendChild(bar);

    const maxLab = document.createElement("span");
    maxLab.className = "node-table-gradient-max";
    maxLab.textContent = formatGradientNumber(gradient.max);
    gradientBar.appendChild(maxLab);
  }

  function formatGradientNumber(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    if (Number.isInteger(v) || Math.abs(v) >= 10) return String(Math.round(v));
    return v.toFixed(2);
  }

  function rebuildSourceOptions(s) {
    const opts = sourceOptionsFor(s);
    sourceSelect.innerHTML = "";
    let matched = false;
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === source) {
        opt.selected = true;
        matched = true;
      }
      sourceSelect.appendChild(opt);
    }
    if (!matched && opts.length > 0) {
      const auto = opts.find(o => o.value === "auto");
      source = auto ? auto.value : opts[0].value;
      sourceSelect.value = source;
      if (tabContext) setTabConfig(tabContext.slot, tabContext.tabId, { source });
    }
  }

  function renderHeader(columns) {
    thead.innerHTML = "";
    const tr = document.createElement("tr");
    for (const col of columns) {
      const th = document.createElement("th");
      th.className = "node-table-th " + (col.sortable ? "sortable" : "");
      th.textContent = col.label;
      if (col.sortable && col.key === sortKey) {
        th.classList.add("sorted-" + sortDir);
        const arrow = document.createElement("span");
        arrow.className = "sort-indicator";
        arrow.textContent = sortDir === "asc" ? "▲" : "▼";
        th.appendChild(arrow);
      }
      if (col.sortable) {
        th.addEventListener("click", () => {
          if (sortKey === col.key) {
            sortDir = sortDir === "asc" ? "desc" : "asc";
          } else {
            sortKey = col.key;
            sortDir = (col.kind === "int" || col.kind === "float") ? "desc" : "asc";
          }
          fullRender();
        });
      }
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

  function renderRows(columns, rows, selectionKey) {
    tbody.innerHTML = "";
    if (rows.length === 0) {
      empty.style.display = "block";
      empty.textContent = "Nothing to show for this source yet.";
      wrap.style.display = "none";
      return;
    }
    empty.style.display = "none";
    wrap.style.display = "block";

    const sorted = sortKey != null
      ? rows.slice().sort((a, b) => compareBy(a, b, sortKey, sortDir))
      : rows;
    const sel = getState().selection;

    for (const row of sorted) {
      const tr = document.createElement("tr");
      tr.className = "node-table-row";
      tr.dataset.rowKey = row._key;
      const isSel = sel && selectionKey && selectionKey(row, sel);
      if (isSel) tr.classList.add("selected");

      for (const col of columns) {
        const td = document.createElement("td");
        td.className = `node-table-cell node-table-cell-${col.kind}`;
        if (col.kind === "colour") {
          const sw = document.createElement("span");
          sw.className = "colour-swatch";
          sw.style.background = row[col.key] || "#888";
          td.appendChild(sw);
        } else {
          td.textContent = formatCell(row[col.key], col.kind);
        }
        tr.appendChild(td);
      }

      tr.addEventListener("click", () => {
        if (!row._select) return;
        const cur = getState().selection;
        const proposed = row._select();
        if (cur && sameSelection(cur, proposed)) {
          setSelection({ type: null, id: null });
        } else {
          setSelection(proposed);
        }
      });

      tbody.appendChild(tr);
    }
  }

  // Initial.
  fullRender();

  return {
    update(s) {
      const viewerMode = activeViewerColourMode(s);
      if (s.engineRevision !== lastEngineRev || viewerMode !== lastViewerMode) {
        lastEngineRev = s.engineRevision;
        lastViewerMode = viewerMode;
        fullRender();
      } else {
        // Selection-only change: cheap repaint of row highlight.
        repaintSelectionOnly();
      }
    },
    destroy() {
      container.innerHTML = "";
    },
  };

  function repaintSelectionOnly() {
    const s = getState();
    const data = buildTableData(s, effectiveSource(s, source));
    const selectionKey = data.selectionKey;
    const sel = s.selection;
    for (const tr of tbody.querySelectorAll(".node-table-row")) {
      const matched = data.rows.find(r => r._key === tr.dataset.rowKey);
      const isSel = sel && selectionKey && matched && selectionKey(matched, sel);
      tr.classList.toggle("selected", !!isSel);
    }
    refreshCartBar(s);
  }
}

/* ── source resolution ────────────────────────────────────────────── */

function effectiveSource(s, source) {
  if (source !== "auto") return source;
  return activeViewerColourMode(s) || "cluster:finest";
}

function activeViewerColourMode(s) {
  for (const slot of Object.keys(s.panels)) {
    for (const tab of s.panels[slot].tabs) {
      if (tab.type === "viewer-3d") {
        return (tab.config && tab.config.colourMode) || "cluster:finest";
      }
    }
  }
  return null;
}

function sourceOptionsFor(s) {
  const opts = [];
  opts.push({ value: "auto", label: "Auto (follow 3D viewer)" });
  const levels = s.clusterLevels || [];
  if (levels.length > 0) {
    for (let i = 0; i < levels.length; i++) {
      opts.push({
        value: `cluster:${i}`,
        label: levels.length > 1 ? `Cluster (level ${i})` : "Cluster",
      });
    }
  }
  if (s.bridgeAnalysis) {
    opts.push({ value: "bridge",        label: "Bridge clusters" });
    opts.push({ value: "boundaryScore", label: "Boundary score (per fine cluster)" });
  }
  if (s.genResult && s.genResult.origins) {
    opts.push({ value: "origin", label: "Origin (generator label)" });
  }
  opts.push({ value: "year", label: "Publication year" });
  if (s.citationResult) {
    opts.push({ value: "inDeg:raw", label: "Citation in-degree (count)" });
    opts.push({ value: "inDeg:log", label: "Citation in-degree (log)" });
  }
  return opts;
}

/* ── per-source row builders ──────────────────────────────────────── */

function buildTableData(s, source) {
  if (source && source.startsWith("cluster")) return clusterRows(s, source);
  if (source === "bridge")        return bridgeRows(s);
  if (source === "boundaryScore") return boundaryScoreRows(s);
  if (source === "origin")        return originRows(s);
  if (source === "inDeg" || source === "inDeg:raw" || source === "inDeg:log") {
    return inDegRows(s, source);
  }
  if (source === "t" || source === "year") return timeBinRows(s);
  return { columns: [], rows: [], unitLabel: "rows", title: "" };
}

function clusterRows(s, source) {
  const levels = s.clusterLevels || [];
  if (levels.length === 0) {
    return { columns: [], rows: [], unitLabel: "clusters", title: "no clusters yet" };
  }
  let levelIdx;
  if (source === "cluster:finest") levelIdx = levels.length - 1;
  else levelIdx = parseInt(source.slice(8), 10);
  if (!Number.isFinite(levelIdx) || levelIdx < 0 || levelIdx >= levels.length) {
    levelIdx = levels.length - 1;
  }
  const cr = levels[levelIdx].clusterResult;
  const rows = cr.clusters.map(c => ({
    _key:    `cluster:${levelIdx}:${c.id}`,
    _select: () => ({ type: "cluster", level: levelIdx, id: c.id }),
    colour:  c.colour,
    id:      c.id,
    count:   c.count,
    spread:  c.spread,
    stab:    c.stability,
  }));
  return {
    title:      `level ${levelIdx} · ${cr.method}`,
    unitLabel:  rows.length === 1 ? "cluster" : "clusters",
    columns: [
      { key: "colour", label: "",       kind: "colour", sortable: false },
      { key: "id",     label: "id",     kind: "int",    sortable: true  },
      { key: "count",  label: "count",  kind: "int",    sortable: true  },
      { key: "spread", label: "spread", kind: "float",  sortable: true  },
      { key: "stab",   label: "stab.",  kind: "float",  sortable: true  },
    ],
    rows,
    defaultSort: { key: "count", dir: "desc" },
    selectionKey: (row, sel) =>
      sel.type === "cluster" && sel.level === levelIdx && sel.id === row.id,
  };
}

// Format a per-level shares array as a compact cell string:
//   "1: 60%  2: 25%  3: 15%"
// Empty (no members or noise-only) → "—".
function formatShares(shares) {
  if (!shares || shares.length === 0) return "—";
  return shares
    .map(s => `${s.id}:${Math.round(s.fraction * 100)}%`)
    .join("  ");
}

// Build one column per coarser level [0, fineLevel - 1]. Each column
// exposes that fine cluster's coarse-membership distribution as a
// share string. The chosen comparison level is highlighted in the
// header label so the user sees which pair drives the colour modes.
function levelShareColumns(ba) {
  return ba.levels.map(li => ({
    key:      `lvl${li}`,
    label:    li === ba.coarseLevel ? `L${li} ★` : `L${li}`,
    kind:     "text",
    sortable: false,
  }));
}

// Spread a perCluster entry's byLevel into the row object as
// `lvl{i}` keys so the dynamic columns can read them.
function fanoutLevelShares(row, p) {
  for (const at of p.byLevel) {
    row[`lvl${at.coarseLevel}`] = formatShares(at.shares);
  }
}

function boundaryScoreRows(s) {
  const ba = s.bridgeAnalysis;
  const levels = s.clusterLevels || [];
  if (!ba || levels.length < 2) {
    return {
      columns: [], rows: [], unitLabel: "clusters",
      title: "needs at least two clustering levels",
    };
  }

  const rows = ba.perCluster.map(p => {
    const at = p.byLevel[ba.coarseLevel];
    const score = at ? 1 - at.dominantFraction : 0;
    const row = {
      _key:    `bs:${p.fineId}`,
      _select: () => ({ type: "cluster", level: ba.fineLevel, id: p.fineId }),
      // Gradient swatch matches viewer-3d's boundaryScore colouring.
      colour:  boundaryScoreGradient(score),
      id:      p.fineId,
      count:   p.memberCount,
      score,
      span:    at ? at.spanCount : 0,
    };
    fanoutLevelShares(row, p);
    return row;
  });

  const dynamicColumns = levelShareColumns(ba);
  return {
    title:     `L${ba.fineLevel} clusters · score vs L${ba.coarseLevel}`,
    unitLabel: "clusters",
    columns: [
      { key: "colour", label: "",                       kind: "colour", sortable: false },
      { key: "id",     label: `L${ba.fineLevel} id`,    kind: "int",    sortable: true  },
      { key: "count",  label: "count",                  kind: "int",    sortable: true  },
      { key: "score",  label: "score",                  kind: "float",  sortable: true  },
      { key: "span",   label: `span @L${ba.coarseLevel}`, kind: "int",  sortable: true  },
      ...dynamicColumns,
    ],
    rows,
    defaultSort: { key: "score", dir: "desc" },
    selectionKey: (row, sel) =>
      sel.type === "cluster" && sel.level === ba.fineLevel && sel.id === row.id,
    gradient: { stops: BOUNDARY_STOPS, min: 0, max: 1, label: "boundary score" },
  };
}

function bridgeRows(s) {
  const ba = s.bridgeAnalysis;
  const levels = s.clusterLevels || [];
  if (!ba || levels.length < 2) {
    return {
      columns: [], rows: [], unitLabel: "bridges",
      title: "needs at least two clustering levels",
    };
  }
  const fine = levels[ba.fineLevel].clusterResult;

  // Filter to fine clusters that bridge AT THE CHOSEN coarse level.
  // The per-level columns reveal the full picture across all coarser
  // levels — a cluster may bridge L0 but not L2, etc.
  const rows = ba.perCluster
    .filter(p => p.isBridgeAtCoarse)
    .map(p => {
      const fineCluster = fine.clusters[p.fineId];
      const at = p.byLevel[ba.coarseLevel];
      const row = {
        _key:    `bridge:${p.fineId}`,
        _select: () => ({ type: "cluster", level: ba.fineLevel, id: p.fineId }),
        colour:  fineCluster ? fineCluster.colour : "#888",
        id:      p.fineId,
        count:   p.memberCount,
        span:    at ? at.spanCount : 0,
      };
      fanoutLevelShares(row, p);
      return row;
    });

  const dynamicColumns = levelShareColumns(ba);
  return {
    title:     `${ba.bridgeCount} bridge${ba.bridgeCount === 1 ? "" : "s"} · L${ba.fineLevel} clusters spanning ≥2 L${ba.coarseLevel} parents`,
    unitLabel: rows.length === 1 ? "bridge" : "bridges",
    columns: [
      { key: "colour", label: "",                              kind: "colour", sortable: false },
      { key: "id",     label: `L${ba.fineLevel} id`,           kind: "int",    sortable: true  },
      { key: "count",  label: "count",                         kind: "int",    sortable: true  },
      { key: "span",   label: `span @L${ba.coarseLevel}`,      kind: "int",    sortable: true  },
      ...dynamicColumns,
    ],
    rows,
    defaultSort: { key: "count", dir: "desc" },
    selectionKey: (row, sel) =>
      sel.type === "cluster" && sel.level === ba.fineLevel && sel.id === row.id,
  };
}

function originRows(s) {
  const origins = s.genResult && s.genResult.origins;
  const nodes   = s.genResult && s.genResult.nodes;
  if (!origins || !nodes) {
    return { columns: [], rows: [], unitLabel: "origins", title: "no data" };
  }
  const counts = new Array(origins.length).fill(0);
  for (const n of nodes) counts[n.originId]++;

  const rows = origins.map((o, idx) => {
    const sx = o.spread[0], sy = o.spread[1], sz = o.spread[2];
    const rmsSpread = Math.sqrt((sx*sx + sy*sy + sz*sz) / 3);
    return {
      _key:    `origin:${o.id}`,
      _select: () => ({ type: "origin", id: o.id }),
      colour:  o.colour,
      id:      o.id,
      count:   counts[idx] || 0,
      spread:  rmsSpread,
      cx:      o.centre[0],
      cy:      o.centre[1],
      cz:      o.centre[2],
    };
  });
  return {
    title:     `${origins.length} origin${origins.length === 1 ? "" : "s"}`,
    unitLabel: rows.length === 1 ? "origin" : "origins",
    columns: [
      { key: "colour", label: "",       kind: "colour", sortable: false },
      { key: "id",     label: "id",     kind: "int",    sortable: true  },
      { key: "count",  label: "count",  kind: "int",    sortable: true  },
      { key: "spread", label: "spread", kind: "float",  sortable: true  },
      { key: "cx",     label: "cx",     kind: "float",  sortable: true  },
      { key: "cy",     label: "cy",     kind: "float",  sortable: true  },
      { key: "cz",     label: "cz",     kind: "float",  sortable: true  },
    ],
    rows,
    defaultSort: { key: "count", dir: "desc" },
    selectionKey: (row, sel) => sel.type === "origin" && sel.id === row.id,
  };
}

function inDegRows(s, source = "inDeg") {
  const cit   = s.citationResult;
  const nodes = s.genResult && s.genResult.nodes;
  if (!cit || !cit.inDeg || !nodes) {
    return { columns: [], rows: [], unitLabel: "nodes", title: "no citation graph" };
  }
  const cl = s.clusterResult;
  const isLog = source === "inDeg:log";
  // Max in-degree once → consistent scaling that matches the viewer's
  // colour-modes inDegStats (so the table reads as the legend).
  let maxIn = 1;
  for (let i = 0; i < cit.inDeg.length; i++) {
    if (cit.inDeg[i] > maxIn) maxIn = cit.inDeg[i];
  }
  const logMax = Math.log1p(maxIn);
  const grad = (c) => inDegGradient(isLog
    ? (logMax > 0 ? Math.log1p(c) / logMax : 0)
    : (maxIn > 0 ? c / maxIn : 0));

  const all = [];
  for (let i = 0; i < nodes.length; i++) {
    const cid = cl ? cl.nodeCluster[i] : -1;
    const inDeg = cit.inDeg[i];
    all.push({
      _key:    `node:${i}`,
      _select: () => ({ type: "node", id: i }),
      colour:  grad(inDeg),
      id:      i,
      inDeg,
      year:    Number.isFinite(nodes[i].year) ? nodes[i].year : null,
      cluster: cid,
    });
  }
  all.sort((a, b) => b.inDeg - a.inDeg);
  const rows = all.slice(0, TOP_N_INDEG);
  return {
    title:     `top ${rows.length} of ${nodes.length} by in-degree` + (isLog ? " (log scale)" : ""),
    unitLabel: "nodes",
    columns: [
      { key: "colour",  label: "",        kind: "colour", sortable: false },
      { key: "id",      label: "id",      kind: "int",    sortable: true  },
      { key: "inDeg",   label: "in-deg",  kind: "int",    sortable: true  },
      { key: "year",    label: "year",    kind: "int",    sortable: true  },
      { key: "cluster", label: "cluster", kind: "int",    sortable: true  },
    ],
    rows,
    defaultSort: { key: "inDeg", dir: "desc" },
    selectionKey: (row, sel) => sel.type === "node" && sel.id === row.id,
    // Legend min/max are real in-degree counts (the gradient may be log-scaled
    // internally, but the labelled bounds are the real 0..max counts).
    gradient: { stops: INDEG_STOPS, min: 0, max: maxIn, label: isLog ? "in-deg (log)" : "in-deg" },
  };
}

function timeBinRows(s) {
  const nodes = s.genResult && s.genResult.nodes;
  if (!nodes) {
    return { columns: [], rows: [], unitLabel: "bins", title: "no data" };
  }
  // Bin by REAL publication year when years are present; fall back to the
  // normalised t for toy data (no real years).
  let yMin = Infinity, yMax = -Infinity;
  for (const n of nodes) {
    const y = n && n.year;
    if (Number.isFinite(y)) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
  }
  const hasYears = Number.isFinite(yMin) && yMax > yMin;
  const span = hasYears ? (yMax - yMin) : 1;

  const frac = (n) => hasYears
    ? (Number.isFinite(n.year) ? (n.year - yMin) / span : 0)
    : (+n.t || 0);
  // Collect the node ids per bin (not just counts) so selecting a bin row
  // resolves to its nodes — same as a cluster row. The id is the node's index,
  // the canonical id space used by selectedNodeIds and the cluster nodeCluster.
  const binIds = Array.from({ length: T_BINS }, () => []);
  for (let k = 0; k < nodes.length; k++) {
    let b = Math.floor(frac(nodes[k]) * T_BINS);
    if (b >= T_BINS) b = T_BINS - 1;
    if (b < 0) b = 0;
    binIds[b].push(k);
  }
  const counts = binIds.map((a) => a.length);
  const rows = counts.map((cnt, i) => {
    const loF = i / T_BINS, hiF = (i + 1) / T_BINS, mid = (loF + hiF) / 2;
    const range = hasYears
      ? `${Math.round(yMin + loF * span)}–${Math.round(yMin + hiF * span)}`
      : `${loF.toFixed(1)}–${hiF.toFixed(1)}`;
    return {
      _key:    `tBin:${i}`,
      _select: () => ({ type: "nodes", key: `tBin:${i}`, ids: binIds[i] }),
      colour:  tGradient(mid),
      bin:     i,
      range,
      count:   cnt,
    };
  });
  return {
    title:     hasYears ? `${T_BINS} year bins (${yMin}–${yMax})` : `${T_BINS} bins of t`,
    unitLabel: "bins",
    columns: [
      { key: "colour", label: "",       kind: "colour", sortable: false },
      { key: "bin",    label: "bin",    kind: "int",    sortable: true  },
      { key: "range",  label: hasYears ? "years" : "range", kind: "text", sortable: false },
      { key: "count",  label: "count",  kind: "int",    sortable: true  },
    ],
    rows,
    defaultSort: { key: "bin", dir: "asc" },
    selectionKey: (row, sel) => sel.type === "nodes" && sel.key === `tBin:${row.bin}`,
    gradient: hasYears
      ? { stops: T_STOPS, min: yMin, max: yMax, label: "year" }
      : { stops: T_STOPS, min: 0, max: 1, label: "t" },
  };
}

/* ── helpers ────────────────────────────────────────────────────────── */

function compareBy(a, b, key, dir) {
  let av = a[key], bv = b[key];
  const aNaN = Number.isNaN(av), bNaN = Number.isNaN(bv);
  if (aNaN && bNaN) return 0;
  if (aNaN) return 1;
  if (bNaN) return -1;
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (av < bv) return dir === "asc" ? -1 : 1;
  if (av > bv) return dir === "asc" ?  1 : -1;
  return 0;
}

function formatCell(value, kind) {
  if (value == null) return "—";
  if (kind === "int") {
    if (!Number.isFinite(value)) return "—";
    return String(Math.round(value));
  }
  if (kind === "float") {
    if (!Number.isFinite(value)) return "—";
    if (Math.abs(value) >= 100) return value.toFixed(0);
    if (Math.abs(value) >= 10)  return value.toFixed(1);
    return value.toFixed(2);
  }
  return String(value);
}

function sameSelection(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "cluster") return a.level === b.level && a.id === b.id;
  if (a.type === "origin")  return a.id === b.id;
  if (a.type === "node")    return a.id === b.id;
  if (a.type === "nodes")   return a.key === b.key;
  return false;
}

// Test-only handle for the pure row-builders (real-year bins, in-degree
// scaling) so they can be exercised without mounting the panel.
export const __test = { timeBinRows, inDegRows, buildTableData };
