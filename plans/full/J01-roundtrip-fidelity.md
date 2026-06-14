# J01 — Round-trip save fidelity

> **STATUS — DONE (Wave 1, run `wf_de3bc524-91c`).** Branch `wave1/J01-roundtrip` · commit `f4f66cd` (+128/−28 across the 5 files). Parse + grep checks pass; buffer-identity dedup keyed on ArrayBuffer; `view` in PASS_THROUGH_KEYS; SCHEMA 3→4. Optional v3→v4 shim intentionally skipped (v3 saves now hard-refuse). Byte-for-byte round-trip + zip-no-double need a manual `serve.py`/Playwright pass.

- **Source plan:** `plans/project-save-fix-plan.md` (Spec 1 content — round-trip fidelity fix, lines 54-123). NOTE: Spec 2 / Part B is SUPERSEDED by the dataset picker — ignore it.
- **Wave:** 1
- **Depends on:** none — can start immediately (head of the critical-path spine)
- **Locks files:** app/src/persistence/serialise.js, app/src/persistence/deserialise.js, app/src/persistence/manifest.js, app/src/ui/workflow.js, app/src/ui/topbar.js (all under network_toy/)
- **Parallel-safe with:** any job not locking those files. NOT with: J02 (deserialise.js), J10 (serialise.js), J05/J09/J18/J26 (topbar.js)
- **Order constraint:** J01 must land before J02, J05, J09, J10, J14, J18, J26 — it bumps SCHEMA_VERSION 3→4 and is the dedup/serialise foundation the others build on.

## Goal
A saved project loads back in the same shape, with the full workflow card tree, selection, and per-card results intact, and stays correct when the user navigates cards after load. Persist `state.workflow` (the canonical store) alongside the existing flat projection slots; on load restore both, then re-project the selected card so tree and flat slots stay consistent and the viewer repaints.

## Changes

**app/src/persistence/serialise.js** (plan lines 67-80)
- Serialise the workflow tree: `out.workflow = stashBinariesIn(state.workflow, arrays, "arrays/workflow")`. The generic `stashBinariesIn` deep-walker already replaces every nested TypedArray (clusterLevels `nodeCluster`/`noiseFlags`, `condensedTree` bag, `dimredResult.data`, `_basePos`, `bridgeAnalysis` arrays, validation runs) with `{__binary,type,length}` descriptors — no per-type code needed.
- Add `"view"` to `PASS_THROUGH_KEYS` (viewer-3d edge toggles + colours).
- Add buffer-identity dedup to `stashBinary`: keep a `Map<ArrayBuffer → path>`; if a TypedArray's underlying bytes were already stashed (same `dimredResult.data` referenced by both the flat slot and the dimred card's `result`), reuse the existing path in the descriptor instead of writing bytes twice. Without this the n×768 embedding (and every heavy array) is written twice and the zip ~doubles.

**app/src/persistence/deserialise.js** (plan lines 82-86)
- No structural change required — `reviveBinaries` already revives nested descriptors recursively, including multiple descriptors pointing at one shared `arrays/` entry. Confirm shared-path revival yields usable views (current `new Uint8Array(bytes)` copy per descriptor is fine).

**app/src/ui/workflow.js** (plan lines 88-93)
- Add an `importWorkflow(workflow)` helper (or `reseedStepSerial(steps)`) that sets `state.workflow` and advances the module-local `nextSerial` past the max serial embedded in loaded step ids, so post-load `createStep` can't collide with restored ids.

**app/src/ui/topbar.js** — `loadProject()` (plan lines 95-102)
- After `deserialiseFile`, apply the patch and restore the tree: `update({...res.patch})`, then `importWorkflow(res.patch.workflow ?? {steps:{},rootId:null,selected:null})`.
- Then call `projectStepIntoLegacyState(state.workflow.selected, {bumpRevision:true})` when a selection exists (rebuilds flat slots from tree, forces viewer repaint); otherwise bump `engineRevision` as today.
- Delete the stale "loading replaces state.workflow wholesale" comment.

**app/src/persistence/manifest.js** (plan lines 103-108)
- Bump `SCHEMA_VERSION` 3 → 4 (breaking: v3 files have no `workflow`). Strict-refusal rejects older saves — acceptable per existing policy.
- Optional: a v3→v4 shim in `deserialise.js` running `workflow-migration.js` over legacy flat slots to synthesise a linear tree; document as optional, not required for the fix.

## Verification
- New pytest/Playwright round-trip in `network_toy/tests/`: build a non-trivial tree (data → dimred → clustering → bridge/labelling), save, reload into a fresh context, assert `state.workflow.steps` deep-equals (structure + revived TypedArray contents), `rootId`/`selected` restored, and that selecting a *different* card after load projects correct (non-null) flat slots.
- Manual: `python serve.py` (or current `http.server`), build a tree, Save, reload the page, Load — chart, selection, and viewer match pre-save.
- Confirm zip size does not double vs. a pre-fix save of the same state (dedup working).
