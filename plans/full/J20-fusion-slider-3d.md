# J20 — Fusion slider → into the 3D viewer (bottom-left, vertical)

- **Source plan:** `plans/ui-cleanup-plan.md` (Panels — "Fusion slider → into the 3D viewer (bottom-left, vertical)")
- **Wave:** 4
- **Depends on:** J19 (shares `ui/main.js` + `panels/viewer-3d.js`)
- **Locks files:** network_toy/app/src/ui/main.js, network_toy/app/src/ui/panels/viewer-3d.js
- **Parallel-safe with:** any job not touching those. NOT with: J14/J19 (main.js), J19/J25 (viewer-3d.js)
- **Order constraint:** after J19. Keep the show/hide-on-`_basePosPreFusion` gating and the `setFusionBlend` wiring; relocate as a bottom-left vertical overlay.

## Goal
The fusion-blend slider currently lives outside the viewer. Move it into the 3D viewer panel, anchored bottom-left and oriented vertically, so it sits over the layout it blends.

## Changes
- `ui/main.js` — `mountFusionBlendSlider` (~L65): stop wiring `#fusion-blend-row` / `#fusion-blend-slider` / `#fusion-blend-readout` outside the viewer. Mount the input inside the viewer instead; keep the `setFusionBlend` / `state.fusionBlend` writes and keep showing the control only when `_basePosPreFusion` exists.
- `panels/viewer-3d.js`: add a bottom-left, vertically-oriented overlay host for the relocated slider + readout.

## Verification
- In a real browser, load a project with a fused layout (so `_basePosPreFusion` exists) and confirm the fusion slider appears as a vertical control anchored bottom-left of the 3D viewer.
- Drag the slider and observe the fusion blend changes and the readout updates (confirming `setFusionBlend` wiring).
- Load a project without fusion and confirm the slider is hidden (gating intact).
