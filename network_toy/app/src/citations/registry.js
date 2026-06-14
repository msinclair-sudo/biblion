// Citation-generation algorithm registry.
//
// Mirrors the clustering registry: one entry per algorithm, each
// exposing a standard interface that downstream layers consume
// without caring which algorithm produced the citation graph.
//
// Public contract validated by ./contract.js. Adding a new
// algorithm = one new entry here + the algorithm module; no other
// file should need to grow a switch on algorithm id.

import * as tasteNetwork  from "./taste-network.js";
import * as importedEdges from "./imported-edges.js";

// Each entry declares its input requirements so the engine's cascade
// can short-circuit appropriately:
//   needsNeighbourhoods — does the algorithm consume the
//                          neighbourhood + taste lanes? false for
//                          import-style algorithms whose topology is
//                          given, not inferred.
//   needsBasePos        — does the algorithm need a 3-d basePos to
//                          run? taste-network does (Euclidean reasoning
//                          over basePos); imported-edges doesn't. This
//                          replaces the engine's previous
//                          `if (!_basePos) bail` hack.
//   isAsync             — does `infer` return a Promise? true for
//                          import-style algorithms that do I/O.
export const ALGORITHMS = [
  {
    id:                   tasteNetwork.ID,
    label:                "Taste Network",
    description:          "Within-cluster mutual k-NN neighbourhoods feed a per-neighbourhood taste vector with shared-taste tilt; transitivity boosts triangle-completing pairs; final per-pair Bernoulli draws hit a user-set density budget split between intra- and cross-cluster categories.",
    defaultParams:        tasteNetwork.defaultParams,
    infer:                tasteNetwork.infer,
    needsNeighbourhoods:  true,
    needsBasePos:         true,
    isAsync:              false,
    // modalSchema not yet driven from here — Phase 4 of v3 will
    // migrate the citation settings modal to be registry-rendered
    // (same pattern as the cluster modal in stage 5). For now the
    // hand-crafted modal in app/index.html is still the source of
    // truth for citation params.
    modalSchema:          [],
  },
  {
    id:                   importedEdges.ID,
    label:                "Imported edges",
    description:          "Loads a pre-existing citation graph from disk via the importer registry (today: citation_edges.json carved by literture-network/scripts/make_subset_citation_edges.py). No neighbourhoods, no taste, no sampling — the topology is given. Used by the real data source; can also be paired with toy data if a matching edge file exists.",
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
