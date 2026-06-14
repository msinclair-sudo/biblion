// SQL library search — read-only query engine over biblion snapshot DBs.
//
// The active dataset's snapshot already lives in the page (datasource/sqlite.js's
// _handle.db); this module runs read-only SELECTs against it plus any number of
// additional snapshots ATTACHed by alias (driven by the panel's scope selector,
// never typed by the user — so aliases are always known). The user can write
// cross-database SQL; results come back tagged by dataset.
//
// Two halves:
//   - PURE (no sql.js, importable under plain Node for unit tests): the
//     SELECT-only guard and the guided-fields → SQL builder.
//   - RUNTIME (browser): scope ATTACH/DETACH + query execution, which reach into
//     sqlite.js via a dynamic import so this module stays Node-importable.
//
// SAFETY: the guard rejects everything but a single SELECT / WITH…SELECT, and
// the snapshots are read-only copies. ATTACH/DETACH are issued by the runtime
// helpers below (off the scope selector), never accepted from user SQL.

// Default row cap. Queries run synchronously on the main thread (the handle lives
// there), so we cap the result set and report "N of M (capped)". A worker move is
// a later optimisation.
export const DEFAULT_ROW_CAP = 1000;

// Statements that must never reach the live handle. The guard is a coarse
// keyword/structure check, not a full parser — snapshots are read-only so this is
// defence-in-depth, not the only line of defence.
const FORBIDDEN = [
  "DROP", "UPDATE", "INSERT", "DELETE", "ATTACH", "DETACH",
  "PRAGMA", "ALTER", "CREATE", "REPLACE", "VACUUM", "REINDEX", "GRANT", "TRIGGER",
];

// Strip SQL comments and a single trailing ";" so the guard sees just the
// statement body. Block comments and -- line comments are removed; string
// literals are left intact (a forbidden keyword inside a literal is still caught
// by the word-boundary scan below, which is the safe direction — reject).
function normalise(sql) {
  return String(sql || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // /* block */
    .replace(/--[^\n]*/g, " ")            // -- line
    .trim()
    .replace(/;\s*$/, "")                 // one trailing semicolon ok
    .trim();
}

// Validate that `sql` is exactly one read-only SELECT (or WITH … SELECT).
// Returns { ok: true, sql } (normalised) or { ok: false, error }.
export function validateSelect(sql) {
  const body = normalise(sql);
  if (!body) return { ok: false, error: "empty query" };
  // Reject multi-statement input (a ";" anywhere after the trim means a second
  // statement — the single trailing one was already stripped).
  if (body.includes(";")) {
    return { ok: false, error: "only a single statement is allowed" };
  }
  const upper = body.toUpperCase();
  // Must start with SELECT or WITH (CTE feeding a SELECT).
  if (!/^\s*(SELECT|WITH)\b/.test(upper)) {
    return { ok: false, error: "query must be a SELECT (or WITH … SELECT)" };
  }
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      return { ok: false, error: `${kw} is not allowed — SELECT only` };
    }
  }
  // A WITH must ultimately drive a SELECT (no INSERT/UPDATE CTE target). The
  // forbidden scan already rejects those keywords; require a SELECT to appear.
  if (/^\s*WITH\b/.test(upper) && !/\bSELECT\b/.test(upper)) {
    return { ok: false, error: "WITH must feed a SELECT" };
  }
  return { ok: true, sql: body };
}

// Wrap a validated SELECT so the row cap is enforced regardless of any LIMIT the
// user wrote. We fetch cap+1 rows via an outer SELECT and report "capped" when
// the extra row comes back. Wrapping (rather than string-injecting a LIMIT) keeps
// the user's own ORDER BY / LIMIT semantics intact inside the subquery.
export function capQuery(sql, cap = DEFAULT_ROW_CAP) {
  const body = normalise(sql);
  return `SELECT * FROM (${body}) LIMIT ${cap + 1}`;
}

// ── Guided fields → SQL builder ─────────────────────────────────────────
// Compose a `SELECT … FROM papers WHERE …` from the form fields. The output is
// dropped into the editor and stays user-editable. Empty/blank fields are
// skipped. `minInDegree` emits a correlated COUNT subquery over `citations`.
//
// fields = {
//   titleContains?: string,
//   yearFrom?: number, yearTo?: number,
//   venue?: string,           // substring match
//   pubType?: string,         // exact match
//   minInDegree?: number,
// }
export function buildGuidedQuery(fields = {}) {
  const where = [];
  const esc = (s) => String(s).replace(/'/g, "''");
  // A blank string coerces to 0 via unary +, which would inject spurious
  // `>= 0` clauses; treat "" / whitespace as absent before parsing a number.
  const num = (v) => {
    if (v == null || String(v).trim() === "") return null;
    const n = +v;
    return Number.isFinite(n) ? n : null;
  };
  const yearFrom = num(fields.yearFrom);
  const yearTo   = num(fields.yearTo);
  const minDeg   = num(fields.minInDegree);

  if (fields.titleContains && String(fields.titleContains).trim()) {
    where.push(`title LIKE '%${esc(String(fields.titleContains).trim())}%'`);
  }
  if (yearFrom != null) where.push(`year >= ${yearFrom}`);
  if (yearTo != null)   where.push(`year <= ${yearTo}`);
  if (fields.venue && String(fields.venue).trim()) {
    where.push(`venue LIKE '%${esc(String(fields.venue).trim())}%'`);
  }
  if (fields.pubType && String(fields.pubType).trim()) {
    where.push(`pub_type = '${esc(String(fields.pubType).trim())}'`);
  }
  if (minDeg != null && minDeg > 0) {
    // In-degree = count of citations pointing AT this paper (cited_id = p.id).
    where.push(
      `(SELECT COUNT(*) FROM citations WHERE cited_id = p.id) >= ${minDeg}`
    );
  }

  const clause = where.length ? `\nWHERE ${where.join("\n  AND ")}` : "";
  return `SELECT p.id, p.title, p.year, p.venue, p.pub_type\nFROM papers p${clause}`;
}

// ── Runtime: scope management + execution (browser only) ─────────────────
// These reach sqlite.js dynamically so this module imports under plain Node for
// the pure-logic tests (validateSelect / buildGuidedQuery / capQuery above).

// Reconcile the ATTACHed snapshot set with the desired dataset id list. The
// active dataset is the live `main` schema and is never ATTACHed; every other
// selected id is ATTACHed by alias, and anything no longer selected is DETACHed.
// Returns { aliasById, active } so the panel can tag rows by dataset.
export async function setSearchScope(selectedIds) {
  const sqlite = await import("./sqlite.js");
  const active = sqlite.getActiveDatasetId();
  const want = new Set((selectedIds || []).map((id) => sqlite.searchAlias(id)));
  // Active dataset is implicit (main); don't try to ATTACH it.
  const activeAlias = active ? sqlite.searchAlias(active) : null;

  // DETACH any currently-attached alias that's no longer wanted.
  for (const alias of sqlite.attachedAliases()) {
    if (!want.has(alias)) await sqlite.detachSnapshotByAlias(alias);
  }
  // ATTACH everything wanted that isn't the active dataset.
  const aliasById = {};
  for (const id of (selectedIds || [])) {
    const alias = sqlite.searchAlias(id);
    aliasById[id] = alias;
    if (alias === activeAlias) continue;       // live main schema
    await sqlite.attachSnapshot(id);
  }
  return { aliasById, active, activeAlias };
}

// Run a user SELECT against the live handle (+ ATTACHed snapshots), enforcing the
// SELECT-only guard and the row cap. Returns:
//   { columns, rows, capped, rowCount, error? }
// `rows` is an array of plain objects keyed by column name. On a guard failure or
// SQL error, returns { error } with empty columns/rows.
export async function runSearch(sql, { cap = DEFAULT_ROW_CAP } = {}) {
  const guard = validateSelect(sql);
  if (!guard.ok) return { columns: [], rows: [], capped: false, rowCount: 0, error: guard.error };

  const sqlite = await import("./sqlite.js");
  let res;
  try {
    res = sqlite.runSearchQuery(capQuery(guard.sql, cap));
  } catch (e) {
    return { columns: [], rows: [], capped: false, rowCount: 0, error: String(e.message || e) };
  }
  const capped = res.values.length > cap;
  const values = capped ? res.values.slice(0, cap) : res.values;
  const columns = res.columns;
  const rows = values.map((v) => {
    const o = {};
    for (let i = 0; i < columns.length; i++) o[columns[i]] = v[i];
    return o;
  });
  return { columns, rows, capped, rowCount: rows.length };
}
