// Dim-reduction worker entry.
//
// Receives one job per worker (spawn-per-call model — see worker-runner.js),
// dispatches on `algo`, calls the relevant algorithm's compute(), and
// posts the result back transferring the output Float32Array's buffer
// so the main thread can adopt it without a copy.
//
// Protocol:
//   in:  { algo, input: { n, d, data: Float32Array }, params }
//   out: { ok: true,  result: { method, params, n, d, data: Float32Array } }
//        { ok: false, error: { message, name, stack? } }
//
// Why a worker-side dispatcher rather than one worker file per algorithm:
//   - Avoids spawning workers that only know one algorithm. The dimred
//     stage runs identity/pca/umap/graph-diffusion interchangeably; one
//     worker file means one URL the runner can spawn for any stage.
//   - Algorithm modules are tiny (<200 LoC each); importing all of them
//     at worker boot is sub-100 ms.
//
// Imports use full esm.sh URLs (via dimred/umap.js's internal import)
// because module-worker importmap support isn't universal yet — see
// the import note in dimred/umap.js.

import { computeIdentity } from "../dimred/identity.js";
import { computePca }      from "../dimred/pca.js";
import { computeUmap }     from "../dimred/umap.js";
import * as graphDiffusion from "../dimred/graph-diffusion.js";

const DISPATCH = {
  identity:           (input, params) => computeIdentity(input, params),
  pca:                (input, params) => computePca(input, params),
  umap:               (input, params) => computeUmap(input, params),
  [graphDiffusion.ID]:(input, params) => graphDiffusion.compute(input, params),
};

self.addEventListener("message", (ev) => {
  const { algo, input, params } = ev.data || {};

  try {
    const fn = DISPATCH[algo];
    if (!fn) throw new Error(`dimred-worker: unknown algorithm "${algo}"`);
    if (!input || typeof input.n !== "number" || typeof input.d !== "number" || !(input.data instanceof Float32Array)) {
      throw new Error("dimred-worker: payload.input must be { n, d, data: Float32Array }");
    }

    const result = fn(input, params || {});

    // Transfer the output buffer back so the main thread doesn't pay
    // the copy cost. Algorithm modules return data as a Float32Array
    // (see contract.js); detach via the transfer list.
    const buf = result.data && result.data.buffer ? [result.data.buffer] : [];
    self.postMessage({ ok: true, result }, buf);
  } catch (err) {
    self.postMessage({
      ok: false,
      error: { message: err.message, name: err.name, stack: err.stack },
    });
  }
});
