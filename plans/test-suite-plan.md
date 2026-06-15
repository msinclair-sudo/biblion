# Test-suite overhaul — stop recomputing, start rehydrating

## Context

The network-toy suite recomputes the same real-data pipeline on every run. The
session fixture `bfs5000_page` (`tests/conftest.py:181`) boots Chromium, loads
BFS-5000 in sql.js, and runs PCA→UMAP→UMAP-viz→HDBSCAN **in the browser** —
~60-90 s one-shot per session (conftest header + lines 6-11). On top of that,
the function-scoped `toy_page`/`clean_page` fixtures re-`new_context()` + `goto`
+ `wait_for_timeout(2000)` **per test**, and the `@slow` tier re-runs real UMAP/
HDBSCAN sweeps at n=5000. Full suite ≈ 14-23 min; fast subset ≈ 3 min. The data
and the expensive geometry are paid for again and again.

Two things already point the way:

- A **Node pure-logic tier has been started today** — `tests/unit/*.test.mjs`
  run under `node --test` (package.json `test:unit`), no browser, no data, no
  60-90 s session. `queue.test.mjs` is labelled "the SPIKE for the pure-logic
  test tier (audit, 2026-06-14)"; 6 files already ported.
- `tests/test_persistence.py:113-115` already does the exact
  `serialiseState → new File([blob]) → deserialiseFile` round-trip in-browser —
  proving a saved `.zip` can rehydrate full computed state. The persistence
  layer's whole point is that **load skips the engine cascade**.

So the better suite = **three tiers + rehydrate-not-recompute**, with the heavy
geometry computed *once*, serialised to a committed fixture, and loaded in ~1-2 s
everywhere else.

## Resolved decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Fixture dataset + storage | Build a dedicated fixture `.zip` from the **fallworm** real dataset (1405 nodes — see `data/fallworm/manifest.json`) and **commit** it under `tests/fixtures/`. The raw fallworm DB/`embeddings.npy` are gitignored, but the serialised zip is self-contained, so committing it lets CI rehydrate **without** the raw data. |
| 2 | Node-tier migration scope | **Port all portable tests now** — audit every `test_*.py`, move each whose target module avoids CDN-only deps to `.test.mjs`. |
| 3 | Sequencing vs round-trip fix | **Gate Tier 1 on `plans/project-save-fix-plan.md`** (rehydration needs load to restore exact state). Tier 0 + the tiering structure proceed immediately in parallel. The fixtures then double as continuous coverage for the round-trip fix. |

---

## Tier 0 — Node pure-logic (`node --test`, no browser, no data)

Expand the started spike to **every portable test**. A test is portable iff its
target module's *eager* import graph touches none of: the DOM, or the CDN-only
deps (`three`, `fflate`, `umap-js`, `3d-force-graph` via esm.sh/unpkg). Import
the **leaf logic module directly** rather than a UI wrapper that transitively
pulls the engine — `colour-modes.test.mjs:7` documents this exact trick
(node-table.js → engine → esm.sh UMAP is *not* portable, but the colour-mode
functions are).

**Mechanical boundary check (build first):** a small script that, for each
`app/src/**/*.js`, attempts `node --input-type=module -e 'await import("…")'`
and records pass/fail. The passing set is the Tier-0 universe; the failing set
(CDN/DOM) stays in Tier 1. Commit it as `scripts/check-node-portable.mjs` so the
boundary is reproducible, not guessed.

**Port targets (representative — finalize from the boundary check):**
- Already done: `queue`, `colour-modes`, `bridges-per-pair`, `hdbscan-model`,
  `multilayer-sweep`, `node-displacement`.
- Port: `test_workflow.py` (workflow.js CRUD), `test_workflow_projection.py`,
  `test_step_job_binding.py` + `test_slice_2_9_step_bindings.py` (queue↔workflow),
  `test_next_steps.py` (next-steps-rules), `test_optimise.py` + `test_eval.py`
  (sweep/scorer math), `test_cross_cluster.py` (flow matrix),
  `test_condensed_tree.py` (model; minus the toy case being deleted),
  `test_scoring.py` (scoring math), and the math-only cases of
  `test_multilevel.py` / `test_multilayer_curve.py`.
- Likely portable, confirm with the check: `test_export_ris.py` (export/ris.js),
  parts of `test_scoring_card.py`.
- **Stays browser** (DOM/engine/CDN): `test_panels.py`, `test_panel_keepalive.py`,
  `test_persistence.py`, the chart-render cases of `test_workflow_chart*.py`,
  and anything asserting rendered SVG/DOM.

Each port is a 1:1 translation (the spike notes this) and can *tighten*
assertions the Playwright version had to loosen for the shared session, because
`beforeEach` gives every Node test a clean module slot.

## Tier 1 — Browser + rehydrated fallworm fixture (no recompute)

**Gated on `plans/project-save-fix-plan.md`.** Replace the in-browser pipeline
in `bfs5000_page` with **loading a precomputed fixture zip** via the
`test_persistence.py` mechanism: fetch `tests/fixtures/fallworm_baseline.zip`
over the dev server, wrap as a `File`, `deserialiseFile`, apply the patch +
restore the workflow tree. ~1-2 s vs ~60-90 s, and **zero** UMAP/HDBSCAN compute.

- Rename/retarget the session fixture (`bfs5000_page` → `fallworm_page`, or keep
  the name and swap the body). `page` stays the per-test wrapper that resets
  `workflow`/`validationRuns`/`jobs` and restores the pristine geometry slots
  (`conftest.py:276-310`) — that discipline is what makes one shared page safe.
- **Fixture variants**, all rehydrated the same cheap way, all session-scoped:
  - `clean` — empty workflow, no data (replaces `clean_page`'s per-test boot).
  - `data_only` — genResult + embedding + rawCitationEdges, no dimred/cluster.
  - `baseline` — full fallworm pipeline (data→dimred→clustering[→bridges]).
  Tests select the lightest variant they need.
- **Kill per-test context boots.** Make `clean`/`data_only`/`baseline` all
  session-scoped booted pages reset per test (the `page` pattern), eliminating
  the repeated `new_context` + `goto` + 2 s `wait_for_timeout`. `toy_page` is
  removed entirely by `plans/toy-removal-plan.md`.
- Re-home the tests the toy-removal plan moves off `toy_page` onto `data_only`/
  `baseline` instead of the slow session.

## Tier 2 — Real-algorithm `@slow` tests (the only place compute happens)

Keep the irreducible set that validates the algorithms themselves (real UMAP/
HDBSCAN at n=5000, the dim-sweep + multilayer-sweep runners). Quarantine them
under `@pytest.mark.slow` (already defined, `pytest.ini`) so the default fast
path never recomputes. This is the *only* tier that runs the engine for real;
everything else rehydrates or runs pure logic.

---

## The fixture: build-from-fallworm, commit, keep fresh

- **Generator:** `scripts/make-fixtures.mjs` (or a `pytest --regen-fixtures`
  flag) that boots one Chromium page against the dev server, selects the
  fallworm `sqlite`/real source, runs the real pipeline once at a fixed seed +
  documented params, then `serialiseState` → writes
  `tests/fixtures/{clean,data_only,fallworm_baseline}.zip`. Because the raw
  fallworm data is gitignored, **regen runs on a dev machine that has
  `data/fallworm/`**; CI consumes the committed zips and needs neither the raw
  data nor any compute.
- **Size:** fallworm's 1405×768 f32 embedding (~4.3 MB raw) dominates; the
  compressed baseline zip is a few MB — acceptable as a committed test fixture.
- **Freshness guard:** a fast test asserts each fixture's `manifest.schemaVersion`
  equals the current `SCHEMA_VERSION` and fails with "run `npm run make:fixtures`"
  otherwise. **Both `plans/project-save-fix-plan.md` (→ v4) and
  `plans/toy-removal-plan.md` bump the schema / change defaults**, so the fixture
  must be regenerated *after* those land — call this out in sequencing.
- **Determinism guard:** one `@slow` test computes the fallworm baseline live and
  asserts the rehydrated fixture matches within tolerance (cluster count, dimred
  shape, node count). Catches a stale fixture drifting from the live pipeline.

## Cross-cutting

- **Parallelism:** with per-fixture setup now ~1-2 s, adopt `pytest-xdist`
  (`-n auto`) for the browser tier — each worker rehydrates its own page from the
  committed zip. The Node tier is already fast and parallel. Workers share the
  read-only static dev server (or bind per-worker ports via
  `NETWORK_TOY_TEST_PORT`, already supported, `conftest.py:46`).
- **Console-error guard** (`conftest.py:141-164`) is preserved verbatim across all
  browser fixtures — it's orthogonal to how data gets loaded.
- **CI:** Node tier (`npm run test:unit`) + browser tier (`pytest -m "not slow"`)
  on every push; `@slow` Tier 2 on a nightly/label.

## Sequencing

1. **Tier 0 now** (independent): build `check-node-portable.mjs`, port all
   portable `test_*.py` → `.test.mjs`, delete the superseded Playwright copies.
2. **Round-trip fix** (`plans/project-save-fix-plan.md`) lands → schema v4.
3. **Toy removal** (`plans/toy-removal-plan.md`) lands → defaults/schema settle.
4. **Generate fixtures** from fallworm (post-2/3 so schema + defaults are final),
   commit the zips + the freshness/determinism guards.
5. **Retier the browser fixtures** to rehydrate (Tier 1), kill per-test boots,
   re-home ex-`toy_page` tests, add `pytest-xdist`.

## Verification

- **Wall-clock targets:** Tier 0 whole-tier in seconds (`npm run test:unit`);
  browser fast suite from ~3 min → well under a minute (rehydrate ~1-2 s + xdist);
  `@slow` unchanged but rarely run. Record before/after in the PR.
- **Boundary check:** `node scripts/check-node-portable.mjs` lists the portable
  set; assert every ported `.test.mjs` target is in it.
- **Fixtures load:** `pytest -m "not slow"` green with no `engine.reingest()` /
  `engine.regenerate()` anywhere in the default path (grep conftest + tests).
- **Freshness + determinism guards** pass; bump `SCHEMA_VERSION` locally and
  confirm the freshness guard fails loudly with the regen hint.
- **No data recompute leak:** grep the default-tier tests for `reingest`,
  `regenerate`, `recluster`, `redimred` — only Tier 2 `@slow` may call them.
- Tear down any dev server started for fixture generation.
