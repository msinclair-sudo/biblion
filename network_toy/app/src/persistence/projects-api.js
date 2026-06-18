// Dataset-scoped fetch wrappers for serve.py's /api/datasets endpoints.
//
// The dev server (network_toy/serve.py) scans data/*/ and exposes the
// loadable datasets plus each one's saves; saves nest at
// data/<id>/saves/<name>.zip. These are thin fetch helpers — the picker
// (ui/modals/data-source-modal.js) and the topbar Save/Open path consume
// them. Errors surface as thrown Errors with the server's message.

const BASE = "/api/datasets";

// A 404 on the dataset API almost always means the app is being served by a
// plain static server (`python -m http.server`) rather than serve.py, the only
// thing that answers /api/datasets. Surface that hint instead of a bare
// "HTTP 404" so the picker's error is self-explanatory.
const SERVE_HINT =
  "the dataset API is served by serve.py, not `python -m http.server` — " +
  "run `python serve.py` from network_toy/";

async function getJson(url) {
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    throw new Error(`[projects-api] ${url}: ${e.message || e} — ${SERVE_HINT}`);
  }
  if (!r.ok) {
    const hint = r.status === 404 ? ` — ${SERVE_HINT}` : "";
    throw new Error(`[projects-api] ${url}: HTTP ${r.status}${hint}`);
  }
  return r.json();
}

// [{id, label, nNodes, embeddingDim, domain, savesCount}]
export function listDatasets() {
  return getJson(BASE);
}

// [{name, projectName, savedAt, sizeBytes}] for one dataset.
export function listSaves(datasetId) {
  return getJson(`${BASE}/${encodeURIComponent(datasetId)}/saves`);
}

// The save zip as a Blob, ready for deserialiseFile().
export async function loadSave(datasetId, name) {
  const url = `${BASE}/${encodeURIComponent(datasetId)}/saves/${encodeURIComponent(name)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[projects-api] load ${name}: HTTP ${r.status}`);
  return r.blob();
}

// POST the serialised zip blob to data/<id>/saves/<name>.zip (atomic write
// server-side). Returns the server's {ok, name, sizeBytes}.
export async function saveProject(datasetId, name, blob) {
  const url = `${BASE}/${encodeURIComponent(datasetId)}/saves/${encodeURIComponent(name)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: blob,
  });
  if (!r.ok) throw new Error(`[projects-api] save ${name}: HTTP ${r.status}`);
  return r.json();
}

export async function deleteSave(datasetId, name) {
  const url = `${BASE}/${encodeURIComponent(datasetId)}/saves/${encodeURIComponent(name)}`;
  const r = await fetch(url, { method: "DELETE" });
  if (!r.ok) throw new Error(`[projects-api] delete ${name}: HTTP ${r.status}`);
  return r.json();
}

// ── tags (read/write against the dataset's live project DB) ──────────────────
// { "<paperId>": ["tag", ...] } for the dataset. Returns {} when the dataset is
// snapshot-only (no live DB) or has no tags. Reads are always fresh from the
// live DB, so tags written by the biblion CLI or a prior session show up.
export function loadTags(datasetId) {
  return getJson(`${BASE}/${encodeURIComponent(datasetId)}/tags`);
}

// Batch add/remove tags. `adds`/`removes` are [{paperId:int, tag:string}].
// Returns the server's {ok, applied}; throws on HTTP error (e.g. 409 when the
// dataset is snapshot-only, 503 when the DB write-lock times out) so the caller
// can roll back optimistic UI state.
export async function writeTags(datasetId, { adds = [], removes = [] } = {}) {
  const url = `${BASE}/${encodeURIComponent(datasetId)}/tags`;
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adds, removes }),
    });
  } catch (e) {
    throw new Error(`[projects-api] writeTags: ${e.message || e} — ${SERVE_HINT}`);
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch { /* keep status */ }
    throw new Error(`[projects-api] writeTags: ${msg}`);
  }
  return r.json();
}
