// Clustering worker entry.
//
// Two job shapes share this worker (dispatched on payload.mode):
//
//   mode: "cascade" (default if omitted) — multi-level cluster cascade.
//     One job = one full pass (post-fusion OR pre-fusion; never both
//     — those are separate DAG nodes in recluster()).
//     We don't run individual levels in separate workers: levels are
//     inherently sequential (each within-parent level reads the
//     previous level's clusterResult), so per-level workers would
//     serialise anyway. Sending one job per pass keeps postMessage
//     traffic at one round-trip per pass.
//
//   mode: "infer" — single algo.infer call. Used by the eval surface
//     (eval/sweep.js + eval/bootstrap.js) so a swept config or
//     bootstrap iter runs off the main thread. Same algorithm
//     registry resolves on both threads.
//
// Protocol (cascade):
//   in:  { mode: "cascade", algoId, nodesSlim, dimredResult, levelCfgs,
//          allowNoise, n, precomputedLevels?: [cr|null, ...] }
//   out: { ok: true,  result: levels[] }
//   precomputedLevels (optional) — sparse cr-by-level cache; when present
//   at index 0 (only L0 is cacheable today) the worker skips that level's
//   algo.infer and uses the supplied cr verbatim. Used by A3 (§6.18.3)
//   so per-row Apply doesn't re-run the sweep's infer.
//
// Protocol (infer):
//   in:  { mode: "infer",   algoId, nodesSlim, dimredResult, params, n }
//   out: { ok: true,  result: ClusterResult }     // single-level
//
// Failure (either mode):
//   out: { ok: false, error: { message, name, stack? } }
//
// All algorithm modules + the registry are pure (no DOM, no esm.sh
// URLs in their import chain), so the worker can resolve `algoId` via
// the same registry the main thread uses.

import { getAlgorithm as getClusteringAlgorithm } from "../clustering-registry.js";
import { runClusterLevels }                        from "../clustering-cascade.js";
import { inferHdbscanMultiLevel, buildHdbscanModel } from "../clustering-hdbscan.js";
import { runPhase1 }                               from "../eval/multilayer-sweep.js";
import { pairwiseDistancesParallel }               from "./parallel-distance.js";
import { validateClusterResult }                   from "../contracts/cluster.js";

self.addEventListener("message", async (ev) => {
  const data = ev.data || {};
  const mode = data.mode || "cascade";

  try {
    if (mode === "cascade") {
      const { algoId, nodesSlim, dimredResult, levelCfgs, allowNoise, n, precomputedLevels, ghostMask, citationEdges } = data;
      if (typeof algoId !== "string") {
        throw new Error("clustering-worker: payload.algoId must be a string");
      }
      if (!Array.isArray(nodesSlim)) {
        throw new Error("clustering-worker: payload.nodesSlim must be an array");
      }
      if (!Array.isArray(levelCfgs) || levelCfgs.length === 0) {
        throw new Error("clustering-worker: payload.levelCfgs must be a non-empty array");
      }
      const algo   = getClusteringAlgorithm(algoId);
      const levels = runClusterLevels(
        algo, nodesSlim, levelCfgs, dimredResult, !!allowNoise, n | 0,
        {
          precomputedLevels: Array.isArray(precomputedLevels) ? precomputedLevels : [],
          ghostMask:     ghostMask instanceof Uint8Array ? ghostMask : null,
          citationEdges: Array.isArray(citationEdges) ? citationEdges : null,
        },
      );

      const transfer = [];
      for (const lvl of levels) {
        const buf = lvl.clusterResult.nodeCluster && lvl.clusterResult.nodeCluster.buffer;
        if (buf) transfer.push(buf);
      }
      self.postMessage({ ok: true, result: levels }, transfer);
      return;
    }

    if (mode === "multilevel") {
      // One HDBSCAN run → a coarse→fine ladder of partitions extracted
      // from the condensed tree (MLC §9). The distance matrix fans out to
      // nested distance-workers inside inferHdbscanMultiLevel.
      const { nodesSlim, dimredResult, params, opts, n } = data;
      if (!Array.isArray(nodesSlim)) {
        throw new Error("clustering-worker: payload.nodesSlim must be an array");
      }
      const genStub = { nodes: nodesSlim };
      const out = await inferHdbscanMultiLevel(genStub, params || {}, dimredResult, opts || {});
      // Each layer is a global partition with no noise (absorption fills
      // every point) — validate against the contract.
      for (const lvl of out.levels) {
        validateClusterResult(lvl.clusterResult, n | 0, { allowNoise: false });
      }
      const transfer = [];
      for (const lvl of out.levels) {
        const b = lvl.clusterResult.nodeCluster && lvl.clusterResult.nodeCluster.buffer;
        if (b) transfer.push(b);
      }
      self.postMessage({ ok: true, result: out }, transfer);
      return;
    }

    if (mode === "multilayer") {
      // Multi-layer-from-sweep, Phase 1 (§9 revamp). Build the HDBSCAN model
      // ONCE (distance matrix fans out to nested distance-workers), then
      // extract a partition at many minClusterSize values and collapse to
      // plateau candidates. Phase 2 (bootstrap-scoring the candidates) runs
      // on the MAIN thread, where it can fan its re-clusterings out across
      // clustering-workers — so it stays out of here.
      const { nodesSlim, dimredResult, params, opts, n } = data;
      if (!Array.isArray(nodesSlim)) {
        throw new Error("clustering-worker: payload.nodesSlim must be an array");
      }
      const genStub = { nodes: nodesSlim };
      const dist = await pairwiseDistancesParallel(dimredResult, n | 0, opts || {});
      const model = buildHdbscanModel(genStub, params || {}, dimredResult, { dist });
      const candidates = runPhase1({
        model, params: params || {}, sizeGridCount: (opts && opts.sizeGridCount) || 25,
      });
      // Each candidate partition is a global, noise-free (absorbed) clustering.
      for (const c of candidates) {
        validateClusterResult(c.clusterResult, n | 0, { allowNoise: false });
      }
      const transfer = [];
      for (const c of candidates) {
        const b = c.clusterResult.nodeCluster && c.clusterResult.nodeCluster.buffer;
        if (b) transfer.push(b);
      }
      self.postMessage({ ok: true, result: { candidates } }, transfer);
      return;
    }

    if (mode === "infer") {
      const { algoId, nodesSlim, dimredResult, params } = data;
      if (typeof algoId !== "string") {
        throw new Error("clustering-worker: payload.algoId must be a string");
      }
      if (!Array.isArray(nodesSlim)) {
        throw new Error("clustering-worker: payload.nodesSlim must be an array");
      }
      const algo   = getClusteringAlgorithm(algoId);
      // The algorithms only read .nodes off genResult; stub it.
      const genStub = { nodes: nodesSlim };
      const cr = algo.infer(genStub, params || {}, dimredResult);

      const transfer = [];
      if (cr.nodeCluster && cr.nodeCluster.buffer) transfer.push(cr.nodeCluster.buffer);
      if (cr.noiseFlags  && cr.noiseFlags.buffer)  transfer.push(cr.noiseFlags.buffer);
      self.postMessage({ ok: true, result: cr }, transfer);
      return;
    }

    throw new Error(`clustering-worker: unknown mode "${mode}"`);
  } catch (err) {
    self.postMessage({
      ok: false,
      error: { message: err.message, name: err.name, stack: err.stack },
    });
  }
});
