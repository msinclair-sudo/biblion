// Citation-generation algorithm: "imported-edges".
//
// Loads a pre-existing citation graph from disk (or, in future, from
// SQL / REST) via the citation-importer registry and materialises it
// into the public `CitationResult` contract (citations/contract.js).
// No neighbourhoods, no taste, no per-pair sampling — the topology
// is given, not inferred.
//
// Used by the `real` data source. Toy mode still uses the synthetic
// `taste-network` algorithm. Both produce the same CitationResult
// shape, so every downstream consumer (Layer 4 layout, Layer 5
// blend, viewer-3d's edge rendering, in-degree node colouring) is
// unaware of the source.
//
// Direction handling: citgraphv2-derived files store
// `source → target` meaning "source is cited by target" — the
// citation-database convention. The toy contract is the reverse
// ("newer cites older": citations[k].source did the citing). We
// swap on materialisation so downstream code doesn't need to care
// where the edges came from.
//
// In-memory representation matches taste-network's output byte-for-
// byte (modulo the data itself): same hasCit, same inDeg, same
// citations[], same edges[]. Layout / blend code is identical.
//
// Scale note: hasCit is n² bytes. At n=1000 that's 1 MB (fine), at
// n=10 k it's 100 MB (problematic), at n=810 k it's 656 GB (infeasible).
// When the contract goes sparse, only the materialiser below has to
// change — the importer's output is already sparse.

import { getImporter } from "./importers/registry.js";

export const ID = "imported-edges";

export const defaultParams = () => ({
  importer: "json-file",
});

// Async because importers do I/O. Engine awaits the result.
//
// Args:
//   genResult         — Layer 1 output (used only for node count)
//   _clusterResult    — not used (citations are loaded, not inferred from clusters)
//   params            — { importer }
//   dataSourceParams  — params from the active data source (e.g. {subset: "..."} )
//                       passed through to the importer; algorithms never reach
//                       into global state.
export async function infer(genResult, _clusterResult, params = {}, dataSourceParams = {}) {
  // Fast path: the data source already supplied its edges on the Layer-1
  // result (genResult.citationEdges, flat [src,dst,…] in node-index space,
  // directed citing→cited — biblion/sqlite + real do this at ingest). Use
  // them directly instead of re-fetching from disk. materialise() expects
  // importer convention "a is cited by b" (and flips to citing→cited), so we
  // hand it CITED-first pairs [dst, src] to preserve the real direction +
  // in-degree (dst is the cited paper).
  if (Array.isArray(genResult.citationEdges) && genResult.citationEdges.length) {
    const flat = genResult.citationEdges;
    const pairs = new Array(flat.length >> 1);
    for (let k = 0, p = 0; k < flat.length; k += 2, p++) {
      pairs[p] = [flat[k + 1], flat[k]];   // [cited, citing]
    }
    return materialise(genResult, pairs, { importer: "data-source-edges" });
  }

  // Fallback: pull from the configured importer (json-file carved subsets).
  const importerId = params.importer || "json-file";
  const importer   = getImporter(importerId);
  const rawEdges   = await importer.fetch({ dataSourceParams });
  return materialise(genResult, rawEdges, { importer: importerId });
}

// Pure: takes (n, raw edges) → CitationResult. Extracted so future
// importers can be tested without going through the registry.
function materialise(genResult, rawEdges, paramsEcho) {
  const n = genResult.nodes.length;
  const hasCit    = new Uint8Array(n * n);
  const inDeg     = new Int32Array(n);
  const citations = [];
  const edges     = [];

  let dropped = 0;
  let selfLoops = 0;

  for (let k = 0; k < rawEdges.length; k++) {
    const pair = rawEdges[k];
    const a = pair[0] | 0;     // importer-side direction: "a is cited by b"
    const b = pair[1] | 0;
    if (a < 0 || a >= n || b < 0 || b >= n) { dropped++; continue; }
    if (a === b)                              { selfLoops++; continue; }

    // Skip duplicates: if hasCit is already set we've seen this pair.
    // The carve script de-duplicates, but defending here keeps inDeg
    // accurate if the importer's source ever changes.
    if (hasCit[a * n + b]) continue;

    // Direction flip: importer gave us "a is cited by b"; toy contract
    // is "source cites target" (newer→older). So the citing paper is b.
    citations.push({ source: b, target: a });
    inDeg[a]++;                              // a was cited by b
    hasCit[a * n + b] = 1;
    hasCit[b * n + a] = 1;
    edges.push(a < b ? [a, b] : [b, a]);
  }

  return {
    method:    ID,
    params:    paramsEcho,
    hasCit,
    inDeg,
    citations,
    edges,
    pools: {
      // Diagnostic counters analogous to taste-network's pools. Empty
      // categories here — the algorithm doesn't classify intra/cross.
      // Keeping the field present satisfies any downstream code that
      // expects `pools` on every CitationResult.
      imported:     citations.length,
      dropped,
      selfLoops,
    },
  };
}
