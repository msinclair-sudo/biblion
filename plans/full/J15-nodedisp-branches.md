# J15 — Node-displacement branches from pre + post fusion

- **Source plan:** `plans/ui-cleanup-plan.md` (Workflow cards — Node-displacement branches from pre + post fusion)
- **Wave:** 3
- **Depends on:** J13 (same file layer-descriptors.js; node-disp lineage builds on the fusion branch cards J13 makes eager)
- **Locks files:** network_toy/app/src/ui/modals/layer-descriptors.js, network_toy/app/src/ui/workflow-chart.js
- **Parallel-safe with:** any job not touching those files. NOT with: J13/J16 (layer-descriptors.js), J14/J16/J17 (workflow-chart.js)
- **Order constraint:** after J13; serialize with J14/J16/J17 on workflow-chart.js.

## Goal
In the workflow viewer, make the node-displacement card visually branch off the pre- and post-fusion branch cards (two incoming edges) instead of hanging off the dimred card. Keep the auto-spawn behavior.

## Changes
Group by file.

- `network_toy/app/src/ui/modals/layer-descriptors.js`
  - `nodeDisplacementDescriptor` (~L563-570) currently sets `parentId: dimredId` (solid spine edge from dimred) with `refIds: [preId, postId]` shown only as dashed cross-edges. Make the lineage read from the two fusion branches: re-parent / promote the ref-edges to the primary branching edges, given the single-`parentId` tree model (decide how to represent two incoming edges within that model).
  - Keep `spawnNodeDispIfMissing` auto-spawn (runs once both branches exist) so the card auto-loads alongside the pre/post fusion cards.
- `network_toy/app/src/ui/workflow-chart.js`
  - Chart draws solid `parentId` edge (~L167) and dashed `refIds` edges (~L187). Adjust drawing so node-disp shows two incoming edges from the pre- and post-fusion branch cards as primary (solid) lineage rather than one solid dimred edge plus dashed refs.

## Verification
Must be verified in a real browser (Playwright / webapp-testing), not just unit smoke.

- Run a workflow with a non-identity fusion fork: confirm the node-displacement card visually branches off BOTH the pre- and post-fusion branch cards (two incoming edges), not off the dimred card.
- Confirm the node-disp card still auto-spawns once both fusion branches exist (no manual add needed).
- Confirm the edges are drawn as the primary lineage to node-disp (not the old solid-from-dimred + dashed-refs layout).
