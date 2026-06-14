// Citation-generation algorithm registry.
//
// Mirrors the clustering registry: one entry per algorithm, each
// exposing a standard interface that downstream layers consume
// without caring which algorithm produced the citation graph.
//
// Public contract validated by ./contract.js. Adding a new
// algorithm = one new entry here + the algorithm module; no other
// file should need to grow a switch on algorithm id.

import * as importedEdges from "./imported-edges.js";

// Each entry declares its input requirements so the engine's cascade
// can short-circuit appropriately:
//   needsNeighbourhoods — does the algorithm consume the
//                          neighbourhood + taste lanes? false for
//                          import-style algorithms whose topology is
//                          given, not inferred.
//   needsBasePos        — does the algorithm need a 3-d basePos to
//                          run? imported-edges doesn't (topology is
//                          given, not inferred over basePos).
//   isAsync             — does `infer` return a Promise? true for
//                          import-style algorithms that do I/O.
export const ALGORITHMS = [
  {
    id:                   importedEdges.ID,
    label:                "Imported edges",
    description:          "Loads a pre-existing citation graph from disk via the importer registry (today: citation_edges.json carved by literture-network/scripts/make_subset_citation_edges.py). No neighbourhoods, no taste, no sampling — the topology is given. Used by the real data source.",
    defaultParams:        importedEdges.defaultParams,
    infer:                importedEdges.infer,
    needsNeighbourhoods:  false,
    needsBasePos:         false,
    isAsync:              true,
    modalSchema:          [],
  },
];

const BY_ID = new Map(ALGORITHMS.map(a => [a.id, a]));

export function getAlgorithm(id) {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`[CitationRegistry] unknown algorithm "${id}"`);
  return a;
}

export function listAlgorithms() {
  return ALGORITHMS.slice();
}
