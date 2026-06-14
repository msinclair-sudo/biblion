# J12 — Shared widget / field-row kit + one spacing/affordance language

- **Source plan:** `plans/ui-cleanup-plan.md` (Menus / navigation — Standardise modals / panels / menus on shared resources)
- **Wave:** 4 (LAST — touches the most surfaces; rebase onto everything else)
- **Depends on:** most other UI jobs. Run after they land so the kit absorbs their final shapes rather than fighting them (notably the modal/panel jobs: J11, J26, J27, and the panel/chart jobs that touch main.css).
- **Locks files:** a new shared widget module (e.g. network_toy/app/src/ui/widgets.js), network_toy/app/styles/main.css (consolidate the many one-off `grid-template` blocks), plus incremental refactors across network_toy/app/src/ui/modals/* and network_toy/app/src/ui/panels/* (migrate file-by-file — do NOT big-bang)
- **Parallel-safe with:** very little while it migrates shared CSS. Schedule it solo at the end.
- **Order constraint:** last. The base contracts already exist (`modals/modal.js` `openModal`; `panels/registry.js` `mount → {update, destroy}`); build on them, do not replace them.

## Goal
Code-cleanup item, no behaviour change. Each modal and panel currently hand-rolls its own form controls (selectors, toggles, sliders, label/field rows) and bespoke `grid-template` CSS (dozens of one-off grids in `styles/main.css`). Extract a small shared widget / field-row kit plus one spacing/affordance language so menus, modals, and panels are built from the same pieces — cutting duplication and making new panels/modals cheap and consistent.

## Changes
- **New shared widget module (network_toy/app/src/ui/widgets.js)** — extract reusable builders: field-row (label + control), selector/dropdown, toggle, slider. They sit on top of the existing `modals/modal.js` `openModal` and the `panels/registry.js` `mount → {update, destroy}` contracts — do not change those contracts.
- **network_toy/app/styles/main.css** — define one spacing/affordance language (consistent gaps, label widths, control sizing) and consolidate the many one-off `grid-template` rules into the shared field-row/grid classes the kit emits. Remove per-modal/per-panel duplicate grids as each surface migrates.
- **network_toy/app/src/ui/modals/* and network_toy/app/src/ui/panels/*** — migrate file-by-file to the kit. Each migration: swap hand-rolled controls for the shared builders, drop that file's bespoke grid CSS. No behaviour change — same controls, same wiring, just built from shared pieces.

## Verification
- In a real browser (Playwright / webapp-testing): open each migrated modal and panel; confirm controls render and function identically to before (same selectors/toggles/sliders, same effects) — pure refactor, no behaviour change.
- Visually confirm consistent spacing and affordances across migrated surfaces (uniform field-row gaps and label/control alignment).
- Confirm the consolidated CSS removed the old one-off `grid-template` blocks for migrated files without breaking layout.
- Migrate and verify one file at a time; do not land a big-bang change.
