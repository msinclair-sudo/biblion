# J03 — Test Tier-0 — Node pure-logic port + portability boundary check

> **STATUS — DONE (Wave 0, run `wf_f1eccd83-aca`).** Branch `wave0/J03-node-portable-ports` · commit `15b07e2`. `npm run test:unit` 47/47 green. `.py` copies trimmed-and-annotated (not hard-deleted); 5 brief-named targets left browser-only as genuinely DOM/engine-bound.

- **Source plan:** `plans/test-suite-plan.md` (Tier 0 section, lines 39-74; Sequencing step 1, lines 144-145)
- **Wave:** 0
- **Depends on:** none — can start immediately (the plan says "Tier 0 now (independent)")
- **Locks files:** `scripts/check-node-portable.mjs` (new), `tests/unit/*.test.mjs` (new ports), deleted superseded Playwright `test_*.py` copies (all under `network_toy/`)
- **Parallel-safe with:** everything (own files only). NOT with: nothing.
- **Order constraint:** none

## Goal
Expand the started Node pure-logic spike to every portable test, so the whole tier runs under `node --test` with no browser, no data, and no 60-90 s session. First build a mechanical boundary check so the portable set is reproducible, then port each qualifying `test_*.py` 1:1 to `.test.mjs` and delete the Playwright copy it supersedes.

## Changes

### Boundary check (build first)
- Add `scripts/check-node-portable.mjs`: for each `app/src/**/*.js`, attempt `node --input-type=module -e 'await import("…")'` and record pass/fail (lines 50-53).
- Passing set = Tier-0 universe; failing set (DOM or CDN-only deps `three`, `fflate`, `umap-js`, `3d-force-graph` via esm.sh/unpkg) stays in Tier 1 (lines 41-47).
- Import the **leaf logic module directly**, not a UI wrapper that transitively pulls the engine — the `colour-modes.test.mjs:7` trick (lines 44-48).

### Ports to `tests/unit/*.test.mjs` (finalize from the boundary check, lines 55-66)
- Already done: `queue`, `colour-modes`, `bridges-per-pair`, `hdbscan-model`, `multilayer-sweep`, `node-displacement`.
- Port: `test_workflow.py` (workflow.js CRUD), `test_workflow_projection.py`, `test_step_job_binding.py` + `test_slice_2_9_step_bindings.py` (queue↔workflow), `test_next_steps.py` (next-steps-rules), `test_optimise.py` + `test_eval.py` (sweep/scorer math), `test_cross_cluster.py` (flow matrix), `test_condensed_tree.py` (model; minus the deleted toy case), `test_scoring.py` (scoring math), and the math-only cases of `test_multilevel.py` / `test_multilayer_curve.py`.
- Likely portable — confirm with the check: `test_export_ris.py` (export/ris.js), parts of `test_scoring_card.py`.

### Stays browser (do NOT port, lines 67-69)
- `test_panels.py`, `test_panel_keepalive.py`, `test_persistence.py`, the chart-render cases of `test_workflow_chart*.py`, anything asserting rendered SVG/DOM.

### Translation notes (lines 71-73)
- Each port is 1:1; may **tighten** assertions the Playwright version loosened for the shared session — `beforeEach` gives every Node test a clean module slot.
- Delete each superseded Playwright `.py` copy once its `.test.mjs` replacement is in place (sequencing step 1, line 145).

## Verification
- `node scripts/check-node-portable.mjs` lists the portable set; assert every ported `.test.mjs` target is in it (lines 158-159).
- Tier 0 whole-tier runs in seconds via `npm run test:unit` (lines 155-156).
