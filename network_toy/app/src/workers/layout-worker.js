// Citation-layout worker entry.
//
// One worker job = one layout compute (FR, MDS, or UMAP-on-graph).
// Alignment stays on the main thread — it's cheap and depends on
// state.basePos which we don't ship to the worker.
//
// Protocol:
//   in:  { algoId, payload: { n, edges, t, seed, params } }
//   out: { ok: true,  result: Float32Array(n*3) }   // the layout buffer
//        { ok: false, error: { message, name, stack? } }
//
// The citation-layout algorithms (fr.js, mds.js, umap-graph.js) are
// pure functions; the registry resolves the algo without touching any
// state, so the same registry import works on both threads. UMAP-on-
// graph already pins its esm.sh URL inline (Slice 1 change), so the
// worker can import the registry without bare-specifier resolution.

import { getAlgorithm as getLayoutAlgorithm } from "../citation-layout/registry.js";

self.addEventListener("message", (ev) => {
  const { algoId, payload } = ev.data || {};

  try {
    if (typeof algoId !== "string") {
      throw new Error("layout-worker: payload.algoId must be a string");
    }
    if (!payload || typeof payload.n !== "number" || !Array.isArray(payload.edges)) {
      throw new Error("layout-worker: payload must include { n, edges, t, seed, params }");
    }
    const algo = getLayoutAlgorithm(algoId);
    const result = algo.compute(payload);

    // Each layout algorithm returns a Float32Array(n*3). Transfer the
    // underlying buffer so the main thread can adopt it without copy.
    const buf = result && result.buffer ? [result.buffer] : [];
    self.postMessage({ ok: true, result }, buf);
  } catch (err) {
    self.postMessage({
      ok: false,
      error: { message: err.message, name: err.name, stack: err.stack },
    });
  }
});
