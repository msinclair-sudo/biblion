# J22 — "Pick layers" panel: single-column stack, not side-by-side

> **STATUS — DONE (Wave 0, run `wf_f1eccd83-aca`).** Branch `wave0/J22-pick-layers-single-column` · commit `ecc62d5`. Parse-checked; browser pass pending. Block order used: heatmap → curve+selector → layers-info → Apply/Clear — confirm with user.

- **Source plan:** `plans/ui-cleanup-plan.md` (Panels / charts — '"Pick layers" panel: single-column stack, not side-by-side')
- **Wave:** 0
- **Depends on:** none — can start immediately
- **Locks files:** network_toy/app/src/ui/panels/multilayer-curve.js, network_toy/app/styles/main.css
- **Parallel-safe with:** any job not touching those. The css block (`multilayer-curve-body`) is distinct from other css jobs, but coordinate with J10/J11/J12 which also edit main.css.
- **Order constraint:** none.

## Goal
The multi-layer picker ("Pick layers", `panels/multilayer-curve.js`) renders a two-column body (LEFT reproducibility/stability curve + selector, RIGHT bridge heatmap) with the picked-layer readout below. Restack everything into a single column / single row so the blocks flow vertically rather than side by side.

## Changes
- `styles/main.css`: change the `multilayer-curve-body` two-column layout rules to a single-column stacked flow (drop the grid/flex side-by-side columns).
- `panels/multilayer-curve.js` — `mount()`: reorder the host so the four blocks are appended in one vertical stack: heatmap, reproducibility curve + selector, layers-information display, Apply/Clear buttons.

## OPEN QUESTION to flag
- Confirm the exact vertical order of the four blocks (heatmap, reproducibility curve + selector, layers-info, Apply/Clear) with the user before finalising.

## Verification
- In a real browser, open the "Pick layers" panel and observe all four blocks stack in a single column (no LEFT/RIGHT split), in the agreed order.
- Resize the panel narrow and confirm nothing reverts to two columns or overflows horizontally.
