// Lane DAG executor.
//
// Each engine lane (redimred, recluster, relayoutCitations) declares
// its compute graph as a plain object keyed by node name; runDAG walks
// the graph, fires independent nodes into workers in parallel via
// Promise.all, and resolves with the full result map.
//
// Node shape:
//   {
//     workerUrl:    string,                               // module worker URL
//     deps:         string[],                             // names of other DAG nodes whose results this depends on
//     buildPayload: (resolved: Record<string, any>) => payload,
//     transferList?:(resolved, payload)        => ArrayBuffer[],   // optional; defaults to []
//     enabled?:     boolean,                              // defaults to true; false = skip + result is null
//   }
//
// The closure-based `buildPayload` (vs stringly-typed `inputs:{key:"nodeName"}`)
// keeps the engine's dependency wiring in normal JS — refactor-safe,
// debuggable, no magic-string typos. The cost is that the DAG isn't a
// pure data structure you could serialise to JSON, but we don't need
// that today.
//
// Execution model:
//   1. Topo-sort nodes by `deps`. Cycles throw immediately.
//   2. Repeatedly pick the set of nodes whose deps are all resolved
//      AND that are still pending; fire them all via `runInWorker` in
//      parallel; await the batch.
//   3. Repeat until every node has a result or has been skipped.
//   4. Resolve with `{ nodeName: result | null }`. Disabled nodes carry null.
//
// Cancellation:
//   `signal` is forwarded to every `runInWorker` call. On abort, all
//   in-flight workers terminate; the runDAG promise rejects with the
//   AbortError from the first cancelled worker.
//
// Errors:
//   If any node rejects, runDAG rejects immediately (Promise.all
//   semantics). Other in-flight workers in the same batch finish their
//   current job and post back, but their results are discarded; the
//   harness does NOT terminate sibling workers on a peer failure today
//   (could be added if it becomes a problem — e.g. by passing a fresh
//   AbortController.signal down to each runInWorker and aborting it on
//   first failure).

import { runInWorker } from "./worker-runner.js";

export async function runDAG(dag, options = {}) {
  const { signal } = options;
  const nodeNames = Object.keys(dag);

  // Validate + topo-sort. Tarjan's wouldn't be wrong here, but Kahn's
  // is simpler and produces an explicit order we can also inspect for
  // debugging.
  const order = topoSort(dag, nodeNames);

  // Build a name → Promise<result> map. Nodes await their deps'
  // promises before firing their own runInWorker. This is structurally
  // equivalent to walking in batches; Promise.all over the full set at
  // the end keeps the code shorter.
  const results = {};                   // name → resolved result (or null when disabled)
  const promises = {};                  // name → Promise<result>

  for (const name of order) {
    const node = dag[name];
    if (node.enabled === false) {
      // Skip. Resolve with null so downstream `buildPayload` calls can
      // see "this dep was skipped" without crashing on undefined.
      promises[name] = Promise.resolve(null);
      results[name]  = null;
      continue;
    }

    // Build this node's promise: await all deps, then fire the worker.
    promises[name] = (async () => {
      const resolved = {};
      // Sequentially await deps — they're already in flight thanks to
      // the for loop above kicking each `promises[depName]` off
      // synchronously when the dep was reached in topo order. Awaiting
      // them here is a join, not a serialisation.
      for (const depName of node.deps || []) {
        resolved[depName] = await promises[depName];
      }

      const payload      = node.buildPayload(resolved);
      const transferList = node.transferList ? node.transferList(resolved, payload) : [];
      const r            = await runInWorker(node.workerUrl, payload, { signal, transferList });
      results[name]      = r;
      return r;
    })();
  }

  // Await every node. If any rejects, the whole DAG rejects (and
  // unresolved peers stay in flight but their results are discarded).
  await Promise.all(Object.values(promises));
  return results;
}

// Kahn's algorithm. Returns a topological order; throws on cycles or
// unknown dep references.
function topoSort(dag, names) {
  const inDeg = new Map();
  const fwd   = new Map();              // name → array of downstream names
  for (const n of names) {
    inDeg.set(n, 0);
    fwd.set(n, []);
  }
  for (const n of names) {
    const deps = dag[n].deps || [];
    for (const d of deps) {
      if (!dag[d]) {
        throw new Error(`runDAG: node "${n}" depends on unknown node "${d}"`);
      }
      fwd.get(d).push(n);
      inDeg.set(n, inDeg.get(n) + 1);
    }
  }
  const ready = [];
  for (const [n, deg] of inDeg) if (deg === 0) ready.push(n);
  const order = [];
  while (ready.length) {
    const n = ready.shift();
    order.push(n);
    for (const m of fwd.get(n)) {
      const next = inDeg.get(m) - 1;
      inDeg.set(m, next);
      if (next === 0) ready.push(m);
    }
  }
  if (order.length !== names.length) {
    throw new Error("runDAG: cycle detected in lane DAG");
  }
  return order;
}
