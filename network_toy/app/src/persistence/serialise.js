// State → zip blob.
//
// Walks state, extracts every TypedArray onto a parallel "binary
// payload" map keyed by zip-relative path, and replaces each in-state
// TypedArray with a {__binary, type, length} descriptor. The walker
// is tailored to this app's state shape — generic JSON.stringify
// doesn't handle TypedArrays, and a generic walker would either pay
// a lot of overhead or miss things.
//
// The zip contains:
//   manifest.json    — schema version + inventory
//   state.json       — JSON-serialisable state, with binary descriptors
//                      pointing into arrays/
//   arrays/*.{f32,i32,u8} — raw typed-array payloads
//
// Output is a Blob ready to download.

import { zipSync, strToU8 } from "fflate";
import { buildManifest } from "./manifest.js";

// Slots saved verbatim as JSON (no typed-array surgery).
// Anything not in this list either gets specially handled below or
// is intentionally excluded (e.g. engineRevision — meaningless across
// sessions).
const PASS_THROUGH_KEYS = [
  "dataSource",
  "layerParams",
  "activeAlgorithm",
  "layerStates",
  "panels",
  "selection",
  "cart",
  "filter",
  "fusionBlend",
  "bridgeConfig",
  "view",          // viewer-3d edge toggles + colours
];

// Slot keys that are excluded from the save entirely.
const EXCLUDED_KEYS = new Set([
  "engineRevision",
  // genResult, _basePos, embedding, dimredResult, clusterLevels,
  // clusterResult, bridgeAnalysis, citationResult, citationLayout,
  // alignedCitationLayout, alignmentCorrelation, evalResults,
  // projectName — all handled explicitly below.
]);

export function serialiseState(state) {
  const arrays = {};   // zip-relative path -> Uint8Array
  // Buffer-identity dedup: ArrayBuffer -> first zip path it was stashed
  // under. The same bytes can be referenced from two places (e.g. the
  // dimred card's result.data and the flat dimredResult slot share one
  // Float32Array buffer) — without this the n x 768 embedding and every
  // heavy array would be written into the zip twice, ~doubling its size.
  const dedup = new Map();
  const out = {};

  // 1. Pass-through slots (plain JSON).
  for (const k of PASS_THROUGH_KEYS) {
    if (k in state) out[k] = state[k];
  }

  // 2. genResult — nodes are JSON-friendly (origins / id / t /
  //    originId / paperId / per-node basePos arrays). Inline it.
  if (state.genResult) {
    out.genResult = state.genResult;
  }

  // 3. _basePos — flat Float32Array(n*3). Binary.
  if (state._basePos instanceof Float32Array) {
    out._basePos = stashBinary(arrays, "arrays/basePos.f32", state._basePos, dedup);
  }
  // 3aa. _basePosPreFusion — flat Float32Array(n*3) for the fusion
  //      comparison slider's α=0 endpoint. Present only when a fusion
  //      run has produced a parallel pre-fusion viz output.
  if (state._basePosPreFusion instanceof Float32Array) {
    out._basePosPreFusion = stashBinary(arrays, "arrays/basePosPreFusion.f32", state._basePosPreFusion, dedup);
  }

  // 3a. _basePos2d — flat Float32Array(n*2) for the 2D viewer. Null
  //     when viz2d hasn't produced a 2-d output yet.
  if (state._basePos2d instanceof Float32Array) {
    out._basePos2d = stashBinary(arrays, "arrays/basePos2d.f32", state._basePos2d, dedup);
  }

  // 4. embedding — {d, data: Float32Array(m*d), m, rowOf?: Int32Array(n)}.
  //    m (embedded-node count) and rowOf (node index → embedding row, -1 for
  //    ghosts) MUST round-trip: pickStage0Input sizes the noise stage to
  //    embedding.m, so dropping it makes a reloaded project re-run dim-reduction
  //    (esp. graph-diffusion / dim-sweep) on the wrong row count for ghost
  //    corpora (NaN → umap-js overflow). Ghost-free sources may omit both.
  if (state.embedding && state.embedding.data instanceof Float32Array) {
    out.embedding = {
      d:    state.embedding.d,
      data: stashBinary(arrays, "arrays/embedding.f32", state.embedding.data, dedup),
    };
    if (Number.isInteger(state.embedding.m)) out.embedding.m = state.embedding.m;
    if (state.embedding.rowOf instanceof Int32Array) {
      out.embedding.rowOf = stashBinary(arrays, "arrays/embeddingRowOf.i32", state.embedding.rowOf, dedup);
    }
  }

  // 4a. rawCitationEdges — flat number[] of length 2|E| populated at
  // ingest time for data sources that supply edges directly. Needed
  // on load so a subsequent fusion-param change can re-run dim-red
  // without losing the graph (real-data path) or falling back to
  // identity. Stored as Int32Array for compactness — typical size at
  // n=5000 is ~25 k entries (100 KB), small relative to the embedding.
  if (Array.isArray(state.rawCitationEdges) && state.rawCitationEdges.length > 0) {
    const flat = new Int32Array(state.rawCitationEdges);
    out.rawCitationEdges = stashBinary(arrays, "arrays/rawCitationEdges.i32", flat, dedup);
  }

  // 5. dimredResult — {method, params, n, d, data: Float32Array(n*d)}.
  if (state.dimredResult && state.dimredResult.data instanceof Float32Array) {
    out.dimredResult = {
      method: state.dimredResult.method,
      params: state.dimredResult.params,
      n:      state.dimredResult.n,
      d:      state.dimredResult.d,
      data:   stashBinary(arrays, "arrays/dimredResult.f32", state.dimredResult.data, dedup),
    };
  }

  // 5a. dimredResultPreFusion — same shape, fusion-comparison A
  // endpoint (Layer 2 ran twice when fusion was non-identity).
  if (state.dimredResultPreFusion && state.dimredResultPreFusion.data instanceof Float32Array) {
    out.dimredResultPreFusion = {
      method: state.dimredResultPreFusion.method,
      params: state.dimredResultPreFusion.params,
      n:      state.dimredResultPreFusion.n,
      d:      state.dimredResultPreFusion.d,
      data:   stashBinary(arrays, "arrays/dimredResultPreFusion.f32", state.dimredResultPreFusion.data, dedup),
    };
  }

  // 6. clusterLevels — array of {uid, scope, clusterResult}.
  //    clusterResult.nodeCluster is Int32Array; noiseFlags (HDBSCAN
  //    only) is Uint8Array. Other fields are JSON-friendly.
  if (Array.isArray(state.clusterLevels)) {
    out.clusterLevels = state.clusterLevels.map((lvl, idx) => ({
      uid:           lvl.uid,
      scope:         lvl.scope,
      clusterResult: serialiseClusterResult(lvl.clusterResult, arrays, idx, dedup),
    }));
  }
  // (6a. clusterLevelsPreFusion removed — pre/post-fusion is now a workflow
  //  fork; each branch's clustering saves as a normal clusterLevels ladder.)
  // clusterResult is a backward-compat alias for the finest level.
  // No need to save separately — restored from clusterLevels.

  // 7. bridgeAnalysis — {fineLevel, coarseLevel, levels, perCluster,
  //    perNodeScore: Float32Array, perNodeIsBridge: Uint8Array, ...}
  if (state.bridgeAnalysis) {
    const ba = state.bridgeAnalysis;
    out.bridgeAnalysis = {
      fineLevel:   ba.fineLevel,
      coarseLevel: ba.coarseLevel,
      levels:      ba.levels,
      perCluster:  ba.perCluster,
      bridgeCount: ba.bridgeCount,
      perNodeScore:    stashBinary(arrays, "arrays/bridge.perNodeScore.f32",    ba.perNodeScore, dedup),
      perNodeIsBridge: stashBinary(arrays, "arrays/bridge.perNodeIsBridge.u8", ba.perNodeIsBridge, dedup),
    };
  }

  // 8. Citation pipeline output (Layer 3).
  if (state.citationResult)      out.citationResult      = state.citationResult;

  // 9. Citation layout / alignment.
  if (state.citationLayout instanceof Float32Array) {
    out.citationLayout = stashBinary(arrays, "arrays/citationLayout.f32", state.citationLayout, dedup);
  }
  if (state.alignedCitationLayout instanceof Float32Array) {
    out.alignedCitationLayout = stashBinary(arrays, "arrays/alignedCitationLayout.f32", state.alignedCitationLayout, dedup);
  }
  if (Number.isFinite(state.alignmentCorrelation)) {
    out.alignmentCorrelation = state.alignmentCorrelation;
  }

  // 10. Eval results — JSON-friendly.
  if (state.evalResults) {
    out.evalResults = state.evalResults;
  }

  // 10a. Validation runs (§6.19). Each run is a typed entry whose
  //      `results` field may contain TypedArrays (e.g. an Optimise
  //      run with per-row _cr Int32Arrays, a dim-sweep run with
  //      partition arrays). Use the generic stashBinariesIn walker
  //      so each run type doesn't need bespoke serialisation —
  //      anywhere a TypedArray appears under the run, it gets
  //      replaced with a {__binary, type, length} descriptor and
  //      the bytes go into arrays/. The deserialiser's generic
  //      reviveBinaries walker reconstructs them automatically.
  if (Array.isArray(state.validationRuns) && state.validationRuns.length > 0) {
    out.validationRuns = state.validationRuns.map((run, i) =>
      stashBinariesIn(run, arrays, `arrays/validationRuns/${i}`, dedup),
    );
  }

  // 10c. workflow — the canonical card tree (steps / rootId / selected).
  //      Persisted alongside the flat projection slots so a load restores
  //      the full branching DAG, not just the selected card's flat view.
  //      Step results carry the same heavy TypedArrays as the flat slots
  //      (they share buffers), so the generic stasher walks them and the
  //      dedup Map keeps each buffer's bytes in the zip exactly once.
  if (state.workflow) {
    out.workflow = stashBinariesIn(state.workflow, arrays, "arrays/workflow", dedup);
  }

  // 10b. Tree scoring (MLC §5) — plain nested numbers keyed by level uid.
  if (state.clusterScores && Object.keys(state.clusterScores).length > 0) {
    out.clusterScores = state.clusterScores;
  }

  // 11. Project name (display only — used by Save vs Save-as).
  if (state.projectName) out.projectName = state.projectName;

  // Build the zip.
  const manifest = buildManifest({
    projectName: state.projectName || null,
    contents:    ["manifest.json", "state.json", ...Object.keys(arrays)],
  });
  const stateJson    = JSON.stringify(out, null, 0);     // compact
  const manifestJson = JSON.stringify(manifest, null, 2);

  const zipEntries = {
    "manifest.json": strToU8(manifestJson),
    "state.json":    strToU8(stateJson),
    ...arrays,
  };
  const zipped = zipSync(zipEntries, { level: 6 });
  return new Blob([zipped], { type: "application/zip" });
}

function serialiseClusterResult(cr, arrays, levelIdx, dedup) {
  const out = {
    method:         cr.method,
    params:         cr.params,
    clusters:       cr.clusters,
    structureEdges: cr.structureEdges,
  };
  if (cr.nodeCluster instanceof Int32Array) {
    out.nodeCluster = stashBinary(
      arrays,
      `arrays/clusterLevels/${levelIdx}.nodeCluster.i32`,
      cr.nodeCluster,
      dedup,
    );
  }
  if (cr.noiseFlags instanceof Uint8Array) {
    out.noiseFlags = stashBinary(
      arrays,
      `arrays/clusterLevels/${levelIdx}.noiseFlags.u8`,
      cr.noiseFlags,
      dedup,
    );
  }
  // condensedTree (HDBSCAN / MLC-0) — a bag of node-parallel + per-leaf
  // typed arrays. Stash generically so the multi-level extraction survives
  // a save/load round-trip; the deserialiser's reviveBinaries restores it.
  if (cr.condensedTree && typeof cr.condensedTree === "object") {
    out.condensedTree = stashBinariesIn(
      cr.condensedTree,
      arrays,
      `arrays/clusterLevels/${levelIdx}.condensedTree`,
      dedup,
    );
  }
  return out;
}

// Move a TypedArray into the arrays bag and return a descriptor
// the loader can use to find it. Path becomes a key inside the zip.
//
// When `dedup` is supplied and the typed array's underlying buffer was
// already stashed, point the descriptor at the existing path instead of
// writing the bytes again. Descriptors are full views (offset 0, whole
// buffer) so dedup keys on buffer identity alone; reviveBinaries copies
// per descriptor, so two descriptors sharing one path still yield
// independent usable views on load.
function stashBinary(arrays, path, typedArray, dedup) {
  if (dedup) {
    const existing = dedup.get(typedArray.buffer);
    if (existing) {
      return {
        __binary: existing,
        type:     typedArray.constructor.name,
        length:   typedArray.length,
      };
    }
  }
  // fflate expects Uint8Array per entry — view the same buffer.
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  arrays[path] = bytes;
  if (dedup) dedup.set(typedArray.buffer, path);
  return {
    __binary: path,
    type:     typedArray.constructor.name,
    length:   typedArray.length,
  };
}

// Generic deep-walk: replace any TypedArray found anywhere inside
// `node` with a {__binary, ...} descriptor, stashing the bytes
// under `pathPrefix/<n>.<ext>`. Returns a new object (deep-copied
// where the walk modified anything; the originals stay untouched).
//
// Used for heterogeneous slots like state.validationRuns where each
// entry's results shape varies by type and listing them all in
// serialise.js would mean per-type bespoke code. The deserialiser's
// reviveBinaries walker is already generic, so a generic stasher on
// this side closes the loop.
function stashBinariesIn(node, arrays, pathPrefix, dedup, counter = { n: 0 }) {
  if (node == null) return node;
  if (typeof node !== "object") return node;

  // TypedArray detection — ArrayBuffer.isView returns true for any
  // TypedArray or DataView; we accept all TypedArrays and skip DataView.
  if (ArrayBuffer.isView(node) && !(node instanceof DataView)) {
    const ext  = extForTypedArray(node);
    const path = `${pathPrefix}/${counter.n++}.${ext}`;
    return stashBinary(arrays, path, node, dedup);
  }

  if (Array.isArray(node)) {
    return node.map(child => stashBinariesIn(child, arrays, pathPrefix, dedup, counter));
  }

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = stashBinariesIn(v, arrays, pathPrefix, dedup, counter);
  }
  return out;
}

function extForTypedArray(ta) {
  if (ta instanceof Float32Array) return "f32";
  if (ta instanceof Int32Array)   return "i32";
  if (ta instanceof Uint8Array)   return "u8";
  if (ta instanceof Float64Array) return "f64";
  if (ta instanceof Int16Array)   return "i16";
  if (ta instanceof Uint16Array)  return "u16";
  return "bin";   // fallback; reviver matches on the `type` field, not the path
}
