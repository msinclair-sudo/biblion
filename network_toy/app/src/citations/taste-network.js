// Citation-generation algorithm: "taste-network".
//
// Wraps the existing four-stage pipeline (neighbourhoods → taste →
// per-pair sampling) behind the CitationResult contract.
//
// This is the algorithm that's been the only citation generator
// since the project began; we keep its internal semantics byte-for-
// byte identical at fixed seed. The registry shell exists to make it
// substitutable: future algorithms (random Erdős–Rényi, time-ordered
// preferential attachment, etc.) can plug in by adding a new entry,
// and the rest of the program — citation-layout especially — only
// ever sees the public contract.

import { inferNeighbourhoods, defaultNeighbourhoodParams } from "../neighbourhoods.js";
import { buildCitationTaste, defaultTasteParams }            from "../citation-taste.js";
import { generateCitations, defaultCitationParams }          from "../citations.js";

export const ID = "taste-network";

// Default params are the union of all three internal stages' defaults.
// Internal stage names are an implementation detail — the registry's
// modalSchema and the citation settings modal expose these knobs to
// the user without any per-stage decomposition leaking out.
export const defaultParams = () => ({
  ...defaultNeighbourhoodParams(),    // neighbourK
  ...defaultTasteParams(),            // tasteSeed, favouritesMean, sharedTaste, tasteRange, transitiveBoost
  ...defaultCitationParams(),         // samplingSeed, density, intraRate, crossRate, epsilonIntra, epsilonCross
});

// Produce a CitationResult from the gen + cluster outputs. Pure: no
// DOM, no app state, no mutation of inputs. Same {seed, …} → same
// hasCit, byte-for-byte.
export function infer(genResult, clusterResult, params = {}) {
  const ng    = inferNeighbourhoods(genResult, clusterResult, params);
  const taste = buildCitationTaste(clusterResult, ng, params);
  const cit   = generateCitations(genResult, clusterResult, ng, taste, params);

  // Build the canonical edge list — same data as `cit.citations` but
  // normalised to i < j so layout / blend code can iterate without
  // worrying about ordering.
  const edges = new Array(cit.citations.length);
  for (let k = 0; k < cit.citations.length; k++) {
    const c = cit.citations[k];
    edges[k] = c.source < c.target ? [c.source, c.target] : [c.target, c.source];
  }

  return {
    method:    ID,
    params:    cit.params,
    hasCit:    cit.hasCit,
    inDeg:     cit.inDeg,
    citations: cit.citations,
    edges,
    pools:     cit.pools,
  };
}
