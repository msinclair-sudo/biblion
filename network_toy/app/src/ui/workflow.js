// Workflow tree — first-class store for the branching DAG of analysis
// cards. Phase 2 slice 2.1 of the workflow-tree-redesign.
//
// Self-contained module. Owns `state.workflow` end-to-end:
//   - All reads go through the read API (getStep / listSteps / etc.).
//   - All mutations go through the CRUD API (createStep / setStepResult
//     / deleteStep / etc.). Invariants are maintained internally.
//   - The Step shape (documented in state.js) is the boundary contract.
//
// Invariants this module enforces:
//   I1. Only one root (parentId === null) per workflow.
//   I2. Every parentId points to an existing step.
//   I3. childIds reflect actual children — adding a step appends to
//       its parent.childIds; deleting removes.
//   I4. refIds point to existing steps (no dangling).
//   I5. Status transitions are valid: pending → running → done/failed/cancelled,
//       pending → cancelled. Done/failed/cancelled are terminal.
//   I6. `revision` is monotonically non-decreasing per step; bumped only
//       by setStepResult.
//   I7. Deleting a step cascades to all descendants (children +
//       transitively); refIds pointing to deleted steps are cleaned out
//       on the survivors.
//
// What this module does NOT do (intentionally — separation of concerns):
//   - It doesn't RUN jobs. Slice 2.4 binds queue.js jobs to steps.
//   - It doesn't RENDER. Slice 2.3 rewrites workflow-chart.js to read
//     from this module's API.
//   - It doesn't MIGRATE legacy state. Slice 2.2 builds a separate
//     migration helper that calls this module's createStep + setStepResult.
//   - It doesn't TOUCH the legacy `state.layerParams` / `dimredResult`
//     / etc. slots. Slice 2.7 builds the back-compat projection layer
//     that syncs those from the selected card's ancestry.

import { getState, update } from "./state.js";

// ── constants ────────────────────────────────────────────────────────

export const STEP_STATUS = Object.freeze({
  PENDING:   "pending",
  RUNNING:   "running",
  DONE:      "done",
  FAILED:    "failed",
  CANCELLED: "cancelled",
});

const TERMINAL_STATUSES = new Set([
  STEP_STATUS.DONE, STEP_STATUS.FAILED, STEP_STATUS.CANCELLED,
]);

// Valid status transitions. Source status → set of allowed targets.
const TRANSITIONS = {
  [STEP_STATUS.PENDING]:   new Set([STEP_STATUS.RUNNING, STEP_STATUS.CANCELLED]),
  [STEP_STATUS.RUNNING]:   new Set([STEP_STATUS.DONE, STEP_STATUS.FAILED, STEP_STATUS.CANCELLED]),
  [STEP_STATUS.DONE]:      new Set(),                                              // terminal
  [STEP_STATUS.FAILED]:    new Set(),                                              // terminal
  [STEP_STATUS.CANCELLED]: new Set(),                                              // terminal
};

// ── id generation ────────────────────────────────────────────────────

let nextSerial = 1;
function makeStepId(type) {
  // Short-readable id. Type prefix so logs are scannable; serial keeps
  // them globally unique within a session; random suffix avoids
  // collisions across migrated tree imports.
  return `step-${type}-${nextSerial++}-${Math.random().toString(36).slice(2, 5)}`;
}

function isoNow() {
  return new Date().toISOString();
}

// ── internal: read raw workflow ──────────────────────────────────────

function getWorkflow() {
  return getState().workflow || { steps: {}, rootId: null, selected: null };
}

function getStepRaw(id) {
  return getWorkflow().steps[id] || null;
}

// Apply an immutable patch to state.workflow. Reads, merges, writes.
// Callers either supply a new `steps` map outright or use the
// per-step helper below.
function patchWorkflow(partial) {
  const cur = getWorkflow();
  update({ workflow: { ...cur, ...partial } });
}
function patchStep(id, fields) {
  const cur = getWorkflow();
  const step = cur.steps[id];
  if (!step) return;
  update({
    workflow: {
      ...cur,
      steps: { ...cur.steps, [id]: { ...step, ...fields } },
    },
  });
}
function patchSteps(updates) {
  // updates: { [id]: fieldsToMerge } — multiple steps in one update().
  const cur = getWorkflow();
  const nextSteps = { ...cur.steps };
  for (const [id, fields] of Object.entries(updates)) {
    if (!nextSteps[id]) continue;
    nextSteps[id] = { ...nextSteps[id], ...fields };
  }
  update({ workflow: { ...cur, steps: nextSteps } });
}

// ── read API ─────────────────────────────────────────────────────────

/**
 * Snapshot of one step, or null if id is unknown.
 * @param {string} id
 * @returns {Step | null}
 */
export function getStep(id) {
  return getStepRaw(id);
}

/**
 * Root step (parentId === null), or null if the workflow is empty.
 * @returns {Step | null}
 */
export function getRootStep() {
  const w = getWorkflow();
  return w.rootId ? (w.steps[w.rootId] || null) : null;
}

/**
 * Currently-selected step, or null if no selection.
 * @returns {Step | null}
 */
export function getSelectedStep() {
  const w = getWorkflow();
  return w.selected ? (w.steps[w.selected] || null) : null;
}

/**
 * Direct children of a step (in childIds order). Empty array if step
 * has no children or doesn't exist.
 * @param {string} id
 * @returns {Step[]}
 */
export function getStepChildren(id) {
  const step = getStepRaw(id);
  if (!step) return [];
  const w = getWorkflow();
  return step.childIds.map(cid => w.steps[cid]).filter(Boolean);
}

/**
 * Ancestor chain from the root down to the given step (inclusive of
 * step itself at the end). Empty if id unknown.
 * @param {string} id
 * @returns {Step[]}
 */
export function getStepAncestors(id) {
  const w = getWorkflow();
  const out = [];
  let cur = w.steps[id];
  while (cur) {
    out.unshift(cur);
    cur = cur.parentId ? w.steps[cur.parentId] : null;
  }
  return out;
}

/**
 * Find the committed clusterLevels[] nearest to `id` by walking up its
 * lineage (the step itself first, then ancestors, deepest → shallowest) for
 * the first step whose result carries a non-empty clusterLevels. Lets cards
 * downstream of an intervening analysis card (e.g. labelling/scoring below an
 * inserted bridge card) still resolve their ladder without assuming a fixed
 * parent hop. Returns { levels, stepId } or { levels: [], stepId: null }.
 * @param {string} id
 */
export function findClusterLevels(id) {
  const lineage = getStepAncestors(id);   // root → id
  for (let i = lineage.length - 1; i >= 0; i--) {
    const r = lineage[i].result;
    if (r && Array.isArray(r.clusterLevels) && r.clusterLevels.length) {
      return { levels: r.clusterLevels, stepId: lineage[i].id };
    }
  }
  return { levels: [], stepId: null };
}

/**
 * All descendants of a step (BFS). Excludes the step itself.
 * @param {string} id
 * @returns {Step[]}
 */
export function getStepDescendants(id) {
  const w = getWorkflow();
  const start = w.steps[id];
  if (!start) return [];
  const out = [];
  const queue = [...start.childIds];
  while (queue.length > 0) {
    const cid = queue.shift();
    const c = w.steps[cid];
    if (!c) continue;
    out.push(c);
    queue.push(...c.childIds);
  }
  return out;
}

/**
 * List steps in creation order (root first, then BFS). Optionally
 * filter by status and/or type.
 * @param {object} [filter]
 * @param {string} [filter.status]
 * @param {string} [filter.type]
 * @returns {Step[]}
 */
export function listSteps(filter = {}) {
  const w = getWorkflow();
  if (!w.rootId) return [];
  const out = [];
  const seen = new Set();
  const queue = [w.rootId];
  // BFS the whole tree. Filter applies only to OUTPUT membership —
  // traversal must continue through non-matching nodes so we still
  // visit their (potentially matching) descendants.
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const step = w.steps[id];
    if (!step) continue;
    const matchesStatus = !filter.status || step.status === filter.status;
    const matchesType   = !filter.type   || step.type   === filter.type;
    if (matchesStatus && matchesType) out.push(step);
    queue.push(...step.childIds);
  }
  return out;
}

/**
 * Computed stale flag: a step is stale when its parent's revision
 * differs from the upstreamRevision stamped at this step's
 * most-recent result-set. Root steps are never stale (no upstream
 * to compare). Steps with no result yet (status pending / running /
 * failed / cancelled) are not stale.
 *
 * Stale propagates through one level only — when the user re-runs
 * the stale step, its descendants' stale flags then need
 * recomputing (which happens automatically because revision /
 * upstreamRevision are reads, not stored flags).
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isStepStale(id) {
  const w = getWorkflow();
  const step = w.steps[id];
  if (!step) return false;
  if (step.status !== STEP_STATUS.DONE) return false;
  if (step.parentId == null) return false;
  const parent = w.steps[step.parentId];
  if (!parent) return false;
  if (step.upstreamRevision == null) return false;
  return parent.revision !== step.upstreamRevision;
}

// ── CRUD API ─────────────────────────────────────────────────────────

/**
 * Create a new step. Returns the new step id.
 *
 * @param {object} opts
 * @param {string} opts.type      Step type ("data" / "dimred" / "clustering" / ...).
 *                                Free string; validated for non-emptiness only.
 * @param {string} opts.label     Display label.
 * @param {object} [opts.params={}]
 * @param {string|null} [opts.parentId=null]
 *                                Parent step id. Required for non-root creation.
 *                                If null AND the workflow has no root yet, the
 *                                new step becomes the root. If null AND a root
 *                                exists, throws.
 * @param {string[]} [opts.refIds=[]]
 *                                Cross-edges to other steps (e.g. fusion-comparison
 *                                referencing two clusterings). All ids must exist.
 * @returns {string}              The new step id.
 * @throws {Error}                If parentId is unknown, refIds contain unknown
 *                                ids, parentId is null when a root already exists,
 *                                or required fields are missing.
 */
export function createStep(opts = {}) {
  const { type, label, params = {}, parentId = null, refIds = [] } = opts;

  if (!type || typeof type !== "string") {
    throw new Error("[workflow] createStep: type is required (non-empty string)");
  }
  if (typeof label !== "string" || label.length === 0) {
    throw new Error("[workflow] createStep: label is required (non-empty string)");
  }
  if (!Array.isArray(refIds)) {
    throw new Error("[workflow] createStep: refIds must be an array of step ids");
  }

  const w = getWorkflow();

  // I1: only one root per workflow.
  if (parentId == null && w.rootId != null) {
    throw new Error(`[workflow] createStep: root already exists (${w.rootId}); provide parentId for non-root creation`);
  }
  // I2: parentId must point at an existing step (if provided).
  if (parentId != null && !w.steps[parentId]) {
    throw new Error(`[workflow] createStep: unknown parentId "${parentId}"`);
  }
  // I4: every refId must exist.
  for (const rid of refIds) {
    if (!w.steps[rid]) {
      throw new Error(`[workflow] createStep: unknown refId "${rid}"`);
    }
  }

  const id = makeStepId(type);
  const newStep = {
    id, type, label,
    params:   { ...params },
    parentId,
    childIds: [],
    refIds:   [...refIds],

    status:           STEP_STATUS.PENDING,
    result:           null,
    error:            null,
    revision:         0,
    upstreamRevision: null,

    progress:   null,
    runtimeSec: null,

    createdAt: isoNow(),
    startedAt: null,
    endedAt:   null,
  };

  const nextSteps = { ...w.steps, [id]: newStep };
  // I3: append to parent's childIds (when there is a parent).
  if (parentId != null) {
    const parent = nextSteps[parentId];
    nextSteps[parentId] = { ...parent, childIds: [...parent.childIds, id] };
  }
  update({
    workflow: {
      ...w,
      steps:    nextSteps,
      rootId:   w.rootId || id,
      // selected stays as-is; caller chooses whether to selectStep(id).
    },
  });
  return id;
}

/**
 * Transition a step's status. Validates the transition; throws if
 * invalid (e.g. done → running).
 *
 * @param {string} id
 * @param {string} newStatus      One of STEP_STATUS values.
 * @param {object} [extras]
 * @param {string} [extras.error] Stamped when newStatus === "failed".
 * @returns {void}
 * @throws {Error}                If id unknown or transition invalid.
 */
export function updateStepStatus(id, newStatus, extras = {}) {
  const step = getStepRaw(id);
  if (!step) throw new Error(`[workflow] updateStepStatus: unknown id "${id}"`);
  const allowed = TRANSITIONS[step.status];
  if (!allowed || !allowed.has(newStatus)) {
    throw new Error(`[workflow] updateStepStatus: invalid transition ${step.status} → ${newStatus} (id: ${id})`);
  }
  const fields = { status: newStatus };
  if (newStatus === STEP_STATUS.RUNNING) {
    fields.startedAt = isoNow();
  }
  if (TERMINAL_STATUSES.has(newStatus)) {
    fields.endedAt = isoNow();
    if (step.startedAt) {
      fields.runtimeSec = (Date.parse(fields.endedAt) - Date.parse(step.startedAt)) / 1000;
    }
  }
  if (newStatus === STEP_STATUS.FAILED && extras && typeof extras.error === "string") {
    fields.error = extras.error;
  }
  patchStep(id, fields);
}

/**
 * Update mid-flight progress. Caller-supplied phase + fraction land
 * on the step; the renderer reads them. No-op if the step isn't
 * currently running.
 *
 * @param {string} id
 * @param {object} progress
 * @param {string} [progress.phase]     Free-text phase label.
 * @param {number} [progress.fraction]  0..1 progress fraction.
 * @returns {void}
 */
export function updateStepProgress(id, progress) {
  const step = getStepRaw(id);
  if (!step || step.status !== STEP_STATUS.RUNNING) return;
  const next = { ...(step.progress || {}) };
  if (progress && typeof progress.phase === "string") next.phase = progress.phase;
  if (progress && Number.isFinite(progress.fraction)) {
    next.fraction = Math.max(0, Math.min(1, progress.fraction));
  }
  patchStep(id, { progress: next });
}

/**
 * Set a step's result. Transitions status running → done, bumps
 * revision, stamps parent's revision into upstreamRevision (for the
 * stale-on-upstream-change check).
 *
 * Only valid when status is "running" — the runner calls this when
 * its fn resolves. If the caller wants to record a failed run, use
 * updateStepStatus(id, "failed", {error}).
 *
 * @param {string} id
 * @param {any} result            Anything — payload travels with the
 *                                save .zip via the existing TypedArray
 *                                deep-walker.
 * @returns {void}
 * @throws {Error}                If id unknown or status isn't "running".
 */
export function setStepResult(id, result) {
  const step = getStepRaw(id);
  if (!step) throw new Error(`[workflow] setStepResult: unknown id "${id}"`);
  if (step.status !== STEP_STATUS.RUNNING) {
    throw new Error(`[workflow] setStepResult: status must be "running", got "${step.status}" (id: ${id})`);
  }
  const w = getWorkflow();
  const parent = step.parentId ? w.steps[step.parentId] : null;
  const parentRev = parent ? parent.revision : null;

  const endedAt = isoNow();
  const runtimeSec = step.startedAt
    ? (Date.parse(endedAt) - Date.parse(step.startedAt)) / 1000
    : null;

  patchStep(id, {
    status:           STEP_STATUS.DONE,
    result,
    error:            null,
    revision:         step.revision + 1,
    upstreamRevision: parentRev,
    endedAt,
    runtimeSec,
  });
}

/**
 * Re-arm a step for an in-place re-run (the ⚙ gear "edit this card"
 * path). Unlike re-run-as-fork, this keeps the step's id, parentId,
 * childIds and refIds — only its params/label are updated and its run
 * state is reset to pending so a fresh job can be bound to the SAME card.
 *
 * Revision is intentionally NOT reset: the next setStepResult bumps it,
 * which is what marks the (kept) children stale so the user knows to
 * re-run them.
 *
 * Allowed from any status (an explicit user edit), so it bypasses the
 * normal transition guard.
 *
 * @param {string} id
 * @param {object} [opts]
 * @param {object} [opts.params]  New params (replaces the old params).
 * @param {string} [opts.label]   New display label.
 * @returns {void}
 * @throws {Error}                If id is unknown.
 */
export function rearmStep(id, opts = {}) {
  const step = getStepRaw(id);
  if (!step) throw new Error(`[workflow] rearmStep: unknown id "${id}"`);
  const fields = {
    status:     STEP_STATUS.PENDING,
    result:     null,
    error:      null,
    progress:   null,
    startedAt:  null,
    endedAt:    null,
    runtimeSec: null,
  };
  if (opts.params != null) fields.params = { ...opts.params };
  if (typeof opts.label === "string" && opts.label) fields.label = opts.label;
  // refIds (cross-edges, e.g. a comparison card's two clusterings) can
  // change when the card is re-targeted. Only touch them if supplied.
  if (Array.isArray(opts.refIds)) {
    const w = getWorkflow();
    fields.refIds = opts.refIds.filter(rid => w.steps[rid]);
  }
  patchStep(id, fields);
}

/**
 * Set a 1–5 score on a scoring card. Scores live ON the card (per the
 * agreed data model — they travel with the branch, not a global store),
 * under result.scores[levelUid][clusterId]. value === null unsets it.
 *
 * Does NOT bump revision (scores aren't upstream data — changing them
 * mustn't mark children stale) and doesn't touch status.
 *
 * @param {string} id            Scoring card step id.
 * @param {string} levelUid
 * @param {number} clusterId
 * @param {number|null} value    1..5, or null to clear.
 * @returns {void}
 */
export function setCardScore(id, levelUid, clusterId, value) {
  const step = getStepRaw(id);
  if (!step || !step.result) return;
  const scores = { ...(step.result.scores || {}) };
  const lvl = { ...(scores[levelUid] || {}) };
  if (value == null) delete lvl[clusterId];
  else lvl[clusterId] = value;
  scores[levelUid] = lvl;
  patchStep(id, { result: { ...step.result, scores } });
}

/**
 * Set the currently-selected step. selectStep(null) clears the
 * selection. Pass an unknown id and the call is a silent no-op (no
 * throw — the renderer may race a delete).
 *
 * @param {string | null} id
 * @returns {void}
 */
export function selectStep(id) {
  const w = getWorkflow();
  if (id != null && !w.steps[id]) return;
  patchWorkflow({ selected: id });
}

/**
 * Delete a step and ALL descendants. refIds on surviving steps that
 * pointed at any deleted step get pruned automatically.
 *
 * If the deleted set includes the root, the workflow becomes empty
 * (rootId → null, selected → null).
 *
 * If the deleted set includes the currently-selected step,
 * `selected` falls back to the step's parent (or null if no parent
 * survived).
 *
 * @param {string} id
 * @returns {string[]}            List of step ids that were deleted
 *                                (including the requested one). Empty
 *                                array if id was unknown.
 */
export function deleteStep(id) {
  const w = getWorkflow();
  const start = w.steps[id];
  if (!start) return [];

  // Collect deletion set via BFS.
  const toDelete = new Set([id]);
  const queue = [...start.childIds];
  while (queue.length > 0) {
    const cid = queue.shift();
    if (toDelete.has(cid)) continue;
    toDelete.add(cid);
    const c = w.steps[cid];
    if (c) queue.push(...c.childIds);
  }

  // Build the survivor map: drop deleted steps, prune refIds + childIds
  // on survivors so they can't dangle into the deleted set.
  const nextSteps = {};
  for (const [sid, s] of Object.entries(w.steps)) {
    if (toDelete.has(sid)) continue;
    const cleanedChildIds = s.childIds.filter(cid => !toDelete.has(cid));
    const cleanedRefIds   = s.refIds.filter(rid => !toDelete.has(rid));
    nextSteps[sid] = {
      ...s,
      childIds: cleanedChildIds.length === s.childIds.length ? s.childIds : cleanedChildIds,
      refIds:   cleanedRefIds.length   === s.refIds.length   ? s.refIds   : cleanedRefIds,
    };
  }

  // Rebind rootId if the root was deleted.
  let nextRoot = w.rootId;
  if (nextRoot && toDelete.has(nextRoot)) nextRoot = null;

  // Rebind selected if the selected step was deleted: fall back to the
  // deleted step's parent (if it survived), else null.
  let nextSelected = w.selected;
  if (nextSelected && toDelete.has(nextSelected)) {
    nextSelected = start.parentId && !toDelete.has(start.parentId) ? start.parentId : null;
  }

  update({
    workflow: {
      steps:    nextSteps,
      rootId:   nextRoot,
      selected: nextSelected,
    },
  });
  return [...toDelete];
}

/**
 * Diagnostic: wipe the entire workflow. Used in tests + migrations.
 * Does NOT touch the legacy state slots (layerParams, clusterLevels,
 * etc.) — Slice 2.7's projection layer owns that side.
 */
export function clearWorkflow() {
  update({ workflow: { steps: {}, rootId: null, selected: null } });
}

/**
 * Install a workflow tree wholesale (project load). Sets state.workflow
 * to the supplied tree and advances the module-local serial counter past
 * the highest serial embedded in the loaded step ids — otherwise a
 * post-load createStep would re-issue an id already present in the
 * restored tree and silently overwrite a card.
 *
 * @param {{steps: object, rootId: string|null, selected: string|null}} workflow
 * @returns {void}
 */
export function importWorkflow(workflow) {
  const wf = workflow && typeof workflow === "object"
    ? workflow
    : { steps: {}, rootId: null, selected: null };
  const steps = wf.steps || {};
  let maxSerial = 0;
  for (const id of Object.keys(steps)) {
    // id shape: step-<type>-<serial>-<suffix>. The serial is the numeric
    // segment; type may itself contain hyphens, so scan all numeric parts
    // and take the largest rather than assuming a fixed index.
    for (const part of id.split("-")) {
      if (/^\d+$/.test(part)) {
        const n = Number(part);
        if (n > maxSerial) maxSerial = n;
      }
    }
  }
  if (maxSerial >= nextSerial) nextSerial = maxSerial + 1;
  update({
    workflow: {
      steps,
      rootId:   wf.rootId ?? null,
      selected: wf.selected ?? null,
    },
  });
}
