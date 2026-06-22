# Enrich redesign — handoff

Status as of 2026-06-21. This documents the read-once / compute / dumb-write
enrich rebuild: what's built, what's the default, the one open bug, and how to
continue. Companion plan: `plans/enrich-redesign-plan.md`. Live progress notes
also in agent memory (`enrich-redesign-progress.md`).

---

## TL;DR

- The **new enrich design is the operational default**. `biblion enrich` runs the
  new pipeline; `BIBLION_LEGACY_ENRICH=1` reverts to the old one. **Legacy code is
  still present as a fallback** (not yet deleted — that's "Step 3").
- Phases 0–7 of the plan are built + unit/integration tested: **632 tests green**
  (608 unit, 21 perf, ~9 integration... run `pytest` to confirm exact counts).
- It's been **validated on real fallworm + live APIs** and works (correct
  topology, bounded growth, seeds get metadata, ghosts get DOIs only).
- **~~OPEN BUG~~ FIXED (2026-06-21):** the pure writer crashed on a stale-snapshot
  UNIQUE-identifier collision in the single-hit UPDATE path → crash-loops →
  stalled progress. Now self-heals by escalating to a merge. See "Resolved bug"
  below. Re-validation on a fresh fallworm run is the remaining gate before Step 3.

---

## What the redesign is

Old pipeline: the merge **writer reads the DB to decide where to write**
(`_batch_lookup` probes papers/identifiers for every record + citation endpoint),
and a separate **Resolver** deletes+re-homes rows for multi-hit dedup — both
contending for the single SQLite write lock.

New pipeline:
```
producers/handlers ─push─→ Redis ─→ Compute (reads, classifies) ─→ write:jobs ─→ Writer (apply-only) ─→ SQLite
        dispatcher (Reader+Solver, owns dirty-set + in-flight)            alias-dedup (no delete)        ↺ dirty:papers
```
- **Reader** (`biblion/enrich/reader.py`): one read-once scan over a dirty-set of
  paper ids → `WorkItem` (presence bitmask + attempted matrix + `needs`).
  `NEEDS_SPEC` is the Python re-expression of `framework/claims.py:CANDIDATE_QUERIES`
  (kept in lockstep — shadow-parity tested).
- **Solver** (`enrich/solver.py`) + **Catalogue** (`enrich/catalogue.py`): greedy
  max-coverage (Gate 1) → provider/budget (Gate 2) → routing decisions.
- **Dispatcher** (`enrich/dispatcher.py`): single process, embeds Reader+Solver,
  owns the in-RAM in-flight set (+ persisted `claimed` rows), calls thin
  **handlers** (`enrich/handlers/*.py`) which wrap the API clients and return
  `HandlerResult(papers, citations, succeeded, failed)`. Handlers reuse the legacy
  modules' parsing helpers.
- **Compute** (`enrich/compute.py`): does the (bottleneck) `_batch_lookup`
  classification off the write path; emits `WritePaperJob`/`WriteEdgeJob`/
  `WritePendingEdgeJob`.
- **Writer apply-only** (`merge/writer.py:_apply_write_jobs`): applies write-jobs,
  reusing `_insert_new`/`_apply_single_hit`/`_apply_merge_plan` verbatim. Pure
  mode = no `_batch_lookup` on the write path.
- **Alias-dedup** (`enrich/dedup.py` + writer `_apply_merge_plan`): multi-hits
  tombstone+alias losers onto a winner (no delete, no edge re-home) via the
  `aliases` union-find (`merge/aliasmap.py`). Replaces the Resolver.
- **Compaction** (`enrich/compaction.py`, `biblion advanced compact`): offline,
  rewrites aliased edges to winners + drops tombstoned losers.

---

## How to run it

Defaults to the new system — just:
```bash
biblion enrich          # dispatcher + compute + pure-writer + alias-dedup; no Resolver
biblion import <file>   # ingest via new pipeline (writer pure + compute)
biblion search <json>   # rebuild from S2 search; auto-marks hits is_seed=1
```

**Mode flags** (all default to the new design unless `BIBLION_LEGACY_ENRICH=1`):

| env | effect |
|---|---|
| `BIBLION_LEGACY_ENRICH=1` | full revert: legacy producers + Resolver + read-to-decide writer |
| `BIBLION_PURE_WRITER=0/1` | writer apply-only vs read-to-decide (override) |
| `BIBLION_ALIAS_DEDUP=0/1` | inline alias-dedup vs park-for-Resolver (override) |
| `BIBLION_DISPATCH_ENDPOINTS=<csv>` | narrow the dispatcher to specific endpoints |

The supervisor (`__main__.py` `cmd_daemon` / `_ensure_merge_daemons`) injects the
resolved `BIBLION_PURE_WRITER`/`BIBLION_ALIAS_DEDUP` into spawned subprocesses;
a directly-constructed `MergeWriter` still defaults to legacy (so unit tests are
unaffected).

**Default `enrich` dispatch set** = `ENRICH_PRODUCERS ∩ handlers` **plus**
`expand_papers_s2_seeds` (the bounded seed hop for refs+cites). See
`__main__.py:_effective_dispatch()`. Deliberately **excludes** the broad
`expand_papers_s2` (hops ghosts → unbounded BFS) and `enrich_stubs_oa`
(metadata-fills ghosts) — those belong to `hop`/`bulk`. `resolve_pending_dois`
and `materialize_ghost_stubs` stay as producers (not handler endpoints).

---

## Resolved bug (was the Step 3 blocker) — fixed 2026-06-21

**Pure-writer stale-snapshot UNIQUE collision → crash-loop.**

`compute` classified a record as a single-hit update (its `oa_id`/`doi` looked new
at scan time). Between compute and apply, that identifier got inserted on another
paper. At apply time `_apply_single_hit` did `UPDATE papers SET oa_id=…` →
`sqlite3.IntegrityError: UNIQUE constraint failed: papers.oa_id` → writer crashed,
supervisor restarted it on the same poison job → progress stalled. (The INSERT
path already self-healed via `_insert_or_update`; the single-hit UPDATE path
didn't.) Surfaced more by the `resolve_oa` bridge fix (records now carry
`s2_id`+`oa_id`, matching two papers more often).

**Fix applied** (`merge/writer.py`): a colliding record is *evidence two rows are
the same paper* (it carries both ids), so the writer self-corrects. New
`_single_hit_or_merge()` wraps each single-hit in a `SAVEPOINT`; on `IntegrityError`
it rolls back the partial single-hit and calls `_merge_stale_collision()`, which
`_batch_lookup`s the record's identifiers, `plan_merge`s the cluster (incl. the
original target), `_apply_merge_plan`s it (losers tombstoned + their ids NULLed, so
the colliding id is freed onto the winner), then re-applies the record onto the
winner — which can no longer collide. Every `_apply_single_hit` site in
`_apply_write_jobs` and the `_insert_or_update` fallback routes through it; the
helper owns the conflicts/updated/merged stat accounting. Regression test:
`tests/unit/test_pure_writer.py::TestApplyOnly::test_stale_single_hit_collision_merges`
(verified it reproduces the `IntegrityError` crash with the recovery stubbed out).
609 unit tests green.

**Still pending before Step 3:** re-validate on a fresh fallworm rebuild (refs/cites
coverage jumps, ghosts stay lean, 0 orphans, no cascade, no crash). Until then
`BIBLION_LEGACY_ENRICH=1` remains the safe fallback.

---

## Bugs found + fixed during validation (all committed in working tree)

1. **All-handlers cascade** — `_effective_dispatch` dispatched all 12 handlers
   incl. the broad `expand_papers_s2`, which hopped ghosts → fallworm exploded
   5,153→20,982 papers. Fixed: dispatch only `ENRICH_PRODUCERS∩handlers` +
   `expand_papers_s2_seeds`.
2. **Orphaned daemons on abort** — supervisor's startup death-check `return`/`raise`
   left already-spawned daemons running. Fixed: kill spawned on abort
   (`cmd_daemon` + `_ensure_merge_daemons`).
3. **`search` didn't mark seeds** — module docstring claimed the writer set
   `is_seed` but nothing did. Fixed: `cmd_search` flags hits `is_seed=1` by
   provenance (`s2_search_factorial:` prefix) after drain, and calls
   `cache.clear_dirty_seeded()` so the next `enrich` re-scans.
4. **Search checkpoints not namespaced** — `search:s2:ckpt:*` used the raw Redis
   key → collide across projects / stale on rebuild. Fixed: namespaced via
   `cache._k()`.
5. **ncbi + crossref gave ghosts metadata** — seed-gated both in `CANDIDATE_QUERIES`
   AND `reader.NEEDS_SPEC` (ghosts get DOIs only).
6. **`resolve_dois_oa` orphan duplicates** — pushed the OA title-match with
   `oa_id` only (no shared id with the s2-origin seed) → merge writer made a twin
   paper. Fixed: the handler bridges the seed's own ids onto the resolved record
   so the merger links it back (single-hit update). Validated: orphans = 0.
7. **refs/cites incompleteness** — `enrich` had no dedicated refs/cites retrieval
   (refs only rode along on metadata calls; cites needed an `oa_id`). Fixed: added
   the bounded `expand_papers_s2_seeds` (edges-only), dispatcher solves over its
   filtered catalogue, solver uncovered-needs log → debug. (Coverage validation
   blocked by the open writer bug above.)

---

## Remaining work

1. **Fix the pure-writer collision bug** (above). Add a regression test that
   simulates the stale snapshot (single-hit job whose id now collides → expect a
   merge, not a crash).
2. **Re-validate** on a fresh fallworm rebuild: confirm refs/cites coverage jumps
   (s2_hop succeeds for ~all seeds; qc credits `s2_hop`), ghosts stay lean, no
   crash, 0 orphans, no cascade.
3. **Step 3 — delete the legacy system** (only after #1+#2 pass): remove the
   Resolver (`merge/resolver.py`), the writer-served claim flow
   (`_serve_claim_flow`, `CANDIDATE_QUERIES`, `request_claim`/`report_marks`), the
   legacy producer run-loops (keep their parsing helpers — handlers + compute
   reuse them), and the writer read-to-decide path (`_process_*_batch`; keep
   `_batch_lookup`, which compute imports). Rewrite the many tests that exercise
   the legacy path. Do it with no daemons running.
   - **Do NOT delete** the pending machinery (`pending_citations`,
     `pending_resolver`, `resolve_pending_dois`, `materialize_ghost_stubs`) — the
     new system still uses it (compute emits pending edges; the resolver promotes
     them). The plan's "retire pending" item is blocked by the unsolved
     pending-edge re-promotion-under-dirty-set question.

---

## Operational gotchas

- **`dirty:seeded` flag**: the dispatcher seeds the whole corpus once, then runs
  off `dirty:papers` (fed by writer commits). A **bulk DB change the writer didn't
  make** (e.g. marking seeds by SQL) is invisible until you
  `cache.clear_dirty_seeded()` (or delete the `<ns>:dirty:seeded` Redis key) so
  the next pass re-scans. `cmd_search` now does this automatically.
- **Rebuild a search dataset cleanly**: wipe `<name>.db` + `<name>_claims.db`,
  clear the Redis namespace (`bib_<sha>:*`) AND search checkpoints
  (`*search:s2:ckpt*`), `biblion init`, then `biblion search`. (`biblion init`
  re-registers the project as current — re-`biblion use <name>` if needed.)
- **Convergence**: dispatcher/compute don't log per-pass. Watch
  `dirty:papers`/`staged:*`/`write:jobs` depths + `enrichment_attempts` growth in
  the `_claims.db`. Converged ≈ all those at 0 and no `status='claimed'`.
- **qc citation coverage** credits a successful `s2_hop` attempt as refs+cites
  retrieved (`__main__.py` ~line 763). Pre-hop it reads 0 (nothing marks a `refs`
  field).
- **Redis db**: the CLI defaults to `redis://localhost:6379/0`; pass `--redis-url`
  to change. `BIBLION_REDIS_URL` is NOT read by the CLI (only `--redis-url`).
- **Tests** assume real Redis on db 15 (`needs_redis` marker auto-skips if down).
  `pytest -m unit` (~20s), `pytest -m perf` after `db.py` schema changes,
  `pytest tests/integration` (spawns real subprocess workers).

---

## Key files

| area | path |
|---|---|
| schema / union-find | `biblion/db.py` (aliases, tombstone, canonical_id), `biblion/merge/aliasmap.py` |
| writer (alias-aware, dirty feed, pure apply, alias-dedup) | `biblion/merge/writer.py` |
| reader / needs | `biblion/enrich/reader.py` |
| catalogue / solver | `biblion/enrich/catalogue.py`, `biblion/enrich/solver.py` |
| dispatcher / handlers | `biblion/enrich/dispatcher.py`, `biblion/enrich/handlers/*.py` |
| compute / dedup / compaction | `biblion/enrich/compute.py`, `dedup.py`, `compaction.py` |
| shadow comparators | `biblion/enrich/shadow.py` |
| supervisor wiring + flags | `biblion/__main__.py` (`_effective_dispatch`, `_legacy_enrich`, `cmd_daemon`, `_ensure_merge_daemons`, `cmd_search`) |
| claims flow / candidate queries | `biblion/framework/claims.py` |
| cache keys / records | `biblion/cache/client.py`, `biblion/cache/records.py` |
