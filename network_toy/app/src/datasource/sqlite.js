// Real-data source backed by a biblion SQLite corpus, built by biblion itself:
//   biblion advanced snapshot   -> <name>_snapshot.db + paper_index.json + ...
//   biblion advanced embedding  -> embeddings.npy
// The bundle lands next to the project DB at the repo-root data/<name>/; the toy
// reaches it because serve.py maps /data/ URLs onto that repo-root data/ dir.
//
// Unlike real.js (a pile of JSON/npy files), this source reads a single
// `*_snapshot.db` snapshot in the browser via sql.js (WASM) and queries it on
// demand. The high-dim embedding stays a separate `.npy` (injected like real.js).
//
// The one hard invariant (enforced below): embeddings.npy row i ==
// paper_index["i"] == the i-th row of the canonical node-set query against the
// snapshot. We re-run that query here and FAIL LOUD if the db has drifted from
// the embedding (e.g. the db was re-enriched without re-embedding).
//
// SAFETY: the toy must only ever attach a *snapshot* DB, never a live project
// DB (data/<name>/<name>.db is in the same dir, mid-write WAL, and attaching it
// would break the row-alignment invariant). We require `snapshot` in the DB
// filename and refuse anything else — see assertSnapshotPath().

import { parseNpy } from "./npy.js";
// sql.js (the WASM engine) is lazy-loaded inside getSQL() rather than imported
// at module top level. Merely importing this module — for DATASETS, getNodeText,
// hasSqliteText, getIdByRow — must NOT pull the WASM lib, so the datasource (and
// everything that transitively imports it: node-table, layer-descriptors,
// next-steps-rules) stays importable under plain Node for the pure-logic unit
// tests. In the browser the importmap resolves the dynamic import the same way.

// Canonical node-set filter + order. MUST match biblion/snapshot.py
// (NODE_SET_WHERE) — the snapshot, the .npy and this query all have to agree on
// the node set. This is the EMBEDDED node set (rows 0..m-1 of embeddings.npy).
const NODE_SET_WHERE =
  "is_rejected = 0 AND is_stub = 0 AND title IS NOT NULL AND abstract IS NOT NULL";

// Structural ("ghost") node-set filter — the wider set surfaced by
// `biblion advanced snapshot --include-structural`. A node is structural when
// it survives rejection + has a title but has NO embedding row (is a stub or
// lacks an abstract). MUST match biblion/snapshot.py's structural predicate.
// These nodes carry citation edges but no SPECTER2 vector; the toy renders them
// as ghosts (isGhost=true, last n-m indices). See ghost-node spec §4.1.
const STRUCTURAL_WHERE =
  "is_rejected = 0 AND title IS NOT NULL AND (is_stub = 1 OR abstract IS NULL)";

// id → {label, sqlitePath, embeddingsPath, indexPath}. No longer hardcoded:
// the list is fetched from serve.py /api/datasets (which scans data/*/ for
// loadable datasets), then this map is populated by datasetEntry()/loadDatasets().
// Paths are derived from the id and resolved by serve.py, which serves /data/
// URLs from the repo-root data/ dir. The DB is always the snapshot copy
// (…_snapshot.db), never the live <name>.db.
const DATASETS = {};

// Build the per-dataset fetch URLs from its id. Centralised so the picker and
// produceSqlite agree on layout. (Previously the literal paths in DATASETS;
// kept identical — /data/<id>/<id>_snapshot.db etc.)
function datasetEntry(id, label) {
  return {
    label: label || id,
    sqlitePath: `/data/${id}/${id}_snapshot.db`,
    embeddingsPath: `/data/${id}/embeddings.npy`,
    indexPath: `/data/${id}/paper_index.json`,
  };
}

// Fetch the loadable datasets from serve.py and (re)populate DATASETS +
// SQLITE_OPTIONS. Returns the dataset list. Best-effort: a server without the
// API (plain http.server) yields an empty list and the picker shows nothing.
let _datasetsPromise = null;
export function loadDatasets() {
  if (_datasetsPromise) return _datasetsPromise;
  _datasetsPromise = (async () => {
    let list = [];
    try {
      const r = await fetch("/api/datasets");
      if (r.ok) list = await r.json();
    } catch { /* no API (static-only server) → empty */ }
    for (const d of list) {
      if (!DATASETS[d.id]) {
        DATASETS[d.id] = datasetEntry(d.id, d.label);
        SQLITE_OPTIONS.push({ value: d.id, label: DATASETS[d.id].label });
      }
    }
    return list;
  })();
  return _datasetsPromise;
}

// Ensure DATASETS holds at least the requested id before produceSqlite reads
// it. Pulls the live list if it's not loaded yet, then falls back to deriving
// the entry from the id alone (so a save's stored dataset still loads even if
// the API is briefly unavailable).
async function ensureDataset(id) {
  if (!DATASETS[id]) await loadDatasets();
  if (!DATASETS[id]) DATASETS[id] = datasetEntry(id);
  return DATASETS[id];
}

// Guard: only ever open a snapshot DB. A live project DB (…/<name>.db) in the
// same data dir is mid-write and would corrupt the read / break alignment.
function assertSnapshotPath(sqlitePath) {
  const base = sqlitePath.split("/").pop() || "";
  if (!/snapshot/i.test(base)) {
    throw new Error(
      `[datasource:sqlite] refusing non-snapshot DB "${base}" — the toy only ` +
      `attaches *_snapshot.db files (run \`biblion advanced snapshot\`).`
    );
  }
}

// No fixed default dataset — the data/-driven picker (ui/modals/data-source-
// modal.js) always passes an explicit {dataset} chosen from /api/datasets.
// Empty default keeps produceSqlite honest: it must be told which dataset.
export const defaultSqliteParams = () => ({ dataset: null });

// Flat option list for the data-source picker: every dataset, plus each
// discovered subset addressed as "<project>::<subset>". Starts empty and is
// populated by loadDatasets() (from /api/datasets) then discoverSubsets().
// Mutated IN PLACE so the modal — which reads this array fresh each open —
// reflects whatever was discovered.
export const SQLITE_OPTIONS = [];

// Best-effort: fetch each dataset's subsets/index.json and append its embedded
// subsets to SQLITE_OPTIONS. A dataset with no subsets/ (404) is skipped.
export async function discoverSubsets() {
  await loadDatasets();   // need the dataset ids before we can probe subsets
  await Promise.all(Object.keys(DATASETS).map(async (id) => {
    let idx;
    try {
      const r = await fetch(`/data/${id}/subsets/index.json`);
      if (!r.ok) return;
      idx = await r.json();
    } catch { return; }
    for (const s of (idx.subsets || [])) {
      if (!s.embedded) continue;                 // un-embedded subset can't load
      const value = `${id}::${s.name}`;
      if (SQLITE_OPTIONS.some((o) => o.value === value)) continue;
      SQLITE_OPTIONS.push({ value, label: `${DATASETS[id].label} / ${s.label || s.name}` });
    }
  }));
  return SQLITE_OPTIONS;
}

// Fire discovery at load so datasets + subsets are usually present by the time
// the data-source modal is opened. Fire-and-forget; failures are non-fatal.
discoverSubsets();

// sql.js engine — initialised once, shared across produce() calls.
let _sqlPromise = null;
function getSQL() {
  if (!_sqlPromise) {
    _sqlPromise = import("sql.js").then((m) =>
      (m.default || m)({
        locateFile: (f) => `https://esm.sh/sql.js@1.10.3/dist/${f}`,
      })
    );
  }
  return _sqlPromise;
}

// Live handle for on-demand per-node lookups (getNodeText). Set by the most
// recent produceSqlite(); replaced when a different dataset is loaded.
let _handle = null;

export async function produceSqlite(params = {}) {
  // A subset is addressed as "<project>::<subset>"; a bare id is the full
  // project. A subset reuses the project's shared snapshot DB and supplies its
  // own paper_index + embeddings under subsets/<name>/.
  const datasetId = params.dataset;
  if (!datasetId) throw new Error(`[datasource:sqlite] no dataset selected (pick one from the picker)`);
  const sep = datasetId.indexOf("::");
  const projectId = sep === -1 ? datasetId : datasetId.slice(0, sep);
  const subsetName = sep === -1 ? null : datasetId.slice(sep + 2);
  const base = await ensureDataset(projectId);
  if (!base) throw new Error(`[datasource:sqlite] unknown dataset "${projectId}"`);
  const ds = subsetName ? {
    label:          `${base.label} / ${subsetName}`,
    sqlitePath:     base.sqlitePath,   // shared project snapshot DB
    embeddingsPath: `/data/${projectId}/subsets/${subsetName}/embeddings.npy`,
    indexPath:      `/data/${projectId}/subsets/${subsetName}/paper_index.json`,
    subset:         true,
  } : base;
  assertSnapshotPath(ds.sqlitePath);

  const [SQL, embAb, dbAb, indexObj] = await Promise.all([
    getSQL(),
    fetch(ds.embeddingsPath).then((r) => {
      if (!r.ok) throw new Error(`[datasource:sqlite] ${ds.embeddingsPath}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(ds.sqlitePath).then((r) => {
      if (!r.ok) throw new Error(`[datasource:sqlite] ${ds.sqlitePath}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(ds.indexPath).then((r) => {
      if (!r.ok) throw new Error(`[datasource:sqlite] ${ds.indexPath}: HTTP ${r.status}`);
      return r.json();
    }),
  ]);

  const { shape, data } = parseNpy(embAb);
  const [m, d] = shape;   // m = EMBEDDED rows in the .npy (ghosts are not in it)

  // index["i"] → papers.id for the m embedded rows; defines the canonical
  // embedded-node order (the .npy contract). An index entry may be a bare id
  // (legacy snapshots) or {id, structural} (--include-structural snapshots);
  // here we only read the embedded rows 0..m-1, which are never structural.
  const idOf = (entry) => (entry && typeof entry === "object") ? entry.id : entry;
  const idByRow = new Array(m);
  for (let i = 0; i < m; i++) {
    const id = idOf(indexObj[String(i)]);
    if (id == null) throw new Error(`[datasource:sqlite] paper_index missing row ${i}`);
    idByRow[i] = id;
  }

  const db = new SQL.Database(new Uint8Array(dbAb));

  let embRows, ghostRows;
  if (ds.subset) {
    // Subset mode: the node set IS the subset's paper_index (m ids), looked up
    // against the SHARED project snapshot DB; preserve paper_index order. No
    // structural/ghost nodes. Pull all (id, year) once and project, to dodge
    // SQLite's 999-param IN() limit for large subsets.
    const yearById = new Map();
    const allRes = db.exec("SELECT id, year FROM papers");
    for (const row of (allRes.length ? allRes[0].values : [])) yearById.set(row[0], row[1]);
    embRows = new Array(m);
    for (let i = 0; i < m; i++) {
      const id = idByRow[i];
      if (!yearById.has(id)) {
        throw new Error(`[datasource:sqlite] subset id ${id} not in snapshot ${ds.sqlitePath} (stale subset — re-run \`biblion advanced subset make\`)`);
      }
      embRows[i] = [id, yearById.get(id)];
    }
    ghostRows = [];
  } else {
    // Full project: re-derive the EMBEDDED node set from the snapshot, in the
    // same order, and verify it matches the embedding's index row-for-row.
    const embRes = db.exec(`SELECT id, year FROM papers WHERE ${NODE_SET_WHERE} ORDER BY id`);
    embRows = embRes.length ? embRes[0].values : [];
    if (embRows.length !== m) {
      throw new Error(`[datasource:sqlite] embedded node-set size ${embRows.length} != embedding rows ${m} (db drifted from embedding — re-run \`biblion advanced snapshot\` + \`embedding\`)`);
    }
    // Structural ("ghost") nodes: surfaced only when the snapshot was carved
    // with --include-structural. They are NOT in the .npy; we append them as the
    // last n-m node indices. On a legacy (embedded-only) snapshot this query
    // returns nothing and the node set is unchanged.
    const ghostRes = db.exec(`SELECT id, year FROM papers WHERE ${STRUCTURAL_WHERE} ORDER BY id`);
    ghostRows = ghostRes.length ? ghostRes[0].values : [];
  }
  const n = m + ghostRows.length;

  // Year range → t ∈ [0,1] (newest = 1), matching real.js's FR time anchor.
  // Computed over all nodes (embedded + ghost) so ghosts share the timeline.
  let yrMin = Infinity, yrMax = -Infinity;
  const noteYear = (y) => {
    if (Number.isFinite(y)) {
      if (y < yrMin) yrMin = y;
      if (y > yrMax) yrMax = y;
    }
  };
  for (let i = 0; i < m; i++) noteYear(embRows[i][1]);
  for (let i = 0; i < ghostRows.length; i++) noteYear(ghostRows[i][1]);
  const yrRange = yrMax > yrMin ? yrMax - yrMin : 0;

  const rowById = new Map();
  const nodes = new Array(n);
  const mkNode = (idx, id, y, isGhost) => {
    rowById.set(id, idx);
    let t = 0, year = null;
    if (Number.isFinite(y)) {
      year = y;
      t = yrRange > 0 ? (y - yrMin) / yrRange : 0;
    }
    nodes[idx] = { id: idx, t, year, paperId: id, isGhost };
  };
  // Embedded nodes occupy rows 0..m-1, in .npy order.
  for (let i = 0; i < m; i++) {
    const id = embRows[i][0];
    if (id !== idByRow[i]) {
      throw new Error(`[datasource:sqlite] row ${i}: snapshot id ${id} != paper_index ${idByRow[i]} (embedding/db drift — re-run \`biblion advanced snapshot\` + \`embedding\`)`);
    }
    mkNode(i, id, embRows[i][1], false);
  }
  // Ghosts occupy rows m..n-1 (NO embedding row). Skip any structural id that
  // somehow already appeared in the embedded set (defensive — the predicates
  // are disjoint, but a malformed snapshot must not double-insert a node).
  let ghostIdx = m;
  for (let i = 0; i < ghostRows.length; i++) {
    const id = ghostRows[i][0];
    if (rowById.has(id)) continue;
    mkNode(ghostIdx++, id, ghostRows[i][1], true);
  }
  // Compact away any skipped duplicate slots so node ids stay contiguous 0..n-1.
  if (ghostIdx !== n) nodes.length = ghostIdx;
  const nFinal = nodes.length;

  // Node index → embedding row, -1 for ghosts. Embedded nodes are rows 0..m-1
  // by construction, so this is the identity on [0,m) and -1 on [m,n) — but we
  // emit it explicitly so downstream consumers never have to re-derive the mask.
  const rowOf = new Int32Array(nFinal);
  for (let i = 0; i < nFinal; i++) rowOf[i] = nodes[i].isGhost ? -1 : i;

  // Citation edges → flat [src, dst, …] in node-index space. biblion stores
  // canonical citing→cited, which already IS the toy's "source cites target",
  // so NO direction flip. Edges to ghosts are KEPT (the whole point — they carry
  // the A→ghost→B bridge). Drop only edges whose endpoint is in neither set.
  const edgeRes = db.exec("SELECT citing_id, cited_id FROM citations");
  const edgeVals = edgeRes.length ? edgeRes[0].values : [];
  const citationEdges = [];
  let droppedEdges = 0;
  let ghostEdges = 0;
  for (let k = 0; k < edgeVals.length; k++) {
    const s = rowById.get(edgeVals[k][0]);
    const t = rowById.get(edgeVals[k][1]);
    if (s === undefined || t === undefined) { droppedEdges++; continue; }
    if (nodes[s].isGhost || nodes[t].isGhost) ghostEdges++;
    citationEdges.push(s, t);
  }

  // Node index → papers.id over ALL nodes (embedded + ghost), for on-demand
  // text/record lookups keyed by the toy's node id (which now spans ghosts).
  const paperIdByNode = new Array(nFinal);
  for (let i = 0; i < nFinal; i++) paperIdByNode[i] = nodes[i].paperId;

  // Keep the db open for on-demand getNodeText(). Free any previous handle.
  if (_handle && _handle.db && _handle.db !== db) {
    try { _handle.db.close(); } catch { /* ignore */ }
  }
  // rowById (papers.id → node index) is the reverse of paperIdByNode; the SQL
  // search panel needs it to map active-dataset hits back to graph nodes.
  // Stash it on the handle (rowById is otherwise local to this function).
  _handle = {
    dataset: datasetId, db, idByRow: paperIdByNode, nodeByPaperId: rowById,
    textStmt: null, attached: new Map(),
  };

  return {
    method: "sqlite",
    params: {
      dataset: datasetId,
      yearRange: Number.isFinite(yrMin) ? [yrMin, yrMax] : null,
      edgesKept: citationEdges.length / 2,
      edgesDropped: droppedEdges,
      nEmbedded: m,
      nGhost: nFinal - m,
      ghostEdges,
    },
    nodes,
    // Embedding covers the m embedded nodes only; ghosts have no row. rowOf
    // maps node index → embedding row (-1 for ghosts); m is the embedded count.
    embedding: { d, data, m, rowOf },
    citationEdges,
    // No basePos — Layer 1.5's viz sub-stage populates _basePos on demand.
  };
}

// Node index → papers.id, the cheap path (no metadata query). For bulk
// node→paperId mapping (e.g. gathering a cluster's members into the cart);
// getNodeRecord stays the full-record path. Null if no corpus / row missing.
export function getIdByRow(nodeId) {
  if (!_handle) return null;
  const paperId = _handle.idByRow[nodeId];
  return paperId == null ? null : paperId;
}

// On-demand per-node text for the labelling ctx (c-TF-IDF / TF-IDF).
// Returns "title. abstract" (whichever are present) for the node's papers.id,
// or null if no corpus is loaded / the row is missing. Reuses one prepared
// statement across calls (labelling queries every node in a cluster).
export function getNodeText(nodeId) {
  if (!_handle) return null;
  const { db, idByRow } = _handle;
  const paperId = idByRow[nodeId];
  if (paperId == null) return null;
  const stmt = _handle.textStmt ||
    (_handle.textStmt = db.prepare("SELECT title, abstract FROM papers WHERE id = ?"));
  stmt.reset();
  stmt.bind([paperId]);
  if (!stmt.step()) return null;
  const [title, abstract] = stmt.get();
  const parts = [];
  if (title) parts.push(title);
  if (abstract) parts.push(abstract);
  return parts.length ? parts.join(". ") : null;
}

// Full per-node bibliographic record for citation export (RIS/BibTeX). Reads
// the columns a reference manager needs from the biblion papers table. Reuses
// one prepared statement across calls (export iterates many nodes). Returns
// null when no corpus is loaded / the row is missing.
//
//   { paperId, title, year, venue, doi, pubType, abstract, authors: string[] }
//
// `authors` is biblion's JSON array of display-name strings (parsed here);
// any parse failure degrades to []. Other fields are null when absent.
export function getNodeRecord(nodeId) {
  if (!_handle) return null;
  const { db, idByRow } = _handle;
  const paperId = idByRow[nodeId];
  if (paperId == null) return null;
  const stmt = _handle.recordStmt ||
    (_handle.recordStmt = db.prepare(
      "SELECT title, year, venue, doi, pub_type, abstract, authors " +
      "FROM papers WHERE id = ?"));
  stmt.reset();
  stmt.bind([paperId]);
  if (!stmt.step()) return null;
  const [title, year, venue, doi, pubType, abstract, authorsJson] = stmt.get();
  let authors = [];
  if (authorsJson) {
    try {
      const parsed = JSON.parse(authorsJson);
      if (Array.isArray(parsed)) authors = parsed.filter(a => typeof a === "string" && a.trim());
    } catch { /* malformed authors JSON → no authors */ }
  }
  return {
    paperId,
    title:    title    || null,
    year:     Number.isFinite(year) ? year : null,
    venue:    venue    || null,
    doi:      doi      || null,
    pubType:  pubType  || null,
    abstract: abstract || null,
    authors,
  };
}

// Parse biblion's JSON name array (authors / editors) into a clean string list;
// any parse failure degrades to [].
function parseNameList(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((a) => typeof a === "string" && a.trim())
      : [];
  } catch {
    return [];
  }
}

// { scheme: [value, …] } from the identifiers table for one paper. The table is
// absent in older snapshots — the first failure flips a handle flag so we don't
// re-prepare per row.
function loadIdentifiers(handle, paperId) {
  if (handle.identifiersTable === false) return {};
  try {
    const stmt = handle.idStmt ||
      (handle.idStmt = handle.db.prepare(
        "SELECT scheme, value FROM identifiers WHERE paper_id = ?"));
    stmt.reset();
    stmt.bind([paperId]);
    const out = {};
    while (stmt.step()) {
      const { scheme, value } = stmt.getAsObject();
      if (scheme && value) (out[scheme] || (out[scheme] = [])).push(value);
    }
    return out;
  } catch {
    handle.identifiersTable = false;   // no identifiers table in this snapshot
    return {};
  }
}

// The papers columns getNodeFullRecord wants. Older snapshots predate the
// extended bibliographic columns (editors/volume/pages/…), so we intersect this
// list with what the table actually has — a missing column reads back as null.
const _FULL_RECORD_COLUMNS = [
  "citekey", "title", "year", "venue", "doi", "pub_type", "abstract", "authors",
  "editors", "volume", "issue", "first_page", "last_page", "publisher",
  "booktitle", "series", "edition", "language", "month", "editorial_status",
  "pubmed_id",
];

// Set of column names on the papers table, discovered once per handle.
function papersColumns(handle) {
  if (handle.papersCols) return handle.papersCols;
  const cols = new Set();
  try {
    const stmt = handle.db.prepare("PRAGMA table_info(papers)");
    while (stmt.step()) {
      const { name } = stmt.getAsObject();
      if (name) cols.add(name);
    }
    stmt.free();
  } catch { /* degrade to empty -> getNodeFullRecord returns mostly nulls */ }
  handle.papersCols = cols;
  return cols;
}

// Full bibliographic record for citation export (BibTeX). Reads the complete set
// of reference columns the snapshot has (older snapshots lack the extended ones)
// plus the identifiers table (isbn/issn/arxiv/…). Heavier than getNodeRecord
// (which feeds the live tables on every rejoin) — meant for export, where the
// caller iterates a bounded set. Null when no corpus is loaded / the row is gone.
//
//   { paperId, citekey, title, year, venue, doi, pubType, abstract, authors:[],
//     editors:[], volume, issue, firstPage, lastPage, publisher, booktitle,
//     series, edition, language, month, editorialStatus, pubmedId,
//     identifiers:{scheme:[…]} }
export function getNodeFullRecord(nodeId) {
  if (!_handle) return null;
  const { db, idByRow } = _handle;
  const paperId = idByRow[nodeId];
  if (paperId == null) return null;
  const stmt = _handle.fullRecordStmt ||
    (_handle.fullRecordStmt = (() => {
      const present = papersColumns(_handle);
      const cols = _FULL_RECORD_COLUMNS.filter((c) => present.has(c));
      return db.prepare(`SELECT ${cols.join(", ")} FROM papers WHERE id = ?`);
    })());
  stmt.reset();
  stmt.bind([paperId]);
  if (!stmt.step()) return null;
  const r = stmt.getAsObject();
  return {
    paperId,
    citekey:         r.citekey || null,
    title:           r.title || null,
    year:            Number.isFinite(r.year) ? r.year : null,
    venue:           r.venue || null,
    doi:             r.doi || null,
    pubType:         r.pub_type || null,
    abstract:        r.abstract || null,
    authors:         parseNameList(r.authors),
    editors:         parseNameList(r.editors),
    volume:          r.volume || null,
    issue:           r.issue || null,
    firstPage:       r.first_page || null,
    lastPage:        r.last_page || null,
    publisher:       r.publisher || null,
    booktitle:       r.booktitle || null,
    series:          r.series || null,
    edition:         r.edition || null,
    language:        r.language || null,
    month:           r.month || null,
    editorialStatus: r.editorial_status || null,
    pubmedId:        r.pubmed_id || null,
    identifiers:     loadIdentifiers(_handle, paperId),
  };
}

// Whether a live sqlite corpus is loaded (so callers can decide whether to
// offer text-based labelling / bibliographic export). True after a successful
// produceSqlite().
export function hasSqliteText() {
  return _handle != null;
}

// Drop the loaded corpus: close the DB handle and null the module state so
// hasSqliteText() reads false again. The inverse of produceSqlite() — used
// when switching away from the sqlite source (and by the test harness to
// restore a data-free session, since _handle is module-global and survives a
// state.update reset). Idempotent.
export function clearSqliteCorpus() {
  if (_handle && _handle.db) {
    try { _handle.db.close(); } catch { /* already closed */ }
  }
  _handle = null;
}

// Re-open the snapshot DB for a project loaded from a save, WITHOUT re-running
// the pipeline. A project load (topbar rehydrateFromBlob) restores state but
// skips the data cascade, so the live DB handle that getNodeRecord / getNodeText
// / SQL-search rely on was never reopened — per-paper metadata (title, authors,
// venue, …) goes missing even though year/cluster (from genResult) still show.
//
// We rebuild idByRow / nodeByPaperId from the LOADED nodes' own paperIds (which
// round-trip through the save), and only need the DB itself for the papers
// table. `nodes` is state.genResult.nodes; `datasetId` is the saved dataset id
// (possibly "<project>::<subset>" — the papers live in the project snapshot DB).
// Returns true on success; throws on a missing/failed DB fetch (caller decides
// whether to surface it).
export async function reconnectSqliteCorpus(datasetId, nodes) {
  if (!datasetId || !Array.isArray(nodes) || nodes.length === 0) return false;
  const sep = datasetId.indexOf("::");
  const projectId = sep === -1 ? datasetId : datasetId.slice(0, sep);
  const base = await ensureDataset(projectId);
  if (!base) return false;
  assertSnapshotPath(base.sqlitePath);

  const [SQL, dbAb] = await Promise.all([
    getSQL(),
    fetch(base.sqlitePath).then((r) => {
      if (!r.ok) throw new Error(`[datasource:sqlite] ${base.sqlitePath}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  const db = new SQL.Database(new Uint8Array(dbAb));

  // node index → papers.id straight off the restored nodes (same content as the
  // original paperIdByNode); reverse map for SQL search.
  const idByRow = nodes.map((nd) => (nd && nd.paperId != null) ? nd.paperId : null);
  const nodeByPaperId = new Map();
  for (let i = 0; i < idByRow.length; i++) {
    if (idByRow[i] != null) nodeByPaperId.set(idByRow[i], i);
  }

  if (_handle && _handle.db && _handle.db !== db) {
    try { _handle.db.close(); } catch { /* already closed */ }
  }
  _handle = {
    dataset: datasetId, db, idByRow, nodeByPaperId,
    textStmt: null, recordStmt: null, attached: new Map(),
  };
  return true;
}

// ── SQL library search support (J09) ────────────────────────────────────
// The active dataset's snapshot DB already lives in the page (_handle.db). The
// search panel runs read-only SELECTs against it directly, plus any number of
// other snapshot DBs ATTACHed by alias. Everything below is the cross-DB plumbing
// the panel needs; the SELECT-only guard and query building live in sql-search.js.

// papers.id → graph node index (the reverse of the per-node paperId map), or
// null when no corpus is loaded / the paper isn't a graph node. Active-dataset
// hits use this to highlight in the viewer and to fill cart `nodeId`; hits from
// ATTACHed non-active DBs have no node and return null (list-only).
export function getNodeByPaperId(paperId) {
  if (!_handle || !_handle.nodeByPaperId) return null;
  const idx = _handle.nodeByPaperId.get(paperId);
  return idx === undefined ? null : idx;
}

// The active dataset id (the one whose snapshot is the live _handle.db), or null.
export function getActiveDatasetId() {
  return _handle ? _handle.dataset : null;
}

// Alias under which a dataset id is ATTACHed in SQL. SQLite schema names must be
// bare identifiers, so non-word chars (incl. the subset "::" separator) collapse
// to "_". The active dataset is the unaliased `main` schema; callers that want a
// symmetric alias for it can use this too.
export function searchAlias(datasetId) {
  return String(datasetId).replace(/[^A-Za-z0-9_]/g, "_");
}

// Whether the sql.js build exposes an Emscripten FS (needed for ATTACH against a
// file path). Determined off the live handle's SQL module. Currently the search
// path requires FS; if a build lacks it, attachSnapshot throws and the panel
// reports the failure rather than silently degrading.
export async function searchFsAvailable() {
  const SQL = await getSQL();
  return !!(SQL && SQL.FS && typeof SQL.FS.writeFile === "function");
}

// ATTACH another dataset's *_snapshot.db onto the live handle under its alias so
// the panel can run cross-DB SELECTs. Read-only: we only ever ATTACH a snapshot
// copy and never issue DML/DDL against it (the SELECT-only guard enforces the
// rest). Cached per alias — re-attaching is a no-op. Returns the alias.
export async function attachSnapshot(datasetId) {
  if (!_handle) throw new Error("[datasource:sqlite] no corpus loaded — cannot ATTACH");
  const alias = searchAlias(datasetId);
  if (_handle.attached.has(alias)) return alias;
  const SQL = await getSQL();
  if (!(SQL.FS && typeof SQL.FS.writeFile === "function")) {
    throw new Error("[datasource:sqlite] sql.js build has no FS — cross-DB ATTACH unavailable");
  }
  const sep = datasetId.indexOf("::");
  const projectId = sep === -1 ? datasetId : datasetId.slice(0, sep);
  const base = await ensureDataset(projectId);
  assertSnapshotPath(base.sqlitePath);   // never attach a live project DB
  const r = await fetch(base.sqlitePath);
  if (!r.ok) throw new Error(`[datasource:sqlite] ${base.sqlitePath}: HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const fsPath = `/${alias}.db`;
  SQL.FS.writeFile(fsPath, bytes);
  _handle.db.run(`ATTACH '${fsPath}' AS ${alias}`);
  _handle.attached.set(alias, fsPath);
  return alias;
}

// DETACH a previously-attached snapshot and drop its FS bytes. No-op if it isn't
// attached. Driven by the scope selector on toggle-off.
export async function detachSnapshot(datasetId) {
  return detachSnapshotByAlias(searchAlias(datasetId));
}

// DETACH by the bare alias (the scope reconciler holds aliases, not ids).
export async function detachSnapshotByAlias(alias) {
  if (!_handle) return;
  const fsPath = _handle.attached.get(alias);
  if (!fsPath) return;
  try { _handle.db.run(`DETACH ${alias}`); } catch { /* already gone */ }
  const SQL = await getSQL();
  try { SQL.FS.unlink(fsPath); } catch { /* best-effort */ }
  _handle.attached.delete(alias);
}

// Currently-attached aliases (excludes the active dataset's `main` schema).
export function attachedAliases() {
  return _handle ? [..._handle.attached.keys()] : [];
}

// Run a read-only SELECT against the live handle (+ any ATTACHed snapshots).
// Returns { columns, values } in sql.js exec shape, or { columns: [], values: [] }
// for an empty result. The caller (sql-search.js) is responsible for the
// SELECT-only guard and the LIMIT cap; this is the thin execution seam so the
// panel never touches the module-private handle directly.
export function runSearchQuery(sql) {
  if (!_handle) throw new Error("[datasource:sqlite] no corpus loaded — cannot query");
  const res = _handle.db.exec(sql);
  if (!res.length) return { columns: [], values: [] };
  return { columns: res[0].columns, values: res[0].values };
}
