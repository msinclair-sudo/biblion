// Selected papers — a live table of every paper currently SELECTED in the viewer
// (node-table cluster/node picks + scoring/search highlights, via selectedNodeIds).
// Clicking a row PINS that paper white in both viewers (state.pinnedNodes), an
// emphasis layer on top of the normal selection colouring. Multiple pins at once;
// pins persist until cleared, independent of the selection.
//
// Sibling of the Cart panel: same wide joinable table (reuses paper-table.js for
// columns + join + format/sort + the cart-* CSS), but its rows come from the
// current selection rather than state.cart, and clicking a row toggles a white
// pin rather than a partial-commit selection.

import {
  getState, togglePinnedNode, clearPinnedNodes, setTabConfig,
  addTag, autoOpenTagsListPanel,
} from "../state.js";
import {
  selectedNodeIds, highlightSignature, pinnedSignature, selectionSignature,
} from "../viewer-shared/colour-modes.js";
import {
  paperColumns, joinPaperRow, formatCell, compareBy,
} from "./paper-table.js";
import { makeColumnsResizable } from "./column-resize.js";
import { openAbstractModal } from "../modals/abstract-modal.js";
import { hasSqliteText } from "../../datasource/sqlite.js";
import { preserveScroll } from "../widgets.js";

export const ID = "selected-papers";
export const LABEL = "Selected papers";
export const DESCRIPTION = "Papers currently selected in the viewer. Click a paper to pin it white (emphasis) in both viewers; Ctrl-click for several, Shift-click for a range. Pins persist until cleared.";
export const SINGLETON = true;

// Shown on first mount; everything else is opt-in via the column picker.
const DEFAULT_VISIBLE = new Set([
  "title", "year", "venue", "authors", "tags", "inDeg",
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
  // Index (within the current filteredSorted() order) of the last row a plain /
  // Ctrl click pinned — the anchor for Shift-click range pinning.
  let lastPinAnchor = null;

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

  // Pin every shown row (replaces the old master "pin all" checkbox).
  const pinAllBtn = mkBtn(bar, "Pin all shown", () => {
    const rows = filteredSorted();
    rangePin(rows, 0, rows.length - 1);
  });
  const clearPinsBtn = mkBtn(bar, "Clear pins", () => clearPinnedNodes());

  // ── tagging ──────────────────────────────────────────────────────
  // Type a tag name, then apply it to all listed papers or just the
  // pinned ones. Tags write through to the project's live DB.
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
    // Re-join so the new tag shows in the tags column now (update() only
    // re-joins on a selection/engine change, not on a tag write).
    fullRender(getState());
  }

  const tagAllBtn = mkBtn(bar, "Tag all", () => applyTag(filteredSorted()));
  const tagTickBtn = mkBtn(bar, "Tag pinned", () => {
    const pinned = getState().pinnedNodes;
    applyTag(filteredSorted().filter(r => pinned.has(r.nodeId)));
  });

  const countEl = document.createElement("span");
  countEl.className = "cart-count";
  bar.appendChild(countEl);

  // Column on/off toggles, always visible inline (no dropdown).
  const colsMenu = document.createElement("div");
  colsMenu.className = "cart-cols-menu";
  root.appendChild(colsMenu);

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
  hint.textContent = "Click a paper to pin it white in the viewer (Ctrl-click for several, Shift-click for a range). Select clusters in the Node table or highlight from a Scoring card to populate this list.";
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

    // Action column header (per-row "abstract" button); empty label, kept
    // narrow so the table's resizable data columns stay aligned.
    const thAbs = document.createElement("th");
    thAbs.className = "cart-th cart-th-abs";
    tr.appendChild(thAbs);

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
    preserveScroll(scroll, renderBodyInner);
  }

  function renderBodyInner() {
    tbody.innerHTML = "";
    const cols = visibleColumns();
    const rows = filteredSorted();
    const pinned = getState().pinnedNodes;

    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.className = "cart-row row-click" + (pinned.has(r.nodeId) ? " pinned" : "");

      // The row itself is the pin control (we dropped the checkbox column):
      //   plain click  → pin ONLY this paper (clear the others)
      //   Ctrl/Cmd     → toggle this paper's pin, keeping the rest
      //   Shift        → pin the visual range from the last anchor to here
      // Clicks on the abstract button (or any future control) never pin.
      tr.addEventListener("click", (ev) => {
        if (ev.target.closest("button")) return;
        if (ev.metaKey || ev.ctrlKey) {
          togglePinnedNode(r.nodeId);
          lastPinAnchor = i;
        } else if (ev.shiftKey && lastPinAnchor != null) {
          rangePin(rows, lastPinAnchor, i);
        } else {
          clearPinnedNodes();
          togglePinnedNode(r.nodeId);
          lastPinAnchor = i;
        }
      });

      // Per-row "abstract" button → reader modal, paging across the shown rows.
      const tdAbs = document.createElement("td");
      tdAbs.className = "cart-cell cart-cell-abs";
      const absBtn = document.createElement("button");
      absBtn.className = "cart-btn";
      absBtn.textContent = "abstract";
      if (!hasSqliteText()) {
        absBtn.disabled = true;
        absBtn.title = "Abstracts need the connected snapshot database. Re-open the dataset to read them.";
      } else {
        const here = i;        // index within the current filteredSorted() list
        absBtn.addEventListener("click", () => openAbstractModal(rows, here));
      }
      tdAbs.appendChild(absBtn);
      tr.appendChild(tdAbs);

      for (const col of cols) {
        const td = document.createElement("td");
        td.className = `cart-cell cart-cell-${col.kind}`;
        const val = formatCell(r[col.key], col.kind);
        td.textContent = val;
        if (col.kind === "text" && val !== "—") td.title = val;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    const isEmpty = joinedRows.length === 0;
    empty.style.display = isEmpty ? "block" : "none";
    empty.textContent = "No papers selected — pick a cluster in the Node table or highlight from a Scoring card.";
    scroll.style.display = isEmpty ? "none" : "block";
    updateCount();
  }

  // Pin every row in the visual range [a, b] (inclusive), unioning onto the
  // current pins — Shift-click extends, it never unpins.
  function rangePin(rows, a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const pinned = getState().pinnedNodes;
    for (let i = lo; i <= hi; i++) {
      const r = rows[i];
      if (r && !pinned.has(r.nodeId)) togglePinnedNode(r.nodeId);
    }
  }

  function updateCount() {
    const n = joinedRows.length;
    const shown = filteredSorted().length;
    const pins = getState().pinnedNodes.size;
    const filt = filterText && shown !== n ? `, ${shown} shown` : "";
    countEl.textContent = `${n} selected${filt}${pins ? `, ${pins} pinned white` : ""}`;
    clearPinsBtn.disabled = pins === 0;
    pinAllBtn.disabled = shown === 0;
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

  // Fingerprint of the current selection: highlight channel + the dimming
  // selection (primary + Ctrl-click extras). A change means the row set must
  // be re-joined.
  function selSig(s) {
    return `${highlightSignature(s)}|${selectionSignature(s)}`;
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
      // Pins-only change → refresh row pin-highlight + count, no re-join.
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
