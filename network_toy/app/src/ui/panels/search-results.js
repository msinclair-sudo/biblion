// SQL library search — a panel for running read-only SQL across one or more
// biblion snapshot DBs and acting on the result set.
//
// Layout (top → bottom):
//   - Scope selector: a checklist of datasets from /api/datasets. The active
//     dataset is checked by default; toggling drives the ATTACH/DETACH set.
//   - SQL editor: a textarea + schema hint + example templates. Read-only —
//     the SELECT-only guard (sql-search.js) rejects anything else.
//   - Guided fields: a small form that composes a SELECT into the editor (still
//     editable). "min in-degree" emits the citations COUNT subquery.
//   - Results table: { dataset, paperId, … } sortable; row actions for
//     highlight-in-graph (active-dataset hits), add-to-cart, and create-subset.
//
// Active-dataset hits highlight in the viewer via state.searchMatches (mapped
// back to graph nodes by getNodeByPaperId). Hits from ATTACHed non-active DBs
// have no graph node → list-only. Add-to-cart feeds the existing cart→subset
// pipeline; cart needs only paperId (nodeId is filled when the hit is a node).

import { getState, addToCart, setSearchMatches, clearSearchMatches } from "../state.js";
import { selectedNodeIds, highlightSignature } from "../viewer-shared/colour-modes.js";
import {
  loadDatasets, getActiveDatasetId, getNodeByPaperId,
} from "../../datasource/sqlite.js";
import { runSearch, buildGuidedQuery, setSearchScope, DEFAULT_ROW_CAP } from "../../datasource/sql-search.js";

export const ID = "search-results";
export const LABEL = "Search";
export const DESCRIPTION = "Run read-only SQL across one or more biblion snapshot DBs (ATTACHed by alias). Highlight active-dataset hits in the graph, add results to the cart, or push them to a subset.";
export const SINGLETON = true;

// Schema the snapshot exposes (from the ingest SELECTs). Surfaced as a hint and
// referenced by the guided-fields builder + example templates.
const SCHEMA_HINT =
  "papers(id, year, title, abstract, venue, doi, pub_type, authors, is_rejected, is_stub)\n" +
  "citations(citing_id, cited_id)";

const TEMPLATES = [
  { label: "By title",      sql: "SELECT id, title, year FROM papers\nWHERE title LIKE '%soil%'" },
  { label: "By year",       sql: "SELECT id, title, year FROM papers\nWHERE year >= 2020" },
  { label: "By author",     sql: "SELECT id, title, year FROM papers\nWHERE authors LIKE '%Smith%'" },
  {
    label: "High in-degree",
    sql: "SELECT p.id, p.title,\n  (SELECT COUNT(*) FROM citations WHERE cited_id = p.id) AS in_deg\n" +
         "FROM papers p\nORDER BY in_deg DESC",
  },
];

export function mount(container, _state, config = {}, _tabContext = null) {
  container.innerHTML = "";

  // Panel-local UI state (not persisted).
  const scopeChecked = new Set();     // dataset ids selected in the scope checklist
  let datasets = [];                  // [{id, label}] from /api/datasets
  let activeId = getActiveDatasetId();
  let aliasById = {};                 // id → SQL alias (after scope reconcile)
  let lastResult = null;             // { columns, rows, capped, rowCount, error? }
  let lastQueryDatasetTag = activeId; // dataset tag stamped on result rows
  let sortKey = null;
  let sortDir = "asc";
  const rowChecked = new Set();       // paperIds selected for partial cart add

  const root = document.createElement("div");
  root.className = "search-root";
  container.appendChild(root);

  // ── scope selector ──────────────────────────────────────────────
  const scopeBox = document.createElement("div");
  scopeBox.className = "search-scope";
  root.appendChild(scopeBox);
  const scopeLabel = document.createElement("div");
  scopeLabel.className = "search-section-label";
  scopeLabel.textContent = "Scope (databases to query)";
  scopeBox.appendChild(scopeLabel);
  const scopeList = document.createElement("div");
  scopeList.className = "search-scope-list";
  scopeBox.appendChild(scopeList);

  // ── guided fields ───────────────────────────────────────────────
  const guidedBox = document.createElement("div");
  guidedBox.className = "search-guided";
  root.appendChild(guidedBox);
  const guidedLabel = document.createElement("div");
  guidedLabel.className = "search-section-label";
  guidedLabel.textContent = "Guided fields → SQL";
  guidedBox.appendChild(guidedLabel);
  const guidedGrid = document.createElement("div");
  guidedGrid.className = "search-guided-grid";
  guidedBox.appendChild(guidedGrid);
  const fTitle   = mkField(guidedGrid, "title contains", "text");
  const fYearLo  = mkField(guidedGrid, "year from", "number");
  const fYearHi  = mkField(guidedGrid, "year to", "number");
  const fVenue   = mkField(guidedGrid, "venue contains", "text");
  const fPubType = mkField(guidedGrid, "pub_type", "text");
  const fMinDeg  = mkField(guidedGrid, "min in-degree", "number");
  const composeBtn = mkBtn(guidedBox, "search-btn", "Compose SQL ↓", () => {
    editor.value = buildGuidedQuery({
      titleContains: fTitle.value,
      yearFrom: fYearLo.value, yearTo: fYearHi.value,
      venue: fVenue.value, pubType: fPubType.value,
      minInDegree: fMinDeg.value,
    });
  });

  // ── SQL editor ──────────────────────────────────────────────────
  const editorBox = document.createElement("div");
  editorBox.className = "search-editor-box";
  root.appendChild(editorBox);
  const editorLabel = document.createElement("div");
  editorLabel.className = "search-section-label";
  editorLabel.textContent = "SQL (read-only SELECT)";
  editorBox.appendChild(editorLabel);
  const editor = document.createElement("textarea");
  editor.className = "search-editor";
  editor.rows = 5;
  editor.spellcheck = false;
  editor.placeholder = "SELECT id, title, year FROM papers WHERE year >= 2020";
  editorBox.appendChild(editor);

  const tplBar = document.createElement("div");
  tplBar.className = "search-templates";
  for (const t of TEMPLATES) {
    mkBtn(tplBar, "search-tpl-btn", t.label, () => { editor.value = t.sql; });
  }
  editorBox.appendChild(tplBar);

  const hint = document.createElement("pre");
  hint.className = "search-schema-hint";
  editorBox.appendChild(hint);

  const runBar = document.createElement("div");
  runBar.className = "search-runbar";
  editorBox.appendChild(runBar);
  const runBtn = mkBtn(runBar, "search-btn search-run", "Run query", () => doRun());
  const statusEl = document.createElement("span");
  statusEl.className = "search-status";
  runBar.appendChild(statusEl);

  // ── results actions ─────────────────────────────────────────────
  const actionBar = document.createElement("div");
  actionBar.className = "search-actions";
  root.appendChild(actionBar);
  const highlightBtn = mkBtn(actionBar, "search-btn", "Select all", () => doSelectAll());
  const clearHlBtn   = mkBtn(actionBar, "search-btn", "Deselect all", () => doDeselectAll());
  const addSelBtn    = mkBtn(actionBar, "search-btn", "Add selected to cart", () => doAddToCart(true));
  const addAllBtn    = mkBtn(actionBar, "search-btn", "Add all to cart", () => doAddToCart(false));

  // ── results table ───────────────────────────────────────────────
  const scroll = document.createElement("div");
  scroll.className = "search-scroll";
  root.appendChild(scroll);
  const table = document.createElement("table");
  table.className = "search-table";
  scroll.appendChild(table);
  const thead = document.createElement("thead");
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  // ── scope rendering ─────────────────────────────────────────────
  function renderScope() {
    scopeList.innerHTML = "";
    for (const d of datasets) {
      const lab = document.createElement("label");
      lab.className = "search-scope-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = scopeChecked.has(d.id);
      cb.addEventListener("change", () => {
        if (cb.checked) scopeChecked.add(d.id); else scopeChecked.delete(d.id);
      });
      lab.appendChild(cb);
      const txt = d.id === activeId ? `${d.label} (active)` : d.label;
      lab.appendChild(document.createTextNode(" " + txt));
      scopeList.appendChild(lab);
    }
    renderHint();
  }

  function renderHint() {
    const aliases = [...scopeChecked].filter((id) => id !== activeId);
    const aliasLine = aliases.length
      ? `\n-- ATTACHed aliases: ${aliases.map((id) => aliasById[id] || id).join(", ")}` +
        `\n-- (qualify cross-DB tables as <alias>.papers)`
      : "";
    hint.textContent = SCHEMA_HINT + aliasLine;
  }

  // ── query run ───────────────────────────────────────────────────
  async function doRun() {
    runBtn.disabled = true;
    statusEl.textContent = "running…";
    try {
      // Reconcile the ATTACH set with the scope before querying. The active
      // dataset is always in scope (it's the live main schema).
      const ids = [...scopeChecked];
      if (activeId && !scopeChecked.has(activeId)) ids.push(activeId);
      const scope = await setSearchScope(ids);
      aliasById = scope.aliasById;
      lastQueryDatasetTag = scope.active;
      const res = await runSearch(editor.value, { cap: DEFAULT_ROW_CAP });
      lastResult = res;
      rowChecked.clear();
      syncGraphSelection();          // a new query drops the old graph selection
      sortKey = null;
      renderResults();
      if (res.error) {
        statusEl.textContent = `error: ${res.error}`;
      } else {
        const capNote = res.capped ? ` (capped at ${DEFAULT_ROW_CAP})` : "";
        statusEl.textContent = `${res.rowCount} row${res.rowCount === 1 ? "" : "s"}${capNote}`;
      }
    } catch (e) {
      lastResult = { columns: [], rows: [], capped: false, rowCount: 0, error: String(e.message || e) };
      renderResults();
      statusEl.textContent = `error: ${e.message || e}`;
    } finally {
      runBtn.disabled = false;
    }
  }

  // The papers.id column in a result row — accept common shapes (id / p.id alias
  // collapses to "id"; explicit "paperId" if the user aliased it).
  function paperIdOf(row) {
    if (row == null) return null;
    if (row.id != null) return row.id;
    if (row.paperId != null) return row.paperId;
    return null;
  }

  function renderResults() {
    thead.innerHTML = "";
    tbody.innerHTML = "";
    const res = lastResult;
    if (!res || res.error || res.rows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.className = "search-empty-cell";
      td.textContent = res && res.error
        ? `Query error: ${res.error}`
        : "No results — run a query.";
      tr.appendChild(td);
      tbody.appendChild(tr);
      updateActionState();
      return;
    }

    // Graph selection (any source) — used to mark rows already selected.
    const sel = selectedNodeIds(getState());

    // Columns = a leading "dataset" tag + a checkbox + every result column.
    const cols = res.columns;
    const headTr = document.createElement("tr");
    const thCheck = document.createElement("th");
    thCheck.className = "search-th search-th-check";
    const master = document.createElement("input");
    master.type = "checkbox";
    master.addEventListener("change", () => {
      for (const r of sortedRows()) {
        const pid = paperIdOf(r);
        if (pid == null) continue;
        if (master.checked) rowChecked.add(pid); else rowChecked.delete(pid);
      }
      syncGraphSelection();
      renderResults();
    });
    thCheck.appendChild(master);
    headTr.appendChild(thCheck);

    headTr.appendChild(mkTh("dataset", "dataset"));
    for (const c of cols) headTr.appendChild(mkTh(c, c));
    thead.appendChild(headTr);

    for (const r of sortedRows()) {
      const tr = document.createElement("tr");
      tr.className = "search-row";
      const pid = paperIdOf(r);
      const nid = pid == null ? null : getNodeByPaperId(pid);
      // Reflect-back: a row whose node is in the graph selection (any source —
      // search, node-table, scoring, …) reads as selected, even if it wasn't
      // ticked here.
      if (nid != null && sel.has(nid)) tr.classList.add("selected");

      const tdCheck = document.createElement("td");
      tdCheck.className = "search-cell search-cell-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.disabled = pid == null;
      cb.checked = pid != null && rowChecked.has(pid);
      cb.addEventListener("change", () => {
        if (pid == null) return;
        if (cb.checked) rowChecked.add(pid); else rowChecked.delete(pid);
        syncGraphSelection();    // node rows → live graph selection
        updateActionState();
      });
      tdCheck.appendChild(cb);
      tr.appendChild(tdCheck);

      const tdDs = document.createElement("td");
      tdDs.className = "search-cell";
      tdDs.textContent = lastQueryDatasetTag || "—";
      tr.appendChild(tdDs);

      for (const c of cols) {
        const td = document.createElement("td");
        td.className = "search-cell";
        const v = r[c];
        const text = v == null ? "—" : String(v);
        td.textContent = text;
        if (text.length > 40) td.title = text;
        tr.appendChild(td);
      }

      // Per-row click toggles the row's selection (same as ticking its
      // checkbox), so clicking anywhere on a hit selects it in the graph.
      tr.addEventListener("click", (e) => {
        if (e.target instanceof HTMLInputElement) return;   // checkbox handled
        if (pid == null) return;
        if (rowChecked.has(pid)) rowChecked.delete(pid); else rowChecked.add(pid);
        syncGraphSelection();
        renderResults();
      });

      tbody.appendChild(tr);
    }
    updateActionState();
  }

  function mkTh(key, label) {
    const th = document.createElement("th");
    th.className = "search-th sortable";
    th.textContent = label;
    if (key === sortKey) {
      th.classList.add("sorted");
      const arrow = document.createElement("span");
      arrow.textContent = sortDir === "asc" ? " ▲" : " ▼";
      th.appendChild(arrow);
    }
    th.addEventListener("click", () => {
      if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortKey = key; sortDir = "asc"; }
      renderResults();
    });
    return th;
  }

  function sortedRows() {
    const rows = (lastResult && lastResult.rows) || [];
    if (!sortKey || sortKey === "dataset") return rows;
    return rows.slice().sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      const an = typeof av === "number", bn = typeof bv === "number";
      const sign = sortDir === "asc" ? 1 : -1;
      if (an && bn) return (av - bv) * sign;
      av = av == null ? "" : String(av).toLowerCase();
      bv = bv == null ? "" : String(bv).toLowerCase();
      return (av < bv ? -1 : av > bv ? 1 : 0) * sign;
    });
  }

  // ── row actions ─────────────────────────────────────────────────
  // The checked rows ARE the selection: mirror their active-dataset node subset
  // into the shared "search" highlight source (which feeds the viewer grey-out,
  // the Selected-papers panel, and white-pinning). Non-active hits have no node
  // and contribute nothing to the graph selection — they stay checked for the
  // cart only. Called after every change to rowChecked.
  function syncGraphSelection() {
    const rows = (lastResult && lastResult.rows) || [];
    const nodeIds = [];
    for (const r of rows) {
      const pid = paperIdOf(r);
      if (pid == null || !rowChecked.has(pid)) continue;
      const nid = getNodeByPaperId(pid);
      if (nid != null) nodeIds.push(nid);
    }
    if (nodeIds.length) setSearchMatches(nodeIds);   // replaces the "search" source
    else clearSearchMatches();
  }

  // Bulk: select / deselect every result row (the checked set drives both the
  // graph selection and the cart-add).
  function doSelectAll() {
    for (const r of (lastResult && lastResult.rows) || []) {
      const pid = paperIdOf(r);
      if (pid != null) rowChecked.add(pid);
    }
    syncGraphSelection();
    renderResults();
  }
  function doDeselectAll() {
    rowChecked.clear();
    syncGraphSelection();
    renderResults();
  }

  // Add results to the cart. nodeId is filled only for active-dataset hits;
  // paperId alone suffices for the cart→subset export.
  function doAddToCart(selectedOnly) {
    const rows = (lastResult && lastResult.rows) || [];
    const items = [];
    for (const r of rows) {
      const pid = paperIdOf(r);
      if (pid == null) continue;
      if (selectedOnly && !rowChecked.has(pid)) continue;
      const nid = getNodeByPaperId(pid);
      items.push({ paperId: pid, nodeId: nid, source: "search" });
    }
    addToCart(items);
  }

  function updateActionState() {
    const rows = (lastResult && lastResult.rows) || [];
    const hasRows = rows.length > 0;
    highlightBtn.disabled = !hasRows;
    addAllBtn.disabled = !hasRows;
    addSelBtn.disabled = rowChecked.size === 0;
  }

  // ── boot ────────────────────────────────────────────────────────
  renderScope();
  renderResults();
  loadDatasets().then((list) => {
    datasets = (list || []).map((d) => ({ id: d.id, label: d.label || d.id }));
    activeId = getActiveDatasetId();
    if (activeId && !datasets.some((d) => d.id === activeId)) {
      datasets.unshift({ id: activeId, label: activeId });
    }
    if (activeId) scopeChecked.add(activeId);   // active dataset checked by default
    renderScope();
  }).catch(() => { /* no API → empty scope list */ });

  // Fingerprint of the graph selection (highlight channel + single selection),
  // so we can re-mark the result rows when it changes from anywhere.
  const selSig = (s) => `${highlightSignature(s)}|${(s.selection && s.selection.type) || ""}:${(s.selection && s.selection.id) ?? ""}:${(s.selection && s.selection.level) ?? ""}`;
  let lastSelSig = selSig(getState());

  return {
    update(s) {
      // Active dataset may change after a re-ingest; refresh the (active) tag.
      const a = getActiveDatasetId();
      if (a !== activeId) { activeId = a; renderScope(); }
      // Re-render so the reflect-back row marks track the live selection.
      const sig = selSig(s);
      if (sig !== lastSelSig) { lastSelSig = sig; renderResults(); }
    },
    destroy() { container.innerHTML = ""; },
  };
}

/* ── helpers ──────────────────────────────────────────────────────── */

function mkBtn(parent, className, text, onClick) {
  const b = document.createElement("button");
  b.className = className;
  b.textContent = text;
  b.addEventListener("click", onClick);
  parent.appendChild(b);
  return b;
}

function mkField(parent, label, type) {
  const wrap = document.createElement("label");
  wrap.className = "search-field";
  const span = document.createElement("span");
  span.textContent = label;
  wrap.appendChild(span);
  const input = document.createElement("input");
  input.type = type;
  input.className = "search-field-input";
  wrap.appendChild(input);
  parent.appendChild(wrap);
  return input;
}
