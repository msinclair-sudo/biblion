// Generic Web Worker runner. Spawns a module worker, posts a payload,
// awaits a single response, then terminates the worker.
//
// Used by runDAG (dag.js) — every node in a lane's compute graph calls
// this once. Workers carry one job each (spawn-per-call); pool only if
// profiling shows the spawn cost mattering.
//
// Protocol (one round-trip):
//   main → worker:  payload
//   worker → main:  { ok: true,  result }                — happy path
//                   { ok: false, error: { message, name, stack? } }  — algorithm threw
//   worker → main:  any onerror event                    — module load / runtime crash
//
// Transfer:
//   - Outbound: caller supplies `transferList` (default []). Typed-array
//     buffers should be transferred so we don't copy 15 MB embeddings.
//     Note that transfer detaches the buffer in the main thread — caller
//     keeps a reference at their own risk.
//   - Inbound: the worker decides what to transfer back. Result-side
//     transfers are described inside `result` itself (the worker entry
//     attaches the relevant ArrayBuffers as part of its postMessage
//     transfer list); the runner just forwards `result` to the caller.
//
// Cancellation:
//   `signal` is an optional AbortSignal. If it fires before the worker
//   responds, the worker is terminated and the Promise rejects with a
//   DOMException(name="AbortError"). Engine re-fires (e.g. user changes
//   UMAP params mid-fit) plug this into their lane's AbortController.

export function runInWorker(workerUrl, payload, options = {}) {
  const { signal, transferList = [] } = options;

  // Bail early if the signal is already aborted — no point spawning a
  // worker just to terminate it.
  if (signal && signal.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    let settled = false;

    const cleanup = () => {
      settled = true;
      worker.terminate();
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    const onMessage = (ev) => {
      if (settled) return;
      const msg = ev.data;
      cleanup();
      if (msg && msg.ok) {
        resolve(msg.result);
      } else {
        const e = msg && msg.error ? msg.error : { message: "worker returned malformed response" };
        const err = new Error(e.message || "worker error");
        err.name  = e.name  || "WorkerError";
        if (e.stack) err.stack = e.stack;
        reject(err);
      }
    };

    const onError = (ev) => {
      if (settled) return;
      cleanup();
      // ErrorEvent fields: message, filename, lineno, colno, error.
      // Some browsers leave .error null when a module fails to import;
      // .message is the most reliably populated.
      const msg = (ev && ev.message) || "worker crashed";
      const err = new Error(msg);
      err.name  = "WorkerError";
      reject(err);
    };

    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(abortError());
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error",   onError);
    if (signal) signal.addEventListener("abort", onAbort);

    try {
      worker.postMessage(payload, transferList);
    } catch (err) {
      // Most likely cause: transferList contained a buffer that wasn't
      // actually transferable (e.g. a SharedArrayBuffer the page can't
      // post). Tear down and reject so the lane sees the failure.
      cleanup();
      reject(err);
    }
  });
}

function abortError() {
  // Match the spec'd AbortController behaviour: DOMException name="AbortError"
  // where available, plain Error fallback for environments without DOMException.
  if (typeof DOMException === "function") {
    return new DOMException("aborted", "AbortError");
  }
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
