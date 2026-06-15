# Plan — write two dev specs for "fix the way projects are saved"

## Context

We're on `main`, staying on `main`. This is a **spec-writing** task, not an
implementation task: the deliverable is two markdown specs under
`claude_doc_dump/` (per the project memory convention "specs go to
`claude_doc_dump/`"). They describe the next lot of work on the **network-toy
UI project save/load**.

Two distinct, separable problems surfaced while investigating:

1. **Round-trip is broken (correctness).** Loading a saved project does not
   restore the same shape it was saved as. Root cause: since the Phase 2
   workflow-tree redesign, `state.workflow` is the *canonical source of truth*
   (each card carries its own heavy `result`; the flat slots like
   `state.dimredResult` / `state.clusterLevels` are **projections** rebuilt
   from the selected card's ancestry by `projectStepIntoLegacyState`). But
   `serialiseState` (`network_toy/app/src/persistence/serialise.js`) was
   written in Phase 1 and **never serialises `state.workflow`** — it saves
   only the flat projection slots. On load the whole card tree (every card,
   branch structure, selection) is lost; `state.workflow` stays at its empty
   live-session default; the workflow chart (primary surface) renders empty;
   and the first projection call (e.g. selecting any card) walks the empty
   ancestry and overwrites the restored flat slots with nulls. The loader's
   comment claiming it "replaces `state.workflow` wholesale" is stale — the
   patch has no `workflow` key. (`state.view` edge-toggles/colours are also
   never saved; most other gaps — `nodeDisplacement`, `clusterLabels`,
   `multiLevelSweep`, `crossClusterCitations` — are projections that return
   for free once the tree is restored.)

2. **Storage mechanism is download-only (UX).** `saveProject()` pushes a
   `.zip` into the browser Downloads folder; `loadProject()` is a raw file
   picker; the `network_toy/saves/` dir is unused; there is no in-place Save
   and no project list. User wants: a **local stdlib write-back server**, a
   **project picker / open dialog**, and **true in-place Save**.

These ship independently (the mechanism is worthless until the round-trip is
correct), so they become **two specs**, and Spec 1 must land first.

## Deliverable

Create two files (the only execution step once this plan is approved):

- `claude_doc_dump/project-save-roundtrip-spec.md`  — the correctness fix
- `claude_doc_dump/project-save-mechanism-spec.md`   — server + picker + in-place save

Add a memory pointer if appropriate (the existing memory already records the
"specs → claude_doc_dump/" convention; no new memory needed unless the user
wants the task tracked).

---

## Spec 1 content — round-trip fidelity fix

**Goal:** a saved project loads back byte-for-byte in the same shape, with the
full workflow card tree, selection, and per-card results intact, and remains
correct when the user navigates cards after load.

**Source-of-truth principle:** persist `state.workflow` (the canonical store);
keep persisting the flat slots so the initial view restores exactly; on load,
restore both, then re-project the selected card so tree and flat slots stay
consistent and the viewer repaints.

**Changes:**

1. `app/src/persistence/serialise.js`
   - Serialise the workflow tree:
     `out.workflow = stashBinariesIn(state.workflow, arrays, "arrays/workflow")`.
     The existing generic `stashBinariesIn` deep-walker already replaces every
     nested TypedArray (clusterLevels `nodeCluster`/`noiseFlags`, `condensedTree`
     bag, `dimredResult.data`, `_basePos`, `bridgeAnalysis` arrays, validation
     runs) with `{__binary,type,length}` descriptors — no per-type code needed.
   - Add `"view"` to `PASS_THROUGH_KEYS` (viewer-3d edge toggles + colours).
   - Add **buffer-identity dedup** to `stashBinary`: keep a
     `Map<ArrayBuffer → path>`; if a TypedArray's underlying bytes were already
     stashed (the same `dimredResult.data` is referenced by both the flat slot
     and the dimred card's `result`), reuse the existing path in the descriptor
     instead of writing the bytes twice. Without this the n×768 embedding (and
     every other heavy array) is written twice and the zip ~doubles.

2. `app/src/persistence/deserialise.js`
   - No structural change required — `reviveBinaries` already revives nested
     descriptors recursively, including multiple descriptors pointing at one
     shared `arrays/` entry. Confirm shared-path revival yields usable views
     (current `new Uint8Array(bytes)` copy per descriptor is fine).

3. `app/src/ui/workflow.js`
   - Add an `importWorkflow(workflow)` helper (or `reseedStepSerial(steps)`)
     that sets `state.workflow` and advances the module-local `nextSerial`
     past the max serial embedded in loaded step ids, so post-load
     `createStep` can't collide with restored ids. (Random suffix already
     makes collision unlikely; this makes it impossible.)

4. `app/src/ui/topbar.js` — `loadProject()`
   - After `deserialiseFile`, apply the patch **and** restore the tree:
     `update({...res.patch})`, then `importWorkflow(res.patch.workflow ?? {steps:{},rootId:null,selected:null})`.
   - Then call `projectStepIntoLegacyState(state.workflow.selected, {bumpRevision:true})`
     when a selection exists (rebuilds the flat slots from the tree and forces
     a viewer repaint); otherwise bump `engineRevision` as today.
   - Delete the stale "loading replaces state.workflow wholesale" comment.

5. `app/src/persistence/manifest.js`
   - Bump `SCHEMA_VERSION` 3 → 4 (breaking: v3 files have no `workflow`).
     Strict-refusal rejects older saves — acceptable per existing policy.
     *Optional:* a v3→v4 shim in `deserialise.js` that runs the existing
     `workflow-migration.js` over the legacy flat slots to synthesise a linear
     tree; document as optional, not required for the fix.

**Files:** `serialise.js`, `deserialise.js`, `manifest.js`, `workflow.js`,
`topbar.js` (all under `network_toy/app/src/`).

**Verification:**
- New pytest/Playwright round-trip in `network_toy/tests/`: build a non-trivial
  tree (data → dimred → clustering → bridge/labelling), save, reload into a
  fresh context, assert `state.workflow.steps` deep-equals (structure + revived
  TypedArray contents), `rootId`/`selected` restored, and that selecting a
  *different* card after load projects correct (non-null) flat slots.
- Manual: `python serve.py` (or current `http.server`), build a tree, Save,
  reload the page, Load — chart, selection, and viewer match pre-save.
- Confirm zip size does not double vs. a pre-fix save of the same state
  (dedup working).

---

## Spec 2 content — storage mechanism (server + picker + in-place save)

> **SUPERSEDED by `plans/dataset-picker-plan.md`.** That plan replaces this
> flat `network_toy/saves/` + `/api/projects` design with a dataset-scoped
> picker and saves nested at `data/<dataset>/saves/` via
> `/api/datasets/<id>/saves/`. The consolidation pass removes this Part B.
> Spec 1 (round-trip fidelity, above) stands and remains a hard dependency.

**Goal:** projects save to `network_toy/saves/` on disk via a local stdlib
server, are listed in a project picker, and `Save` overwrites in place.
Depends on Spec 1 (saved projects must round-trip correctly first).

**Changes:**

1. `network_toy/serve.py` (new, Python stdlib only — keeps "no build step"):
   - `ThreadingHTTPServer` + a `SimpleHTTPRequestHandler` subclass serving the
     static app, plus a small JSON API:
     - `GET /api/projects` → list `saves/*.zip`, reading each `manifest.json`
       for `projectName`/`savedAt`; return `[{name, projectName, savedAt,
       sizeBytes, mtime}]`.
     - `GET /api/projects/<name>` → stream the zip bytes.
     - `POST /api/projects/<name>` → atomic write of the body to
       `saves/<name>.zip` (temp + `os.replace`, mirroring the write-then-rename
       pattern in `biblion/projects.py`).
     - `DELETE /api/projects/<name>` → unlink.
   - Name sanitisation + path-traversal rejection (no `/`, `..`); `saves/`
     resolved relative to `serve.py`.
   - Port 8000. Update run command in `network_toy/CLAUDE.md` + `README.md`
     from `python -m http.server 8000` to `python serve.py`.

2. `app/src/persistence/projects-api.js` (new): `fetch` wrappers —
   `listProjects()`, `saveProjectToServer(name, blob)`,
   `loadProjectFromServer(name)`, `deleteProject(name)`.

3. `app/src/ui/topbar.js`:
   - `saveProject`: POST the serialised blob to the server instead of the
     Downloads path. `Save` → POST to `state.projectName` (overwrite, true
     in-place); `Save as…` → prompt, POST new name, `setProjectName`.
     Surface success/failure (replace the silent download).
   - New `Open…` menu item → opens a **project-picker modal** listing
     `listProjects()` (name + saved-at, sortable; per-row delete) → on choose,
     `loadProjectFromServer` → existing `deserialiseFile`/apply path (Spec 1).
   - *Optional / not selected by user:* keep `.zip` download as a separate
     `Export…` item and the raw file-picker as `Import .zip…`. Mark optional.

4. `app/src/ui/modals/project-picker.js` (new, or reuse existing modal infra):
   the picker UI.

**Files:** `network_toy/serve.py` (new), `network_toy/CLAUDE.md`,
`network_toy/README.md`, `app/src/persistence/projects-api.js` (new),
`app/src/ui/topbar.js`, `app/src/ui/modals/project-picker.js` (new).

**Verification:**
- pytest against `serve.py`: POST a zip → `GET /api/projects` lists it →
  `GET /api/projects/<name>` returns identical bytes → `DELETE` removes it;
  assert path-traversal names are rejected.
- Playwright: Save → project appears in the picker → Open → state matches;
  Save again (in-place) overwrites without a new file; Save-as creates a
  second entry.
- Manual smoke per `network_toy/CLAUDE.md` running conventions; tear down the
  server afterwards.

---

## Notes / sequencing

- **Spec 1 before Spec 2** — the mechanism is moot until the round-trip is
  correct.
- Both specs are scoped to the user's selections: project picker + true
  in-place Save + stdlib `serve.py`. **Autosave/dirty-state is out of scope**
  (not selected). Export-download retention is optional and flagged as such.
- Execution after approval: write the two `claude_doc_dump/*.md` files with the
  content above (expanded into proper spec prose), nothing else. No code
  changes in this task.
