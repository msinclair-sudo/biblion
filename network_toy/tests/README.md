# network_toy test suite — structure and the decisions behind it

This file records the **non-obvious engineering decisions** in this
suite — the places where we deliberately deviate from a documented
standard, or where no standard exists and we made a local call. It is
the companion to `plans/test-suite/standards-alignment-plan.md` (the
governing plan) and the deep-research review behind it
(`vault biblion/research/results/pytest-test-suite-standards-result.md`).

For *how to run* the suite, see `network_toy/CLAUDE.md` → "Running and
testing". For *how the fixtures work*, see the `conftest.py` docstring.

## Tiers

- **Node pure-logic tier** — `tests/unit/*.test.mjs`, run with
  `node --test` (or `npm run test:unit`). No browser, no data, no CDN
  deps. Each test imports a leaf logic module directly and gets a clean
  module slot. This is where logic is covered.
- **Browser tier** — `tests/test_*.py`, Playwright under pytest. Boots
  Chromium and **rehydrates** a committed fixture zip; covers what
  genuinely needs a browser (DOM render, console behaviour, job
  lifecycle, viewer, persistence round-trips).
- **Slow algorithm tier** — the `@pytest.mark.slow` subset of the
  browser tier. The only place real UMAP/HDBSCAN compute runs. Skipped
  by `pytest -m "not slow"`.

## Decisions and their authority

Each decision is tagged with how much authority backs it, per the
research review: **[STANDARD]** documented framework guidance,
**[CONVENTION]** common practice without controlled evidence,
**[JUDGEMENT]** no standard found, our own call.

### 1. We deviate from per-test browser-context isolation — [STANDARD we choose against, with a safety net]

Playwright's documented standard is a fresh, isolated browser context
**per test**. This suite does the opposite: one session-scoped page per
fixture variant (`clean` / `data_only` / `baseline`), booted once and
**reset between tests** rather than rebuilt.

*Why:* the whole architecture is rehydrate-not-recompute. A fresh
context per test would re-pay the zip rehydrate (and re-boot Chromium)
every test, defeating the point. We trade the documented isolation for
speed, with eyes open.

*The safety net that makes it sound* (all in `conftest.py`):
- `_reset_page` clears `workflow` / `validationRuns` / `jobs` and
  restores the pristine geometry slots before every test, on pass *or*
  fail (it runs at the next test's setup regardless of the prior
  outcome).
- The restore **deep-clones** each geometry slot from the snapshot
  (`structuredClone`), so a test that mutates an array in place cannot
  corrupt the shared session for later tests. pytest documents the
  no-copy reference-sharing hazard this guards against; the guard is
  locked in by `tests/test_fixture_isolation.py`. (Measured clone cost
  ~0.9 ms/test, so this is free in practice.)
- Every page tracks console / pageerror / HTTP>=400 events and the
  fixture asserts none occurred during the test — this catches silent
  cross-test contamination that the shared session could otherwise hide.
- `_wipe_data_slots` restores the `clean` session's data-free contract
  for tests that deliberately run a real ingest.

If you add a test that needs true isolation (e.g. it mutates
module-global browser state the reset does not cover), give it its own
booted context rather than weakening the shared-session discipline.

### 2. Teardown belongs to the fixture, not the test body — [STANDARD]

Resource cleanup (cancelling in-flight jobs, etc.) lives in `_reset_page`,
not in inline calls at the end of a test. Inline cleanup is skipped when
an earlier assertion throws, leaking a running job onto the shared
session; fixture-level reset runs regardless of test outcome. Do not
re-add end-of-test `cancelJob`/cleanup blocks — the fixture owns it.

### 3. Logic is covered once, in the Node tier — [JUDGEMENT]

The research found **no evidence** either way on deliberately duplicating
the same logic across a browser tier and a fast unit tier. So this is our
call: **pure logic is tested once, in `tests/unit/*.test.mjs`; the
browser tier covers only what needs a browser.** When you port a test's
logic down to the Node tier, retire the superseded Playwright case (keep
only the part, if any, that asserts browser behaviour). The indirect cost
signal supports this (browser tests are measurably flakier — async-wait
timing is ~45% of UI flakiness in the studied corpus) but does not
mandate it; we own the policy. *(The known duplicates have been retired;
when you port new logic down to the Node tier, retire the superseded
browser case in the same change.)*

### 4. Fixture staleness defence — [JUDGEMENT]

The research found **no authoritative standard** for committed binary
fixtures or staleness detection. Our chosen, layered defence:

- Commit the rehydration zips under `tests/fixtures/`.
- **Schema stamp** — `test_fixture_freshness.py` (fast, file-only) checks
  each manifest's `schemaVersion` against the app's current
  `SCHEMA_VERSION`.
- **Provenance stamp** — `make-fixtures.mjs` writes a `fixtureStamp`
  (`generatorVersion` + the pipeline params + dataset) into each
  manifest. The freshness test asserts the stamp's `generatorVersion`
  matches the current generator, catching a fixture that predates a
  generator change even when the schema is unchanged. Bump
  `GENERATOR_VERSION` in `make-fixtures.mjs` whenever you change what the
  generator produces, and regenerate.
- **Determinism guard** — `test_fixture_determinism.py` (`@slow`)
  rehydrates the baseline, recomputes it live from the raw data, and
  asserts shape match. It reads the pipeline params back **from the
  fixture's own stamp** (single source of truth — no second copy to
  drift). It needs `data/fallworm/`; by default it skips when that is
  absent, but `NETWORK_TOY_HAVE_FALLWORM=1` turns absence into a hard
  failure so the regen / CI-with-data box can't silently let drift through.

The pipeline params live in exactly one place: `make-fixtures.mjs`,
recorded into each fixture's stamp. To populate the stamp on the
committed zips, run `npm run make:fixtures` once (needs the Node
`playwright` package + `data/fallworm/`); until then the stamp checks
skip with a regen hint.

## Markers

- `slow` — inherent real-algorithm cost (n=5000 sweeps). Excluded by
  `-m "not slow"`.
- `perf` — asserts a timing/output-shape budget that can regress
  (distinct from `slow`). Run with `-m perf`.
- `--strict-markers` is on: a typo'd `@pytest.mark.<x>` is a hard error.
