# J16 — Drop the cross-cluster-citations card (auto-fired, no config)

- **Source plan:** `plans/ui-cleanup-plan.md` (Workflow cards — Drop the cross-cluster-citations card)
- **Wave:** 3
- **Depends on:** J13, J15 (same files layer-descriptors.js + workflow-chart.js)
- **Locks files:** network_toy/app/src/ui/modals/layer-descriptors.js, network_toy/app/src/ui/workflow-chart.js, network_toy/app/src/ui/workflow-projection.js
- **Parallel-safe with:** any job not touching those files. NOT with: J13/J15 (layer-descriptors.js), J14/J15/J17 (workflow-chart.js)
- **Order constraint:** after J13 and J15.

## Goal
`crossClusterCitations` is auto-spawned after the layer ladder commits and takes no configuration, so it is a wasted node in the workflow tree. Surface its result as an auto-opened panel reading `state.crossClusterCitations` instead of a card, and re-anchor the labelling node (currently a child of the crossCluster card) back to the clustering card.

## Changes
Group by file.

- `network_toy/app/src/ui/modals/layer-descriptors.js`
  - Remove the auto-spawn of the crossClusterCitations card after the layer ladder commits (~L1081-1103) and the no-op `crossClusterDescriptor.applyChange()` (~L1337).
  - The crossCluster card currently doubles as a tree attach-point: labelling is bumped to become a child of it (~L1152-1153, L1284). Re-anchor labelling back to the clustering card when the crossCluster card goes away.
- `network_toy/app/src/ui/workflow-projection.js`
  - The projection already populates `state.crossClusterCitations` (~L138-145). Keep that population; the result is now read by an auto-opened panel rather than a card.
- `network_toy/app/src/ui/workflow-chart.js`
  - Remove any chart drawing/edges specific to the crossCluster card now that it is gone.
- Wire an auto-opened panel that reads `state.crossClusterCitations` to surface the result (replacing the card).

## Verification
Must be verified in a real browser (Playwright / webapp-testing), not just unit smoke.

- Commit a layer ladder: confirm NO cross-cluster-citations card appears in the workflow tree.
- Confirm the cross-cluster result is surfaced via an auto-opened panel reading `state.crossClusterCitations`.
- Confirm the labelling node is now a child of the clustering card (lineage edge re-anchored), not orphaned or pointing at a missing crossCluster card.
- Confirm no dangling edges or broken nodes remain in the chart where the card used to be.
