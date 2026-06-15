# J11 — Dimred modal: default profile + two-column layout

> **STATUS — DONE (Wave 0, run `wf_f1eccd83-aca`).** Branch `wave0/J11-dimred-default-two-column` · commit `622cfa5`. Parse-checked; browser pass pending. Note: modal now always opens on the default preset and ignores an edited card's stored params — confirm desired for the edit-existing-card case.

- **Source plan:** `plans/ui-cleanup-plan.md` (Menus / navigation — Dim-reduction modal: default profile + two-column layout)
- **Wave:** 0
- **Depends on:** none — can start immediately
- **Locks files:** network_toy/app/src/ui/modals/dimred-modal.js (`renderSection`), network_toy/app/styles/main.css (`dimred-modal-*` rules)
- **Parallel-safe with:** any job not touching those files. main.css is shared with J10/J12/J22 — touch only the `dimred-modal-*` rule block (distinct from their rule blocks); flag the overlap when scheduling.
- **Order constraint:** none.

## Goal
Two changes to the dim-reduction modal so users are not configuring every stage by hand and so the modal reads clearly: (1) ship a sensible default preset across the stages (noise / fusion / compression / viz / viz2d) as the initial state plus a "Reset to default" affordance; (2) restructure the modal into two columns — algorithm pickers on the left, the selection-specific description and sliders/params on the right, driven by the focused selection.

## Changes
- **network_toy/app/src/ui/modals/dimred-modal.js** — today `renderSection` stacks title → description → algorithm `select` → params vertically per stage.
  - Default profile: define a default preset of stage selections covering noise / fusion / compression / viz / viz2d; apply it as the modal's initial state. Add a "Reset to default" control that restores the preset.
  - Two-column layout: render the algorithm pickers (one per stage) in a LEFT column; render the description text + sliders/params for the currently focused/active selection in a RIGHT column. Selecting/focusing a stage on the left drives what the right column shows.
- **network_toy/app/styles/main.css** — extend the `dimred-modal-*` rules with the two-column grid (left pickers / right detail pane) and styling for the "Reset to default" control. Keep edits inside the `dimred-modal-*` block to avoid colliding with J10/J12/J22.

## Verification
- In a real browser (Playwright / webapp-testing): open the dimred modal cold and confirm every stage already has a sensible default selected (no empty/unconfigured stages).
- Change several selections, click "Reset to default", confirm all stages return to the preset.
- Confirm the layout is two columns: pickers on the left, description + sliders/params on the right.
- Focus/select different stages on the left and confirm the right column updates to that selection's description and params.
