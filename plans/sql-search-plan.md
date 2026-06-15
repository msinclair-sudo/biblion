# Library search — SQL search bar over biblion snapshot DBs

## Context

The toy already holds the active dataset's biblion snapshot DB **live in the
browser**: `datasource/sqlite.js` retains a module-scope handle
`_handle = { dataset, db, idByRow, … }` (lines 154, 316-320) and reuses it for
`getNodeText` / `getNodeRecord`. So arbitrary read queries can run against
`_handle.db` with **no reload**. The queryable schema (from the ingest SELECTs)
is `papers(id, year, title, abstract, venue, doi, pub_type, authors,
is_rejected, is_stub)` and `citations(citing_id, cited_id)`.

**Goal:** a "library search" surface in the toy — a panel where the user runs
SQL against biblion databases (the currently-loaded one, or a selection of
several) and gets a paper result set they can highlight in the graph, add to the
cart, or push to a subset. Per decisions: **ATTACH cross-DB** scope, a
**dedicated Search panel**, and **raw SQL + guided fields**.

## Resolved decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Multi-DB execution | **ATTACH cross-DB** — selected snapshot DBs are ATTACHed into one sql.js context under per-dataset aliases; the user writes cross-database SQL. |
| 2 | Primary surface | **Dedicated Search panel** — SQL editor + scope (dataset) selector + results table, opened from the topbar. |
| 3 | Query mode | **Raw SQL + guided fields** — a SQL editor plus a field form (title contains, year range, venue, pub_type, min in-degree) that composes SQL the user can then edit. |

## What has to be built

### 1. Query engine — `app/src/datasource/sql-search.js` (new)

- **Query context** = the live `_handle.db` (active dataset) with **additional
  selected snapshots ATTACHed** by alias (alias = sanitised dataset id; the
  active dataset also gets its own alias for symmetric cross-DB SQL).
  - Mechanism: fetch `/data/<id>/<id>_snapshot.db`, write the bytes into sql.js's
    Emscripten FS (`SQL.FS.writeFile`), then `db.run("ATTACH '/<id>.db' AS <id>")`.
    **Verify the sql.js build exposes `FS`**; if not, fall back to a dedicated
    in-memory search DB that ATTACHes every selected snapshot (including the
    active one). Cache attached snapshots; DETACH on scope change.
  - ATTACH/DETACH are managed by the **scope selector**, not typed by the user —
    so aliases are always known and shown in the schema hint.
- **SELECT-only guard:** accept a single read-only `SELECT` / `WITH … SELECT`;
  reject DDL/DML (`DROP/UPDATE/INSERT/DELETE/ATTACH/DETACH/PRAGMA`). Snapshots are
  read-only copies, but the guard prevents confusion and footguns.
- **Row cap:** enforce/inject a `LIMIT` (e.g. 1000) and report "N of M (capped)".
  Queries run synchronously on the main thread — keep the cap; a worker move is a
  later optimisation (the DB handle lives on the main thread).
- Returns `{ columns, rows, capped, perDatasetCounts, error? }`.

### 2. `datasource/sqlite.js` — expose what search needs

- Export a **reverse map** `getNodeByPaperId(paperId) → nodeId | null` (build from
  the existing `rowById` / `paperIdByNode`, lines 256/313). Used to map active-
  dataset hits back to graph nodes for highlighting/cart `nodeId`.
- Export an `attachSnapshot(datasetId)` / `detachSnapshot(datasetId)` helper (or
  host the FS-attach logic in `sql-search.js` using the exported `_handle`/SQL
  module). Keep ingest and search isolated — search must not mutate the data the
  ingest handle depends on beyond read-only ATTACH.

### 3. Multi-node highlight — new state

Today `state.selection` holds a single `{type, id}` (state.js:213); search needs
to light up a **set** of hits.

- Add `state.searchMatches` — a Set/typed mask of **active-dataset** nodeIds (hits
  from attached, non-active DBs have no node in the viz → list-only).
- Add `setSearchMatches(nodeIds)` / `clearSearchMatches()` to `state.js`.
- Add a "search" branch to `ui/viewer-shared/colour-modes.js`
  (`nodeColourFor` / `nodeMatchesSelection`, lines 207-235): when `searchMatches`
  is non-empty, matched nodes keep colour, others go `DIMMED_COLOUR`. Both viewers
  already route through `nodeColourFor`, so they pick it up on repaint (bump
  engineRevision or a dedicated repaint, like the existing selection path).

### 4. Search panel — `app/src/ui/panels/search-results.js` (new) + registry

- **SQL editor** (textarea) with a **schema hint** (tables + columns + the live
  ATTACH aliases) and a few example templates (by title, by year, by author,
  high in-degree via a `citations` subquery).
- **Guided fields** form (title contains / year range / venue / pub_type / min
  in-degree) → composes a `SELECT … FROM papers WHERE …` into the editor, still
  editable. "min in-degree" emits the `citations` COUNT subquery.
- **Scope selector:** checklist of datasets (from `/api/datasets` — see
  `plans/dataset-picker-plan.md`); the active dataset checked by default. Toggling
  drives the ATTACH/DETACH set.
- **Results table** `{ dataset, paperId, title, year, venue, … }`, sortable,
  reusing the `node-table.js` column/row pattern. Row actions:
  - **Highlight in graph** → active-dataset hits → `setSearchMatches` (+ optional
    focus/zoom). Non-active hits are list-only.
  - **Add to cart** (all / selected) → `addToCart({ paperId, nodeId, source:"search" })`
    (`nodeId` only for active-dataset hits — `paperId` suffices for cart/subset).
  - **Create subset from results** (optional) → the existing cart→biblion-subset
    flow.
  - Per-row click → select/focus that node if present.
- Register in `ui/panels/registry.js`; add a **Search** opener in `ui/topbar.js`
  (singleton panel, like the cart).

## Cross-plan coordination

- **`plans/dataset-picker-plan.md`:** the scope selector reuses `/api/datasets`;
  "currently loaded" = the active `_handle.dataset`; attached snapshots are the
  same `/data/<id>/<id>_snapshot.db` files the picker serves.
- **`plans/toy-removal-plan.md`:** search is real-data only (toy has no DB) —
  consistent; no toy branch needed.
- **Cart / subset:** results are another feeder into the existing
  cart→subset pipeline (`claude_doc_dump/cart-cluster-subset-spec.md`).
- **`plans/test-suite-plan.md`:** browser search tests run against the committed
  fallworm fixture.

## Tests

- **Node `.test.mjs`** (pure, Tier 0): the SELECT-only guard (accepts SELECT/WITH,
  rejects DDL/DML) and the guided-fields→SQL builder.
- **Browser test** (fallworm fixture): run `SELECT id,title,year FROM papers
  WHERE year>=2020`, assert results + that `searchMatches` lights the right nodes +
  add-to-cart. A two-dataset ATTACH test asserting cross-DB rows merge with the
  `dataset` tag.

## Verification

- Open Search panel → type `SELECT id,title,year FROM papers WHERE year>=2020`
  against loaded fallworm → results table; matching nodes highlight, the rest dim.
- Guided fields (title contains "soil", year 2015-2026) compose correct SQL.
- Multi-DB: check fallworm + biblion → both ATTACHed → cross-DB query returns
  merged rows tagged by dataset.
- SELECT-only guard rejects `DROP`/`UPDATE`/`DELETE`.
- Row cap engages on a broad query and reports the cap.
- Add-to-cart from results works and flows to a subset export.
- `grep` confirms search never mutates the ingest handle's data (read-only ATTACH).
