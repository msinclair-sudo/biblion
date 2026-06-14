# Toy-data removal — scope & plan

Supersedes `network_toy/TOY_REMOVAL.md` (moved here, line numbers verified
against the code 2026-06-14, decisions resolved, legacy retirement folded in,
verification added).

## Context

The network-toy app carries a synthetic **toy** (Gaussian-mixture) data path
alongside the real paths. The toy was scaffolding for developing the pipeline
before real embeddings existed; it's now dead weight that complicates
`engine.js`/`state.js`, forces a supervised-ARI eval branch that only works on
synthetic ground truth, and keeps a parallel `taste-network` citation model
alive. Goal: **remove the toy path entirely**, leaving only real data types
(`real` = SPECTER2 dev-subsets, `sqlite` = biblion corpus). The app should
boot with no data loaded (granular build-out already does this) and let the
user pick a real source.

Toy is woven through **three entangled seams** that all meet in `engine.js` +
`state.js`, plus a **separable legacy demo** that we are retiring in this pass:

1. **Toy datasource** — the generator + its registration.
2. **Toy citations** — the `taste-network` synthetic citation model.
3. **Toy eval** — supervised scoring needing toy ground-truth (`originId`,
   Bayes-optimal ARI ceiling).
4. **Legacy v3 demo** (`app/legacy.html` → `app/src/main.js`) — its own shell.
   **Retiring it now** (user decision).

Order matters: the **citation default** must flip atomically — a dangling
`"taste-network"` default crashes boot (Risk #1).

## Resolved decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Default `dataSource.mode` once toy is gone | **empty / no data** — boot loads nothing (already true); nominal mode value defaults to `"real"` so any code reading a missing mode resolves to the lightest real path. **No auto-ingest at boot.** |
| 2 | Default citation method | **`imported-edges`** (forced — see Risk #1) |
| 3 | Default optimise scorer | **`richness`** (revisitable; `stability` is the alternative) |
| 4 | Legacy v3 demo | **Retire now** — delete the legacy shell + its legacy-only debug/eval modules in this pass |

> Decision 1 note for the implementer: there is no literal `"empty"` value for
> `dataSource.mode` (the enum is `real`/`sqlite`). "Empty" = the existing
> granular-boot behaviour (no pipeline run, empty tree). Set the default mode
> *value* to `"real"` (pre-selected source in the data panel) and the engine
> `|| "toy"` fallbacks to `|| "real"`, but **do not add any boot-time ingest**.
> Confirm `ui/main.js` still performs no auto-load.

---

## Tier 1 — DELETE-WHOLE (toy-only files) — all confirmed zero real importers

Datasource/generation:
- `app/src/datasource/toy.js`            (only importer: `datasource/registry.js:15`)
- `app/src/generation.js`                (only `toy.js` + legacy `main.js`)
- `app/src/eval/bayes-ari.js`            (only `toy.js:8`)

Citations (the taste-network chain):
- `app/src/citations/taste-network.js`   (only `citations/registry.js:11`)
- `app/src/citation-taste.js`            (only `retaste()` in engine.js)
- `app/src/citations.js`                 (only `resample()` in engine.js + taste-network.js)
- `app/src/neighbourhoods.js`            (only `reneighbour()` in engine.js)

## Tier 2 — SURGICAL (shared files: cut the toy arm, keep real) — verified line numbers

**Registries**
- `datasource/registry.js`: remove `import {produceToy, defaultToyParams}` (**line 15**)
  and the toy entry (**lines 20–56**). Keep real (58–72) + sqlite (74–90).
- `citations/registry.js`: remove `import * as tasteNetwork` (**line 11**) and the
  taste-network entry (**lines 28–43**). Keep imported-edges (45–54).

**Engine** (`app/src/ui/engine.js`)
- Source fallbacks `|| "toy"` → `|| "real"` at **lines 172 and 1075**.
- Citation defaults `"taste-network"` → `"imported-edges"` at **lines 92, 95, 130**.
- `reneighbour()` (**1040–1065**): keep the function shell but delete the
  generation branch (**1055–1064**) including the `retaste()` call (**1064**).
- DELETE `retaste()` (**1105–1113**) and `resample()` (**1116–1126**) and the
  `resample()` call (**1112**) — they form a toy-only chain.
- KEEP `resampleViaImport()` (**1072**) and the citation-layout lanes (real path).
- In `ingestDataOnly`, drop the toy `desiredMethod` branch so it's always
  `"imported-edges"`, and delete the toy `density/intraRate/crossRate` plumbing.

**State** (`app/src/ui/state.js`)
- `dataSource.mode` (**line 23**) → `"real"` (see Decision 1 note).
- Delete the toy config bag (**lines 25–33**: seed/nodeCount/origins/spread/
  density/intraRate/crossRate).
- Delete `neighbourhoodResult` (**86**) and `tasteResult` (**87**) slots.
- Delete `layerParams.taste: null` (**154**).
- `activeAlgorithm.dataSource` (**175**) → `"real"`;
  `activeAlgorithm.citations` (**181**) `"taste-network"` → `"imported-edges"`.

**UI**
- `ui/data-panel.js`: remove the `mode==="toy"` conditional (**31–36**), always
  `renderRealMode()`; delete `renderToyMode()` (**38–62**) and its only-callers
  `numberRow`/`rangeRow` (**43–49**).
- `ui/panels/method-receipt.js`: delete the Bayes-optimal-ARI-ceiling block
  (**212–217**).
- `ui/modals/clustering-tabs/optimise-tab.js`: drop the `ariScorer` import (**20**);
  in `pickScorer()` (**693–711**) remove the `ariScorer()` branch (**701**) and the
  `"ari"` case (**706–709**); delete `extractGroundTruth()` (**713–722**).
  Default scorer → **`richness`** (Decision 3).
- `ui/modals/clustering-tabs/optimise-results-renderer.js`: delete the
  `scorer.id==="ari"` "Match %" column branch (**185–201**).
- `eval/scorers.js`: drop `adjustedRandIndex` import (**20**) and `ariScorer()`
  (**27–50**). KEEP `stabilityScorer` (60), `numClustersScorer` (101),
  `clusterRichnessScorer` (127).
- `ui/workflow-migration.js`: `|| "toy"` → `|| "real"` (**87**); remove the else
  branch with the `'Toy · n=${nNodes}'` label (**92–94**). (The
  citations→layout→blend branch is gated on `citationResult`, NOT toy — keep it.)
- `ui/viewer-shared/colour-modes.js`: the `node.t` "Time (t)" colour path and the
  `origin` mode are dead-but-guarded on real → **optional low-priority cleanup,
  safe to defer**.

## Tier 2b — LEGACY v3 demo retirement (Decision 4)

Legacy-only files (verified zero real importers) — DELETE:
- `app/src/main.js`            (the legacy boot; distinct from the live `app/src/ui/main.js`)
- `app/legacy.html`
- `app/src/generation-debug.js`
- `app/src/clustering-debug.js`
- `app/src/citations-debug.js`
- `app/src/physics-debug.js`   (only a *comment* reference in `blend/align.js:293`, not an import)
- `app/src/eval/kmeans.js`     (zero real importers)
- `app/src/eval/layout-sweep.js` (zero real importers)

Shared-with-real — **KEEP** (do not delete despite legacy use):
- `app/src/base-edges.js`      — used by `ui/panels/viewer-3d.js` (real)
- `app/src/eval/ari.js`        — real partition-vs-partition (see traps)
- `app/src/contracts/cluster.js` — core contract, ~70 importers
- `app/src/eval/sweep.js`      — **keep the file**: `optimise-tab.js:18` imports
  `sweepAcrossAlgorithms`/`runTargetRangeSweep`. Delete **only** the legacy
  `sweepAlgorithm` export (**line 477**) and any now-unused imports it pulled
  (e.g. the `groundTruth`/`kmeans` path).

`rng.js`: keep (12 real modules use it); `gauss3()` becomes dead → optional prune.

## Tier 3 — TESTS (verified line numbers)

- `tests/conftest.py`: DELETE the `toy_page` fixture (**314–341**). `page`/
  `bfs5000_page` set `mode:"real"` explicitly and `clean_page` loads no data, so
  flipping the default is safe.
- DELETE (genuinely toy-only):
  - `tests/test_workflow.py:263` `test_migration_toy_mode_includes_citations`
  - `tests/test_condensed_tree.py:151` `test_condensed_tree_surfaced_toy`
- RE-HOME onto a real fixture (used `toy_page` only for speed):
  - `tests/test_multilevel.py:93, 186, 257, 334`
  - `tests/test_condensed_tree.py:160` `test_condensed_tree_survives_save_load`
  - `tests/test_panel_keepalive.py:11, 45`
  - `tests/test_slice_2_9_step_bindings.py:14, 76`
  Use a small real fixture (`dev_subset_1000`) or mark `@slow` to avoid pulling
  the n=5000 session into the fast suite (watch fast-suite time — Risk #4).
- COMMENT-ONLY: `tests/test_panels.py` docstring.

## DO-NOT-TOUCH traps (look toy, are real) — all verified

- `datasource/contract.js` basePos/origins validation (lines 12, 20, 48) — keeps a
  future "load existing 3D coords" source viable.
- `eval/dim-sweep.js:200` + `eval/fusion-compare.js:77` `adjustedRandIndex` —
  **partition-vs-partition** (unsupervised); name collision only. Keep.
- `ui/workflow-migration.js` citations branch — gated on `citationResult`; real
  populates via imported edges. Keep (only the comment is mislabelled).
- `citations/imported-edges.js`, `citations/importers/*` — the real path. Keep.

## CRITICAL: persistence back-compat shim (Risk #2 — confirmed gap)

`app/src/persistence/deserialise.js` has **no** back-compat shim today. Old
`.zip` saves can carry:
- `citations.method: "taste-network"` → remap to `"imported-edges"`
- `evalResults.optimise.scorerId: "ari"` or `"auto"` → remap to `"richness"`

Without a shim these throw on load once the registry entries are gone. **Add the
shim in `deserialise.js` BEFORE flipping defaults.** Note this dovetails with the
project-save round-trip work (`plans/project-save-fix-plan.md`): both touch
`deserialise.js`, so land the round-trip fix first or coordinate the edits.

## Risks

1. **Hard-crash:** `"taste-network"` is the default in `state.js` + 3 spots in
   `engine.js`. Drop the registry entry only in the SAME change that flips all
   defaults, or `getAlgorithm("taste-network")` throws on boot/ingest.
2. **Persistence:** see shim above.
3. **Three slices edit `engine.js`/`state.js`** (datasource + citations + eval) —
   sequence them; don't parallel-edit the same defaults.
4. **Test re-homing** moves ~9 tests onto the slow real session — watch
   fast-suite runtime; prefer the `dev_subset_1000` fixture.

## Suggested order

1. **Persistence shim** in `deserialise.js` (`taste-network`→`imported-edges`,
   `ari`/`auto`→`richness`). Coordinate with `plans/project-save-fix-plan.md`.
2. **Flip defaults** (state + engine citation default → `imported-edges`, mode
   value → `real`, no boot ingest). Verify boot/ingest on real.
3. **Remove toy eval** (bayes-ari, ariScorer, optimise ARI options).
4. **Remove toy citations** (taste chain + registry entry + engine lanes).
5. **Remove toy datasource** (toy.js, generation.js, registry entry, data-panel UI).
6. **Retire legacy v3 demo** (Tier 2b delete-set).
7. **Tests**: delete/re-home + drop `toy_page`.

## Verification

- **Boot/ingest:** `cd network_toy && python serve.py` (or current
  `python -m http.server 8000`); open `http://localhost:8000/app/`. Confirm: app
  boots with an empty tree and no console errors, the data panel offers only
  real/sqlite, adding a real source ingests and the dimred→clustering cascade
  runs, citations default to imported-edges. Tear the server down afterwards.
- **No dangling toy refs:**
  `grep -rnE "taste-network|produceToy|bayes|originId|renderToyMode|ariScorer|\"toy\"" network_toy/app/src`
  returns nothing (outside removed files).
- **Old-save load:** load a pre-change `.zip` that carries
  `citations.method:"taste-network"` / `scorerId:"ari"` and confirm the shim
  remaps it instead of throwing.
- **Tests:** `cd network_toy && pytest -m "not slow"` green (fast suite), then
  full `pytest`. Confirm `toy_page` is gone and re-homed tests pass on real data.
- **Legacy gone:** `app/legacy.html` 404s; no module imports the deleted
  `*-debug.js`/`eval/kmeans.js`/`eval/layout-sweep.js`.
