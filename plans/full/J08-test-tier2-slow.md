# J08 — Test Tier-2 — real-algorithm @slow quarantine

- **Source plan:** `plans/test-suite-plan.md` (Tier 2 section, lines 99-106)
- **Wave:** 4
- **Depends on:** J07 (cleanest after the retier, so the `@slow` set is the residue). May be folded into J07 if convenient — note this.
- **Locks files:** the `@slow` marker additions on the real UMAP/HDBSCAN/sweep tests (under `network_toy/tests/`)
- **Parallel-safe with:** most jobs. NOT with: J07 (overlapping test files).
- **Order constraint:** after / alongside J07

## Goal
Quarantine the irreducible set of tests that validate the algorithms themselves — real UMAP/HDBSCAN at n=5000, the dim-sweep and multilayer-sweep runners — under `@pytest.mark.slow` so the default fast path never recomputes. This is the only tier that runs the engine for real; everything else rehydrates (J07) or runs pure logic (J03).

## Changes

### Mark the real-algorithm tests (lines 99-105)
- Add `@pytest.mark.slow` (already defined in `pytest.ini`) to the tests running real UMAP/HDBSCAN at n=5000 and the dim-sweep + multilayer-sweep runners.
- Leave them running the engine for real — they are the only place compute happens.
- Folding note: because this is the residue left after J07's retier, it may be done inside J07 if convenient; keep separate if J07's diff is already large.

## Verification
- Grep the default-tier tests for `reingest`, `regenerate`, `recluster`, `redimred` — only Tier 2 `@slow` may call them (lines 164-165).
- `pytest -m "not slow"` green with no engine recompute in the default path (lines 160-161).
- `@slow` Tier 2 wall-clock unchanged but rarely run (lines 156-157); runs on nightly/label, not every push (lines 139-140).
