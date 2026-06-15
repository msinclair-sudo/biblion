# J10 — Dynamic layout: draggable dividers, collapse rails, persisted UI-prefs

- **Source plan:** `plans/ui-cleanup-plan.md` (Layout / resizing — Draggable slot dividers + Persist layout + Collapse / expand rails)
- **Wave:** 2
- **Depends on:** J01 (only if persisting layout into the project save via `persistence/serialise.js`; see persistence decision below). If localStorage-only, J01 dependency drops.
- **Locks files:** network_toy/app/styles/main.css (the `#layout` grid vars `--left-rail-w` / `--right-rail-w` / `--bottom-h`), network_toy/app/src/ui/state.js (new UI-prefs slice), network_toy/app/src/persistence/serialise.js (ONLY if persisting into the project save), new splitter-handle code (likely network_toy/app/src/ui/main.js or a new module), network_toy/app/index.html (handle elements)
- **Parallel-safe with:** any job not locking those files. NOT with: J01 (serialise.js if chosen), J02/J09/J14/J25 (state.js), J11/J12/J22 (main.css)
- **Order constraint:** after J01 iff using `serialise.js`. Splitter drag must write computed sizes back to the CSS vars. Call out the persistence target explicitly (see below).

## Goal
Make the shell layout user-adjustable: draggable dividers between the left rail / primary / secondary slots and above the bottom row, collapse/expand toggles to reclaim space for the viewer, and persistence so the chosen layout survives reload. The layout state lives in a UI-prefs slice and is reflected through the existing `#layout` CSS grid variables.

## Changes
- **network_toy/app/styles/main.css** — the `#layout` grid is driven by `--left-rail-w` / `--right-rail-w` / `--bottom-h`; splitter drags write the live size back to these vars. Add CSS for the splitter handles (hit area, cursor, hover affordance) and for the collapsed-rail state (rail width → 0 / a thin re-expand stub).
- **network_toy/app/src/ui/state.js** — add a UI-prefs slice holding rail/slot sizes and per-rail collapsed booleans; expose getters/setters the splitter code and toggles call.
- **Splitter-handle code (network_toy/app/src/ui/main.js or new module)** — pointer-drag handlers for each divider (left-rail | primary | secondary, and the bottom-row divider); clamp to sane min/max; on drag, set the corresponding CSS var on `#layout` and update the UI-prefs slice. Add collapse/expand toggle buttons per rail.
- **network_toy/app/index.html** — add the divider handle elements between the slots and above the bottom row, plus the rail collapse toggles.
- **Persistence (DECIDE + document in the file header):**
  - Option A — localStorage UI-prefs blob: write the slice to localStorage on change, hydrate on boot. No `serialise.js` touch, so the J01 dependency drops. Layout is per-browser, not per-project.
  - Option B — project save via network_toy/app/src/persistence/serialise.js: fold rail/slot sizes + collapsed state into the saved project. Requires J01 first (shared file). Layout travels with the project.
  - Recommend Option A unless the user wants layout to travel with saved projects; record the chosen option at the top of this job.

## Verification
- In a real browser (Playwright / webapp-testing): drag each divider and observe the adjacent slots resize live; confirm the matching `--left-rail-w` / `--right-rail-w` / `--bottom-h` value on `#layout` changes.
- Toggle each rail collapsed then expanded; confirm the viewer reclaims the space and the rail returns to its prior width.
- Reload the page; confirm sizes and collapsed state are restored (localStorage for Option A; via a saved/reloaded project for Option B).
- Confirm drags clamp at the min/max and do not let a slot collapse to an unusable size unintentionally.
