# Toy-data removal — scope & plan

Goal: remove the synthetic **toy** Gaussian-mixture data path, leaving only the
real-data path (`real` = SPECTER2 dev-subsets, `sqlite` = biblion corpus).

## Shape of the problem

Toy is woven through **three entangled seams** that all meet in `engine.js` +
`state.js`, plus a **separable legacy demo**:

1. **Toy datasource** — the generator + its registration.
2. **Toy citations** — the `taste-network` synthetic citation model.
3. **Toy eval** — supervised scoring that needs the toy ground-truth (`originId`,
   Bayes-optimal ARI ceiling).
4. **Legacy v3 demo** (`app/legacy.html` → `app/src/main.js`) — its own shell,
   *not* part of the current app. Removing it is a **separate, larger** cut.

Order matters: changing the **citation default** must land atomically (a
dangling `"taste-network"` default crashes boot — see Risks).

---

## Tier 1 — DELETE-WHOLE (toy-only files)

Datasource/generation:
- `app/src/datasource/toy.js`
- `app/src/generation.js`  *(only the toy datasource + legacy shell reach it)*
- `app/src/eval/bayes-ari.js`  *(imported only by toy.js)*

Citations (the taste-network chain):
- `app/src/citations/taste-network.js`
- `app/src/citation-taste.js`
- `app/src/citations.js`  *(stage-4 Bernoulli sampler)*
- `app/src/neighbourhoods.js`  *(stage-1 mutual-kNN; orphan once taste gone)*

Legacy-only (delete **with** the legacy shell, see Tier 4):
- `app/src/main.js`, `app/legacy.html`, `app/src/generation-debug.js`
  *(and the legacy `eval/sweep.js sweepAlgorithm` supervised path)*

## Tier 2 — SURGICAL (shared files: cut the toy arm, keep real)

**Registries**
- `datasource/registry.js` — drop the `import {produceToy,…}` + the whole
  `{id:"toy", …}` entry. Keep `real` + `sqlite`.
- `citations/registry.js` — drop `import * as tasteNetwork` + its `ALGORITHMS`
  entry. Keep `importedEdges`.

**Engine** (`app/src/ui/engine.js`)
- `|| "toy"` source fallbacks → `|| "real"` (≈ lines 172, 1075).
- `ingestDataOnly` (≈184-199): `desiredMethod = sourceId==="toy" ? "taste-network"
  : "imported-edges"` → always `"imported-edges"`; delete the toy `density/
  intraRate/crossRate` plumbing.
- `ensureLayerParams` citations default (≈86-97): `"taste-network"` → `"imported-edges"`.
- `activeCitationAlgorithm` fallback (≈130): `"taste-network"` → `"imported-edges"`.
- DELETE the taste-generation lanes `retaste()`/`resample()` (+ the generation
  tail of `reneighbour()`); KEEP `resampleViaImport()` (real) + citation-layout lanes.

**State** (`app/src/ui/state.js`)
- `dataSource.mode: "toy"` → **decision** (recommend `"real"`).
- delete the `configs.toy: {seed,nodeCount,origins,spread,density,intraRate,crossRate}` bag.
- `activeAlgorithm.dataSource: "toy"` → `"real"`; `"citations":"taste-network"` → `"imported-edges"`.
- drop `neighbourhoodResult`/`tasteResult` slots.

**UI**
- `ui/data-panel.js` — remove the `mode==="toy"` branch + `renderToyMode()` +
  its only-callers `numberRow`/`rangeRow`. Always `renderRealMode`.
- `ui/panels/method-receipt.js` — remove the toy Gaussian-mixture data line and
  the Bayes-optimal-ARI-ceiling block.
- `ui/modals/clustering-tabs/optimise-tab.js` — remove `extractGroundTruth()`,
  the `ariScorer` import + `"auto"`/`"ari"` scorer dropdown options + their
  `pickScorer` branches + the "ARI requires toy mode" guard. Default scorer
  `"auto"` → **decision** (recommend `"richness"`).
- `ui/modals/clustering-tabs/optimise-results-renderer.js` — remove the
  `scorer.id==="ari"` "Match %" column branch.
- `eval/scorers.js` — remove `ariScorer` + its `adjustedRandIndex` import. Keep
  `stability`/`numClusters`/`richness` (unsupervised).
- `ui/workflow-migration.js` — `|| "toy"` → `|| "real"`; drop the `'Toy · n=…'`
  data-label arm. (The citations→layout→blend branch is **gated on
  `citationResult`, NOT toy** — keep it; only the comment is mislabelled.)
- `ui/viewer-shared/colour-modes.js` — `"Time (t)"` label fallback, the `node.t`
  colour path, and the `origin` mode are all dead-but-guarded on real → optional
  low-priority cleanup, safe to defer.

## Tier 3 — TESTS

- `tests/conftest.py` — DELETE the `toy_page` fixture (+ its docstring). `page`/
  `bfs5000_page` set `mode:"real"` explicitly, and `clean_page` loads no data, so
  **neither depends on the toy default** — flipping the default is safe.
- DELETE (genuinely toy-only): `test_workflow.py::test_migration_toy_mode_includes_citations`,
  `test_condensed_tree.py::test_condensed_tree_surfaced_toy`.
- RE-HOME `toy_page` → `page` (real-relevant, used toy only for speed): the rest
  of `test_multilevel.py` toy tests, `test_panel_keepalive.py` (both),
  `test_slice_2_9_step_bindings.py` (both), `test_condensed_tree.py::…survives_save_load`.
  Consider a small real fixture (`dev_subset_1000`) or `@slow` to avoid loading
  the n=5000 session for fast tests.
- COMMENT-ONLY: `test_panels.py` docstring.
- No standalone `test_bayes_ari`/`test_taste_network` file exists.

## Tier 4 — Comment-only / deferred / legacy
- `rng.js` (keep — 12 real modules use it; `gauss3` becomes dead, optional prune).
- `datasource/contract.js`, `dimred/contract.js`, `clustering-registry.js`,
  `eval/{dim-sweep,bootstrap,run-infer-remote}.js` — comments only; **logic stays**.
- **Legacy v3 demo** (`app/src/main.js` + `app/legacy.html` + `generation-debug.js`
  + legacy-only debug modules) — decide separately whether to retire the archive.

## DO-NOT-TOUCH traps (look toy, are real)
- `contract.js` `basePos`/`origins` validation — keep (future load-3D-coords source).
- `dim-sweep.js` / `fusion-compare.js` `ari` — **partition-vs-partition**
  (unsupervised); name collision only. Keep.
- `workflow-migration.js` citations branch — gated on `citationResult`; real can
  populate via imported edges. Keep.
- `imported-edges.js`, `citations/importers/*` — the real path. Keep.

## DECISIONS for a human
1. **Default `dataSource.mode`** once toy is gone → `real` (recommended) | `sqlite` | `empty`.
2. **Default citation method** → `imported-edges` (REQUIRED — see risk #1).
3. **Default optimise scorer** → `richness` (recommended) | `stability`.
4. **Retire the legacy v3 demo** in this pass, or leave it frozen? (Bigger cut.)

## RISKS
1. **Hard-crash risk:** `"taste-network"` is the default in `state.js` + 3 spots in
   `engine.js`. Removing the registry entry without flipping ALL defaults →
   `getAlgorithm("taste-network")` throws on boot/ingest. Change defaults + drop
   the toy override in the **same** change.
2. **Persistence:** old `.zip` saves may carry `citations.method:"taste-network"`
   or `scorerId:"ari"/"auto"`. Add a `deserialise.js` back-compat shim
   (`taste-network`→`imported-edges`, `ari`/`auto`→`richness`) or they throw on load.
3. **Three slices edit `engine.js`/`state.js`** (datasource + citations + eval) —
   sequence them, don't parallel-edit the same defaults.
4. **Test re-homing** moves 7 tests onto the slow real session — watch fast-suite time.

## Suggested order
1. Flip defaults (state + engine citation default → `imported-edges`, mode → `real`)
   + add persistence shim. Verify boot/ingest on real.
2. Remove toy eval (bayes-ari, ariScorer, optimise ARI options).
3. Remove toy citations (taste chain + registry entry + engine lanes).
4. Remove toy datasource (toy.js, generation.js, registry entry, data-panel toy UI).
5. Tests: delete/re-home + drop `toy_page`.
6. (Separate) legacy v3 demo retirement.
</content>
