# J23 — Scoring panel: add-to-cart + paper count + sort-by control

- **Source plan:** `plans/ui-cleanup-plan.md` (Panels / charts — "Scoring cluster blocks: add-to-cart button + paper count" AND "Scoring panel: sort-by control for cluster columns"; combined — same file)
- **Wave:** 4
- **Depends on:** J04 (shares `ui/panels/scoring.js`)
- **Locks files:** network_toy/app/src/ui/panels/scoring.js (and reads `addToCart` helper in network_toy/app/src/ui/state.js ~L425)
- **Parallel-safe with:** any job not touching scoring.js. NOT with: J04 (scoring.js)
- **Order constraint:** after J04.

## Goal
On the scoring board, add per-cluster-block actions and a column sort. Each cluster block gets an Add-to-cart button (pushing that cluster's real papers) and a visible paper count; the board gets a sort-by control for ordering cluster blocks.

## Changes
- `panels/scoring.js` — `renderClusterBlock` (~L205–311):
  - (1) add an **Add to cart** button that maps the cluster's `members` node indices to their `paperId`s (excluding ghosts) and pushes via the existing `addToCart` helper (`state.js` ~L425).
  - (2) show the **paper count**. A count already renders as `Cluster {id} · {count}` (~L222–223) from `members.length || count`.
- `panels/scoring.js`: add a **sort-by** selector for the cluster columns. Options: Default (current order), Score descending, Score ascending, Un-scored first. Scores come from the card's `result.scores[levelUid][clusterId]`. Suggest a single **board-wide** control.

## OPEN QUESTIONS to flag
- (a) Is the wanted "paper count" distinct from the existing `members.length` count (e.g. real-papers-only, excluding ghost nodes), or just a relabel?
- (b) Target surface: these scoring **panel** cluster blocks vs. the workflow-chart scoring card?
- (c) Sort per-column or board-wide? (suggest board-wide single control)

## Verification
- In a real browser, click Add to cart on a cluster block and confirm only that cluster's real papers (no ghosts) appear in the cart.
- Observe each block shows the paper count.
- Change the sort-by control and observe cluster blocks reorder accordingly (Default / Score desc / Score asc / Un-scored first).
