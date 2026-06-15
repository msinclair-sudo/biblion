# J19 — Edge colour/toggle controls → 3D viewer settings popup

- **Source plan:** `plans/ui-cleanup-plan.md` (Panels — "Edge colour/toggle controls → 3D viewer settings")
- **Wave:** 4
- **Depends on:** J14 (shares `ui/main.js` + `index.html`)
- **Locks files:** network_toy/app/src/ui/main.js, network_toy/app/src/ui/panels/viewer-3d.js, network_toy/app/src/index.html
- **Parallel-safe with:** any job not touching those. NOT with: J14/J20 (main.js), J20/J25 (viewer-3d.js), J14 (index.html)
- **Order constraint:** after J14 on main.js/index.html; before J20 on viewer-3d.js (J19 → J20). Keep the `setView` wiring; only relocate the inputs.

## Goal
The edge controls (citation/base/structure toggles, arrows, opacity/density sliders, colour pickers) currently sit at the bottom of the left rail. Move them into the 3D viewer's existing settings popup so they live with the controls they affect, freeing left-rail space.

## Changes
- `ui/main.js` — `mountEdgeControls` (~L100): stop mounting into the left-rail `edge-controls` container; mount the same `ec-*` inputs into the viewer settings overlay host. Preserve every `setView` write so `state.view` updates are unchanged.
- `panels/viewer-3d.js` — `buildSettingsOverlay` / gear button (~L125): expose a host element inside the settings popup for the relocated edge controls.
- `index.html` — move the `ec-*` elements + the `edge-controls` container out of the left rail (or remove the left-rail container if the inputs are now built inside the overlay).

## Verification
- In a real browser, open the 3D viewer settings popup (gear) and confirm the edge controls (toggles, arrows, opacity/density sliders, colour pickers) appear there.
- Toggle each control and observe the corresponding edge rendering changes (citation/base/structure visibility, arrows, opacity/density, colours) — confirming `setView` wiring still works.
- Confirm the left rail no longer shows the edge controls block.
