// Selected papers — a live table of every paper currently SELECTED in the viewer
// (node-table cluster/node picks + scoring/search highlights, via selectedNodeIds).
// Ticking a row PINS that paper white in both viewers (state.pinnedNodes), an
// emphasis layer on top of the normal selection colouring. Multiple pins at once;
// pins persist until cleared, independent of the selection.
//
// Sibling of the Cart panel: same wide joinable table (reuses paper-table.js for
// columns + join + format/sort + the cart-* CSS), but its rows come from the
// current selection rather than state.cart, and its checkbox toggles a white pin
// rather than a partial-commit selection.

import {
  getState, togglePinnedNode, clearPinnedNodes, setTabConfig,
  addTag, autoOpenTagsListPanel,
} from "../state.js";
import {
  selectedNodeIds, highlightSignature, pinnedSignature,
} from "../viewer-shared/colour-modes.js";
import {
  paperColumns, joinPaperRow, formatCell, compareBy,
} from "./paper-table.js";
import { makeColumnsResizable } from "./column-resize.js";

export const ID = "selected-papers";
export const LABEL = "Selected papers";
export const DESCRIPTION = "Papers currently selected in the viewer. Tick a paper to pin it white (emphasis) in both viewers; multiple pins persist until cleared.";
export const SINGLETON = true;

// Shown on first mount; everything else is opt-in via the column picker.
const DEFAULT_VISIBLE = new Set([
  "title", "year", "venue", "authors", "inDeg",
]);

export function mount(container, _state, config = {}, tabContext = null) {
  container.innerHTML = "";

  // Panel-local UI state.
  const visible = new Set(DEFAULT_VISIBLE);
  // Per-column widths (px), restored from + persisted to the tab config.
  const colWidths = { ...(config && config.colWidths) };
  const persistWidths = (w) => {
    if (tabContext) setTabConfig(tabContext.slot, tabContext.tabId, { colWidths: w });
  };
  let filterText = "";
  let sortKey = null;
  let sortDir = "asc";

  let joinedRows = [];
  let columns = [];
  let clusterDefaulted = false;

  // Change-detection fingerprints.
  let lastSelSig = null;
  let lastEngineRev = -1;
  let lastPinSig = null;

  const root = document.createElement("div");
  root.className = "cart-root";          // reuse the cart panel's layout/styling
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

  const clearPinsBtn = mkBtn(bar, "Clear pins", () => clearPinnedNodes());

  // ── tagging ──────────────────────────────────────────────────────
  // Type a tag name, then apply it to all listed papers or just the
  // tick-marked (pinned) ones. Tags write through to the project's live DB.
  const tagInput = document.createElement("input");
  tagInput.className = "cart-filter";        // reuse styling
  tagInput.type = "text";
  tagInput.placeholder = "tag name…";
  bar.appendChild(tagInput);

  function applyTag(rows) {
    const tag = tagInput.value.trim();
    if (!tag || rows.length === 0) return;
    const hadTags = Object.keys(getState().tags || {}).length > 0;
    const paperIds = rows.map(r => r.paperId).filter(p => p != null);
    const n = addTag(paperIds, tag, {
      onError: (e) => window.alert(
        "Tag write failed (the dataset may be snapshot-only, or the DB is busy): "
        + (e.message || e)),
    });
    if (n > 0 && !hadTags) autoOpenTagsListPanel();   // first tag → open the list
    tagInput.value = "";
    updateCount();
  }

  const tagAllBtn = mkBtn(bar, "Tag all", () => applyTag(filteredSorted()));
  const tagTickBtn = mkBtn(bar, "Tag tick-marked", () => {
    const pinned = getState().pinnedNodes;
    applyTag(filteredSorted().filter(r => pinned.has(r.nodeId)));
  });

  const countEl = document.createElement("span");
  countEl.className = "cart-count";
  bar.appendChild(countEl);

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
  hint.textContent = "Tick a paper to pin it white in the viewer. Select clusters in the Node table or highlight from a Scoring card to populate this list.";
  root.appendChild(hint);

  // ── data join ───────────────────────────────────────────────────
  function resolveColumns(s) {
    const { columns: cols, clusterKeys } = paperColumns(s);
    columns = cols;
    if (clusterKeys.length && !clusterDefaulted) {
      visible.add(clusterKeys[clusterKeys.length - 1]);
      clusterDefaulted = true;
    }
  }

  function rejoin(s) {
    resolveColumns(s);
    const levels = s.clusterLevels || [];
    const ids = [...selectedNodeIds(s)].sort((a, b) => a - b);
    joinedRows = [];
    for (const nodeId of ids) {
      // Unlike the cart (which excludes ghosts from a subset EXPORT), this is a
      // view of what's selected — include ghost papers too (they're real cited
      // works with metadata, just not embedded). The "ghost" column marks them.
      const row = joinPaperRow(nodeId, s, levels);
      if (row.paperId == null) continue;        // need a paper to show
      joinedRows.push(row);
    }
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

    // Master checkbox pins / unpins all currently-visible rows.
    const thCheck = document.createElement("th");
    thCheck.className = "cart-th cart-th-check";
    const master = document.createElement("input");
    master.type = "checkbox";
    master.title = "Pin / unpin all shown";
    const pinned = getState().pinnedNodes;
    const visRows = filteredSorted();
    master.checked = visRows.length > 0 && visRows.every(r => pinned.has(r.nodeId));
    master.addEventListener("change", () => {
      // Toggle each shown row toward the master state (togglePinnedNode flips,
      // so only flip rows that need flipping).
      for (const r of visRows) {
        const isPinned = getState().pinnedNodes.has(r.nodeId);
        if (master.checked && !isPinned) togglePinnedNode(r.nodeId);
        else if (!master.checked && isPinned) togglePinnedNode(r.nodeId);
      }
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
    thead.appendChild(tr);

    // Drag-to-resize the data columns; widths persist on the tab.
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
    const pinned = getState().pinnedNodes;

    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.className = "cart-row" + (pinned.has(r.nodeId) ? " pinned" : "");

      const tdCheck = document.createElement("td");
      tdCheck.className = "cart-cell cart-cell-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.title = "Pin this paper white in the viewer";
      cb.checked = pinned.has(r.nodeId);
      cb.addEventListener("change", () => togglePinnedNode(r.nodeId));
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
      tbody.appendChild(tr);
    }

    const isEmpty = joinedRows.length === 0;
    empty.style.display = isEmpty ? "block" : "none";
    empty.textContent = "No papers selected — pick a cluster in the Node table or highlight from a Scoring card.";
    scroll.style.display = isEmpty ? "none" : "block";
    updateCount();
  }

  function updateCount() {
    const n = joinedRows.length;
    const shown = filteredSorted().length;
    const pins = getState().pinnedNodes.size;
    const filt = filterText && shown !== n ? `, ${shown} shown` : "";
    countEl.textContent = `${n} selected${filt}${pins ? `, ${pins} pinned white` : ""}`;
    clearPinsBtn.disabled = pins === 0;
    tagAllBtn.disabled = shown === 0;
    tagTickBtn.disabled = pins === 0;
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

  // Fingerprint of the current selection: highlight channel + the single
  // selection. A change means the row set must be re-joined.
  function selSig(s) {
    const sel = s.selection || {};
    return `${highlightSignature(s)}|${sel.type || ""}:${sel.id ?? ""}:${sel.level ?? ""}`;
  }

  // Initial paint.
  const s0 = getState();
  lastSelSig = selSig(s0);
  lastEngineRev = s0.engineRevision;
  lastPinSig = pinnedSignature(s0);
  fullRender(s0);

  return {
    update(s) {
      const selSigNow = selSig(s);
      if (selSigNow !== lastSelSig || s.engineRevision !== lastEngineRev) {
        lastSelSig = selSigNow;
        lastEngineRev = s.engineRevision;
        lastPinSig = pinnedSignature(s);
        fullRender(s);
        return;
      }
      // Pins-only change → refresh checkboxes + count, no re-join.
      const pinSig = pinnedSignature(s);
      if (pinSig !== lastPinSig) {
        lastPinSig = pinSig;
        renderBody();
      }
    },
    destroy() { container.innerHTML = ""; },
  };
}

function mkBtn(parent, text, onClick) {
  const b = document.createElement("button");
  b.className = "cart-btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  parent.appendChild(b);
  return b;
}
