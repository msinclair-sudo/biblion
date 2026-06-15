# J04 — Cluster labelling improvements (paper-df banding + scoring-panel visibility)

> **STATUS — DONE (Wave 0, run `wf_f1eccd83-aca`).** Branch `wave0/J04-cluster-labelling-paper-df` · commit `39fe06f`. Node tests green. New scoring-panel controls have no CSS yet (main.css out of lock) — follow-up CSS pass needed. Browser eyeball pending.

- **Source plan:** `plans/labelling-improvement-plan.md` (whole file)
- **Wave:** 0
- **Depends on:** none — can start immediately
- **Locks files:** network_toy/app/src/labelling/cluster-labels.js, network_toy/app/src/ui/panels/scoring.js, network_toy/tests/test_cluster_labels.py, network_toy/tests/test_labelling_card.py, plus a new Node .test.mjs
- **Parallel-safe with:** any job not touching those files. NOT with: J23 (ui/panels/scoring.js)
- **Order constraint:** before J23 on scoring.js (J04 → J23). The new Node .test.mjs ties into J03's Tier-0 structure.

## Goal
Keep the banded label approach (anchor → broad → mid → specific → signature) but swap the banding axis from cluster-df to corpus/paper-df — the validated fix for "mid/specific reads too specific," since collection/corpus-df is the validated specificity signal while cluster/class-df is unvalidated and near-random for general terms. Add a modest support floor before banding, and add scoring-panel visibility controls (a per-panel method dropdown defaulting to combined, plus a per-cluster show-more expander). This is explicitly NOT a rewrite to continuous-spread selection; the bake-off and the IC/hierarchy-depth altitude axis are deferred and out of scope.

## Changes

### Change A — `cluster-labels.js`
- **Band on paper-df, not cluster-df.** Add a per-node pass counting how many *papers* contain each term, and feed that paper-df into the existing `bandEdges` (line 436) / `bandOf` (line 450) in place of the cluster-df map. Same band names, same log-spacing over `[2 .. maxDf]`, `signature` still `df==1` — only the banding axis changes, giving a finer/smoother ruler so `mid`/`specific` stop collapsing onto cluster-unique jargon.
- **Keep c-TF-IDF for relevance ranking.** The relevance scoring that picks *which* terms enter the bands is untouched — only the banding axis moves to paper-df.
- **Modest minimum support floor.** Before banding, drop terms below a small corpus-scaled floor (frequency-1, and terms in <~0.5–1% of papers). Keep it modest — removing very-low-frequency terms has negligible impact and aggressive pruning was refuted, so do not over-trim the specific tail. Keep `looksJunk` (multilingual/number filter) as the second pass.
- **Comment fixups.** Soften "Zipfian" → "heavy-tailed" where the file justifies the log-spacing (distributions are heavy-tailed but not reliably Zipfian); note that paper-df is now the band axis and why.
- **Leave untouched:** MMR diversity, `STRAT_PER_BAND`, the band set, the multi-method registry, n-grams, and `combine()`.

### Change B — `ui/panels/scoring.js`
- **Method dropdown** (panel-level, in the panel header) to pick which labelling method to display, defaulting to the preferred/combined method, instead of stacking every method per cluster (current lines 235–270). Method list comes from `labels.methods` (already returned by `labelClusters`). Persist the choice in the panel's tab config via `setTabConfig` so it sticks across renders.
- **Per-cluster show-more expander** that reveals the full per-band terms in `v.bands[b]` beyond the top `STRAT_PER_BAND` (3) summary — toggle between the top-3 summary and the full lists. No new data needed; terms are already computed, just not all rendered.
- **Leave untouched:** the one-line-per-band layout (lines 254–261) and the 1–5 scoring control. This is purely a visibility/affordance addition.

## Verification
- Support floor drops sub-threshold terms before banding.
- With paper-df as the axis, a corpus-common term lands in a more-general band than a cluster-unique term (re-home the intent of `test_cluster_labels.py::test_stratified_bands`, line 123 — band *names* unchanged so structural assertions mostly hold; update fixture expectations only if placements shift).
- New Node `.test.mjs` (pure-logic, ties into J03 / `plans/test-suite-plan.md` Tier 0) asserts the support-floor drop and the paper-df band-ordering behaviour.
- Scoring panel: the method dropdown switches the displayed labels; "show more" reveals additional terms per band. Extend `test_labelling_card.py::test_scoring_panel_renders_banded_labels_multiline` (line 187) to cover both.
- Eyeball fallworm cluster labels: `mid` reads as a real sub-topic, `specific` as distinguishing content, with less df==1 noise. (Optional `scratch/label_overlap/` band-fill CSV sanity check — not required this pass.)
- No regression in `representative` / `year` / flat `cTfidf` / `keybert` methods — only the banded methods' axis and the panel rendering changed.
