// Dim-reduction output contract.
//
// Every Layer 1.5 algorithm produces this shape. The engine validates
// it once on the way out (cheap, ~10 µs at toy scale) so contract
// violations surface immediately when registering a new algorithm.
//
// Shape:
//   {
//     method: "identity" | "pca" | "umap" | …,
//     params: { ... },                // the params the algorithm ran with
//     n:      int,                     // node count
//     d:      int,                     // output dimensionality (n_components)
//     data:   Float32Array(n * d),     // ROW-MAJOR: data[i*d + axis] = node i's coord along axis
//   }
//
// Rationale for flat Float32Array (vs an array-of-vectors):
//   * Real-pipeline data shape (768-d SPECTER2, 50-d UMAP) is a single
//     float32 matrix in `expanded_embeddings.npy`. Mirroring that shape
//     in the toy means the contract carries over to the Python port.
//   * O(1) random access per scalar, no per-node object allocations.
//
// Toy default at the input side: `identity` reads basePos and emits
// d = 3 — so until a higher-dim embedding source exists, this is a
// near-noop. The contract still exercises end-to-end on toy data.

export const DIMRED_CONTRACT_VERSION = 1;

export function validateDimredResult(result, n) {
  fail(result && typeof result === "object", "dimred result must be an object");
  fail(typeof result.method === "string", "result.method must be a string");
  fail(result.params && typeof result.params === "object",
       "result.params must be an object");
  fail(Number.isInteger(result.n) && result.n === n,
       `result.n must equal n (${n}), got ${result.n}`);
  fail(Number.isInteger(result.d) && result.d > 0,
       `result.d must be a positive integer, got ${result.d}`);
  fail(result.data instanceof Float32Array,
       "result.data must be a Float32Array");
  fail(result.data.length === result.n * result.d,
       `result.data.length must equal n*d (${result.n * result.d}), got ${result.data.length}`);
  for (let k = 0; k < result.data.length; k++) {
    if (!Number.isFinite(result.data[k])) {
      fail(false, `result.data[${k}] is not finite`);
    }
  }
}

function fail(ok, msg) {
  if (!ok) throw new Error(`[dimred contract] ${msg}`);
}
