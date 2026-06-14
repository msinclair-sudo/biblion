// Edge-importer registry.
//
// Citation-importers are the transport layer behind the
// `imported-edges` citation algorithm: each one knows how to pull a
// raw edge list `[[src, dst], …]` from some backend (a JSON file
// today, a SQL DB or REST endpoint later). Citation-algorithm code
// never touches transport concerns; it just calls the active
// importer's `fetch()`.
//
// Three independent axes of variation, three independent layers:
//
//   carve-script               on-disk file shape   importer
//   ──────────────             ──────────────────   ──────────
//   make_subset_citation_       citation_edges.json  json-file
//   edges.py (Python)
//
// If the upstream raw format ever changes (different columns in
// citgraphv2/output/edges.csv), only the carve script changes. If
// the on-disk JSON shape changes, only the json-file importer
// changes. If we add a SQL backend, only a new importer entry
// appears here — `imported-edges.js` stays still.
//
// Each entry: { id, label, description, fetch }
//   fetch({ dataSourceParams }) → Promise<[[src, dst], …]>
//     dataSourceParams: the params object from the active data
//     source (e.g. {subset: "dev_subset_1000"} for the real source).
//     Importers that don't need it can ignore the argument.

import * as jsonFile from "./json-file.js";

export const IMPORTERS = [
  {
    id:          jsonFile.ID,
    label:       "JSON file (carved subset)",
    description: "Loads citation_edges.json from the active subset's directory. Produced by literture-network/scripts/make_subset_citation_edges.py — carve once, then the file lives alongside the embedding subset.",
    fetch:       jsonFile.fetch,
  },
];

const BY_ID = new Map(IMPORTERS.map(i => [i.id, i]));

export function getImporter(id) {
  const i = BY_ID.get(id);
  if (!i) throw new Error(`[ImporterRegistry] unknown importer "${id}"`);
  return i;
}

export function listImporters() {
  return IMPORTERS.slice();
}
