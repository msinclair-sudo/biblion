# Workers — DAG-orchestrated background compute

The three heavy engine lanes (`redimred`, `recluster`,
`relayoutCitations`) run their compute in module Web Workers. The
main thread stays responsive while UMAP / HDBSCAN / FR / UMAP-on-
graph crunch. Each lane declares a small **DAG** of work; a generic
walker fires independent nodes into workers in parallel and threads
results between them.


---

## 1. File layout

```
app/src/workers/
  worker-runner.js       generic runInWorker(workerUrl, payload, {signal, transferList})
  dag.js                 runDAG(dag, {signal}?) — topo-sort + parallel-batch
  dimred-worker.js       module worker entry; dispatches on algo (identity/pca/umap/graph-diffusion)
  clustering-worker.js   module worker entry; runs the multi-level cascade per job
  layout-worker.js       module worker entry for FR / MDS / UMAP-on-graph
app/src/clustering-cascade.js   shared multi-level cascade extracted from engine.js so the worker can call it
```

`clustering-cascade.js` exports `runClusterLevels`,
`clusterWithinParents`, `sliceDimred`, and `slimNodesForClustering`
— all pure functions. The engine imports them; the clustering
worker imports them. One source of truth either side of the worker
boundary.

---

## 2. Why workers, and why a DAG

The page used to freeze for 30–90 s during UMAP / HDBSCAN at the
BFS-5000 subset. Workers fix the freeze; the DAG layer on top does
two extra things:

1. **Sibling parallelism.** Layer 1.5's compression / viz / viz2d
   are independent fits — they all read the fusion-stage output.
   Running them in three parallel workers cuts the post-noise wall
   clock by ~3× at BFS scale. When fusion is non-identity the same
   triple runs again on the pre-fusion side (compPre / vizPre);
   five workers cover that whole layer in parallel.
2. **Uniform shape.** `relayoutCitations()` is a single-node DAG —
   silly on its own, but uniform with `redimred` means cancellation,
   progress reporting, and introspection all work the same way
   across every lane. Future branchy lanes (e.g. ensemble clustering
   that runs the algorithm three ways and merges) come for free.

Inline `Promise.all` would have done the parallel work too; the DAG
shape was chosen for the consistency.

---

## 3. `runInWorker(workerUrl, payload, {signal, transferList}?)`

`worker-runner.js`. Spawns one module worker, posts a payload,
awaits a single response, then terminates the worker.

**Protocol (one round-trip):**
```
main → worker:  payload
worker → main:  { ok: true,  result }                       — happy path
                { ok: false, error: { message, name, stack? } }  — algorithm threw
worker → main:  any onerror event                            — module load / runtime crash
```

**Transfer.**
- Outbound: caller supplies `transferList` (default `[]`).
  TypedArray buffers should be transferred — otherwise we copy
  ~15 MB embeddings per call at n=5000×768.
- Inbound: the worker decides what to transfer back. The result is
  forwarded as-is to the caller.

**Cancellation.** `signal` is an optional `AbortSignal`. If it
fires before the worker responds, the worker is terminated and the
promise rejects with a `DOMException(name="AbortError")`.

**Spawn-per-call.** Worker spawn is ~10 ms; UMAP and HDBSCAN are
seconds. No pool — revisit if profiling shows spawn cost mattering.

---

## 4. `runDAG(dag, {signal}?)`

`dag.js`. Walks a node-keyed object; each node declares its `deps`
(other node names whose results it consumes), a `buildPayload`
closure, and an optional `transferList` builder.

**Node shape:**
```ts
{
  workerUrl:    string,                                      // module worker URL
  deps:         string[],                                    // names of other DAG nodes
  buildPayload: (resolved: Record<string, any>) => payload,
  transferList?: (resolved, payload) => ArrayBuffer[],       // default: []
  enabled?:     boolean,                                     // default: true; false = skip + result is null
}
```

The closure-based `buildPayload` (vs a stringly-typed
`inputs: {key: "nodeName"}` map) keeps the engine's dependency
wiring in normal JS — refactor-safe, debuggable, no magic-string
typos. The cost is that the DAG isn't a pure-data structure you
could serialise; we don't need that today.

**Execution.**
1. Topo-sort nodes by `deps` (Kahn's algorithm). Cycles throw
   immediately; unknown dep references throw.
2. Each node's promise awaits its deps' promises, then fires
   `runInWorker`. Independent nodes thus run in parallel naturally
   (their promises kick off as soon as the topo-sort loop reaches
   them, even though they `await` later).
3. Returns `{ nodeName: result | null }` once all nodes complete.
   Disabled nodes carry `null`.

**Cancellation.** `signal` is forwarded to every `runInWorker`
call. On abort, all in-flight workers terminate; the `runDAG`
promise rejects with the AbortError from the first cancelled
worker. Engine wires a per-lane `AbortController` so re-firing a
lane mid-flight cancels the prior run.

**Errors.** If any node rejects, `runDAG` rejects immediately
(`Promise.all` semantics). Other in-flight workers in the same
batch finish their current job and post back, but their results
are discarded. The harness does NOT terminate sibling workers on a
peer failure today; could be added by passing a fresh
`AbortController.signal` down to each `runInWorker` and aborting
it on first failure.

---

## 5. Worker entries

Each worker is a thin dispatcher. The algorithm modules themselves
(`dimred/umap.js`, `clustering-hdbscan.js`, etc.) are unchanged —
pure functions with no DOM access; they run identically on the
main thread (legacy shell) and inside a worker (new shell).

### `dimred-worker.js`

```
in:  { algo, input: { n, d, data: Float32Array }, params }
out: { ok: true,  result: { method, params, n, d, data: Float32Array } }
     { ok: false, error: { ... } }
```

Dispatches on `algo` ∈ `{identity, pca, umap, graph-diffusion}`.
One worker file handles every Layer 1.5 algorithm — avoids spawning
workers that only know one algorithm at a time.

### `clustering-worker.js`

Dispatches on `payload.mode`:

**`mode: "cascade"` (default)** — multi-level cluster cascade.
```
in:  { mode: "cascade", algoId, nodesSlim, dimredResult, levelCfgs, allowNoise, n }
out: { ok: true,  result: levels[] }
```
Runs the full multi-level cascade per job via
`clustering-cascade.js`'s `runClusterLevels`. When fusion is
active, the `recluster()` lane fires two clustering workers in
parallel (post-fusion + pre-fusion); the merge happens on the main
thread.

**`mode: "infer"`** — single `algo.infer` call. Used by the eval
surface (`eval/sweep.js` + `eval/bootstrap.js` via
`eval/run-infer-remote.js`) so swept configs and bootstrap iters
run off the main thread.
```
in:  { mode: "infer", algoId, nodesSlim, dimredResult, params, n }
out: { ok: true,  result: ClusterResult }    // single-level
```
Shipped 2026-05-24 under §6.18.2 (A1 + A4).

### `layout-worker.js`

```
in:  { algoId, input, params }
out: { ok: true, result: Float32Array(n*3) }
```

Dispatches FR / MDS / UMAP-on-graph from
`citation-layout/registry.js`. Single-node DAG inside
`relayoutCitations()` — uniform shape with the other lanes.

---

## 6. Lane DAGs

### `redimred()` (in `engine.js`)

```
input0 ──▶ noise ──▶ fusion ─┬─▶ compression  (clustering input)
                             ├─▶ viz          (3D viewer basePos)
                             └─▶ viz2d        (2D viewer basePos)

  when fusion is active, also:
            noise ──┬─▶ compPre  (pre-fusion clustering input)
                    └─▶ vizPre   (pre-fusion 3D basePos)
```

After the DAG resolves, the engine runs `alignGlobal(vizPre, viz)`
on the main thread (cheap; depends on both viz results) and adopts
the aligned pre-fusion basePos as `_basePosPreFusion`. Then
cascades into `recluster()`.

### `recluster()` (in `engine.js`)

```
post:  one clustering-worker call with dimredResult     → clusterLevels
pre:   one clustering-worker call with dimredResultPreFusion (when present) → clusterLevelsPreFusion
```

After the DAG, `computeBridgeAnalysis(clusterLevels)` runs on the
main thread when `clusterLevels.length >= 2`.

### `relayoutCitations()` (in `engine.js`)

```
layout: one layout-worker call → citationLayout
```

Then `alignByComponent(citationLayout, _basePos, components)` runs
on the main thread (Procrustes + correlation; small) producing
`alignedCitationLayout` + `alignmentCorrelation`.

---

## 7. Determinism

Workers don't change `mulberry32`'s output — same seed → same
sequence on either side of the worker boundary. UMAP runs seeded;
HDBSCAN is deterministic given its inputs; FR / MDS / UMAP-on-graph
are all seeded too. Smoke-tested at toy n=400 (byte-identical
outputs vs the pre-DAG sync path) and at BFS n=5000 (cluster
counts + cluster IDs match the pre-DAG run when the same seed is
used).

---

## 8. Engine-side discipline

Two requirements every async lane must satisfy — both were the
showstopper bugs documented in `RESUMING.md` (parked branch
`dev/dag-workers`, fixed in commit 6b51c6a):

1. **`setLayerState("X", "running")` at the start of the lane.** The
   workflow chart's status dot reads this signal; without it the dot
   stays green during the entire (potentially 30+ s) compute and
   there's no visible progress signal outside the modal's Running…
   button. Each lane sets `"running"` on entry, `"fresh"` on the
   terminal `update({...})`.
2. **`engineRevision` bump in the terminal `update({...})`.** The
   3D viewer reads `engineRevision` to decide whether to call
   `rebuildData()` + `colourOverlay.refreshOptions()`. Without the
   bump, the viewer sees `dataChanged === false` and keeps painting
   the old result — the clustering DID change underneath, but the
   viewer never noticed.

---

## 9. What this does NOT solve

- **Per-epoch progress reporting** (e.g. "UMAP epoch 124/500").
  umap-js exposes this; the worker protocol currently posts only
  the final result. Slice 4 follow-up — defer until the chart's
  per-card progress overlay wants the granularity.
- **HDBSCAN producing too many clusters at default
  `min_cluster_size` at large n.** Param-tuning issue, independent
  of workers. Use the §6.17 target-range sweep to find a sensible
  resolution.
- **(Resolved §6.18.4)** ~~Active mid-flight cancellation of eval
  workers.~~ `optimise-tab.js` now wires a real `AbortController`
  through `sweep.js` / `bootstrap.js` / `runInferRemote`; the
  worker-runner's `signal.addEventListener("abort", …)` hook
  terminates in-flight workers synchronously on cancel.

---

## 10. Cross-references

- `doc/ui-architecture.md` §3 — engine orchestrator; §12 —
  typed-job queue (worker lanes run inside step-bound jobs whose
  status mirrors to the bound chart card).
- `doc/dimred.md` §4 — Layer 1.5 engine orchestration; the redimred
  DAG above is its parallel-execution overlay.
- `doc/clustering.md` §5 — pipeline rerun semantics; `recluster()`
  now runs through `clustering-worker.js`.
- `doc/multi-level.md` §3 — multi-level cascade; the shared logic
  is `clustering-cascade.js`'s `runClusterLevels`.
- `RESUMING.md` (repo root) — postmortem of the two demo-night
  bugs that pushed the worker port off `main` initially.
