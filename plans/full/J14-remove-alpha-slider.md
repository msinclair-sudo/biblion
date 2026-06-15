# J14 — Remove the alpha (blend) slider

- **Source plan:** `plans/ui-cleanup-plan.md` (Workflow cards — Remove the alpha (blend) slider)
- **Wave:** 2
- **Depends on:** J02 (state/migration settled)
- **Locks files:** network_toy/app/src/index.html (verify vs app/index.html — the `#blend-slider` / `#blend-readout` host), network_toy/app/src/ui/main.js, network_toy/app/src/ui/state.js, network_toy/app/src/ui/workflow-chart.js, network_toy/app/src/ui/workflow-projection.js, network_toy/app/src/ui/workflow-migration.js
- **Parallel-safe with:** any job not touching those files. NOT with: J17/J15/J16 (workflow-chart.js), J19 (index.html + main.js), J02/J09/J10/J25 (state.js)
- **Order constraint:** after J02 (state.js settled). Check persistence/migration shims don't choke on saved states carrying an `alpha`/`blend` value.

## Goal
Remove the topbar alpha/blend slider, which is no longer used. Keep the separate fusion-blend slider (`mountFusionBlendSlider`, `#fusion-blend-slider`, `setFusionBlend`) — that one is still in use.

## Changes
Group by file.

- `network_toy/app/src/index.html` (verify path)
  - Remove the `#blend-slider` and `#blend-readout` elements (and any wrapping row).
- `network_toy/app/src/ui/main.js`
  - Remove `mountBlendSlider` (~L37) and its call site. Do NOT touch `mountFusionBlendSlider`.
- `network_toy/app/src/ui/state.js`
  - Remove `setBlend` and `state.blend` (~L515). Keep `setFusionBlend` / `state.fusionBlend`.
- `network_toy/app/src/ui/workflow-chart.js`
  - Remove the `blend` step `alpha = ...` label (~L597).
- `network_toy/app/src/ui/workflow-projection.js` and `network_toy/app/src/ui/workflow-migration.js`
  - Remove the `alpha` handling.
- Persistence/migration: ensure loading a saved state that still carries an `alpha`/`blend` value does not error (drop the key gracefully).

## Verification
Must be verified in a real browser (Playwright / webapp-testing), not just unit smoke.

- Load the app: confirm the alpha/blend slider is gone from the topbar and the fusion-blend slider still renders and works.
- Load a saved/persisted state that carried an `alpha`/`blend` value: confirm no console error and the app loads cleanly.
- Confirm the workflow chart no longer renders the `alpha = ...` blend-step label.
