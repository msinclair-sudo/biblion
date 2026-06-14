// Remote algo.infer — runs a single clustering inference in a worker.
//
// Used by the eval surface (sweep.js + bootstrap.js) so swept configs
// and bootstrap iters don't freeze the main thread. Same algorithm
// registry resolves on both threads (the worker imports
// clustering-registry.js directly), so the caller passes the
// algorithm id rather than the algorithm object itself.
//
// Why a helper rather than inline runInWorker calls at each site:
//   - One payload shape, in one place. If we add a slim-nodes cache or
//     a threshold-based sync fallback later, both consumers pick it up
//     for free.
//   - Lets us strip the worker call down to its minimum API. The
//     algorithms only read .nodes.basePos off genResult, so we send
//     a slim copy rather than the whole graph + origins + citations
//     blob.
//
// Trade-offs vs sync (algo.infer called directly):
//   + Doesn't block the main thread → UI repaints during sweeps.
//   + Multiple inferences can run in parallel via Promise.all (the
//     B4 win for bootstrap iters and the future per-sweep-config win).
//   - Spawn-per-call cost ~10 ms (see worker-runner.js). At toy scale
//     (n=400, fast algorithms like mutualKNN) this dominates and can
//     make individual configs marginally slower. Acceptable: toy is
//     for interactive exploration where the UI freeze was the real
//     problem; raw speed at toy scale was never the bottleneck.
//   - Transferable Int32Array's buffer detaches in the worker (gets
//     transferred back). Caller must not retain a reference.

import { runInWorker }              from "../workers/worker-runner.js";
import { slimNodesForClustering }   from "../clustering-cascade.js";

// Resolved relative to this module so the runtime URL matches the
// served file layout, regardless of which page hosts the import.
const CLUSTERING_WORKER_URL = new URL("../workers/clustering-worker.js", import.meta.url);

/**
 * Run a single algo.infer in a worker.
 *
 * @param {object} algo           Clustering registry entry (must carry .id).
 * @param {object} genResult      Full genResult; only nodes[i].basePos is read.
 * @param {object} params         Algorithm-specific params.
 * @param {object} dimredResult   Float-32 dimred output, or null when an
 *                                algorithm runs on basePos alone.
 * @param {object} [opts]
 * @param {AbortSignal|{aborted:boolean}} [opts.signal]
 *                      Either a WHATWG AbortSignal (wired into the
 *                      worker for active termination) or the eval
 *                      surface's polling `{aborted: bool}` object
 *                      (checked once at entry; can't interrupt
 *                      mid-flight). Mixed for backward-compat with
 *                      sweep.js's pre-§6.18 convention. New call
 *                      sites should prefer AbortController.
 * @param {boolean}     [opts.transferDimred=false]
 *                      Transfer dimredResult.data.buffer to the worker
 *                      instead of structured-cloning it. Detaches the
 *                      buffer in the main thread — only safe when the
 *                      caller built a one-shot sliced sub-buffer (e.g.
 *                      bootstrap.js's per-iter subDimred). The default
 *                      false matches sweep.js's pattern of reusing the
 *                      same full dimredResult for every config in a run.
 * @returns {Promise<ClusterResult>}   The same shape sync `algo.infer`
 *                                     would return on the main thread.
 *                                     Output Int32Arrays are transferred
 *                                     back, no copy.
 */
export async function runInferRemote(algo, genResult, params, dimredResult, opts = {}) {
  const { signal, transferDimred = false } = opts;

  // Signal disambiguation: AbortSignal has addEventListener; the eval
  // polling object doesn't. We forward real signals (so worker-runner
  // can terminate the worker on abort) and treat polling objects as a
  // pre-flight check only.
  const isAbortSignal = signal && typeof signal.addEventListener === "function";
  if (signal && !isAbortSignal && signal.aborted) {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }
  const fwdSignal = isAbortSignal ? signal : undefined;

  const nodesSlim = slimNodesForClustering(genResult.nodes);
  const payload = {
    mode:         "infer",
    algoId:       algo.id,
    nodesSlim,
    dimredResult,
    params:       params || {},
    n:            genResult.nodes.length,
  };
  const transferList = [];
  if (transferDimred && dimredResult && dimredResult.data && dimredResult.data.buffer) {
    transferList.push(dimredResult.data.buffer);
  }
  return runInWorker(CLUSTERING_WORKER_URL, payload, { signal: fwdSignal, transferList });
}
