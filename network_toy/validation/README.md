# Validation scripts

Research / methodology validation scripts that produce evidence
shipped in the project (typically writing to `doc/*-results.md`).

**This directory is tracked in git** — unlike `scratch/` which is
gitignored. The split is intentional:

- `scratch/` — disposable smoke tests, debugging harnesses,
  one-off explorations. Per the project's memory rule, smoke tests
  use toy fixtures only (no real-data ingest) so they're fast +
  cheap to run on every change.
- `validation/` — research scripts that produce evidence the
  project depends on for methodological defensibility (e.g. the
  §6.9 dim-sweep that justifies the locked compression default).
  These typically use real-data fixtures and take minutes to run,
  not seconds. They're not part of CI; they get re-run when a
  default needs re-validating against a new fixture or algorithm.

Each script's docstring explains its protocol + how to run it.
Each writes a corresponding `doc/<topic>-results.md` so the
verdict travels with the project even when the script isn't
re-run.

## Current scripts

| Script | Plan section | What it validates |
|--------|--------------|-------------------|
| `dim_sweep_validation.py` | §6.9 | Is UMAP-50 enough compression, or does it lose clustering structure? (Answer: 50 is too small; default bumped to 100.) |
| `compression_redundancy_check.py` | §6.9 follow-up | Is UMAP-after-PCA redundant since PCA-100 is already 100-d? (Answer: no — UMAP does essential manifold reshape; without it HDBSCAN finds only 2 clusters.) |

## Pattern for adding a new validation

1. Write a script that drives the live app via Playwright
   (boot, configure layerParams, run engine, capture results).
2. Use real-data fixtures via the data-source registry; document
   any fixture-specific tuning (e.g. `min_cluster_size` adjusted
   for n=5000).
3. Compute verdict + write the result to
   `doc/<topic>-results.md` from the script so the doc stays in
   sync with re-runs.
4. Cross-link the results doc from `doc/plan.md` in the section
   that motivated the validation.
