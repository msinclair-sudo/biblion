// Distance sub-worker — computes a horizontal block of the pairwise
// Euclidean distance matrix so the O(n²·d) build fans out across cores.
//
// Spawned (nested) by parallel-distance.js from inside the clustering
// worker. One message in, one transferred block out, then the spawner
// terminates it. SharedArrayBuffer is unavailable in this app (no
// COOP/COEP from the dev server), so positions arrive as a structured-
// clone copy and the result block is transferred back (move, not copy).
//
// Protocol:
//   in:  { positions: Float32Array(n*d), n, d, r0, r1 }
//   out: { ok: true, r0, r1, block: Float32Array((r1-r0)*n) }   // transferred
//        { ok: false, error: {...} }
//
// Rows [r0, r1) are filled densely (full n columns, zero on the diagonal)
// so the spawner can D.set(block, r0*n) with no triangular bookkeeping.

self.addEventListener("message", (ev) => {
  try {
    const { positions, n, d, r0, r1 } = ev.data;
    const rows = r1 - r0;
    const block = new Float32Array(rows * n);
    for (let i = r0; i < r1; i++) {
      const ai = i * d;
      const rowOff = (i - r0) * n;
      for (let j = 0; j < n; j++) {
        if (j === i) { block[rowOff + j] = 0; continue; }
        const bj = j * d;
        let sq = 0;
        for (let k = 0; k < d; k++) {
          const v = positions[ai + k] - positions[bj + k];
          sq += v * v;
        }
        block[rowOff + j] = Math.sqrt(sq);
      }
    }
    self.postMessage({ ok: true, r0, r1, block }, [block.buffer]);
  } catch (err) {
    self.postMessage({
      ok: false,
      error: { message: err.message, name: err.name, stack: err.stack },
    });
  }
});
