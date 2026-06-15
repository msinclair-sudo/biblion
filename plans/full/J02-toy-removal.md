# J02 — Toy-data removal + legacy v3 retirement

> **STATUS — DONE (Wave 1, run `wf_de3bc524-91c`).** Branch `wave1/J02-toy-removal` · commit `e03fd18` (built on J01: contains main-base + J01 merge + J02; +174/−4416 across 40 files, 15 whole-file deletions). Shim landed before defaults flipped; dangling-toy-ref greps clean; DO-NOT-TOUCH traps intact; all `.js`/`.py` parse. Boot/ingest, old-`.zip` shim load, and full `pytest` need a manual pass. Re-homed browser tests (migrate preludes; `test_condensed_tree` n=5000 swap) were not executed. Merge note: J02 + J03 both edit `test_workflow.py`/`test_multilevel.py`/`test_slice_2_9_step_bindings.py` — merge J03 first.

- **Source plan:** `plans/toy-removal-plan.md` (whole file — Tiers 1, 2, 2b, 3, the persistence back-compat shim section, and Suggested order)
- **Wave:** 1
- **Depends on:** J01 (both edit app/src/persistence/deserialise.js — land round-trip first per the plan's "Suggested order" step 1 and the Risk #2 note)
- **Locks files:** app/src/persistence/deserialise.js, app/src/ui/engine.js, app/src/ui/state.js, app/src/datasource/registry.js, app/src/citations/registry.js, app/src/ui/data-panel.js, app/src/ui/panels/method-receipt.js, app/src/ui/modals/clustering-tabs/optimise-tab.js, app/src/ui/modals/clustering-tabs/optimise-results-renderer.js, app/src/eval/scorers.js, app/src/ui/workflow-migration.js, tests/conftest.py, plus the Tier-1/2b delete-set (toy.js, generation.js, eval/bayes-ari.js, taste-network.js, citation-taste.js, citations.js, neighbourhoods.js, main.js[legacy], legacy.html, *-debug.js, eval/kmeans.js, eval/layout-sweep.js)
- **Parallel-safe with:** Wave-0 jobs touching none of those files. NOT with: J05 (datasource/registry.js), J09/J10/J14/J25 (state.js), J07 (conftest.py), J27 (data-panel.js), J09/J25 (colour-modes.js — optional toy cleanup)
- **Order constraint:** after J01 on deserialise.js; before J05 (registry), J07 (conftest), J27 (data-panel). Sequence its own three engine/state slices internally per Risk #3 (datasource + citations + eval — don't parallel-edit the same defaults). The persistence shim must land BEFORE flipping defaults.

## Goal
Remove the synthetic toy (Gaussian-mixture) data path entirely — datasource, taste-network citations, supervised ARI eval — and retire the legacy v3 demo shell. Leave only the real data types (`real` SPECTER2 dev-subsets, `sqlite` biblion corpus). The app boots with no data loaded and lets the user pick a real source. The citation default must flip atomically: a dangling `"taste-network"` default crashes boot (Risk #1).

## Changes

**app/src/persistence/deserialise.js** — persistence shim FIRST (plan lines 163-173, 188)
- Add a back-compat shim (none exists today) BEFORE flipping any defaults: remap `citations.method: "taste-network"` → `"imported-edges"`; remap `evalResults.optimise.scorerId: "ari"` or `"auto"` → `"richness"`. Without it, old `.zip` saves throw on load once registry entries are gone. Coordinate with J01 (round-trip lands first).

**app/src/ui/state.js** (plan lines 82-89)
- `dataSource.mode` (line 23) → `"real"` (no literal `"empty"`; empty = granular-boot, no boot-time ingest).
- Delete the toy config bag (lines 25-33: seed/nodeCount/origins/spread/density/intraRate/crossRate).
- Delete `neighbourhoodResult` (86) and `tasteResult` (87) slots; delete `layerParams.taste: null` (154).
- `activeAlgorithm.dataSource` (175) → `"real"`; `activeAlgorithm.citations` (181) `"taste-network"` → `"imported-edges"`.

**app/src/ui/engine.js** (plan lines 71-80)
- Source fallbacks `|| "toy"` → `|| "real"` at lines 172, 1075.
- Citation defaults `"taste-network"` → `"imported-edges"` at lines 92, 95, 130.
- `reneighbour()` (1040-1065): keep the shell, delete the generation branch (1055-1064) incl. the `retaste()` call (1064).
- DELETE `retaste()` (1105-1113), `resample()` (1116-1126), and the `resample()` call (1112) — toy-only chain.
- KEEP `resampleViaImport()` (1072) and the citation-layout lanes (real path).
- In `ingestDataOnly`, drop the toy `desiredMethod` branch (always `"imported-edges"`) and the toy `density/intraRate/crossRate` plumbing.

**Registries**
- `app/src/datasource/registry.js`: remove `import {produceToy, defaultToyParams}` (line 15) and the toy entry (lines 20-56). Keep real (58-72) + sqlite (74-90).
- `app/src/citations/registry.js`: remove `import * as tasteNetwork` (line 11) and the taste-network entry (lines 28-43). Keep imported-edges (45-54).

**Toy eval removal** (plan lines 95-105)
- `app/src/ui/panels/method-receipt.js`: delete the Bayes-optimal-ARI-ceiling block (212-217).
- `app/src/ui/modals/clustering-tabs/optimise-tab.js`: drop `ariScorer` import (20); in `pickScorer()` (693-711) remove the `ariScorer()` branch (701) and the `"ari"` case (706-709); delete `extractGroundTruth()` (713-722); default scorer → `richness`.
- `app/src/ui/modals/clustering-tabs/optimise-results-renderer.js`: delete the `scorer.id==="ari"` "Match %" column branch (185-201).
- `app/src/eval/scorers.js`: drop `adjustedRandIndex` import (20) and `ariScorer()` (27-50). KEEP `stabilityScorer` (60), `numClustersScorer` (101), `clusterRichnessScorer` (127).

**app/src/ui/data-panel.js** (plan lines 92-94)
- Remove the `mode==="toy"` conditional (31-36), always `renderRealMode()`; delete `renderToyMode()` (38-62) and its only-callers `numberRow`/`rangeRow` (43-49).

**app/src/ui/workflow-migration.js** (plan lines 106-108)
- `|| "toy"` → `|| "real"` (87); remove the else branch with the `'Toy · n=${nNodes}'` label (92-94). KEEP the citations→layout→blend branch (gated on `citationResult`, not toy).

**Tier 1 / Tier 2b deletes** (plan lines 50-62, 113-132)
- DELETE-WHOLE: `app/src/datasource/toy.js`, `app/src/generation.js`, `app/src/eval/bayes-ari.js`, `app/src/citations/taste-network.js`, `app/src/citation-taste.js`, `app/src/citations.js`, `app/src/neighbourhoods.js`.
- Legacy v3: `app/src/main.js` (legacy boot, distinct from `app/src/ui/main.js`), `app/legacy.html`, `app/src/generation-debug.js`, `app/src/clustering-debug.js`, `app/src/citations-debug.js`, `app/src/physics-debug.js`, `app/src/eval/kmeans.js`, `app/src/eval/layout-sweep.js`.
- KEEP (shared with real): `base-edges.js`, `eval/ari.js`, `contracts/cluster.js`, `eval/sweep.js` (delete only the legacy `sweepAlgorithm` export at line 477 + its now-unused imports). `rng.js` stays; `gauss3()` becomes dead → optional prune.
- DO-NOT-TOUCH traps (look toy, are real): `datasource/contract.js` basePos/origins (12, 20, 48); `eval/dim-sweep.js:200` + `eval/fusion-compare.js:77` `adjustedRandIndex` (partition-vs-partition); `citations/imported-edges.js`, `citations/importers/*`.

**tests/conftest.py + tests** (plan lines 136-151)
- Delete the `toy_page` fixture (314-341). Delete toy-only tests: `tests/test_workflow.py:263`, `tests/test_condensed_tree.py:151`. Re-home onto a real fixture (`dev_subset_1000`, or mark `@slow`): `tests/test_multilevel.py:93,186,257,334`, `tests/test_condensed_tree.py:160`, `tests/test_panel_keepalive.py:11,45`, `tests/test_slice_2_9_step_bindings.py:14,76`. Comment-only: `tests/test_panels.py` docstring.

## Verification
- Boot/ingest: `python serve.py` (or `python -m http.server 8000`), open `http://localhost:8000/app/`. App boots with an empty tree, no console errors; data panel offers only real/sqlite; adding a real source ingests and the dimred→clustering cascade runs; citations default to imported-edges. Tear the server down after.
- No dangling toy refs: `grep -rnE "taste-network|produceToy|bayes|originId|renderToyMode|ariScorer|\"toy\"" network_toy/app/src` returns nothing (outside removed files).
- Old-save load: load a pre-change `.zip` carrying `citations.method:"taste-network"` / `scorerId:"ari"`; confirm the shim remaps instead of throwing.
- Tests: `pytest -m "not slow"` green (fast suite), then full `pytest`. Confirm `toy_page` is gone and re-homed tests pass on real data.
- Legacy gone: `app/legacy.html` 404s; no module imports the deleted `*-debug.js`/`eval/kmeans.js`/`eval/layout-sweep.js`.
