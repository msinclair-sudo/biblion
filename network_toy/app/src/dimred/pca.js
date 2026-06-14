// PCA dim-reduction.
//
// Algorithm: power iteration with deflation.
//   1. Mean-centre the input vectors.
//   2. For each component k = 0..K-1:
//        a. Initialise v_k = random unit vector (deterministic via the
//           input size so PCA is reproducible per run).
//        b. Iterate v_k ← (Aᵀ A) v_k / ‖·‖ for ~50 steps.
//        c. Deflate: subtract v_k v_kᵀ from the centred matrix.
//   3. Project: out[i, k] = (x_i − mean) · v_k.
//
// Cheap at toy scale (n ≤ 400, d ≤ 3): O(K · n · d · iters). For real-
// pipeline d = 768 we'd want a proper SVD, but the contract is the
// same; only the inner loop swaps. Pure: reads input.data, returns a
// new Float32Array.
//
// Plan + clustering-research role: PCA is the **noise-reduction**
// (denoiser) prefix before UMAP. PCA alone is documented to fail on
// transformer embeddings (variance-preserving, not boundary-preserving)
// — so it's tagged `family: "noise"` in the registry, never standalone
// "compression" for the locked default at real-data scale.
//
// Ghost nodes (ghost-node spec §4.2): PCA fits the covariance + projects on
// EXACTLY the rows it is handed. The engine feeds it the m EMBEDDED nodes only
// (input.n = m, the dense m×d embedding block) — ghosts have no embedding row
// and so get NO PCA row here; they acquire a position later at fusion. This is
// deliberate: fitting on real-only avoids the covariance bias the research
// flags in Q4. Output is m×K. No code branch is needed — feeding m rows is the
// whole mechanism.

import { mulberry32 } from "../rng.js";

const POWER_ITER = 50;

export const defaultPcaParams = () => ({
  n_components: 2,
});

export function computePca(input, params = {}) {
  const n      = input.n;
  const inputD = input.d;
  const K      = clampInt(params.n_components ?? 2, 1, inputD);

  // Lift to Float64 for numerical stability through power iteration.
  const X = new Float64Array(n * inputD);
  for (let i = 0; i < n * inputD; i++) X[i] = input.data[i];

  // Mean-centre.
  const mean = new Float64Array(inputD);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < inputD; a++) mean[a] += X[i * inputD + a];
  }
  for (let a = 0; a < inputD; a++) mean[a] /= Math.max(1, n);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < inputD; a++) X[i * inputD + a] -= mean[a];
  }

  // Power iteration with deflation. Components are returned in
  // descending eigenvalue order.
  const rng = mulberry32(0x9e3779b9 ^ ((n * 31 + inputD) | 0));
  const components = [];
  for (let k = 0; k < K; k++) {
    let v = randomUnit(inputD, rng);
    for (let it = 0; it < POWER_ITER; it++) {
      // u = X v   (n-vector)
      const u = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let a = 0; a < inputD; a++) s += X[i * inputD + a] * v[a];
        u[i] = s;
      }
      // w = Xᵀ u  (d-vector)
      const w = new Float64Array(inputD);
      for (let i = 0; i < n; i++) {
        const ui = u[i];
        for (let a = 0; a < inputD; a++) w[a] += X[i * inputD + a] * ui;
      }
      v = unit(w);
    }
    components.push(v);
    // Deflate: X ← X − (X v) vᵀ.
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let a = 0; a < inputD; a++) s += X[i * inputD + a] * v[a];
      for (let a = 0; a < inputD; a++) X[i * inputD + a] -= s * v[a];
    }
  }

  // Project the (originally mean-centred) input onto the K components.
  // Note: we already mutated X in-place above, but we reproject from
  // the original input below for clarity (deflation drops information,
  // so we can't read projections off the deflated matrix).
  const data = new Float32Array(n * K);
  for (let i = 0; i < n; i++) {
    const baseOff = i * inputD;
    // Re-centre this row from raw input on the fly.
    for (let k = 0; k < K; k++) {
      const v = components[k];
      let acc = 0;
      for (let a = 0; a < inputD; a++) acc += (input.data[baseOff + a] - mean[a]) * v[a];
      data[i * K + k] = acc;
    }
  }

  return {
    method: "pca",
    params: { n_components: K },
    n,
    d: K,
    data,
  };
}

function unit(v) {
  let s = 0;
  for (let a = 0; a < v.length; a++) s += v[a] * v[a];
  s = Math.sqrt(s) || 1;
  const out = new Float64Array(v.length);
  for (let a = 0; a < v.length; a++) out[a] = v[a] / s;
  return out;
}

function randomUnit(d, rng) {
  const v = new Float64Array(d);
  for (let a = 0; a < d; a++) v[a] = rng() * 2 - 1;
  return unit(v);
}

function clampInt(x, lo, hi) {
  const v = Math.round(+x || 0);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
