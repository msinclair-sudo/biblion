// Pairwise Euclidean distance matrix — sync + multi-core variants.
//
// The matrix is the dominant cost of HDBSCAN at scale (O(n²·d): at
// n=5000, d=100 that's ~2.5 Gflop). It's embarrassingly parallel by row
// block, so `pairwiseDistancesParallel` fans the rows out to
// `distance-worker.js` across `navigator.hardwareConcurrency` cores and
// reassembles. Falls back to the sync version when workers are
// unavailable, n is small, or anything throws — so correctness never
// depends on the fan-out succeeding.
//
// SharedArrayBuffer is NOT available here (the dev server sends no
// COOP/COEP ⇒ crossOriginIsolated is false), so we structured-clone the
// small positions buffer (n·d·4 bytes ≈ 2 MB at n=5000) to each worker
// and transfer each result block back. The full n² matrix is assembled
// once in the caller's thread.

// Below this n the spawn + clone overhead outweighs the parallel win.
const PARALLEL_MIN_N = 1200;
// Cap fan-out; beyond ~16 the clone/postMessage overhead dominates.
const MAX_WORKERS = 16;

export function pairwiseDistancesSync(dimredResult, n) {
  const pos = dimredResult.data;
  const d   = dimredResult.d;
  const D   = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const ai = i * d;
    for (let j = i + 1; j < n; j++) {
      const bj = j * d;
      let sq = 0;
      for (let k = 0; k < d; k++) {
        const v = pos[ai + k] - pos[bj + k];
        sq += v * v;
      }
      const dist = Math.sqrt(sq);
      D[i * n + j] = dist;
      D[j * n + i] = dist;
    }
  }
  return D;
}

function coreCount() {
  try {
    const hc = (typeof navigator !== "undefined" && navigator.hardwareConcurrency)
      || (typeof self !== "undefined" && self.navigator && self.navigator.hardwareConcurrency);
    return Math.max(1, hc | 0);
  } catch { return 1; }
}

// Split n rows into `parts` near-equal contiguous blocks [r0, r1).
function rowBlocks(n, parts) {
  const blocks = [];
  const base = Math.floor(n / parts);
  let rem = n % parts;
  let r0 = 0;
  for (let p = 0; p < parts && r0 < n; p++) {
    const rows = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    const r1 = Math.min(n, r0 + rows);
    if (r1 > r0) blocks.push([r0, r1]);
    r0 = r1;
  }
  return blocks;
}

export async function pairwiseDistancesParallel(dimredResult, n, opts = {}) {
  const concurrency = Math.max(1, Math.min(opts.concurrency || (coreCount() - 1) || 1, MAX_WORKERS));
  if (n < PARALLEL_MIN_N || concurrency <= 1 || typeof Worker === "undefined") {
    return pairwiseDistancesSync(dimredResult, n);
  }

  const d = dimredResult.d;
  const positions = dimredResult.data;       // Float32Array(n*d)
  try {
    const D = new Float32Array(n * n);
    const blocks = rowBlocks(n, concurrency);
    const workerUrl = new URL("./distance-worker.js", import.meta.url);

    await Promise.all(blocks.map(([r0, r1]) => new Promise((resolve, reject) => {
      const w = new Worker(workerUrl, { type: "module" });
      const done = (err) => { w.terminate(); err ? reject(err) : resolve(); };
      w.addEventListener("message", (ev) => {
        const msg = ev.data;
        if (!msg || !msg.ok) {
          done(new Error(msg && msg.error ? msg.error.message : "distance-worker failed"));
          return;
        }
        D.set(msg.block, msg.r0 * n);
        done();
      });
      w.addEventListener("error", (e) => done(new Error(e.message || "distance-worker crashed")));
      // Structured-clone the positions (can't transfer — every block needs them).
      w.postMessage({ positions, n, d, r0, r1 });
    })));

    return D;
  } catch {
    // Any failure (nested workers blocked, import error, OOM) → correct
    // single-thread path. The whole point of the fan-out is speed, not
    // correctness, so degrade silently.
    return pairwiseDistancesSync(dimredResult, n);
  }
}
