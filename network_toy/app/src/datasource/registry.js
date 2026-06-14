// Data-source registry (Layer 1).
//
// Two entries today: `real` (load a SPECTER2 embedding subset from
// literture-network/) and `sqlite` (a biblion corpus). Adding a new
// source = one new entry — produce(params) returns a DataSourceResult
// satisfying app/src/datasource/contract.js.
//
// Each entry: { id, label, description, defaultParams, produce, modalSchema }
//
// Sources are mutually exclusive at runtime. Switching from one to the
// other drops the previous source's outputs (genResult, _basePos,
// embedding, dimredResult, clusterLevels, citations, layout — all of it).

import { produceReal, defaultRealParams, SUBSET_IDS, SUBSET_LABELS } from "./real.js";
import { produceSqlite, defaultSqliteParams, DATASET_IDS, DATASET_LABELS, SQLITE_OPTIONS } from "./sqlite.js";

export const DATA_SOURCES = [
  {
    id: "real",
    label: "Real data (SPECTER2 papers)",
    description: "Loads a small slice of the SPECTER2 paper embeddings (768 numbers per paper). Best for trying the pipeline against real research-paper data. Switching sources drops the previous source's data — only one is loaded at a time. The viewer stays empty until you pick a 3-d visualisation reduction in the dim-reduction layer.",
    defaultParams: defaultRealParams,
    produce: (params) => produceReal(params),
    modalSchema: [
      {
        key: "subset",
        label: "Dataset",
        kind: "select",
        options: SUBSET_IDS.map(id => ({ value: id, label: SUBSET_LABELS[id] || id })),
        hint: "Which slice to load. The random 1000-paper subset shatters citation neighbourhoods (~3 within-subset edges); the BFS 5000-paper subset preserves topology (~12,000 within-subset edges, 100% node coverage). Carve more via literture-network/scripts/make_dev_subset_bfs.py.",
      },
    ],
  },
  {
    id: "sqlite",
    label: "Real data (biblion corpus)",
    description: "Loads a biblion SQLite corpus (papers + citations) built by `biblion advanced snapshot` + `biblion advanced embedding`, with SPECTER2 embeddings injected from a sibling .npy. Read in-browser via sql.js — titles/abstracts/authors are queried on demand, which unlocks c-TF-IDF / TF-IDF labelling and real titles. Switching sources drops the previous data; only one source is loaded at a time. The viewer stays empty until you pick a 3-d visualisation reduction in the dim-reduction layer.",
    defaultParams: defaultSqliteParams,
    produce: (params) => produceSqlite(params),
    modalSchema: [
      {
        key: "dataset",
        label: "Dataset",
        kind: "select",
        // Live list: projects + discovered subsets ("<project>::<subset>"),
        // populated by sqlite.js discoverSubsets() at load. Read fresh each open.
        options: SQLITE_OPTIONS,
        hint: "Pick a project or one of its named subsets. New projects: add a DATASETS entry in datasource/sqlite.js. New subsets: `biblion advanced subset make <name> …` + `embedding --subset <name>` (they appear here after reload).",
      },
    ],
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
