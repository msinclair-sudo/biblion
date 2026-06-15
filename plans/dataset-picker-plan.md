# Dataset picker + nested saves — data/-driven load flow

## Context

The data-source picker (`network_toy/app/src/ui/modals/data-source-modal.js`,
opened from the workflow chart's Data card ⚙) presents **hardcoded** sources from
`datasource/registry.js`: `toy`, `real` (SPECTER2 dev-subsets under
`/literture-network/artifacts/`, hardcoded `SUBSETS` in `real.js:15`), and
`sqlite` (biblion projects, hardcoded `DATASETS` in `sqlite.js:44` — biblion /
fallworm / microalgae / PhD_proposal). There is no top-level index; the project
list is baked in. Saves currently sit in `network_toy/saves/` but aren't wired
into the app at all (save = browser download; load = file picker).

**Desired flow:** the load menu should stop exposing "real data" / "biblion" /
mode abstractions and instead **list the datasets actually present under
`data/`**. Selecting a dataset reveals its **saves** (resume a project) plus a
**"Create new"**. Saves move out of `network_toy/saves/` to nest **inside each
dataset**: `data/<dataset>/saves/<name>.zip` — better-structured, co-located with
the data they belong to.

This unifies dataset-selection and project-selection into one
**dataset → save | create-new** picker, and **supersedes Part B** (server +
flat picker + in-place save) of `plans/project-save-fix-plan.md`.

## Resolved decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Dataset discovery | **`serve.py /api/datasets`** — the local write-back server scans `data/*/manifest.json` and returns loadable datasets + their saves. Dynamic, always current. |
| 2 | Old `real` dev-subset source | **Drop from the picker (data/ only).** Retire `datasource/real.js`; the picker lists only `data/` biblion datasets. (Test-suite already moved to the fallworm `data/` dataset; toy-removal strips the other synthetic path.) |
| 3 | Reconcile with save-fix Part B | **This plan supersedes Part B.** Dataset-scoped `/api/datasets/<id>/saves/` is the single source of truth; flat `network_toy/saves/` + `/api/projects` is dropped. Migrate the one existing save. The consolidation pass removes Part B from the save-fix plan. |

## New data layout

```
data/<dataset>/
  <dataset>_snapshot.db        # existing — read-only snapshot the toy loads
  embeddings.npy               # existing
  paper_index.json             # existing
  manifest.json                # existing — dataset identity (n_nodes, dims, …)
  subsets/<name>/…             # existing — sliced derived datasets (keep)
  saves/<name>.zip             # NEW — workflow saves for THIS dataset
```

A dataset is **loadable** iff it has `<id>_snapshot.db` + `embeddings.npy` +
`paper_index.json` + `manifest.json` (filters out incomplete dirs like
`PhD_proposal`). `data/` is gitignored for the DBs/embeddings, so `saves/` under
it is untracked user state — correct. (The committed **test fixture** stays in
`tests/fixtures/`, NOT `data/<id>/saves/` — see `plans/test-suite-plan.md`; keep
them distinct so tests don't depend on user saves.)

## Server — `network_toy/serve.py` (extends the save-mechanism server)

Python stdlib server (the one introduced for saves) gains a dataset-scoped API,
all paths resolved relative to the repo-root `data/` (via the existing
`network_toy/data -> ../data` symlink):

- `GET /api/datasets` → scan `data/*/`, return loadable datasets:
  `[{id, label, nNodes, embeddingDim, domain, savesCount}]` (read each
  `manifest.json`; mark/omit incomplete dirs).
- `GET /api/datasets/<id>/saves` → list `data/<id>/saves/*.zip`:
  `[{name, projectName, savedAt, sizeBytes}]` (read each zip's `manifest.json`).
- `GET /api/datasets/<id>/saves/<name>` → stream the save zip.
- `POST /api/datasets/<id>/saves/<name>` → atomic write to
  `data/<id>/saves/<name>.zip` (temp + `os.replace`; create `saves/` on first
  write), mirroring `biblion/projects.py`.
- `DELETE /api/datasets/<id>/saves/<name>` → unlink.
- Path-safety: validate `<id>` against the discovered set; sanitise `<name>`
  (reject `/`, `..`).

## Front-end

1. **`datasource/sqlite.js`** — replace the hardcoded `DATASETS` map (line 44)
   with a list fetched from `/api/datasets`. Keep the URL construction
   (`/data/<id>/...`, lines 166-171) and the per-dataset subset discovery
   (`discoverSubsets`, line 106) — subsets become selectable children of their
   parent dataset.
2. **`datasource/registry.js`** — drop the `real` entry (lines 57-72) along with
   `toy` (toy-removal). Leaves the single `sqlite`/data source, now keyed by
   dataset id. Delete `datasource/real.js` (coordinate with toy-removal Tier 2,
   which previously kept `real`).
3. **`ui/modals/data-source-modal.js`** — rework into the unified picker:
   - **Step 1:** list datasets from `/api/datasets` (name + stats + saves count).
   - **Step 2 (on select):** show that dataset's saves (`/api/datasets/<id>/saves`)
     to **load**, plus **"Create new"**.
     - *Load save* → fetch the zip, `deserialiseFile`, rehydrate (depends on the
       round-trip fix, `plans/project-save-fix-plan.md`).
     - *Create new* → ingest the dataset fresh (`engine.reingest` against
       `data/<id>`), empty workflow, unnamed project.
   - Drop the `toy`/`real`/`sqlite` mode surface entirely.
4. **`ui/topbar.js`** — Save/Open wired to the dataset-scoped API:
   - Track the current `{datasetId, saveName}` in state (replaces the lone
     `projectName`). **Save** POSTs in-place to `data/<datasetId>/saves/<saveName>`;
     **Save as…** prompts a name → new file under the same dataset.
   - **Open…** opens the Step-2 saves list for the current dataset (or routes back
     to Step-1 dataset selection).
5. **`persistence/projects-api.js`** (the new fetch-wrapper module from the
   save-mechanism, now dataset-scoped): `listDatasets()`,
   `listSaves(datasetId)`, `loadSave(datasetId, name)`,
   `saveProject(datasetId, name, blob)`, `deleteSave(datasetId, name)`.

## Cross-plan coordination

- **Supersedes** `plans/project-save-fix-plan.md` Part B (flat `network_toy/saves/`
  + `/api/projects` + flat picker). The round-trip fidelity fix (Part A) stays and
  is still a hard dependency (load must restore exact state).
- **Toy-removal** (`plans/toy-removal-plan.md`): this plan additionally drops the
  `real` source, so after both land only the data/-driven `sqlite` source remains.
  Update toy-removal's "keep real + sqlite" note accordingly during consolidation.
- **Test-suite** (`plans/test-suite-plan.md`): fallworm is a `data/` dataset; the
  committed fixture stays under `tests/fixtures/`, NOT `data/fallworm/saves/`.

## Migration

- Move the existing `network_toy/saves/network-toy-sqlite-*.zip` into
  `data/<dataset>/saves/` by reading its `manifest.json` for the dataset id;
  drop it if undetermined. Remove the now-empty `network_toy/saves/`.

## Verification

- `GET /api/datasets` lists exactly the loadable `data/` datasets (fallworm,
  biblion, microalgae) and omits/disables `PhD_proposal`; `savesCount` correct.
- Picker: open → datasets listed (no toy/real/sqlite, no hardcoded names) →
  select fallworm → its saves listed + "Create new" → create new ingests
  fallworm with an empty workflow → Save writes `data/fallworm/saves/<name>.zip`
  (verify on disk) → re-open → save appears → load restores the exact state
  (round-trip fix) → Save overwrites in place; Save-as makes a second file.
- Path-safety: `<id>`/`<name>` with `..` or `/` rejected by serve.py.
- `grep -rn "network_toy/saves\|/api/projects\|datasource/real\|\"real\"\|\"toy\"" network_toy/app/src` returns nothing in live code.
- Manual smoke per `network_toy/CLAUDE.md`; tear the server down after.
