// Cart — the data-wrangle table for papers collected from clusters / selections,
// staged for export to a biblion subset (cluster→cart→subset round-trip).
//
// A standalone table (deliberately NOT node-table's renderer): rows are cart
// papers, columns are EVERY per-node datum we can join — biblion metadata,
// citation in-degree, cluster id per level, layout position, ghost flag — with
// show/hide columns, text filter, sort, per-row remove, and per-row checkboxes
// for partial commit. Export emits a BibTeX (.bib) bibliography, pulling each
// paper's full reference (authors, venue, year, volume/issue/pages, identifiers,
// …) live from the connected snapshot DB via getNodeFullRecord; the cart's
// `source` provenance rides along in each entry's `note` field.
//
// Per-node data sources (joined by nodeId):
//   s.genResult.nodes[i]                       → paperId, isGhost, year (toy)
//   getNodeRecord(i)                           → title, venue, authors, doi, pubType, year
//   s.citationResult.inDeg[i]                  → citation in-degree
//   s.clusterLevels[L].clusterResult.nodeCluster[i] → cluster id at level L
//   s._basePos[3i..3i+2]                       → x / y / z

import { getState, removeFromCart, clearCart, setTabConfig } from "../state.js";
import { downloadText } from "../../export/cluster-export.js";
import { formatBibtex } from "../../export/bibtex.js";
import { getNodeFullRecord, hasSqliteText } from "../../datasource/sqlite.js";
import { paperColumns, joinPaperRow, formatCell, compareBy } from "./paper-table.js";
import { makeColumnsResizable } from "./column-resize.js";

export const ID = "cart";
export const LABEL = "Cart";
export const DESCRIPTION = "Papers collected from clusters/selections, staged for citation export. Show/hide columns, filter, sort, then export as a BibTeX (.bib) bibliography pulled live from the connected snapshot database.";
export const SINGLETON = true;   // one cart per project

// Column catalogue + per-node join + cell format/sort live in paper-table.js,
// shared with the Selected-papers panel.

// Shown on first mount; everything else is opt-in via the column picker.
const DEFAULT_VISIBLE = new Set([
  "source", "title", "year", "venue", "authors", "inDeg", "isGhost",
]);

export function mount(container, _state, config = {}, tabContext = null) {
  container.innerHTML = "";

  // Panel-local UI state (not persisted — only the cart contents are).
  const visible = new Set(DEFAULT_VISIBLE);
  // Per-column widths (px), keyed by column key. Restored from the tab config
  // and persisted back on resize so they survive a remount / project reload.
  const colWidths = { ...(config && config.colWidths) };
  const persistWidths = (w) => {
    if (tabContext) setTabConfig(tabContext.slot, tabContext.tabId, { colWidths: w });
  };
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
    "Export → a BibTeX (.bib) file of the cart papers, pulled from the connected snapshot DB.";
  root.appendChild(hint);

  // ── data join ───────────────────────────────────────────────────
  function resolveColumns(s) {
    const { columns: cols, clusterKeys } = paperColumns(s);
    columns = cols;
    // Show the finest cluster column the first time clusters exist; after that
    // the user's show/hide choices stand (don't re-add on every rejoin).
    if (clusterKeys.length && !clusterDefaulted) {
      visible.add(clusterKeys[clusterKeys.length - 1]);
      clusterDefaulted = true;
    }
  }

  function rejoin(s) {
    resolveColumns(s);
    const levels = s.clusterLevels || [];
    const cart = s.cart || [];
    joinedRows = cart.map(it =>
      joinPaperRow(it.nodeId, s, levels, { paperId: it.paperId, source: it.source }));
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
      th.dataset.colKey = col.key;          // resizable column
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

    // Drag-to-resize the (keyed) data columns; widths persist on the tab.
    makeColumnsResizable(table, thead, {
      keyOf:    (th) => th.dataset.colKey || null,
      widths:   colWidths,
      onResize: (w) => persistWidths(w),
    });
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
    // BibTeX needs the live snapshot DB (full reference fields aren't on the
    // joined row). After a project load without a reconnected corpus there's
    // nothing to pull — say so rather than emit empty/partial entries.
    if (!hasSqliteText()) {
      window.alert("BibTeX export needs the connected snapshot database. Re-open the dataset, then export.");
      return;
    }
    const tagsMap = getState().tags || {};
    const records = [];
    const notes = [];
    let missing = 0;
    for (const r of rows) {
      const rec = getNodeFullRecord(r.nodeId);
      if (!rec) { missing++; continue; }
      const t = tagsMap[r.paperId];           // user tags → BibTeX keywords
      if (t && t.length) rec.keywords = t.slice();
      records.push(rec);
      notes.push(r.source || null);
    }
    if (records.length === 0) return;
    if (missing) console.warn(`[cart] BibTeX export: ${missing} paper(s) had no DB record and were skipped.`);
    const name = selectedOnly ? "cart-selected.bib" : "cart.bib";
    downloadText(formatBibtex(records, notes), name, "application/x-bibtex");
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
