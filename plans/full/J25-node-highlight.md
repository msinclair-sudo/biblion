# J25 — Node-highlight framework (coloured glow, multi-source)

- **Source plan:** `plans/ui-cleanup-plan.md` (Viewer framework — "Node-highlight framework (coloured glow, multi-source)")
- **Wave:** 4
- **Depends on:** J09 (folds the SQL-search `searchMatches` in as a highlight consumer); J04/J23 (scoring-panel card-select consumer)
- **Locks files:** network_toy/app/src/ui/state.js, network_toy/app/src/ui/viewer-shared/colour-modes.js, network_toy/app/src/ui/panels/viewer-3d.js, network_toy/app/src/ui/panels/viewer-2d.js, plus the scoring-panel hook
- **Parallel-safe with:** any job not touching those. NOT with: J02/J09/J10/J14 (state.js), J02/J09 (colour-modes.js), J19/J20 (viewer-3d.js)
- **Order constraint:** late — after J09 and after J04/J23.

## Goal
Add a general node-highlight framework: viewers highlight nodes with a coloured glow driven by highlight *requests* from any source (not bound to one caller). First consumers are scoring-panel card selection (Ctrl+click to multi-select, additive) and the SQL search bar (query results highlighted). It is a shared highlight channel distinct from the single-`state.selection` dim mechanism.

## Changes
- `ui/state.js` (~slice near other view state): add a `state.highlights` slice — sets of node ids, each tagged with a colour/source, supporting multiple concurrent groups — plus a small API `addHighlight(source, nodeIds, colour)` / `clearHighlight(source)`. Plain click replaces; Ctrl+click adds. Keep this **in-memory only** — never serialise into project save.
- `ui/viewer-shared/colour-modes.js`: extend the shared colour resolver to compose a halo/emissive glow layer additively over the current colour mode, alongside the existing `nodeMatchesSelection` / selection-dim. It is additive (a glow layer), not a recolour.
- `panels/viewer-3d.js` and `panels/viewer-2d.js`: render the glow in both viewers via the shared resolver. Updates must hit a **cheap render path** (toggle a glow/emissive attribute on existing node objects), NOT `rebuildData()` or any engine recompute.
- Scoring-panel hook (J04/J23 surface): card select → `addHighlight("scoring", nodeIds, colour)`; Ctrl+click adds. SQL-search (J09 `searchMatches`) → `addHighlight("search", ...)`.

## NOTES / OPEN QUESTION to flag
- Purely visual, in-memory, must update at interaction speed.
- Define how the glow composes with the current selection-dim (does dim still apply to non-highlighted, etc.) — confirm with the user.

## Verification
- In a real browser, select a card in the scoring panel and observe its nodes glow in both the 2D and 3D viewers; Ctrl+click another card and confirm the highlight is additive (both groups glow); plain click replaces.
- Run a SQL search and observe matching nodes glow via the same channel.
- Watch performance: highlight toggles should be instant (no full rebuild / layout recompute) on a large graph.
- Save and reload the project; confirm highlights are NOT persisted.
