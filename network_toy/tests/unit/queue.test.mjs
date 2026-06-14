// Node-native unit tests for app/src/ui/queue.js — the typed-job FIFO queue.
//
// This is the SPIKE for the pure-logic test tier (audit, 2026-06-14): queue.js
// is a pure ES module (its only eager deps — state.js / workflow.js /
// workflow-projection.js — are pure too; panel-system.js is lazy-imported and
// only for step-bound jobs, which these tests don't use). So it runs directly
// under Node's built-in test runner: no Playwright, no http.server, no Chromium,
// no 60-90s real-data session, no inline-JS-in-a-string. Real imports, real
// stack traces, milliseconds.
//
//   node --test tests/unit/            # whole tier
//   node --test tests/unit/queue.test.mjs
//
// Ports tests/test_queue.py 1:1 (and tightens a couple of assertions that the
// Playwright version had to loosen because it shared one mutable session — here
// each test starts from a clean jobs slot via beforeEach).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as q from "../../app/src/ui/queue.js";
import { getState, update } from "../../app/src/ui/state.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each test starts from an empty jobs slot. All tests below await their jobs to
// completion, so queue.js's internal runtime map / drain flag are clear by here.
beforeEach(() => {
  update({ jobs: { byId: {}, order: [], runningId: null } });
});

test("enqueue happy path: result, phase, progress, timestamps", async () => {
  const { id, promise } = q.enqueueJob({
    type: "smoke-happy",
    label: "happy path",
    fn: async (ctx) => {
      ctx.setPhase("step-1");
      await sleep(50);
      ctx.setProgress(0.5);
      ctx.setPhase("step-2");
      await sleep(50);
      return { ok: true, n: 42 };
    },
  });
  const result = await promise;
  const done = getState().jobs.byId[id];

  assert.deepEqual(result, { ok: true, n: 42 });
  assert.equal(done.status, "done");
  assert.deepEqual(done.result, { ok: true, n: 42 });
  assert.equal(done.phase, "step-2");
  assert.equal(done.progress, 0.5);
  assert.ok(done.startedAt && done.endedAt);
});

test("listJobs filters by status and type", async () => {
  const a = q.enqueueJob({ type: "x", label: "x", fn: async () => 1 });
  const b = q.enqueueJob({ type: "y", label: "y", fn: async () => 2 });
  await Promise.all([a.promise, b.promise]);

  assert.equal(q.listJobs().length, 2);
  assert.equal(q.listJobs({ status: "done" }).length, 2);
  assert.equal(q.listJobs({ type: "x" }).length, 1);
  assert.equal(q.listJobs({ type: "nope" }).length, 0);
});

test("FIFO single worker: second job waits for the first", async () => {
  const a = q.enqueueJob({
    type: "fifo", label: "first",
    fn: async () => { await sleep(200); return "a"; },
  });
  const b = q.enqueueJob({
    type: "fifo", label: "second",
    fn: async () => { await sleep(50); return "b"; },
  });
  await sleep(30);
  const snap = getState().jobs;

  assert.equal(snap.byId[a.id].status, "running");
  assert.equal(snap.byId[b.id].status, "pending");
  assert.equal(await a.promise, "a");
  assert.equal(await b.promise, "b");
});

test("cancel a pending job: dequeued, promise rejects AbortError", async () => {
  const a = q.enqueueJob({
    type: "blocker", label: "blocker",
    fn: async () => { await sleep(200); return "a"; },
  });
  const b = q.enqueueJob({
    type: "cancel-me", label: "cancel-me",
    fn: async () => "b-should-never-run",
  });
  const cancelled = q.cancelJob(b.id);

  let bResult = "(unset)";
  try { await b.promise; bResult = "resolved (BAD)"; }
  catch (e) { bResult = e.name; }
  await a.promise;

  assert.equal(cancelled, true);
  assert.equal(getState().jobs.byId[b.id].status, "cancelled");
  assert.equal(bResult, "AbortError");
});

test("cancel a running job: abort signal observed, status cancelled", async () => {
  const a = q.enqueueJob({
    type: "abortable", label: "abortable",
    fn: async (ctx) => {
      for (let i = 0; i < 100; i++) {
        if (ctx.signal.aborted) {
          const e = new Error("aborted"); e.name = "AbortError"; throw e;
        }
        await sleep(30);
      }
      return "ran-too-long";
    },
  });
  await sleep(50);
  const cancelOk = q.cancelJob(a.id);

  let result = "(unset)";
  try { await a.promise; result = "resolved (BAD)"; }
  catch (e) { result = e.name; }

  assert.equal(cancelOk, true);
  assert.equal(getState().jobs.byId[a.id].status, "cancelled");
  assert.equal(result, "AbortError");
});

test("a failing job propagates; the queue keeps draining", async () => {
  const a = q.enqueueJob({
    type: "fail", label: "failer",
    fn: async () => { throw new Error("boom"); },
  });
  const b = q.enqueueJob({
    type: "after-fail", label: "after-failer",
    fn: async () => "still works",
  });

  let aErr = null;
  try { await a.promise; } catch (e) { aErr = e.message; }
  const br = await b.promise;

  assert.equal(aErr, "boom");
  assert.equal(getState().jobs.byId[a.id].status, "failed");
  assert.equal(getState().jobs.byId[a.id].error, "boom");
  assert.equal(br, "still works");
  assert.equal(getState().jobs.byId[b.id].status, "done");
});

test("clearSettledJobs drops settled, keeps running + pending", async () => {
  await q.enqueueJob({ type: "x", label: "done1", fn: async () => 1 }).promise;
  const slow = q.enqueueJob({
    type: "x", label: "running",
    fn: async () => { await sleep(200); return "slow"; },
  });
  const pending = q.enqueueJob({
    type: "x", label: "still pending",
    fn: async () => "pending",
  });

  // clean slate per test, so exactly 3 jobs exist: done1 + running + pending.
  assert.equal(getState().jobs.order.length, 3);
  q.clearSettledJobs();
  assert.equal(getState().jobs.order.length, 2);   // only running + pending remain

  await slow.promise;
  await pending.promise;
});
