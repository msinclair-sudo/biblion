# J06 — Build & commit fallworm fixtures + freshness/determinism guards

- **Source plan:** `plans/test-suite-plan.md` (fixture section lines 109-128; Sequencing step 4, lines 146-147; decision #1, line 33)
- **Wave:** 2
- **Depends on:** J01 (SCHEMA v4) AND J02 (defaults/schema final) — sequencing says generate fixtures only AFTER round-trip and toy-removal land, else fixtures are stale on creation
- **Locks files:** `scripts/make-fixtures.mjs` (new); `tests/fixtures/{clean,data_only,fallworm_baseline}.zip` (new, committed); the freshness-guard and determinism-guard tests (all under `network_toy/`)
- **Parallel-safe with:** most jobs (own files). NOT a blocker on others except J07.
- **Order constraint:** after J01 and J02; before J07

## Goal
Build the fixture generator that boots one Chromium page, runs the real fallworm pipeline once at a fixed seed, serialises state, and writes the three committed fixture zips. Because the raw fallworm data is gitignored but the serialised zip is self-contained, committing the zips lets CI rehydrate without the raw data or any compute. Add a fast freshness guard and a `@slow` determinism guard.

## Changes

### Generator — `scripts/make-fixtures.mjs` (lines 111-118)
- Boot one Chromium page against the dev server; select the fallworm `sqlite`/real source (1405 nodes — `data/fallworm/manifest.json`, decision #1).
- Run the real pipeline once at a **fixed seed + documented params**, then `serialiseState` → write `tests/fixtures/{clean,data_only,fallworm_baseline}.zip`.
- Regen runs on a dev machine that has `data/fallworm/`; CI consumes the committed zips only.
- Expose as `npm run make:fixtures` (and/or a `pytest --regen-fixtures` flag).

### Committed fixtures (lines 119-120)
- fallworm's 1405×768 f32 embedding (~4.3 MB raw) dominates; compressed baseline zip is a few MB — acceptable as a committed fixture.

### Freshness guard (fast test, lines 121-125)
- Assert each fixture's `manifest.schemaVersion` equals the current `SCHEMA_VERSION`; fail with "run `npm run make:fixtures`" otherwise.
- Both J01 (→ v4) and J02 (defaults/schema) bump schema/defaults — hence this job runs *after* they land.

### Determinism guard (`@slow`, lines 126-128)
- One `@slow` test computes the fallworm baseline live and asserts the rehydrated fixture matches within tolerance (cluster count, dimred shape, node count). Catches a stale fixture drifting from the live pipeline.

## Verification
- `pytest -m "not slow"` green with no `engine.reingest()` / `engine.regenerate()` in the default path (grep conftest + tests, lines 160-161).
- Freshness + determinism guards pass; bump `SCHEMA_VERSION` locally and confirm the freshness guard fails loudly with the regen hint (lines 162-163).
- Tear down any dev server started for fixture generation (line 166).
