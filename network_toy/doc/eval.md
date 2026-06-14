# Eval — Optimise

Cluster-quality evaluation backs the **Optimise** tab of the
Clustering modal. Engine code lives in `app/src/eval/`; the UI in
`app/src/ui/modals/clustering-tabs/optimise-tab.js`. State persists
across project saves via `state.evalResults.optimise`.

Optimise is in beta — interface, scorers, and sweep modes may shift.

> **Validate tab removed 2026-05-24.** Bootstrap-Jaccard
> is reachable from inside Optimise via the `clusterRichnessScorer`
> / `stabilityScorer` paths and via the target-range sweep's
> `runBootstrap` flag — same `eval/bootstrap.js` engine, same
> Hennig thresholds, just one config per row. The standalone
> Validate tab on the single applied config was redundant.
> `state.evalResults.validate` slot preserved on the read side for
> backward-compat; nothing writes to it.

---

## 1. Surface overview

The Optimise tab sweeps `algorithms × params`, ranks each config by
the chosen scorer, and exposes per-row Apply (which targets a
named clustering level). Output: a sortable results table that
survives tab hops + project saves.

---

## 2. Jaccard primitives — `eval/jaccard.js`

- `jaccardSimilarity(setA, setB)` — symmetric set Jaccard
  `|A ∩ B| / |A ∪ B|`.
- **`bipartiteMatchJaccard(refLabels, candLabels, idMask?)`**
  *(primary; used by the bootstrap as of §6.18.7)* — finds the
  maximum-total-Jaccard one-to-one matching between reference and
  candidate clusters via Hungarian / Munkres
  (`maxWeightMatch`, O(n³) on the cluster-count-square). Each
  candidate cluster contributes its support to at most one
  reference; unmatched reference clusters score 0. Same output
  shape as `bestMatchJaccard` for drop-in use.
- `bestMatchJaccard(refLabels, candLabels, idMask?)` — **DEPRECATED**
  greedy form (each reference takes its single best candidate,
  ignoring matching constraints). Double-counts when the bootstrap
  produces a coarser partition than reference: two ref clusters can
  both best-match the same candidate, inflating meanJaccard. Kept
  exported for any external caller; new code should use
  `bipartiteMatchJaccard`.
- `idMask` (both functions) restricts the comparison to a subset of
  node ids — used by the bootstrap so the reference cluster's
  "members" are the ones that survived subsampling.

---

## 3. Bootstrap stability — `eval/bootstrap.js`

Adapted from Hennig 2007. A real cluster reappears in clusterings
of slightly-different data; an artifact falls apart. As of
§6.18.7 (`SCORE_VERSION = 2`) the protocol is:

**Algorithm:**

1. Take the reference clustering as ground truth.
2. Repeat B times: subsample the data **without replacement** at
   `subsampleFrac` (default 0.5, per Hennig 2008 §3.2). All B
   subsets pre-generated up front using a deterministic mulberry32
   walk; workers fire in parallel.
3. For each reference cluster, compute the **bipartite-matched**
   Jaccard against any cluster in the bootstrap (restricted to
   subsample members via the `idMask`). Each candidate is matched
   to at most one reference — no double-counting.
4. Mean the matched Jaccards across B iters → per-cluster stability.

**Protocol choices and the audit they resolve:**

| Item | Choice | Why |
|------|--------|-----|
| Subsampling vs bootstrap-with-replacement | subsampling without replacement | Hennig 2008 §3.2 endorses; simpler (no ties in Jaccard); aligns with how we sample. |
| `subsampleFrac` default | 0.5 | Hennig 2008 recommends m=n/2. 0.8 (previous default) was inflating reproducibility — subsamples too similar to full data. |
| Matching | bipartite (Hungarian) via `bipartiteMatchJaccard` | Greedy `bestMatchJaccard` double-counted when bootstrap was coarser than reference (two ref clusters could both best-match the same candidate). |
| Aggregates | `meanJaccard_macro` (size-weighted) + `meanJaccard_unweighted` (per-cluster) | Single number compressed two different views; surfacing both lets users spot when small clusters drag things down. |
| Hennig thresholds | kept as a coarse colour code only | Calibrated against with-replacement bootstrap, so applying them directly to subsampling is rough. Used for the breakdown bar, not as a primary metric. |

**Hennig thresholds (exported as constants):**
```
HENNIG_STABLE   = 0.85   // stable
HENNIG_DOUBTFUL = 0.60   // doubtful (between thresholds)
                          // unstable below 0.60
```

`classifyJaccard(j)` returns `"stable" | "doubtful" | "unstable"`.

**Parallel iters.** All B iterations fire concurrently via
`Promise.all` over `runInferRemote` worker calls. Subset sets are
deterministic given seed, so results are byte-identical to a
serial run at the same seed (§6.18.2 / A4).

**Returns:**
```ts
{
  perCluster: [{ clusterId, memberCount, meanJaccard, classification }],
  aggregate:  {
    nClusters, nStable, nDoubtful, nUnstable,
    fractionStable,                  // nStable / nClusters (deprecated as primary)
    meanJaccard,                     // backwards-compat alias == meanJaccard_macro
    meanJaccard_macro,               // size-weighted (after any penalise scaling)
    meanJaccard_unweighted,          // one-cluster-one-vote (after any penalise scaling)
    noiseFraction,                   // (#noise points in ref) / n; always reported
    noiseHandling,                   // "exclude" | "asCluster" | "penalise"
    // Only when noiseHandling === "penalise" AND noiseFraction > 0:
    meanJaccard_macro_raw?,          // pre-penalty macro
    meanJaccard_unweighted_raw?,     // pre-penalty unweighted
  },
  bootstrapsRun: int,
  scoreVersion:  int,                // SCORE_VERSION = 3; bumped on protocol change
}
```

### 3.1 Noise handling modes (§6.18.9 B8)

`noiseHandling` controls how `-1` (noise) labels enter the scoring:

| Mode | Matching | Aggregate |
|------|----------|-----------|
| `exclude` (default) | Drop `-1` from ref + cand before bipartite match. Noise points are invisible. | Macro / unweighted computed on the non-noise portion. |
| `asCluster` | Remap `-1` in both ref + per-iter cand to a synthetic `NOISE_ID` (one above the max real label). Noise becomes a regular cluster; noise-vs-noise matches contribute. | `nClusters` grows by 1 (the synthetic noise cluster); macro reflects noise stability. |
| `penalise` | Same matching as `exclude`. | Aggregates multiplied by `(1 − noiseFraction)`. A 30%-noise clustering loses 30% of its reproducibility score. `meanJaccard_*_raw` fields expose the pre-penalty values. |

Scores under different modes are **not directly comparable** — they
answer different questions. Pick a mode for a research question and
stick to it; the chosen mode is recorded in `aggregate.noiseHandling`
and in the persisted `settings.noiseHandling` so a saved Optimise
result self-documents the assumption that produced it.

### 3.2 Minimum members threshold (§6.18.9 B9)

`bootstrapStability` defaults `minMembers = 3` per Hennig 2007 §3.2.
For each per-iter subsample, reference clusters with fewer than
`minMembers` in-subsample members are dropped from that iter's
bipartite match. A 1-member-in-subsample reference cluster matched
against a singleton candidate would otherwise score Jaccard = 1.0
mechanically — meaningless. With the threshold, tiny clusters that
never reach 3 in-subsample members end up with `countJ = 0` and
appear in the final `perCluster` with `meanJaccard = 0`.

The threshold is configurable (passes through `scorers.js` →
`bootstrap.js`), but the audit recommendation is to leave it at 3.

**Multi-level note.** Validates the FINEST level only. Within-parent
scope isn't exercised in v1 — the bootstrap reclusters the whole
subsample in one pass. Acceptable for current usage; revisit when
multi-level reproducibility becomes load-bearing.

---

## 4. Scorers — `eval/scorers.js`

Uniform `score()` signature so the sweep is metric-agnostic:

```ts
score(genResult, dimredResult, clusterResult, algo, params, ctx?)
  → { primary: number,     // higher = better; the rank key
      secondary: number?,   // tie-breaker
      numClusters: int,
      extra?: object }
```

| Scorer | `id` | Primary metric | Notes |
|--------|------|-----------------|-------|
| `ariScorer(groundTruth)` | `"ari"` | Adjusted Rand Index vs `groundTruth` | **Toy-only** — needs ground-truth labels. Surfaces `extra.ariCeiling` (the Bayes-optimal ARI, §4.1) so the UI can read "0.85 (92% of 0.92)". |
| `stabilityScorer({B, subsampleFrac, noiseHandling, minMembers})` | `"stability"` | `meanJaccard_macro` (size-weighted) | Failure mode persists: trivial 1-cluster solutions score ~1.0. Documented; use richness when count also matters. |
| `numClustersScorer()` | `"numClusters"` | `nClusters` | No bootstrap. Useful when you trust the algorithm and want to push toward more clusters. |
| `clusterRichnessScorer({B, subsampleFrac, noiseHandling, minMembers})` | `"richness"` | `nClusters × meanJaccard_macro` | Penalises both extremes — `1 × 1.0` ties with `200 × 0.005`; the sweet spot wins. Renamed in the UI to "Cluster count × reproducibility" so the trade-off is in the label (§6.18.10 B11). |

**Auto-pick rule** (§6.18.10 B11):
- **Toy mode** → `Automatic` available, picks `ariScorer(originId)`.
- **Real mode** → `Automatic` **removed** from the dropdown. User
  must explicitly pick a scorer; each one answers a different
  question (count, reproducibility, count × reproducibility) and
  hiding the choice under "Auto" obscured the trade-off.

### 4.1 Bayes-optimal ARI ceiling (B5 / §6.18.10)

For toy data, `datasource/toy.js` stamps
`genResult.bayesOptimalAri` at generation time via
`eval/bayes-ari.js`. The Bayes-optimal classifier knows the true
Gaussian-mixture parameters and applies argmax over posterior; on
any sample with overlapping components it still misclassifies some
fraction of points. So the maximum ARI any algorithm can achieve
against `originId` is bounded above by the Bayes-optimal ARI on
that sample — not by 1.0.

- At well-separated defaults (toy: `spread=1.0`, 6 origins,
  R=60-cube): ceiling = 1.0 in typical samples; the algorithm
  could in principle recover the partition perfectly.
- At widened spreads (`spread=3.0`+): ceiling drops to ~0.6–0.8
  as components overlap; the headline ARI should be read relative
  to that.

`ariScorer` exposes the ceiling on each row as `extra.ariCeiling`.
The Optimise table renders it as `"0.85 (92% of 0.92)"`.

### 4.2 Distribution stats in the status line (B6 / §6.18.10)

After a sweep, the Optimise status line appends
`· best 0.78 · median 0.42 · sd 0.18 · n 27`. This is honest
disclosure: the headline "best" is cherry-picked from N configs,
and the spread tells the reader how dramatic that cherry-picking
is. A spread of 0.05 around a median of 0.75 reads very
differently from a spread of 0.30 around a median of 0.40.

Skipped when fewer than 2 finite primaries (stats not meaningful).

---

## 5. Sweep modes — `eval/sweep.js`

Three sweep strategies, all sharing the same result-row shape so
the Optimise table renders them with one code path.

### 5.1 `sweepAcrossAlgorithms({...})` — Resolution / Full grid

Cartesian enumeration of `algorithms × per-algorithm modalSchema
sweep grids`, scored via the chosen scorer.

**`resolutionOnly: true` (default)** — sweeps only fields tagged
`resolution: true` in the registry entry. Keeps the cross-algo grid
tractable (HDBSCAN's full grid alone is 648 configs;
resolution-only trims it to 6).

Resolution-tagged fields today:
- `mutualKNN.mutualK`
- `hdbscan.minClusterSize`
- `hdbscan.selectionMethod` (so both EOM and Leaf are tried)
- `connected-components.k`

**`resolutionOnly: false`** — Full grid. Every field on every
algorithm becomes an axis.

**Async + cooperative.** Yields between configs; `onProgress(i,
total, label)` fires after each one; `abortSignal.aborted` breaks
out of the loop early and resolves with whatever was scored so far.

### 5.2 `runTargetRangeSweep({...})` — Target range (§6.17)

Two-phase guided search for "the most stable settings that produce
between `targetMin` and `targetMax` clusters". Much cheaper than
the cartesian sweeps when the user knows roughly what cluster count
they want.

**Phase 1 — Latin hypercube probe.** For each enabled algorithm,
sample `phase1Count` configs across resolution-tagged fields via
`sampleLatinHypercube` (§6). Each numeric field is divided into
`phase1Count` equal-probability bins; one value is drawn from each
bin, then per-field sequences are independently Fisher-Yates
shuffled so the joint distribution is space-filling (no two samples
share a bin on any axis). Run each config; record cluster count;
mark `inRange` iff `targetMin ≤ nClusters ≤ targetMax`. Phase-1
hits are the seeds for Phase 2.

**Phase 2 — neighbourhood refine.** For each Phase-1 hit, perturb
each int/range resolution field by `±refineStep` (clamped to the
field's `[min, max]`); dedupe across overlapping hit neighbourhoods
via stable-stringified params. Re-run `algo.infer(...)` on each
neighbour.

**Scoring (Phase 2):**
- **Proximity (default, `runBootstrap = false`).**
  `primary = 1 / (1 + |nClusters − midpoint|)` where
  `midpoint = (targetMin + targetMax) / 2`. Configs in the centre
  of the band rank highest; overshooters fall off.
- **Reproducibility (`runBootstrap = true`).** Bootstrap-Jaccard
  each candidate via `bootstrapStability`; `primary =
  aggregate.meanJaccard`. Slower but reveals which target-range
  configs are most stable.

**Ranking.** In-range first (descending primary), out-of-range
second (refine-step can walk a hit just outside the band; those
rows stay visible but rank below the hits).

**Returns:**
```ts
{
  phase1: [{ algoId, params, numClusters, inRange, ... }],
  phase2: [{ algoId, params, numClusters, primary, secondary, extra, ... }],
  ranked: phase2 sorted (in-range first, then primary desc),
  hitCount:     int,
  totalConfigs: int,
  completed:    int,
  settings: { targetMin, targetMax, phase1Count, refineStep, runBootstrap, seed },
}
```

### 5.2.1 Phase-2 fallback when no hits (B12)

If `phase1.filter(inRange).length === 0`, the sweep would have
returned an empty Phase-2 table — leaving the user with no signal
beyond "your band was wrong". As of §6.18.8 the sweep falls back
to the **K=3 closest-to-band Phase-1 configs** (distance computed
as `max(0, targetMin - n, n - targetMax)` so configs inside the
band have distance 0 and outside-band configs are ranked by how
far out) and refines those instead. The outcome carries
`usedFallback: true`; the Optimise tab's status line surfaces it
as *"no hits in [min, max] — refined the closest Phase-1 configs"*
so the user knows the table isn't from in-band configs.

### 5.2.2 Reproducible bootstrap seed (B10)

Bootstrap iterations inside Phase 2 use a seed derived from
`(seed, algoId, stableStringify(params))` rather than the Phase-2
array index. Without this fix the same `(algo, params)` could
score differently between runs whenever cache dedup or fallback
reordered the Phase-2 walk. Now identical configs always score
identically across re-runs at the same outer seed.

### 5.3 "Sweep against" — fusion-aware variant

When `state._basePosPreFusion` exists (fusion is non-identity), the
target-range UI exposes a **Sweep against** radio: Post-fusion /
Pre-fusion / Both.

**Both** runs the whole two-phase sweep twice — once on
`dimredResult`, once on `dimredResultPreFusion`, with distinct LHS
seeds per pass (42, 42+1009, …) so the two passes don't collide on
identical samples. The merged ranked list shows a **Source** column
so the user can compare which params win on each representation
side-by-side ("does fusion change which params are most stable?").

Auto-collapses to "Post-fusion" when no pre-fusion buffer exists
(toy mode default).

---

## 6. Latin hypercube sampler — `eval/lhs.js`

Drives Phase 1 of the target-range sweep. Independent of the rest
of the eval engine; reusable for any future "space-filling sample
of an algorithm's parameter space" need.

**`sampleLatinHypercube(algorithm, count, seed, {fields}?)`** returns
`count` parameter objects suitable for `algo.infer(...)`.

**Per-field scale and kind handling:**

| Field shape | Behaviour |
|-------------|-----------|
| `kind: "int"` | Round each sampled value, clamp to `[min, max]`, dedupe within bins. If `count > distinctValues`, late bins repeat — LHS guarantee weakens gracefully. |
| `kind: "range"` | Keep as float. |
| `kind: "select"` | Cycle through `options.value` in shuffled order. |
| `scale: "log"` | Log-uniform within `[min, max]`. Requires `min > 0`; silently falls back to linear when `min === 0` (e.g. `selectionEpsilon`, `min_dist`). |
| no scale / `scale: "linear"` | Linear-uniform within `[min, max]`. |

**Determinism.** Seeded `mulberry32`; same `(algorithm, count,
seed)` always produces the same samples. Fisher-Yates shuffle keyed
off the same RNG.

**Restriction.** `opts.fields = string[]` restricts sampling to a
subset of field keys; others pin to the algorithm's defaults.
Target-range uses this to sample only resolution-tagged fields.

---

## 7. UI — `app/src/ui/modals/clustering-tabs/`

### 7.1 `configure-tab.js`

Extracted from the previous one-shot cluster modal. Renders the
multi-level config (algorithm dropdown + N stacked level cards
with params + scope toggle + `× / + Add level`). Exposes
`getWorking()` + `overwrite(config)` so the Optimise tab can write
a config back to the editor.

### 7.2 `optimise-tab.js`

Same vertical rhythm. Settings:
- **Algorithms** checkboxes (one per registered clustering algo).
- **Sweep mode** radio: Resolution only / Full grid / Target range.
  Target range reveals a settings panel with:
  - Target clusters min/max (cluster-count band)
  - Phase-1 samples slider (10–100)
  - Refine step slider (0–6)
  - "Rank by reproducibility (bootstrap)" checkbox
  - "Sweep against" radio (Post / Pre / Both) — only when fusion is
    active
- **Bootstraps** slider (5–30) — only meaningful for bootstrap-based
  scorers (stability + richness); hidden in target-range mode.
- **Ranked by** dropdown: Automatic / Match to known groups /
  Cluster richness / Number of clusters / Cluster reproducibility.
  Hidden in target-range mode (it has its own ranking).

Results table:
- Shows **every config the sweep produced** (not a top-N).
- **Sortable columns** — click any header to re-rank. The `#`
  column reflects the original primary-ranked position and stays
  fixed (anchor for "what did the chosen scorer think?").
- Columns adapt to the scorer: `Match` (ARI), `Reproducibility +
  Richness` (richness), `Stable % + Reproducibility` (stability), or
  just `Clusters` (numClusters). Target-range adds a `Source` column
  when sweep-against = Both.
- Per-row Apply has a **level picker** (`L0 / L1 / … / + New level`)
  that drops the chosen config into the named slot. The cascade
  runs in the background via the typed-job queue (`ui/queue.js`);
  the modal closes immediately and a spinner appears on the new
  clustering card.
- A **Save this run** button appears in the run-row after a
  successful sweep — persists the table as a saved validation run
  (§6.19). Re-openable later from the panel picker's *Validation
  runs* section, even after a project reload.

Scrollable tbody (max-height 320px) keeps long sweeps manageable.

---

## 8. Persistence

Two complementary stores:

### `state.evalResults` — the "latest sweep" cache

```ts
{
  validate: null,    // DEPRECATED — slot kept for backward-compat with
                     // old saves; no UI writes to it any more (§6.18.1)
  optimise: { ranked, totalConfigs, completed, scorerId, scorerLabel,
              settings, runtimeSec, timestamp } | null,
}
```

Holds whatever the Optimise tab last produced — overwritten each
sweep. Survives tab hops + project saves. `recluster()` clears it
so stale scores don't survive a clustering config change.

### `state.validationRuns` — saved-run archive (§6.19)

```ts
ValidationRun[]
```

Persistent, user-curated list of saved sweeps. Each entry
self-describes (type, label, inputs snapshot, settings, results,
timestamp, scoreVersion). Populated by clicking the **Save this
run** button in the Optimise tab after a sweep completes.

Survives project save/load. Renderable in panels via the panel
picker's *Validation runs* section — picking one opens it in a
`validation-run-optimise` panel that uses the same
`renderResults` renderer the modal Optimise tab uses.

Per-row Apply on a saved run currently re-infers (v1 strips `_cr`
to match the in-modal cache shape). Persisting `_cr` for instant
Apply is a follow-up.

---

## 9. Worker offload (A1 + A4 ✓)

As of §6.18.2 (2026-05-24), `algo.infer` calls in `sweep.js` and
`bootstrap.js` run inside `clustering-worker.js` via
`eval/run-infer-remote.js`. The main thread stays responsive
through long sweeps. Bootstrap iterations fire **concurrently**
via `Promise.all` rather than serial-with-yield — at toy n=400
B=10 the wall time drops from sequential `B × infer-time` to
roughly `max(infer-time)` plus ~10ms × B in spawn overhead.

**Determinism preserved.** Subsample sets are pre-generated up
front using the same deterministic mulberry32 walk the serial
version consumed iter-by-iter; the scoring loop runs serially
after all workers settle. Verified by `scratch/eval_workers_smoke.py`
— two consecutive bootstrap calls at the same seed give
byte-identical perCluster meanJaccards.

**Cancellation.** As of §6.18.4, the eval surface uses a real
`AbortController` per run. `optimise-tab.js` constructs the
controller, passes `controller.signal` through `sweep.js` and
`bootstrap.js`, and calls `controller.abort()` on the Cancel
button or tab hide. The signal flows into `runInferRemote` →
`worker-runner.js`, which terminates in-flight workers
synchronously on abort. Cancel during a 20-iter parallel
bootstrap returns in ~120 ms at toy scale (vs ~1.5 s under the
old polling-only pattern). AbortError is filtered out of
`console.error` so cancellation doesn't spam B log lines.

---

## 9.1 Sweep result cache (A2 + A3 ✓)

As of §6.18.3 (2026-05-24):

- **Phase 1 → Phase 2 cache (A2).** Every Phase-1 `cr` is stamped
  onto its result row as `_cr` and keyed in a
  `phase1CrByKey: Map<"algoId|stableStringify(params)", cr>`. When
  Phase 2 walks each hit's `±refineStep` neighbours, every
  neighbour config first checks the cache before firing a worker.
  Cache key is exposed on each Phase-2 config so dedup + lookup
  share one stringification. `phase2CacheHits` surfaces on the
  sweep result for observability.
- **Per-row Apply cache (A3).** `sweepAcrossAlgorithms` and
  `runTargetRangeSweep` both stamp each row with `_cr`. The
  Optimise tab's per-row Apply threads it through
  `descriptor.applyChange(algoId, levels, {precomputedCr})` →
  `engine.recluster({precomputedCr})` → worker payload's
  `precomputedLevels[0]`. The cascade skips L0's `algo.infer` and
  uses the supplied cr directly. Match is on `(algoId, params)`
  via a stable sorted-key comparison; mismatches silently fall
  back to a normal infer.
- **Cache is in-memory only.** `_cr` is stripped before
  `setOptimiseResult` so persisted `state.evalResults.optimise`
  doesn't carry ClusterResult Int32Arrays. After a project
  reload, Apply falls back to re-infer; running a new sweep
  re-populates the cache for that session.
- **Eligible levels.** Only L0 is cacheable today (it's the only
  level guaranteed to share inputs with a sweep — within-parent
  levels are derived from their parent's partition, not directly
  comparable to a sweep cr). Multi-level Applies that append a
  within-parent L1 still re-run L0 from cache, then compute L1
  from scratch.

## 10. Known limitations

- **Trivial-partition stability inflation** (intrinsic, not a bug). A
  1-cluster clustering bootstraps to `meanJaccard_macro = 1.0` because
  the full-data partition is trivially preserved under any subsample.
  The `clusterRichnessScorer` correctly punishes this (`1 × 1 = 1`);
  the raw `stabilityScorer` does not. Documented by surfacing both
  scorers + the cluster-count column so users can spot the failure
  mode.
- **Per-row Apply on multi-level configs.** The L0 precomputed-cr
  cache only covers L0 (its inputs match the sweep's). Multi-level
  Applies that append a within-parent L1 still recompute L1 from
  scratch even when L0 is cached. Acceptable; documented.
- **Beta surface.** Interface and column choices may continue to
  evolve. Future protocol changes that alter scoring numerics will
  bump `SCORE_VERSION` and discard old caches.

---

## 11. Cross-references

- `doc/workers.md` §9 — why eval still runs on the main thread.
- `doc/ui-architecture.md` §6 — Configure / Optimise tabbed
  clustering modal structure.
- `cards.md` — live card palette; how bootstrap got folded into the
  clustering modal as a sidecar.
