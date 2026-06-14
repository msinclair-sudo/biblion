// Sweep scorers — pluggable evaluation metrics.
//
// A scorer is a (possibly async) function that takes a clustering
// outcome and returns:
//
//   { primary: number,    // higher = better; the rank key
//     secondary: number?,  // optional tie-breaker
//     numClusters: int,    // surfaced in the results table
//     extra?:    object,   // metric-specific detail (e.g. perCluster) }
//
// Scorers today:
//   * stabilityScorer(opts) — data-source-agnostic; runs bootstrap-
//     Jaccard and ranks by Hennig fraction-stable.
//   * numClustersScorer / clusterRichnessScorer — count-based metrics.
//
// The scorer signature is uniform so the sweep doesn't care which
// metric is active.

import { bootstrapStability } from "./bootstrap.js";

// Real-data-friendly scorer. Runs B bootstrap iterations and ranks by
// the cluster-size-weighted mean Jaccard (meanJaccard_macro) per
// §6.18.7 B4. The Hennig fractionStable is exposed in `extra` for the
// UI's breakdown bar but is no longer the headline primary.
//
// Failure mode (still documented): coarse clusterings (1–3 clusters)
// can score high because the bootstrap trivially reproduces them.
// Use `clusterRichnessScorer` when count matters too.
export function stabilityScorer({
  B = 10,
  subsampleFrac = 0.5,
  seed = 12345,
  noiseHandling = "exclude",    // §6.18.9 B8
  minMembers,                    // §6.18.9 B9 — undefined → bootstrap default (3)
} = {}) {
  return {
    id:    "stability",
    label: "reproducibility score",
    isAsync: true,
    async score(genResult, dimredResult, clusterResult, algo, params, ctx = {}) {
      const result = await bootstrapStability({
        refClusterResult: clusterResult,
        genResult,
        dimredResult,
        algo,
        params,
        B,
        subsampleFrac,
        seed,
        noiseHandling,
        ...(minMembers !== undefined ? { minMembers } : {}),
        onProgress: ctx.onIterProgress || null,
        abortSignal: ctx.abortSignal     || null,
      });
      return {
        primary:     result.aggregate.meanJaccard_macro,
        secondary:   result.aggregate.meanJaccard_unweighted,
        numClusters: result.aggregate.nClusters,
        extra:       result,
      };
    },
  };
}

// Counts-only scorer. Ranks by raw cluster count — informative when
// you trust the algorithm's geometry but want the resolution knob
// pushed toward "more clusters". Beware: noise-fragmented configs
// (e.g. 200 singletons) will dominate. Pair with a manual look at
// the rows or use `clusterRichnessScorer` for a balanced signal.
export function numClustersScorer() {
  return {
    id:    "numClusters",
    label: "cluster count",
    isAsync: false,
    score(genResult, dimredResult, clusterResult, _algo, _params) {
      const n = clusterResult.clusters.length;
      return {
        primary:     n,
        secondary:   0,
        numClusters: n,
        extra:       null,
      };
    },
  };
}

// Balanced scorer — cluster count × cluster-size-weighted reproducibility.
// Penalises both ends: a single mega-cluster scores 1 × 1.0 = 1; 100
// noise-fine clusters score 100 × 0.01 = 1; the sweet spot of e.g.
// 24 medium clusters at meanJaccard_macro = 0.55 scores 24 × 0.55 = 13.2.
//
// Under §6.18.7 we no longer auto-pick this in real mode (the audit
// argued the "balanced" framing was a fix-for-a-fix that hides the
// trade-off; user picks explicitly now per B11). The scorer remains
// available as a defensible choice when the user wants one number.
export function clusterRichnessScorer({
  B = 10,
  subsampleFrac = 0.5,
  seed = 12345,
  noiseHandling = "exclude",   // §6.18.9 B8
  minMembers,                   // §6.18.9 B9 — undefined → bootstrap default (3)
} = {}) {
  return {
    id:    "richness",
    label: "cluster richness",
    isAsync: true,
    async score(genResult, dimredResult, clusterResult, algo, params, ctx = {}) {
      const result = await bootstrapStability({
        refClusterResult: clusterResult,
        genResult,
        dimredResult,
        algo,
        params,
        B,
        subsampleFrac,
        seed,
        noiseHandling,
        ...(minMembers !== undefined ? { minMembers } : {}),
        onProgress: ctx.onIterProgress || null,
        abortSignal: ctx.abortSignal     || null,
      });
      const nC      = result.aggregate.nClusters;
      const macro   = result.aggregate.meanJaccard_macro;
      const richness = nC * macro;
      return {
        primary:     richness,
        secondary:   macro,
        numClusters: nC,
        extra:       result,
      };
    },
  };
}
