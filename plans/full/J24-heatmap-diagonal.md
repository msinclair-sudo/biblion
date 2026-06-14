# J24 — Cross-citation heatmap excludes the diagonal

> **STATUS — DONE (Wave 0, run `wf_f1eccd83-aca`).** Branch `wave0/J24-heatmap-exclude-diagonal` · commit `2a0e19e`. Parse-checked; browser pass pending. Diagonal disabled via `cellEnabled` + vmax recomputed over off-diagonal cells; normalised-view row total also excludes the diagonal.

- **Source plan:** `plans/ui-cleanup-plan.md` (Panels / charts — "Cross-citation heatmap excludes the diagonal")
- **Wave:** 0
- **Depends on:** none — can start immediately
- **Locks files:** network_toy/app/src/ui/panels/cross-cluster.js
- **Parallel-safe with:** everything (own file). Uses the existing `cellEnabled` predicate in `charts/heatmap.js` — no edit there.
- **Order constraint:** none.

## Goal
The cross-cluster matrix currently renders within-cluster citations on the diagonal (cluster i → cluster i), which dominates the colour scale. Suppress the diagonal so only cross-cluster flows show, and rescale to off-diagonal cells.

## Changes
- `panels/cross-cluster.js` — at the `renderHeatmap` call: pass `cellEnabled: (r, c) => r !== c` (the predicate already exists in `charts/heatmap.js`; no change needed there).
- `panels/cross-cluster.js`: recompute `vmax` over off-diagonal cells only, so the scale isn't dominated by the intra-cluster counts.
- Note: the data layer (`cross-cluster-citations.js`) already excludes the diagonal for degree metrics, so this is a render-side change only.

## Verification
- In a real browser, open the cross-citation heatmap and observe the diagonal cells (same-to-same) are blank/disabled.
- Confirm the colour scale now spreads across the off-diagonal cross-cluster counts (previously washed out) rather than being saturated by the diagonal.
