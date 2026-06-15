# J07 — Test Tier-1 — browser rehydrate retier + pytest-xdist

- **Source plan:** `plans/test-suite-plan.md` (Tier 1 section lines 75-98; Cross-cutting lines 131-140; Sequencing step 5, lines 148-149)
- **Wave:** 3
- **Depends on:** J06 (committed fixtures) AND J01 (round-trip — rehydration needs load to restore exact state; plan gates Tier 1 on the save-fix). Lands after J02 (which removes `toy_page`).
- **Locks files:** `tests/conftest.py`; the browser-tier test fixtures (`bfs5000_page`→`fallworm_page` rename + clean/data_only/baseline variants); pytest config for xdist (all under `network_toy/`)
- **Parallel-safe with:** jobs not touching `conftest.py`. NOT with: J02 (`conftest.py`).
- **Order constraint:** after J02 on `conftest.py`; after J06 for fixtures

## Goal
Replace the in-browser pipeline in the session fixture with loading the precomputed fixture zip, turning ~60-90 s recompute into a ~1-2 s rehydrate with zero UMAP/HDBSCAN compute. Make all variants session-scoped and reset per test, kill per-test context boots, re-home ex-`toy_page` tests, and add `pytest-xdist`.

## Changes

### Retarget the session fixture (lines 77-86)
- Replace `bfs5000_page`'s in-browser pipeline: fetch `tests/fixtures/fallworm_baseline.zip` over the dev server, wrap as a `File`, `deserialiseFile`, apply the patch + restore the workflow tree (the `test_persistence.py` mechanism).
- Rename `bfs5000_page` → `fallworm_page` (or keep the name, swap the body).
- `page` stays the per-test wrapper resetting `workflow`/`validationRuns`/`jobs` and restoring pristine geometry slots (`conftest.py:276-310`).

### Fixture variants — all rehydrated, all session-scoped (lines 87-91)
- `clean` — empty workflow, no data (replaces `clean_page`'s per-test boot).
- `data_only` — genResult + embedding + rawCitationEdges, no dimred/cluster.
- `baseline` — full fallworm pipeline (data→dimred→clustering[→bridges]).
- Tests select the lightest variant they need.

### Kill per-test boots + re-home (lines 92-97)
- Make `clean`/`data_only`/`baseline` session-scoped booted pages, reset per test (the `page` pattern) — eliminate repeated `new_context` + `goto` + 2 s `wait_for_timeout`. `toy_page` is removed by J02.
- Re-home the tests J02 moves off `toy_page` onto `data_only`/`baseline` (not the slow session).

### Cross-cutting (lines 131-138)
- Adopt `pytest-xdist` (`-n auto`) for the browser tier; each worker rehydrates its own page from the committed zip. Workers share the read-only dev server or bind per-worker ports via `NETWORK_TOY_TEST_PORT` (`conftest.py:46`).
- Preserve the console-error guard verbatim (`conftest.py:141-164`) across all browser fixtures.

## Verification
- Browser fast suite from ~3 min → well under a minute (rehydrate ~1-2 s + xdist); record before/after in the PR (lines 156-157).
- `pytest -m "not slow"` green with no `engine.reingest()` / `engine.regenerate()` in the default path (lines 160-161).
- Grep default-tier tests for `reingest`, `regenerate`, `recluster`, `redimred` — only Tier 2 `@slow` may call them (lines 164-165).
