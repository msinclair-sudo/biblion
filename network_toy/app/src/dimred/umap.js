// UMAP dim-reduction (compression family).
//
// Wraps `umap-js` (PAIR / Andy Coenen) loaded via the importmap in
// app/index.html (esm.sh transforms its CommonJS bundle to ESM).
// Plan + clustering-research pin UMAP as the default for the
// dimension-compression slot at real-data scale (PCA-100 → UMAP-50 →
// HDBSCAN). At toy scale (n ≤ 400, input d = 3) UMAP-to-2-d is
// useful for sanity-checking the wiring; UMAP-to-50 is a no-op
// upsample and shouldn't be used.
//
// Algorithm signature (per the dimred contract):
//   compute(input, params) → DimredResult
//   input  = { n, d, data: Float32Array(n*d) }
//   output = { method:"umap", params, n, d:k, data:Float32Array(n*k) }
//
// Determinism: seeded via a mulberry32 RNG passed to umap-js's
// `random` parameter. Same params + same input → same output.

// umap-js's `cosine` / `euclidean` helpers live in its inner module
// and aren't re-exported at the package entrypoint, so we provide our
// own — they're 4 lines each and avoid coupling to umap-js's internal
// file layout. Output convention matches umap-js (non-negative scalar).
//
// Import note: we use the full esm.sh URL here rather than the bare
// "umap-js" specifier because this module is consumed BOTH from the
// main page (where the importmap in app/index.html resolves the bare
// specifier) and from Web Workers (where importmaps don't apply
// consistently across browsers as of 2026). Pinning the full URL lets
// the same algorithm module load identically in both contexts. Keep
// the version in sync with the "umap-js" entry of app/index.html's
// importmap.
import { UMAP } from "https://esm.sh/umap-js@1.4.0";
import { mulberry32 } from "../rng.js";

function euclideanDistance(x, y) {
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - y[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function cosineDistance(x, y) {
  let dot = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) {
    dot += x[i] * y[i];
    nx  += x[i] * x[i];
    ny  += y[i] * y[i];
  }
  if (nx === 0 || ny === 0) return 1;
  return 1 - dot / (Math.sqrt(nx) * Math.sqrt(ny));
}

export const defaultUmapParams = () => ({
  // n_components defaults to 3 so the viz slot's UMAP produces a usable
  // basePos out of the box. In the compression slot users typically
  // crank this up (50 at real-data scale); 3 is a benign starting
  // point either way.
  n_components: 3,
  n_neighbors:  15,
  min_dist:     0.1,
  metric:       "cosine",
  random_state: 42,
});

export function computeUmap(input, params = {}) {
  const n      = input.n;
  const inputD = input.d;

  if (n < 2) {
    // UMAP needs at least n_neighbors+1 points; for the trivial case
    // we just return a 1-component zero output so the contract still
    // validates. n < 2 is a degenerate case not seen in toy use.
    const k = clampInt(params.n_components ?? 2, 1, Math.max(1, inputD));
    const data = new Float32Array(n * k);
    return {
      method: "umap",
      params: { ...defaultUmapParams(), ...echoParams(params, k, 1, 0.1) },
      n, d: k, data,
    };
  }

  const K           = clampInt(params.n_components ?? 2, 1, Math.max(1, inputD));
  const nNeighbors  = clampInt(params.n_neighbors  ?? 15, 2, n - 1);
  const minDist     = clampFloat(params.min_dist   ?? 0.1, 0, 1);
  const metric      = (params.metric === "euclidean") ? "euclidean" : "cosine";
  const seed        = (params.random_state >>> 0) || 42;

  // Convert flat Float32Array → Vectors (number[][]) for umap-js.
  const X = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(inputD);
    const off = i * inputD;
    for (let a = 0; a < inputD; a++) row[a] = input.data[off + a];
    X[i] = row;
  }

  // umap-js builds a random-projection tree (makeTree — the se/kt recursion)
  // that splits the point set until each leaf is small. A group of *identical*
  // rows can never be split, so it recurses until the call stack overflows
  // (RangeError). Real corpora trigger this via ghost/stub nodes that share a
  // placeholder embedding. Break exact duplicates with a tiny seeded jitter,
  // applied ONLY when duplicates exist so clean inputs stay bit-for-bit equal.
  jitterDuplicateRows(X, inputD, seed);

  const umap = new UMAP({
    nComponents: K,
    nNeighbors:  nNeighbors,
    minDist:     minDist,
    distanceFn:  metric === "cosine" ? cosineDistance : euclideanDistance,
    random:      mulberry32(seed),
  });

  const Y = umap.fit(X);   // number[][] of shape n × K

  // Repack into a flat Float32Array(n × K) for the dimred contract.
  const data = new Float32Array(n * K);
  for (let i = 0; i < n; i++) {
    const row = Y[i];
    const off = i * K;
    for (let k = 0; k < K; k++) data[off + k] = row[k];
  }

  return {
    method: "umap",
    params: echoParams(params, K, nNeighbors, minDist, metric, seed),
    n,
    d: K,
    data,
  };
}

// Defensive de-duplication for umap-js (see the call site in computeUmap): a
// set of identical input rows makes the RP-tree split recurse forever. We add
// a deterministic, negligible jitter to the *duplicate* occurrences only —
// unique rows are untouched, so a clean input produces an identical embedding.
function jitterDuplicateRows(X, d, seed) {
  const seen = new Set();
  const dups = [];
  for (let i = 0; i < X.length; i++) {
    const row = X[i];
    for (let a = 0; a < d; a++) {
      // Non-finite input is always an upstream bug (e.g. a stage-0 buffer read
      // past its end). umap-js would respond with an opaque RP-tree stack
      // overflow; fail loud and actionable instead.
      if (!Number.isFinite(row[a])) {
        throw new Error(`[umap] non-finite value at row ${i} col ${a} — upstream stage produced bad data`);
      }
    }
    const key = row.join(",");
    if (seen.has(key)) dups.push(i);
    else seen.add(key);
  }
  if (!dups.length) return;
  // Offset the seed from UMAP's own rng stream so we don't perturb its
  // randomness. 1e-4 separates rows for the projection split while staying far
  // below any meaningful change to the embedding.
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  for (const i of dups) {
    const row = X[i];
    for (let a = 0; a < d; a++) row[a] += (rng() - 0.5) * 1e-4;
  }
}

function echoParams(params, n_components, n_neighbors, min_dist, metric, random_state) {
  return {
    n_components,
    n_neighbors,
    min_dist,
    metric: metric ?? (params.metric === "euclidean" ? "euclidean" : "cosine"),
    random_state: random_state ?? ((params.random_state >>> 0) || 42),
  };
}

function clampInt(x, lo, hi) {
  const v = Math.round(+x || 0);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function clampFloat(x, lo, hi) {
  const v = +x || 0;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
