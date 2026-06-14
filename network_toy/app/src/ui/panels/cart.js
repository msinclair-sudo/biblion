// Cart — the data-wrangle table for papers collected from clusters / selections,
// staged for export to a biblion subset (cluster→cart→subset round-trip).
//
// A standalone table (deliberately NOT node-table's renderer): rows are cart
// papers, columns are EVERY per-node datum we can join — biblion metadata,
// citation in-degree, cluster id per level, layout position, ghost flag — with
// show/hide columns, text filter, sort, per-row remove, and per-row checkboxes
// for partial commit. Export emits {"papers":[{"id","source"}]} for
// `biblion advanced subset make <name> --ids-file <file>`.
//
// Per-node data sources (joined by nodeId):
//   s.genResult.nodes[i]                       → paperId, isGhost, year (toy)
//   getNodeRecord(i)                           → title, venue, authors, doi, pubType, year
//   s.citationResult.inDeg[i]                  → citation in-degree
//   s.clusterLevels[L].clusterResult.nodeCluster[i] → cluster id at level L
//   s._basePos[3i..3i+2]                       → x / y / z

import { getState, removeFromCart, clearCart } from "../state.js";
import { getNodeRecord } from "../../datasource/sqlite.js";
import { downloadText } from "../../export/cluster-export.js";

export const ID = "cart";
export const LABEL = "Cart";
export const DESCRIPTION = "Papers collected from clusters/selections, staged for export to a biblion subset. Show/hide columns, filter, sort, then export ids as JSON for `subset make --ids-file`.";
export const SINGLETON = true;   // one cart per project

// Static column catalogue. Cluster-per-level columns are appended dynamically.
// `kind` drives formatting + sort comparator. `get` reads the joined row.
const BASE_COLUMNS = [
  { key: "source",  label: "source",  kind: "text"  },
  { key: "title",   label: "title",   kind: "text"  },
  { key: "year",    label: "year",    kind: "int"   },
  { key: "venue",   label: "venue",   kind: "text"  },
  { key: "authors", label: "authors", kind: "text"  },
  { key: "inDeg",   label: "in-deg",  kind: "int"   },
  { key: "isGhost", label: "ghost",   kind: "text"  },
  { key: "pubType", label: "type",    kind: "text"  },
  { key: "doi",     label: "doi",     kind: "text"  },
  { key: "paperId", label: "paperId", kind: "int"   },
  { key: "nodeId",  label: "nodeId",  kind: "int"   },
  { key: "x",       label: "x",       kind: "float" },
  { key: "y",       label: "y",       kind: "float" },
  { key: "z",       label: "z",       kind: "float" },
];

// Shown on first mount; everything else is opt-in via the column picker.
const DEFAULT_VISIBLE = new Set([
  "source", "title", "year", "venue", "authors", "inDeg", "isGhost",
]);

export function mount(container, _state, config = {}, _tabContext = null) {
  container.innerHTML = "";

  // Panel-local UI state (not persisted — only the cart contents are).
  const visible = new Set(DEFAULT_VISIBLE);
  const checked = new Set();          // paperIds selected for partial commit
  let filterText = "";
  let sortKey = null;
  let sortDir = "asc";

  let joinedRows = [];                // cache: joined once per cart/engine change
  let lastCartRef = null;
  let lastEngineRev = -1;
  let columns = [];                   // resolved (base + dynamic cluster cols)
  let clusterDefaulted = false;       // finest-cluster column auto-shown once

  const root = document.createElement("div");
  root.className = "cart-root";
  container.appendChild(root);

  // ── toolbar ─────────────────────────────────────────────────────
  const bar = document.createElement("div");
  bar.className = "cart-toolbar";
  root.appendChild(bar);

  const filterInput = document.createElement("input");
  filterInput.className = "cart-filter";
  filterInput.type = "search";
  filterInput.placeholder = "filter…";
  filterInput.addEventListener("input", () => {
    filterText = filterInput.value.trim().toLowerCase();
    renderTable();
  });
  bar.appendChild(filterInput);

  const colsBtn = document.createElement("button");
  colsBtn.className = "cart-btn";
  colsBtn.textContent = "Columns ▾";
  bar.appendChild(colsBtn);

  const exportSelBtn = mkBtn(bar, "Export selected", () => doExport(true));
  const exportAllBtn = mkBtn(bar, "Export all",      () => doExport(false));
  const clearBtn     = mkBtn(bar, "Clear cart",      () => clearCart());

  const countEl = document.createElement("span");
  countEl.className = "cart-count";
  bar.appendChild(countEl);

  // Columns dropdown (toggled by colsBtn).
  const colsMenu = document.createElement("div");
  colsMenu.className = "cart-cols-menu";
  colsMenu.style.display = "none";
  root.appendChild(colsMenu);
  colsBtn.addEventListener("click", () => {
    colsMenu.style.display = colsMenu.style.display === "none" ? "block" : "none";
  });

  // ── table ───────────────────────────────────────────────────────
  const empty = document.createElement("div");
  empty.className = "cart-empty";
  root.appendChild(empty);

  const scroll = document.createElement("div");
  scroll.className = "cart-scroll";
  root.appendChild(scroll);
  const table = document.createElement("table");
  table.className = "cart-table";
  scroll.appendChild(table);
  const thead = document.createElement("thead");
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  const hint = document.createElement("div");
  hint.className = "cart-hint";
  hint.textContent =
    "Export → biblion advanced subset make <name> --ids-file <downloaded.json>";
  root.appendChild(hint);

  // ── data join ───────────────────────────────────────────────────
  function resolveColumns(s) {
    const levels = s.clusterLevels || [];
    const dyn = levels.map((_, i) => ({
      key: `clusterL${i}`,
      label: levels.length > 1 ? `clust L${i}` : "cluster",
      kind: "int",
    }));
    columns = [...BASE_COLUMNS, ...dyn];
    // Show the finest cluster column the first time clusters exist; after that
    // the user's show/hide choices stand (don't re-add on every rejoin).
    if (dyn.length && !clusterDefaulted) {
      visible.add(dyn[dyn.length - 1].key);
      clusterDefaulted = true;
    }
  }

  function joinRow(item, s, levels) {
    const nodeId = item.nodeId;
    const rec = getNodeRecord(nodeId) || {};
    const nodes = (s.genResult && s.genResult.nodes) || [];
    const nd = nodes[nodeId] || {};
    const pos = s._basePos;
    const inDeg = (s.citationResult && s.citationResult.inDeg)
      ? s.citationResult.inDeg[nodeId] : null;
    const row = {
      paperId: item.paperId,
      nodeId,
      source:  item.source ?? null,
      title:   rec.title ?? null,
      year:    rec.year ?? (Number.isFinite(nd.year) ? nd.year : null),
      venue:   rec.venue ?? null,
      authors: (rec.authors && rec.authors.length) ? rec.authors.join("; ") : null,
      doi:     rec.doi ?? null,
      pubType: rec.pubType ?? null,
      isGhost: nd.isGhost ? "ghost" : "",
      inDeg:   inDeg == null ? null : inDeg,
      x: pos ? round3(pos[nodeId * 3])     : null,
      y: pos ? round3(pos[nodeId * 3 + 1]) : null,
      z: pos ? round3(pos[nodeId * 3 + 2]) : null,
    };
    for (let i = 0; i < levels.length; i++) {
      const cr = levels[i].clusterResult;
      row[`clusterL${i}`] = (cr && cr.nodeCluster) ? cr.nodeCluster[nodeId] : null;
    }
    return row;
  }

  function rejoin(s) {
    resolveColumns(s);
    const levels = s.clusterLevels || [];
    const cart = s.cart || [];
    joinedRows = cart.map(it => joinRow(it, s, levels));
    // Drop checks for papers no longer in the cart.
    const present = new Set(cart.map(it => it.paperId));
    for (const pid of [...checked]) if (!present.has(pid)) checked.delete(pid);
  }

  // ── rendering ───────────────────────────────────────────────────
  function renderColsMenu() {
    colsMenu.innerHTML = "";
    for (const col of columns) {
      const lab = document.createElement("label");
      lab.className = "cart-cols-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = visible.has(col.key);
      cb.addEventListener("change", () => {
        if (cb.checked) visible.add(col.key); else visible.delete(col.key);
        renderHeader();
        renderBody();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(" " + col.label));
      colsMenu.appendChild(lab);
    }
  }

  function visibleColumns() {
    return columns.filter(c => visible.has(c.key));
  }

  function filteredSorted() {
    const cols = visibleColumns();
    let rows = joinedRows;
    if (filterText) {
      rows = rows.filter(r =>
        cols.some(c => String(r[c.key] ?? "").toLowerCase().includes(filterText)));
    }
    if (sortKey) {
      const col = columns.find(c => c.key === sortKey);
      rows = rows.slice().sort((a, b) => compareBy(a, b, sortKey, sortDir, col));
    }
    return rows;
  }

  function renderHeader() {
    thead.innerHTML = "";
    const tr = document.createElement("tr");

    // Master checkbox (toggle all filtered rows).
    const thCheck = document.createElement("th");
    thCheck.className = "cart-th cart-th-check";
    const master = document.createElement("input");
    master.type = "checkbox";
    const visRows = filteredSorted();
    master.checked = visRows.length > 0 && visRows.every(r => checked.has(r.paperId));
    master.addEventListener("change", () => {
      for (const r of visRows) {
        if (master.checked) checked.add(r.paperId); else checked.delete(r.paperId);
      }
      renderBody();
    });
    thCheck.appendChild(master);
    tr.appendChild(thCheck);

    for (const col of visibleColumns()) {
      const th = document.createElement("th");
      th.className = "cart-th sortable";
      th.textContent = col.label;
      if (col.key === sortKey) {
        th.classList.add("sorted");
        const arrow = document.createElement("span");
        arrow.className = "cart-sort-arrow";
        arrow.textContent = sortDir === "asc" ? " ▲" : " ▼";
        th.appendChild(arrow);
      }
      th.addEventListener("click", () => {
        if (sortKey === col.key) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortKey = col.key;
          sortDir = (col.kind === "int" || col.kind === "float") ? "desc" : "asc";
        }
        renderHeader();
        renderBody();
      });
      tr.appendChild(th);
    }

    const thRm = document.createElement("th");
    thRm.className = "cart-th cart-th-rm";
    tr.appendChild(thRm);
    thead.appendChild(tr);
  }

  function renderBody() {
    tbody.innerHTML = "";
    const cols = visibleColumns();
    const rows = filteredSorted();

    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.className = "cart-row";

      const tdCheck = document.createElement("td");
      tdCheck.className = "cart-cell cart-cell-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = checked.has(r.paperId);
      cb.addEventListener("change", () => {
        if (cb.checked) checked.add(r.paperId); else checked.delete(r.paperId);
        updateCount();
      });
      tdCheck.appendChild(cb);
      tr.appendChild(tdCheck);

      for (const col of cols) {
        const td = document.createElement("td");
        td.className = `cart-cell cart-cell-${col.kind}`;
        const val = formatCell(r[col.key], col.kind);
        td.textContent = val;
        if (col.kind === "text" && val !== "—") td.title = val;
        tr.appendChild(td);
      }

      const tdRm = document.createElement("td");
      tdRm.className = "cart-cell cart-cell-rm";
      const rm = document.createElement("button");
      rm.className = "cart-rm-btn";
      rm.textContent = "×";
      rm.title = "remove from cart";
      rm.addEventListener("click", () => removeFromCart(r.paperId));
      tdRm.appendChild(rm);
      tr.appendChild(tdRm);

      tbody.appendChild(tr);
    }

    const isEmpty = (getState().cart || []).length === 0;
    empty.style.display = isEmpty ? "block" : "none";
    empty.textContent = "Cart is empty — add a cluster from the Node table.";
    scroll.style.display = isEmpty ? "none" : "block";
    updateCount();
  }

  function updateCount() {
    const n = (getState().cart || []).length;
    const shown = filteredSorted().length;
    const sel = checked.size;
    const filt = filterText && shown !== n ? `, ${shown} shown` : "";
    countEl.textContent = `${n} paper${n === 1 ? "" : "s"}${filt}${sel ? `, ${sel} selected` : ""}`;
    exportSelBtn.disabled = sel === 0;
    exportAllBtn.disabled = n === 0;
    clearBtn.disabled = n === 0;
  }

  function renderTable() {
    renderHeader();
    renderBody();
  }

  function fullRender(s) {
    rejoin(s);
    renderColsMenu();
    renderTable();
  }

  function doExport(selectedOnly) {
    const rows = filteredSorted().filter(r => !selectedOnly || checked.has(r.paperId));
    if (rows.length === 0) return;
    const payload = { papers: rows.map(r => ({ id: r.paperId, source: r.source })) };
    const name = selectedOnly ? "cart-selected.json" : "cart-ids.json";
    downloadText(JSON.stringify(payload, null, 2), name, "application/json");
  }

  // Initial paint.
  const s0 = getState();
  lastCartRef = s0.cart;
  lastEngineRev = s0.engineRevision;
  fullRender(s0);

  return {
    update(s) {
      // Re-join only when the cart contents or the engine output changed;
      // filter/sort/column toggles repaint without re-querying sqlite.
      if (s.cart !== lastCartRef || s.engineRevision !== lastEngineRev) {
        lastCartRef = s.cart;
        lastEngineRev = s.engineRevision;
        fullRender(s);
      }
    },
    destroy() { container.innerHTML = ""; },
  };
}

/* ── helpers ──────────────────────────────────────────────────────── */

function mkBtn(parent, text, onClick) {
  const b = document.createElement("button");
  b.className = "cart-btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  parent.appendChild(b);
  return b;
}

function round3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

function formatCell(value, kind) {
  if (value == null || value === "") return value === "" ? "" : "—";
  if (kind === "float") return Number.isFinite(value) ? String(value) : "—";
  if (kind === "int")   return Number.isFinite(value) ? String(value) : "—";
  return String(value);
}

function compareBy(a, b, key, dir, col) {
  const sign = dir === "asc" ? 1 : -1;
  let av = a[key], bv = b[key];
  const numeric = col && (col.kind === "int" || col.kind === "float");
  if (numeric) {
    const an = Number.isFinite(av) ? av : (dir === "asc" ? Infinity : -Infinity);
    const bn = Number.isFinite(bv) ? bv : (dir === "asc" ? Infinity : -Infinity);
    return (an - bn) * sign;
  }
  // Text: nulls/empties last regardless of dir.
  av = av == null ? "" : String(av).toLowerCase();
  bv = bv == null ? "" : String(bv).toLowerCase();
  if (av === "" && bv !== "") return 1;
  if (bv === "" && av !== "") return -1;
  return av < bv ? -1 * sign : av > bv ? 1 * sign : 0;
}
