// Data-source registry (Layer 1).
//
// Two entries today: `toy` (Gaussian-mixture generator) and `real`
// (load a SPECTER2 embedding subset from literture-network/). Adding
// a new source = one new entry — produce(params) returns a
// DataSourceResult satisfying app/src/datasource/contract.js.
//
// Each entry: { id, label, description, defaultParams, produce, modalSchema }
//
// Toy and real are mutually exclusive at runtime. Switching from one
// to the other drops the previous source's outputs (genResult,
// _basePos, embedding, dimredResult, clusterLevels, citations, layout
// — all of it). The toy is not deprecated; both stay first-class.

import { produceToy,  defaultToyParams  } from "./toy.js";
import { produceReal, defaultRealParams, SUBSET_IDS, SUBSET_LABELS } from "./real.js";
import { produceSqlite, defaultSqliteParams, DATASET_IDS, DATASET_LABELS, SQLITE_OPTIONS } from "./sqlite.js";

export const DATA_SOURCES = [
  {
    id: "toy",
    label: "Toy generator",
    description: "Generates a synthetic 3-d cloud of points sampled from a few Gaussian blobs. Useful for trying out the pipeline quickly — you control how many points there are, how many groups they split into, and how spread out each group is.",
    defaultParams: defaultToyParams,
    produce: (params) => produceToy(params),
    modalSchema: [
      {
        key: "seed",
        label: "Random seed",
        kind: "int", min: 0, max: 999, step: 1,
        format: (v) => String(v),
        hint: "Same seed → same cloud. Change the seed to shuffle the layout while keeping every other knob the same.",
      },
      {
        key: "nodeCount",
        label: "Number of points",
        kind: "int", min: 10, max: 2000, step: 10,
        format: (v) => String(v),
        hint: "How many points to generate. Larger counts are slower; ~400 is a comfortable default.",
      },
      {
        key: "origins",
        label: "Number of groups",
        kind: "int", min: 1, max: 12, step: 1,
        format: (v) => String(v),
        hint: "How many Gaussian blobs the points come from. Acts as ground-truth cluster count for the toy.",
      },
      {
        key: "spread",
        label: "Group spread",
        kind: "range", min: 0.2, max: 3, step: 0.1,
        format: (v) => (+v).toFixed(2),
        hint: "How wide each blob is. Small values produce tight, well-separated groups; large values overlap them.",
      },
    ],
  },
  {
    id: "real",
    label: "Real data (SPECTER2 papers)",
    description: "Loads a small slice of the SPECTER2 paper embeddings (768 numbers per paper). Best for trying the pipeline against real research-paper data. Switching to this drops the toy data; switching back drops the real data — only one is loaded at a time. The viewer stays empty until you pick a 3-d visualisation reduction in the dim-reduction layer.",
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
    description: "Loads a biblion SQLite corpus (papers + citations) built by `biblion advanced snapshot` + `biblion advanced embedding`, with SPECTER2 embeddings injected from a sibling .npy. Read in-browser via sql.js — titles/abstracts/authors are queried on demand, which unlocks c-TF-IDF / TF-IDF labelling and real titles. Switching to this drops the toy/real data; only one source is loaded at a time. The viewer stays empty until you pick a 3-d visualisation reduction in the dim-reduction layer.",
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
