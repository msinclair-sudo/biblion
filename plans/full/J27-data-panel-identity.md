# J27 — Top-left data panel references the open dataset / connected DB

- **Source plan:** `plans/ui-cleanup-plan.md` (Data panel / shell — Top-left data panel references the open dataset / connected DB)
- **Wave:** 3
- **Depends on:** J05 (real source identity comes from `/api/datasets` + the `sqlite.js` dataset), J02 (`data-panel.js` is rewritten by toy-removal first)
- **Locks files:** network_toy/app/src/ui/data-panel.js (`renderRealMode` ~L64–95 — the hardcoded "Real data" title + static `cfg.subset` label); reads network_toy/app/src/datasource/sqlite.js
- **Parallel-safe with:** any job not touching those files. NOT with: J02 (data-panel.js), J05/J09 (sqlite.js)
- **Order constraint:** after J02 (data-panel.js rewritten) and J05 (dataset identity available).

## Goal
The left-rail data panel currently shows a hardcoded "Real data" title and a static subset label (`cfg.subset`, e.g. `dev_subset_1000`, from the `SUBSETS` registry in `datasource/real.js`) plus the placeholder hint about opening the Data card. Make the panel reference the actual open dataset / connected DB(s) so it reflects what is really connected, surfacing the real source identity behind `datasource/sqlite.js` + `real.js`.

## Changes
- **network_toy/app/src/ui/data-panel.js** — in `renderRealMode` (~L64–95): replace the hardcoded "Real data" title and the static `cfg.subset` label with the real source identity drawn from the active dataset.
  - Read the active dataset identity from network_toy/app/src/datasource/sqlite.js (the dataset exposed via J05's `/api/datasets`).
  - Drop / update the placeholder hint ("Open the Data card in the workflow chart to load a subset…") so it reflects the connected state rather than the baked-in subset id.

## OPEN QUESTION (flag / confirm with user before implementing)
Confirm what "connected DB" identity to display: file/path, biblion DB name, subset, or all of these. Pick the display fields with the user before finalizing the panel copy.

## Verification
- In a real browser (Playwright / webapp-testing): connect/open a dataset and confirm the top-left data panel shows the actual source identity (per the confirmed fields) rather than "Real data" + a static `dev_subset_*` label.
- Switch the connected dataset (e.g. via J26's Databases dropdown) and confirm the panel updates to the new identity.
- Confirm the stale placeholder hint no longer shows when a dataset is connected.
