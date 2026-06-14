# J09 — SQL library search panel (ATTACH cross-DB)

- **Source plan:** `plans/sql-search-plan.md` (whole file)
- **Wave:** 3
- **Depends on:** J05 (the scope selector reuses serve.py `/api/datasets`; attached snapshots are the same `/data/<id>/<id>_snapshot.db` files), J02 (it adds a "search" branch to colour-modes.js after the toy path is gone)
- **Locks files:** network_toy/app/src/datasource/sql-search.js (new), network_toy/app/src/datasource/sqlite.js, network_toy/app/src/ui/state.js, network_toy/app/src/ui/viewer-shared/colour-modes.js, network_toy/app/src/ui/panels/search-results.js (new), network_toy/app/src/ui/panels/registry.js, network_toy/app/src/ui/topbar.js, plus tests
- **Parallel-safe with:** any job not touching those files. NOT with: J05/J27 (datasource/sqlite.js), J05/J18/J26 (ui/topbar.js), J02/J25 (colour-modes.js), J02/J10/J14/J25 (ui/state.js)
- **Order constraint:** after J05 (needs /api/datasets) and J02 (colour-modes after toy). Coordinate with J25 (node-highlight framework) — J25 may fold state.searchMatches into the general highlight channel; if J25 runs, search highlighting should plug into it rather than the standalone searchMatches set. Note this.

## Goal

Add a dedicated Search panel that runs read-only SQL — raw SELECT plus a
guided-fields form — against the live in-browser biblion handle (`_handle.db`,
the active dataset) together with any number of additional snapshot DBs ATTACHed
by per-dataset alias, so the user can write cross-database queries. The result
set is a list of papers tagged by dataset; active-dataset hits highlight in the
graph, any hits can be added to the cart, and the cart can be pushed to a
biblion subset. No reload is needed: the active DB is already live in the page.

## Changes

(1) **`datasource/sql-search.js` (new) — query engine.**
- Query context = live `_handle.db` plus selected snapshots ATTACHed by alias
  (alias = sanitised dataset id; the active dataset also gets an alias so SQL is
  symmetric across DBs). Mechanism: fetch `/data/<id>/<id>_snapshot.db`, write
  bytes into sql.js Emscripten FS (`SQL.FS.writeFile`), then
  `db.run("ATTACH '/<id>.db' AS <id>")`. **First verify the sql.js build exposes
  `FS`**; if it does not, fall back to a dedicated in-memory search DB that
  ATTACHes every selected snapshot (including the active one). Cache attached
  snapshots; DETACH on scope change. ATTACH/DETACH are driven by the scope
  selector, never typed by the user, so aliases are always known.
- **SELECT-only guard:** accept exactly one read-only `SELECT` / `WITH … SELECT`;
  reject DDL/DML (`DROP/UPDATE/INSERT/DELETE/ATTACH/DETACH/PRAGMA`). Snapshots
  are read-only copies, but the guard removes footguns.
- **Row cap:** enforce/inject `LIMIT` (~1000) and report "N of M (capped)".
  Queries run synchronously on the main thread (handle lives there) — keep the
  cap; a worker move is a later optimisation.
- Returns `{ columns, rows, capped, perDatasetCounts, error? }`.

(2) **`datasource/sqlite.js` — expose what search needs.**
- Export reverse map `getNodeByPaperId(paperId) → nodeId | null`, built from the
  existing `rowById` / `paperIdByNode` structures (lines 256/313). Maps
  active-dataset hits back to graph nodes for highlight and cart `nodeId`.
- Export `attachSnapshot(datasetId)` / `detachSnapshot(datasetId)` helpers (or
  host the FS-attach logic in sql-search.js via the exported `_handle`/SQL
  module). Keep ingest and search isolated — search must not mutate the data the
  ingest handle depends on beyond read-only ATTACH.

(3) **New highlight state.**
- Add `state.searchMatches` — a Set/mask of **active-dataset** nodeIds (hits from
  attached non-active DBs have no node in the viz → list-only). Add
  `setSearchMatches(nodeIds)` / `clearSearchMatches()` to `state.js` (~line 213,
  beside the single-`selection` `{type,id}`).
- Add a "search" branch to `ui/viewer-shared/colour-modes.js`
  (`nodeColourFor` / `nodeMatchesSelection`, lines 207-235): when `searchMatches`
  is non-empty, matched nodes keep colour, others go `DIMMED_COLOUR`. Both
  viewers route through `nodeColourFor`, so they pick it up on repaint (bump
  engineRevision / dedicated repaint, like the existing selection path).

(4) **`ui/panels/search-results.js` (new) + registry + topbar.**
- SQL editor (textarea) with a schema hint (tables `papers(id, year, title,
  abstract, venue, doi, pub_type, authors, is_rejected, is_stub)` and
  `citations(citing_id, cited_id)`, plus the live ATTACH aliases) and a few
  example templates (by title, by year, by author, high in-degree via a
  `citations` subquery).
- Guided-fields form (title contains / year range / venue / pub_type / min
  in-degree) → composes a `SELECT … FROM papers WHERE …` into the editor, still
  editable; "min in-degree" emits the `citations` COUNT subquery.
- Scope selector: checklist of datasets from `/api/datasets`, active dataset
  checked by default; toggling drives the ATTACH/DETACH set.
- Results table `{ dataset, paperId, title, year, venue, … }`, sortable, reusing
  the `node-table.js` column/row pattern. Row actions: **Highlight in graph**
  (active-dataset hits → `setSearchMatches`, optional focus/zoom; non-active hits
  list-only); **Add to cart** (all/selected →
  `addToCart({ paperId, nodeId, source:"search" })`, `nodeId` only for
  active-dataset hits, `paperId` suffices for cart/subset); **Create subset from
  results** (existing cart→biblion-subset flow); per-row click selects/focuses
  that node if present.
- Register in `ui/panels/registry.js`; add a singleton **Search** opener in
  `ui/topbar.js` (like the cart).

## Verification

- Node `.test.mjs` (Tier 0, pure): SELECT-only guard accepts `SELECT`/`WITH`,
  rejects `DROP`/`UPDATE`/`INSERT`/`DELETE`/`ATTACH`/`DETACH`/`PRAGMA`.
- Node `.test.mjs`: guided-fields → SQL builder produces the expected
  `SELECT … FROM papers WHERE …`, including the `citations` COUNT subquery for
  min in-degree.
- Browser (fallworm fixture): open Search, run `SELECT id,title,year FROM papers
  WHERE year>=2020` → results table populates; `searchMatches` lights the
  matching nodes and the rest dim.
- Browser: single-dataset ATTACH path works; two-dataset ATTACH (fallworm +
  biblion) returns cross-DB rows merged and tagged by `dataset`.
- Browser: add-to-cart from results works and flows through to a subset export.
- Row cap engages on a broad query and reports "N of M (capped)".
- `grep` confirms search never mutates the ingest handle's data — ATTACH is
  read-only and no DDL/DML reaches the live DB.
