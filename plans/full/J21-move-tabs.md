# J21 — Move/pop tabs between slots

> **STATUS — DONE (Wave 0, run `wf_f1eccd83-aca`).** Branch `wave0/J21-move-pop-tabs` · commit `0a4c3eb`. Parse-checked; browser pass pending. `moveTab` wired via drag + context menu; singleton guard enforced.

- **Source plan:** `plans/ui-cleanup-plan.md` (Panels — "Move/pop tabs between slots")
- **Wave:** 0
- **Depends on:** none — can start immediately
- **Locks files:** network_toy/app/src/ui/panel-system.js (and network_toy/app/src/ui/panels/registry.js if needed)
- **Parallel-safe with:** everything (own file)
- **Order constraint:** none. Respect the singleton constraint (viewer-2d / viewer-3d cannot be duplicated or moved into a conflicting state).

## Goal
Let the user move a tab to another slot (primary / secondary / bottom), either by drag or a context action. Tabs that are singletons (viewer-2d, viewer-3d) must not be duplicated or end up in a state where two slots claim the same singleton.

## Changes
- `ui/panel-system.js`: add a move/pop operation that detaches a tab from its current slot and re-adds it to a target slot. Reuse the existing add/remove tab plumbing rather than rebuilding panels.
- Enforce the singleton constraint before completing a move: if the tab is a singleton viewer and the target already hosts it, reject the move (no duplication).
- `panels/registry.js` (only if needed): consult/extend registry metadata to know which panel ids are singletons.

## Verification
- In a real browser, move a non-singleton tab (e.g. cart or scoring) from one slot to another via the drag/context action and observe it appears in the new slot and is gone from the old one.
- Attempt to move/duplicate viewer-3d into a slot that conflicts and observe the move is refused (only one viewer-3d exists; no broken/blank duplicate panel).
