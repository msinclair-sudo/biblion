// ARI dim-sweep runner (§6.9 / §6.19 step 4).
//
// Given a fixed Layer 0 input (embedding or basePos), sweeps the
// compression stage across a list of target dims × seeds, clusters
// each result, then computes pairwise ARI between *same-seed*
// partitions across dims. Mean ARI(d1, d2) across seeds quantifies
// how much partition structure is preserved as compression dim
// changes — the "is UMAP-50 throwing information away" question.
//
// Architecture:
//   - Runs the noise stage ONCE (no dim/seed dependence; reused
//     across all iterations). PCA-100 at n=5000 is ~3 s per run,
//     so this saves ~36 s on a 12-iter sweep.
//   - For each (dim, seed) pair, runs compression then clustering
//     via the dimred + clustering workers. Sequential per iter
//     (next iter doesn't start until clustering completes), so we
//     never have two workers fighting for the same core. Parallel
//     across seeds isn't worth the complexity — the bottleneck is
//     UMAP, which is single-threaded inside the worker anyway.
//   - Computes pairwise ARI on the main thread (cheap; pure JS,
//     <100 ms per pair at n=5000).
//   - PURE: doesn't touch global state. Caller owns whether the
//     sweep's intermediate dimreds become user-visible. The panel
//     opts for "no" — sweeps run silently, the canonical
//     dimredResult / clusterLevels aren't disturbed.
//
// Cancellation: pass an AbortSignal. Checked between every worker
// call; if aborted mid-flight, the active worker is terminated by
// worker-runner.js and we throw AbortError. Caller's state is
// untouched (because we never mutated it).

import { runInWorker }            from "../workers/worker-runner.js";
import { runInferRemote }         from "./run-infer-remote.js";
import { adjustedRandIndex }      from "./ari.js";
import { getAlgorithm as getClusteringAlgo } from "../clustering-registry.js";

const DIMRED_WORKER_URL = new URL("../workers/dimred-worker.js", import.meta.url);

/**
 * Run an ARI dim-sweep.
 *
 * @param {object} opts
 * @param {{n: number, d: number, data: Float32Array}} opts.input
 *           Stage 0 input — embedding or basePos. The runner is
 *           agnostic; whatever the user wants the noise stage to
 *           consume.
 * @param {object} opts.genResult
 *           Needed by runInferRemote (it slims down to nodes[i].basePos
 *           for some algorithms). Real-data path: basePos may be null;
 *           HDBSCAN doesn't read it, so that's fine. Toy path:
 *           per-node basePos is populated by the generator.
 * @param {number[]} opts.dims    Compression target dims to sweep.
 * @param {number[]} opts.seeds   Seeds per dim.
 * @param {{method: string, params: object}} opts.noise
 *           Applied once. Output reused across all (dim, seed) runs.
 * @param {{method: string, params: object}} opts.compression
 *           Params other than `n_components` and `random_state` —
 *           those two get patched per iter from dims + seeds.
 * @param {{method: string, params: object}} opts.clustering
 *           Algorithm + params. Same params used for every (dim, seed).
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(stage: string, completed: number, total: number) => void} [opts.onProgress]
 *           Called at the start of the noise stage and at the start
 *           of each (dim, seed) iter. `total` is the count of (dim,seed)
 *           pairs.
 * @returns {Promise<DimSweepResult>}
 *
 * DimSweepResult shape:
 *   {
 *     dims, seeds,                              // echoed for the renderer
 *     inputs: { noise, compression, clustering }, // echoed
 *     partitions: { [seed]: { [dim]: { nodeCluster: Int32Array, nClusters, timeSec } } },
 *     ariMatrix:  { [d1]: { [d2]: { mean: number, sd: number, perSeed: number[] } } },
 *     clusterCounts: { [dim]: { mean: number, sd: number, perSeed: number[] } },
 *     runtimeSec: number,
 *     completedAt: ISO string,
 *   }
 */
export async function runDimSweep(opts = {}) {
  const {
    input,
    genResult,
    dims,
    seeds,
    noise,
    compression,
    clustering,
    abortSignal,
    onProgress,
  } = opts;

  if (!input || !(input.data instanceof Float32Array)) {
    throw new Error("[dim-sweep] input { n, d, data: Float32Array } required");
  }
  if (!Array.isArray(dims) || dims.length < 2) {
    throw new Error("[dim-sweep] need ≥ 2 dims");
  }
  if (!Array.isArray(seeds) || seeds.length < 1) {
    throw new Error("[dim-sweep] need ≥ 1 seed");
  }
  if (!noise || !noise.method)             throw new Error("[dim-sweep] noise required");
  if (!compression || !compression.method) throw new Error("[dim-sweep] compression required");
  if (!clustering || !clustering.method)   throw new Error("[dim-sweep] clustering required");

  const emit = (stage, completed, total) => {
    if (typeof onProgress === "function") onProgress(stage, completed, total);
  };
  const checkAborted = () => {
    if (abortSignal && abortSignal.aborted) throw abortError();
  };

  const t0 = performance.now();
  const totalRuns = dims.length * seeds.length;

  // ── Stage 1 — noise. Run once. ────────────────────────────────────
  emit("noise", 0, totalRuns);
  checkAborted();
  // The dimred-worker dispatcher transfers the input.data buffer back as
  // part of its result; we don't want to detach our caller's `input`,
  // so we ship a copy. n × d × 4 bytes — at n=5000, d=768 that's 15 MB
  // copied once at sweep start. Cheap relative to PCA / UMAP cost.
  const inputCopy = {
    n:    input.n,
    d:    input.d,
    data: new Float32Array(input.data),
  };
  const noiseOut = await runInWorker(DIMRED_WORKER_URL, {
    algo:   noise.method,
    input:  inputCopy,
    params: noise.params || {},
  }, { signal: abortSignal, transferList: [inputCopy.data.buffer] });
  checkAborted();

  // ── Stage 2 + 3 — per-iter compression + clustering. ──────────────
  const partitions = {};
  for (const s of seeds) partitions[s] = {};

  let runIdx = 0;
  const clustAlgo = getClusteringAlgo(clustering.method);
  if (!clustAlgo) throw new Error(`[dim-sweep] unknown clustering algorithm: ${clustering.method}`);

  for (const seed of seeds) {
    for (const dim of dims) {
      checkAborted();
      runIdx++;
      emit(`(d=${dim}, s=${seed})`, runIdx, totalRuns);

      const tIter = performance.now();

      // Compression input is the SAME noise output every iter; we copy
      // it so the worker's transfer doesn't detach the canonical noiseOut
      // (we still need it for the rest of the sweep).
      const compInput = {
        n:    noiseOut.n,
        d:    noiseOut.d,
        data: new Float32Array(noiseOut.data),
      };
      const compOut = await runInWorker(DIMRED_WORKER_URL, {
        algo:   compression.method,
        input:  compInput,
        params: {
          ...(compression.params || {}),
          n_components: dim,
          random_state: seed,
        },
      }, { signal: abortSignal, transferList: [compInput.data.buffer] });
      checkAborted();

      // Clustering. runInferRemote handles the slim-nodes payload + worker
      // dispatch. We pass transferDimred=true since compOut is a one-shot
      // sub-buffer we just built — no other consumer will touch its data.
      const cr = await runInferRemote(
        clustAlgo,
        genResult,
        clustering.params || {},
        compOut,
        { signal: abortSignal, transferDimred: true },
      );
      checkAborted();

      partitions[seed][dim] = {
        nodeCluster: cr.nodeCluster,
        nClusters:   cr.clusters ? cr.clusters.length : 0,
        timeSec:     (performance.now() - tIter) / 1000,
      };
    }
  }

  // ── Aggregate — pairwise ARI per seed, then mean ± SD across seeds. ─
  // ARI(d, d) = 1.0 trivially; we still populate the diagonal so the
  // renderer doesn't have to special-case it.
  const ariMatrix = {};
  for (const d1 of dims) {
    ariMatrix[d1] = {};
    for (const d2 of dims) {
      const perSeed = [];
      for (const seed of seeds) {
        const a = partitions[seed][d1].nodeCluster;
        const b = partitions[seed][d2].nodeCluster;
        perSeed.push(d1 === d2 ? 1.0 : adjustedRandIndex(a, b));
      }
      ariMatrix[d1][d2] = {
        mean:    mean(perSeed),
        sd:      pstdev(perSeed),
        perSeed,
      };
    }
  }

  const clusterCounts = {};
  for (const d of dims) {
    const perSeed = seeds.map(s => partitions[s][d].nClusters);
    clusterCounts[d] = { mean: mean(perSeed), sd: pstdev(perSeed), perSeed };
  }

  return {
    dims,
    seeds,
    inputs: { noise, compression, clustering },
    partitions,
    ariMatrix,
    clusterCounts,
    runtimeSec:  (performance.now() - t0) / 1000,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Verdict helper for a chosen (d1, d2) pair against a threshold.
 * Mirrors the validation script's PASS/FAIL convention.
 */
export function dimSweepVerdict(result, d1, d2, threshold = 0.9) {
  const cell = result.ariMatrix[d1] && result.ariMatrix[d1][d2];
  if (!cell) return { pair: [d1, d2], threshold, mean: null, sd: null, defensible: null };
  return {
    pair:       [d1, d2],
    threshold,
    mean:       cell.mean,
    sd:         cell.sd,
    defensible: cell.mean > threshold,
  };
}

/**
 * Coarse cost estimate for the confirm-dialog banner. Per-iter cost is
 * dominated by UMAP at the chosen n; we model it as
 *   t_iter ≈ baseUmapSec × (n / 5000) × (dim / 50)
 * which fits the validation script's observed timings (~30–60 s per
 * iter at n=5000, d ∈ {30..200}). Caller can override baseUmapSec if
 * a more accurate model emerges.
 */
export function estimateDimSweepCost(opts) {
  const { n, dims, seeds, baseUmapSec = 8 } = opts;
  let total = 0;
  // Noise stage: PCA on n=5000×768 is ~3 s; toy n=400 is ~0.1 s. One-off.
  total += Math.max(0.3, (n / 5000) * 3);
  for (const dim of dims) {
    for (const _ of seeds) {
      // UMAP fit + HDBSCAN + worker spawn overhead.
      total += baseUmapSec * Math.max(0.05, n / 5000) * Math.max(0.3, dim / 50);
    }
  }
  return total;
}

function mean(xs) {
  if (xs.length === 0) return NaN;
  let s = 0; for (const x of xs) s += x;
  return s / xs.length;
}
function pstdev(xs) {
  if (xs.length === 0) return NaN;
  const m = mean(xs);
  let s = 0; for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

function abortError() {
  if (typeof DOMException === "function") return new DOMException("aborted", "AbortError");
  const e = new Error("aborted"); e.name = "AbortError"; return e;
}
