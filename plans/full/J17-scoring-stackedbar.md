# J17 — Scoring card mini stacked-bar of node scores

> **STATUS — DONE (Wave 0, run `wf_f1eccd83-aca`).** Branch `wave0/J17-scoring-mini-bar` · commit `90afc84`. Parse-checked; browser pass pending. Decisions made: bar reflects the SELECTED level (not pooled) and reads the card's COMMITTED scores (not live edits) — both need user confirmation.

- **Source plan:** `plans/ui-cleanup-plan.md` (Workflow cards — Scoring card: mini stacked-bar of node scores)
- **Wave:** 0
- **Depends on:** none — can start immediately
- **Locks files:** network_toy/app/src/ui/workflow-chart.js, possibly network_toy/app/src/ui/gradients.js
- **Parallel-safe with:** any job not touching workflow-chart.js. NOT with: J14/J15/J16 (workflow-chart.js)
- **Order constraint:** serialize with J14/J15/J16 on workflow-chart.js — J17 can go first since it is Wave 0; later chart jobs rebase.

## Goal
Add a small vertical stacked bar down the right-hand side of each scoring card in the workflow chart. Single bar (x = 1), y normalised 0-1, segments coloured by score value, each segment's height = the fraction of nodes (node-weighted, not cluster-weighted) whose cluster carries that score.

## Changes
Group by file.

- `network_toy/app/src/ui/workflow-chart.js`
  - In the card drawing for `step.type === "scoring"`, render the stacked bar on the right edge, like the queue badge (~L387).
  - Derive the distribution from the card's `result.scores[levelUid][clusterId]` (mirrored in `state.clusterScores`), mapped over cluster membership counts (node-weighted). Segment height = fraction of nodes whose cluster carries that score; normalise y to 0-1.
- `network_toy/app/src/ui/gradients.js`
  - Reuse an existing 1-5 score colour ramp if present. CHECK `ui/gradients.js` and `viewer-shared/colour-modes.js` first for an existing scale before adding a new one.

## Open questions to flag (confirm with user)
- Which level's scores the bar reflects: the selected level, or pooled across all scored levels. Confirm before finalising.

## Verification
Must be verified in a real browser (Playwright / webapp-testing), not just unit smoke.

- Open a workflow with a scoring card that has results: confirm a small vertical stacked bar renders on the card's right edge.
- Confirm segment colours map to score value (matching the reused 1-5 ramp) and the bar spans the normalised 0-1 height.
- Confirm segment heights are node-weighted (a score carried by clusters with more member nodes occupies a proportionally larger segment), not cluster-weighted.
- Confirm the bar does not overlap/collide with the queue badge on the same right edge.
