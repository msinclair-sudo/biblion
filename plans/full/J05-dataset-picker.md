# J05 — Dataset picker + serve.py /api/datasets + nested saves

- **Source plan:** `plans/dataset-picker-plan.md` (whole file)
- **Wave:** 2
- **Depends on:** J01 (round-trip fidelity — "Load save → deserialiseFile, rehydrate" is a hard dependency per the plan), J02 (drops `real` from the same datasource/registry.js this job also edits, and the toy-removal must settle first)
- **Locks files:** network_toy/serve.py (new), network_toy/app/src/datasource/sqlite.js, network_toy/app/src/datasource/registry.js, network_toy/app/src/ui/modals/data-source-modal.js, network_toy/app/src/ui/topbar.js, network_toy/app/src/persistence/projects-api.js (new), and DELETE network_toy/app/src/datasource/real.js; also network_toy/CLAUDE.md + README.md run-command updates
- **Parallel-safe with:** any job not touching those files. NOT with: J09/J27 (datasource/sqlite.js), J02 (datasource/registry.js), J01/J09/J18/J26 (ui/topbar.js)
- **Order constraint:** after J01 and J02. This job ESTABLISHES serve.py + /api/datasets, which J09 (sql-search scope selector), J26 (databases dropdown) and J27 (data-panel identity) all consume — so it must land before them.

## Goal

Unify dataset-selection and project-selection into one **dataset → save | create-new** picker driven by `serve.py /api/datasets`, which scans `data/*/manifest.json` and returns the loadable datasets actually present plus each one's saves. Saves move out of the flat `network_toy/saves/` and nest inside each dataset at `data/<dataset>/saves/<name>.zip`, co-located with the data they belong to. The picker stops exposing the `toy`/`real`/`sqlite` mode abstractions; selecting a dataset reveals its saves (resume) plus "Create new" (fresh ingest). This SUPERSEDES Part B of `plans/project-save-fix-plan.md` (flat saves dir + `/api/projects`); Part A round-trip fidelity stays and is the hard dependency.

## Changes

- **`serve.py` (new, extends the save-mechanism server)** — stdlib server, all paths resolved relative to repo-root `data/` via the existing `network_toy/data -> ../data` symlink:
  - `GET /api/datasets` → scan `data/*/`, return `[{id, label, nNodes, embeddingDim, domain, savesCount}]` from each `manifest.json`; a dataset is loadable iff it has `<id>_snapshot.db` + `embeddings.npy` + `paper_index.json` + `manifest.json` (omit/disable incomplete dirs like `PhD_proposal`).
  - `GET /api/datasets/<id>/saves` → list `data/<id>/saves/*.zip` as `[{name, projectName, savedAt, sizeBytes}]` (read each zip's `manifest.json`).
  - `GET /api/datasets/<id>/saves/<name>` → stream the save zip.
  - `POST /api/datasets/<id>/saves/<name>` → atomic write (temp + `os.replace`; create `saves/` on first write), mirroring `biblion/projects.py`.
  - `DELETE /api/datasets/<id>/saves/<name>` → unlink.
  - Path-safety: validate `<id>` against the discovered set; sanitise `<name>` (reject `/`, `..`).
- **`datasource/sqlite.js`** — replace the hardcoded `DATASETS` map at line 44 with a list fetched from `/api/datasets`. KEEP the URL construction (`/data/<id>/...`, lines 166-171) and per-dataset `discoverSubsets` (line 106) — subsets become selectable children of their parent dataset.
- **`datasource/registry.js`** — drop the `real` entry (lines 57-72); coordinate with J02 which drops the `toy` entry. Leaves a single `sqlite`/data source keyed by dataset id. Triggers deletion of `datasource/real.js`.
- **DELETE `datasource/real.js`** — the SPECTER2 dev-subset source (hardcoded `SUBSETS` at real.js:15) is retired; picker lists only `data/` datasets.
- **`ui/modals/data-source-modal.js`** — rework into the two-step unified picker:
  - Step 1: list datasets from `/api/datasets` (name + stats + saves count).
  - Step 2 (on select): show that dataset's saves (`/api/datasets/<id>/saves`) to **load**, plus **"Create new"**. Load save → fetch zip → `deserialiseFile` → rehydrate (depends on J01 round-trip fix). Create new → `engine.reingest` against `data/<id>`, empty workflow, unnamed project.
  - Drop the `toy`/`real`/`sqlite` mode surface entirely.
- **`ui/topbar.js`** — Save/Open wired to the dataset-scoped API:
  - Track current `{datasetId, saveName}` in state (replaces the lone `projectName`).
  - **Save** POSTs in-place to `data/<datasetId>/saves/<saveName>`; **Save as…** prompts a name → new file under the same dataset.
  - **Open…** opens the Step-2 saves list for the current dataset (or routes back to Step-1).
- **`persistence/projects-api.js` (new)** — dataset-scoped fetch wrappers: `listDatasets()`, `listSaves(datasetId)`, `loadSave(datasetId, name)`, `saveProject(datasetId, name, blob)`, `deleteSave(datasetId, name)`.
- **Migration** — move the existing `network_toy/saves/network-toy-sqlite-*.zip` into `data/<dataset>/saves/` by reading its `manifest.json` for the dataset id (drop if undetermined); remove the now-empty `network_toy/saves/`.
- **Docs** — update run-command/server notes in `network_toy/CLAUDE.md` and `README.md` to reflect serve.py + the data/-driven picker.

## Verification

- `GET /api/datasets` lists exactly the loadable `data/` datasets (fallworm, biblion, microalgae) and omits/disables `PhD_proposal`; `savesCount` correct.
- Picker flow: open → datasets listed (no toy/real/sqlite, no hardcoded names) → select fallworm → its saves listed + "Create new" → create new ingests fallworm with an empty workflow.
- On-disk save path: Save writes `data/fallworm/saves/<name>.zip` — verify on disk.
- Round-trip restore: re-open → save appears → load restores the exact state (J01 round-trip fix) → Save overwrites in place; Save-as makes a second file.
- Path-safety: `<id>`/`<name>` containing `..` or `/` rejected by serve.py.
- Dead-ref grep: `grep -rn "network_toy/saves\|/api/projects\|datasource/real\|\"real\"\|\"toy\"" network_toy/app/src` returns nothing in live code.
- Manual smoke per `network_toy/CLAUDE.md`; tear the server down after.
