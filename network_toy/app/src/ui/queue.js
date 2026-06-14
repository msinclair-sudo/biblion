// Typed-job queue — workflow-tree-redesign Phase 1, slice A.
//
// Each job has:
//   - a stable id (issued at enqueue time)
//   - a type (free string; "optimise", "bootstrapStability", "save", etc.
//     — callers pick the value; consumers filter on it)
//   - a label (headline text for any UI surface that shows it)
//   - a status that transitions: pending → running → done | failed | cancelled
//   - an optional mid-flight phase + progress (set by the job's runner)
//   - a result (populated on done) or error (populated on failed)
//   - createdAt / startedAt / endedAt timestamps
//
// The runner is **FIFO and single-threaded**. One job runs at a time;
// the rest sit pending. Multiple-concurrent execution is a follow-up —
// out of scope here.
//
// Cancellation is per-job:
//   - Pending: dequeues the job, status → "cancelled".
//   - Running: aborts the job's AbortController, status → "cancelled"
//     once the runner observes the abort. The job's `fn` is responsible
//     for checking `signal.aborted` or wiring it through (e.g.
//     `runInWorker(..., {signal})`).
//
// Slice 2.11 retired the legacy busy.js queue + bottom busy-bar; the
// workflow chart's per-card spinner + queue-position badge are the
// user-visible surface for in-flight work now.

import { getState, update } from "./state.js";

// Optional workflow.js coupling for step-bound jobs (Phase 2 slice 2.4).
// queue.js stays self-contained when stepId isn't used; importing the
// workflow mirror only triggers when the caller binds a job to a step.
import {
  updateStepStatus, setStepResult, updateStepProgress,
  getStep, STEP_STATUS,
} from "./workflow.js";
import { projectStepIntoLegacyState } from "./workflow-projection.js";

// ── helpers ──────────────────────────────────────────────────────────

let nextSerial = 1;
function makeJobId() {
  // Short serial + random suffix so ids are stable across a session
  // but visibly distinct from validationRuns ids (which start with "vr-").
  return `job-${nextSerial++}-${Math.random().toString(36).slice(2, 6)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function getJobsSnapshot() {
  return getState().jobs || { byId: {}, order: [], runningId: null };
}

// Apply an immutable patch to state.jobs. Reads the current snapshot,
// merges the patch, and writes the result. Callers either pass a new
// `byId` map outright or use `patchJob(id, fields)` for single-job
// edits.
function patchJobs(partial) {
  const cur = getJobsSnapshot();
  update({ jobs: { ...cur, ...partial } });
}
function patchJob(id, fields) {
  const cur = getJobsSnapshot();
  const job = cur.byId[id];
  if (!job) return;
  const nextJob = { ...job, ...fields };
  update({
    jobs: {
      ...cur,
      byId: { ...cur.byId, [id]: nextJob },
    },
  });
}

// ── runner ───────────────────────────────────────────────────────────

// In-memory map of running-job AbortControllers + resolver/rejector
// hooks. Kept separate from state.jobs because functions + controllers
// don't survive structured-clone (we never persist them).
const runtime = new Map();    // id → { controller, resolve, reject, fn }

let draining = false;

async function processNext() {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const cur = getJobsSnapshot();
      // Already-running jobs hold the runner; new arrivals wait.
      if (cur.runningId) return;
      // Find the next pending job (in creation order).
      const nextId = cur.order.find(id => {
        const j = cur.byId[id];
        return j && j.status === "pending";
      });
      if (!nextId) return;
      const rt = runtime.get(nextId);
      if (!rt) {
        // Lost runtime — shouldn't happen, but skip cleanly rather than
        // wedge. Mark as failed so the user sees something.
        patchJob(nextId, {
          status:    "failed",
          error:     "runtime lost (job runtime entry missing)",
          startedAt: isoNow(),
          endedAt:   isoNow(),
        });
        continue;
      }

      // Transition to running.
      patchJob(nextId, { status: "running", startedAt: isoNow() });
      patchJobs({ runningId: nextId });
      // Mirror status onto a bound step (Phase 2 slice 2.4). Swallow
      // any error from the mirror — it shouldn't block the job from
      // running; worst case the chart shows a stale dot.
      const boundStepId = getJobsSnapshot().byId[nextId] && getJobsSnapshot().byId[nextId].stepId;
      if (boundStepId) {
        try { updateStepStatus(boundStepId, STEP_STATUS.RUNNING); }
        catch (e) { console.warn("[queue] step mirror (running) failed:", e); }
      }

      const ctx = {
        signal: rt.controller.signal,
        setPhase: (phase) => {
          // Only mutate if still running — late phase updates after
          // cancel / failure shouldn't move the job's display.
          const j = getJobsSnapshot().byId[nextId];
          if (!j || j.status !== "running") return;
          patchJob(nextId, { phase: phase || null });
          if (boundStepId) {
            try { updateStepProgress(boundStepId, { phase: phase || undefined }); }
            catch (_) {}
          }
        },
        setProgress: (fraction) => {
          const j = getJobsSnapshot().byId[nextId];
          if (!j || j.status !== "running") return;
          const f = Math.max(0, Math.min(1, Number(fraction) || 0));
          patchJob(nextId, { progress: f });
          if (boundStepId) {
            try { updateStepProgress(boundStepId, { fraction: f }); }
            catch (_) {}
          }
        },
      };

      // Stage the engine input for step-bound jobs. The queue is FIFO,
      // so by the time a child job runs its parent has already settled
      // and populated its result — project that ancestry into the legacy
      // slots (state._basePos / clusterLevels / …) so the engine reads
      // THIS branch's upstream, not whatever the user has since clicked
      // onto. This is what lets a card be queued while its parent is
      // still in-flight ("each branch owns its children"). Silent
      // (bumpRevision:false) so it doesn't pull the viewer off the card
      // the user is currently looking at; the engine lane bumps
      // engineRevision itself when it finishes. Only steps with a parent
      // consume upstream geometry — the data root doesn't.
      if (boundStepId) {
        const boundStep = getStep(boundStepId);
        if (boundStep && boundStep.parentId) {
          try { projectStepIntoLegacyState(boundStepId, { bumpRevision: false }); }
          catch (e) { console.warn("[queue] pre-run input staging failed:", e); }
        }
      }

      try {
        const result = await rt.fn(ctx);
        // Even after success, honour the cancel flag (caller may have
        // hit cancel during the resolve microtask).
        if (rt.controller.signal.aborted) {
          patchJob(nextId, { status: "cancelled", endedAt: isoNow() });
          patchJobs({ runningId: null });
          if (boundStepId) {
            try { updateStepStatus(boundStepId, STEP_STATUS.CANCELLED); }
            catch (_) {}
          }
          // Reject with AbortError so the promise consumer can react.
          rt.reject(abortError());
        } else {
          patchJob(nextId, { status: "done", result, endedAt: isoNow() });
          patchJobs({ runningId: null });
          if (boundStepId) {
            try { setStepResult(boundStepId, result); }
            catch (e) { console.warn("[queue] step mirror (setResult) failed:", e); }
            // Surface the result: auto-open the analysis card's panel (bottom
            // slot) so a completed dim-sweep / bootstrap / scoring / etc. shows
            // its table instead of needing a separate trip through the panel
            // picker. A no-op for non-analysis cards. Lazy import to keep the
            // queue decoupled from the panel system (and dodge any boot
            // init-order coupling). Fire-and-forget; never block the queue.
            import("./panel-system.js")
              .then(m => m.autoOpenPanelForStep(boundStepId))
              .catch(e => console.warn("[queue] auto-open panel failed:", e));
          }
          rt.resolve(result);
        }
      } catch (err) {
        const wasAborted = rt.controller.signal.aborted ||
                           (err && err.name === "AbortError");
        if (wasAborted) {
          patchJob(nextId, { status: "cancelled", endedAt: isoNow() });
          patchJobs({ runningId: null });
          if (boundStepId) {
            try { updateStepStatus(boundStepId, STEP_STATUS.CANCELLED); }
            catch (_) {}
          }
          rt.reject(abortError());
        } else {
          const errMsg = (err && (err.message || err.name)) || String(err);
          patchJob(nextId, {
            status: "failed",
            error:  errMsg,
            endedAt: isoNow(),
          });
          patchJobs({ runningId: null });
          if (boundStepId) {
            try { updateStepStatus(boundStepId, STEP_STATUS.FAILED, { error: errMsg }); }
            catch (_) {}
          }
          rt.reject(err);
        }
      } finally {
        // Drop runtime entry to release the controller + closures.
        runtime.delete(nextId);
      }
    }
  } finally {
    draining = false;
  }
}

function abortError() {
  if (typeof DOMException === "function") return new DOMException("aborted", "AbortError");
  const e = new Error("aborted"); e.name = "AbortError"; return e;
}

// ── public API ───────────────────────────────────────────────────────

/**
 * Enqueue a typed job. Returns the job id and a promise that settles
 * when this specific job finishes (resolves with fn's result; rejects
 * on failure or cancellation).
 *
 * @param {object} opts
 * @param {string} opts.type     Free string ("optimise", "save", "load",
 *                               "bootstrapStability", "dimSweep", …).
 *                               Used for filtering + per-type UI rendering.
 * @param {string} opts.label    Headline text for any UI surface.
 * @param {(ctx) => Promise<any>} opts.fn
 *                               Worker. Receives { signal, setPhase, setProgress }.
 *                               The signal aborts on cancelJob; the worker
 *                               must propagate (or check `signal.aborted`
 *                               at progress points) for cancel to take
 *                               effect mid-flight.
 * @param {string} [opts.stepId] Optional workflow-tree step id. When
 *                               set, the queue runner mirrors job
 *                               lifecycle onto the bound step:
 *                                  - running → updateStepStatus(stepId, "running")
 *                                  - done    → setStepResult(stepId, result)
 *                                  - failed  → updateStepStatus(stepId, "failed", {error})
 *                                  - cancel  → updateStepStatus(stepId, "cancelled")
 *                               Phase/progress are forwarded via
 *                               updateStepProgress so the chart can
 *                               render mid-flight feedback per-card.
 * @returns {{id: string, promise: Promise<any>}}
 */
export function enqueueJob({ type, label, fn, stepId = null }) {
  if (typeof fn !== "function") throw new Error("[queue] enqueueJob: fn must be a function");
  if (!type)  throw new Error("[queue] enqueueJob: type is required");
  if (!label) throw new Error("[queue] enqueueJob: label is required");
  // Validate the stepId up front (fail fast if the caller passes a bad
  // id) rather than discovering the issue inside the runner.
  if (stepId != null && !getStep(stepId)) {
    throw new Error(`[queue] enqueueJob: unknown stepId "${stepId}"`);
  }

  const id = makeJobId();
  const job = {
    id, type, label,
    stepId,
    status:    "pending",
    result:    null,
    error:     null,
    phase:     null,
    progress:  null,
    createdAt: isoNow(),
    startedAt: null,
    endedAt:   null,
  };

  // Persist the job + remember its runtime side-effects.
  const cur = getJobsSnapshot();
  update({
    jobs: {
      ...cur,
      byId:  { ...cur.byId, [id]: job },
      order: [...cur.order, id],
    },
  });

  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const controller = new AbortController();
  runtime.set(id, { controller, resolve, reject, fn });

  // Kick the drainer. Re-entry-safe; if draining is already running it
  // picks up this entry on the next iteration.
  processNext();

  return { id, promise };
}

/**
 * Cancel a job by id. If pending, marks cancelled and dequeues. If
 * running, fires the AbortController and the runner observes; the
 * job's fn must propagate `signal.aborted` for cancellation to take
 * effect mid-flight.
 *
 * @param {string} id
 * @returns {boolean}  true if the job was found and a cancel was
 *                     issued; false if the id was unknown or the job
 *                     was already settled.
 */
export function cancelJob(id) {
  const cur = getJobsSnapshot();
  const job = cur.byId[id];
  if (!job) return false;
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
    return false;
  }
  const rt = runtime.get(id);
  if (job.status === "pending") {
    // Mark cancelled immediately + reject the promise; the drainer
    // skips it next iteration because its status is no longer
    // "pending".
    patchJob(id, { status: "cancelled", endedAt: isoNow() });
    if (job.stepId) {
      try { updateStepStatus(job.stepId, STEP_STATUS.CANCELLED); }
      catch (_) {}
    }
    if (rt) {
      rt.reject(abortError());
      runtime.delete(id);
    }
    return true;
  }
  // Running. Abort the controller; the runner's catch/finally
  // observes signal.aborted and transitions status.
  if (rt) rt.controller.abort();
  return true;
}

/**
 * Snapshot of a single job, or null if the id is unknown.
 * @param {string} id
 * @returns {object | null}
 */
export function getJob(id) {
  const cur = getJobsSnapshot();
  return cur.byId[id] || null;
}

/**
 * List jobs in creation order, optionally filtered.
 *
 * @param {object} [filter]
 * @param {string} [filter.status]  exact status match
 * @param {string} [filter.type]    exact type match
 * @returns {object[]}              job snapshots in creation order
 */
export function listJobs(filter = {}) {
  const cur = getJobsSnapshot();
  const out = [];
  for (const id of cur.order) {
    const j = cur.byId[id];
    if (!j) continue;
    if (filter.status && j.status !== filter.status) continue;
    if (filter.type   && j.type   !== filter.type)   continue;
    out.push(j);
  }
  return out;
}

/**
 * Remove every settled (done / failed / cancelled) job from state.
 * Doesn't touch pending or running. Intended for "clear history" UX —
 * not called automatically.
 */
export function clearSettledJobs() {
  const cur = getJobsSnapshot();
  const keepById = {};
  const keepOrder = [];
  for (const id of cur.order) {
    const j = cur.byId[id];
    if (!j) continue;
    if (j.status === "pending" || j.status === "running") {
      keepById[id] = j;
      keepOrder.push(id);
    }
  }
  update({
    jobs: {
      byId:      keepById,
      order:     keepOrder,
      runningId: cur.runningId,
    },
  });
}

/**
 * For tests + diagnostics only. Returns the number of in-memory
 * runtime entries (AbortControllers + resolve/reject hooks). Should
 * always equal the count of pending + running jobs.
 */
export function _runtimeSize() {
  return runtime.size;
}
