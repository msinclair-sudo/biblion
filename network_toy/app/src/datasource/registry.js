// Data-source registry (Layer 1).
//
// A single source today: `sqlite` (a biblion corpus). The former `toy`
// (toy-removal) and `real` (SPECTER2 dev-subsets) entries are gone — the
// picker now lists the datasets actually present under data/ via serve.py
// /api/datasets, and selecting one drives this `sqlite` source with its
// dataset id. Adding a new source = one new entry — produce(params) returns
// a DataSourceResult satisfying app/src/datasource/contract.js.
//
// Each entry: { id, label, description, defaultParams, produce, modalSchema }
//
// Sources are mutually exclusive at runtime. Switching from one to the
// other drops the previous source's outputs (genResult, _basePos,
// embedding, dimredResult, clusterLevels, citations, layout — all of it).

import { produceSqlite, defaultSqliteParams } from "./sqlite.js";

export const DATA_SOURCES = [
  {
    id: "sqlite",
    label: "biblion corpus",
    description: "Loads a biblion SQLite corpus (papers + citations) built by `biblion advanced snapshot` + `biblion advanced embedding`, with SPECTER2 embeddings injected from a sibling .npy. Read in-browser via sql.js — titles/abstracts/authors are queried on demand, which unlocks c-TF-IDF / TF-IDF labelling and real titles. Switching sources drops the previous data; only one source is loaded at a time. The viewer stays empty until you pick a 3-d visualisation reduction in the dim-reduction layer.",
    defaultParams: defaultSqliteParams,
    produce: (params) => produceSqlite(params),
    // The dataset is chosen in the two-step picker (data-source-modal.js),
    // sourced live from /api/datasets — no static option list here.
    modalSchema: [],
  },
];

const BY_ID = new Map(DATA_SOURCES.map(s => [s.id, s]));

export function getDataSource(id) {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`[DataSourceRegistry] unknown source "${id}"`);
  return s;
}

export function listDataSources() {
  return DATA_SOURCES.slice();
}
