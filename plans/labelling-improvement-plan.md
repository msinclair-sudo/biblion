# Cluster labelling — modest improvements + scoring-panel visibility

## Context & scope decision

The stratified ("banded") label methods in
`network_toy/app/src/labelling/cluster-labels.js` describe each cluster across
specificity altitudes — `anchor → broad → mid → specific → signature` — by
bucketing candidate terms on their **cluster document-frequency** (`df` = how
many of the ~50 clusters contain the term; `bandEdges` line 436, `bandOf` line
450), log-spaced over `[2 .. maxDf]`; `signature` is `df==1`. Symptom: the `mid`
and `specific` bands read "a bit too specific."

**Decision (user):** keep the current banded approach — it's working well enough.
**Do not** rewrite to a continuous-spread mechanism and **do not** run the ruler
bake-off. Just apply the cheap, safe improvements the research surfaced, and add
a way to **see more of the labels in the scoring panel** (a method dropdown +
"show more"). Leave it there.

Research is done: brief + verified result are in the vault
(`PhD/biblion/research/results/term-specificity-labelling-result.md`). The
take-aways that map to small, drop-in changes are below; the bigger findings
(continuous spread, IC/hierarchy-depth axis, a head-to-head bake-off) are
**deferred — out of scope** for this pass.

## Change A — modest tweaks to `cluster-labels.js`

Keep the 5-band log-spaced structure, the multi-method registry, c-TF-IDF /
KeyBERT-MMR relevance scoring, n-grams, and `combine()`. Three localized edits:

1. **Band on corpus/paper document-frequency instead of cluster df.** This is the
   actual fix for "too specific" and is a small swap: add a per-node pass counting
   how many *papers* contain each term, and feed that paper-df into the existing
   `bandEdges`/`bandOf` instead of the cluster-df map. Same band names, same
   log-spacing — just a finer, smoother ruler so `mid`/`specific` stop collapsing
   onto cluster-unique jargon. (Research: collection/corpus-df is the validated
   specificity signal; cluster/class-df is unvalidated as an altitude measure and
   is near-random for general terms.) Keep c-TF-IDF for the *relevance* ranking
   that picks which terms enter the bands — only the **banding axis** changes.
2. **Add a modest minimum support floor.** Before banding, drop terms with
   paper-support below a small corpus-scaled floor (frequency-1, and terms in
   <~0.5–1% of papers). Keep it modest — research found removing very-low-frequency
   terms has negligible impact and that aggressive pruning was refuted, so don't
   over-trim the specific tail. Keep `looksJunk` (multilingual/number filter) as
   the second pass.
3. **Comment fixups:** soften the "Zipfian" framing to "heavy-tailed" where the
   file justifies the log-spacing (distributions are heavy-tailed but not reliably
   Zipfian); note that paper-df is now the band axis and why.

Everything else in the method (MMR diversity, `STRAT_PER_BAND`, the band set,
`combine()`) stays as-is.

## Change B — scoring panel: see more labels

`ui/panels/scoring.js` currently stacks **every** method's labels per cluster
(lines 235–270), and each banded method prints one line per band showing only the
top `STRAT_PER_BAND` (3) terms. It's both cluttered and truncated. Add:

1. **A method dropdown** (panel-level, in the panel header) to pick which
   labelling method to display — defaulting to the preferred/combined method —
   instead of stacking all of them. The method list comes from `labels.methods`
   (already returned by `labelClusters`). Persist the choice in the panel's tab
   config via `setTabConfig` so it sticks across renders.
2. **A "show more" expander per cluster** that reveals more terms per band (beyond
   the top 3) — e.g. toggle between the top-3 summary and the full per-band term
   lists already present in `v.bands[b]`. No new data needed; the terms are
   already computed, just not all rendered.

Keep the one-line-per-band layout (lines 254–261) and the 1–5 scoring control
untouched; this is purely a visibility/affordance addition.

## Tests

- **Node `.test.mjs`** (pure-logic, ties into `plans/test-suite-plan.md` Tier 0):
  assert the support floor drops sub-threshold terms, and that with paper-df as
  the axis a corpus-common term lands in a more-general band than a cluster-unique
  term (re-home the intent of `test_cluster_labels.py::test_stratified_bands`).
- **Update** `test_cluster_labels.py::test_stratified_bands` (line 123) if its
  fixture's expected band placements shift under paper-df (the band *names* are
  unchanged, so the structural assertions mostly hold).
- **Scoring panel:** extend
  `test_labelling_card.py::test_scoring_panel_renders_banded_labels_multiline`
  (line 187) to cover the method dropdown (switching method changes the rendered
  labels) and the show-more expander (more terms appear when expanded).

## Verification

- Eyeball fallworm cluster labels in the scoring panel: with paper-df banding, the
  `mid` tier reads as a real sub-topic and `specific` as distinguishing content,
  with less df==1 noise than before. (Optional sanity check via the
  `scratch/label_overlap/` harness band-fill CSV — not required this pass.)
- Scoring panel: the method dropdown switches the displayed labels; "show more"
  reveals additional terms per band.
- No regression in `representative` / `year` / flat `cTfidf` / `keybert` methods —
  only the banded methods' axis + the panel rendering changed.

## Deferred (explicitly out of scope)

Continuous specificity-spread selection, an information-content / hierarchy-depth
altitude axis, and the cluster-df-vs-corpus-df-vs-IC bake-off. The research
rationale for these is recorded in the vault result note if revisited later.
