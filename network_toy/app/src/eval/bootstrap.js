// Bootstrap-Jaccard cluster stability (Hennig 2007), as adapted under
// §6.18.7 + §6.18.9. This is `scoreVersion: 3`.
//
// Idea: a real cluster reappears in clusterings of slightly-different
// data. An artifact falls apart. So:
//   1. Take the reference clustering as ground truth.
//   2. Repeat B times: subsample the data, re-cluster from scratch.
//   3. For each reference cluster, compute its bipartite-matched
//      Jaccard against any cluster in the bootstrap (restricted to
//      subsample members; each candidate matched to at most one ref).
//   4. Mean the matched Jaccards across B iters → per-cluster stability.
//   5. Hennig thresholds: ≥0.85 stable, 0.6–0.85 doubtful, <0.6 unstable
//      — kept as a coarse colour code only; not the headline number.
//
// Protocol choices (locked under §6.18.7 + §6.18.9):
//   - Subsampling WITHOUT replacement, default fraction 0.5 (Hennig
//     2008 §3.2). 0.8 inflated stability across the board because
//     subsamples were too similar to the full data.
//   - Scoring via bipartite-matched Jaccard (eval/jaccard.js
//     `bipartiteMatchJaccard`), not greedy. The greedy form
//     double-counted whenever the bootstrap produced a coarser
//     partition than the reference.
//   - Reference clusters with fewer than `minMembers` (default 3) in
//     the current subsample are excluded from that iter's scoring
//     (B9, §6.18.9 / Hennig 2007 §3.2). A 1-member-in-subsample
//     cluster matched against a singleton candidate scores Jaccard =
//     1.0 mechanically, which is meaningless. Skipping them shrinks
//     `countJ[id]` for tiny clusters; a cluster that never reaches
//     `minMembers` ends up with meanJaccard = 0, countJ = 0 — surfaced
//     as 0 in the perCluster output.
//   - `noiseHandling` controls how `-1` (noise) labels participate
//     (B8, §6.18.9):
//       "exclude" (default) — drop -1 from ref + cand before matching.
//         Same behaviour as pre-§6.18.9. Noise points are invisible
//         to the score.
//       "asCluster" — remap -1 labels in both ref and cand to a
//         synthetic NOISE_ID so the bipartite match treats noise as
//         a real cluster. "ref-noise matches cand-noise" becomes a
//         legitimate cluster contribution.
//       "penalise" — same matching as "exclude" but the macro and
//         unweighted aggregates are multiplied by (1 − noiseFraction)
//         where noiseFraction = (#noise in ref) / n. A clustering
//         that's 30% noise loses 30% of its reproducibility score.
//   - Two aggregate Jaccards always reported:
//       meanJaccard_macro      — size-weighted (large clusters dominate)
//       meanJaccard_unweighted — one-cluster-one-vote
//     plus noiseFraction (always; observational metric).
//   - fractionStable kept on aggregate but not a primary headline —
//     feeds the UI's coloured breakdown bar.
//
// Saved-result migration: scoreVersion: 3 stamped on every result.
// Older saves (no scoreVersion or != 3) are discarded on load by the
// Optimise tab and the user is asked to re-run. §6.18.9 bumps the
// version because the minMembers filter changes per-cluster numbers
// (tiny clusters that previously scored 1.0 via trivial-singleton
// matches now score lower or 0).
//
// Parallelism (A4): all B bootstrap iterations are now fired into the
// clustering worker concurrently via Promise.all. The subsample sets
// are pre-generated up front using the same deterministic mulberry32
// sequence the serial version walked, so results are byte-identical
// to the pre-parallel implementation given the same seed.
//
// Cancellation: the eval surface's polling `{aborted: bool}` signal is
// honoured (a) pre-flight before kicking off any workers and (b) during
// scoring (after Promise.all returns). Mid-flight cancellation of an
// in-progress batch isn't supported under the polling convention — the
// outer caller will see results from the entire batch once the slowest
// worker completes. Acceptable: per-iter wall time at toy scale is
// sub-second; at BFS scale the workers wouldn't be cancellable mid-
// algorithm anyway (HDBSCAN's inner loop is synchronous).
//
// Multi-level handling: validates the FINEST level only. For multi-
// level clusterings each bootstrap re-runs the same algorithm (single-
// level) on the subsampled finest-level positions. Within-parent scope
// isn't exercised in v1 — the bootstrap reclusters the whole subsample
// in one pass. Acceptable for now since the smoke flow uses the
// default single-level config.

import { mulberry32 } from "../rng.js";
import { bipartiteMatchJaccard } from "./jaccard.js";
import { runInferRemote } from "./run-infer-remote.js";

export const SCORE_VERSION    = 3;   // bump on any change to protocol/aggregates
export const HENNIG_STABLE    = 0.85;
export const HENNIG_DOUBTFUL  = 0.60;
export const DEFAULT_MIN_MEMBERS = 3;  // §6.18.9 B9 — Hennig 2007 §3.2

// Classify a Jaccard score per Hennig 2007.
export function classifyJaccard(j) {
  if (j >= HENNIG_STABLE)   return "stable";
  if (j >= HENNIG_DOUBTFUL) return "doubtful";
  return "unstable";
}

// Inputs:
//   refClusterResult — {nodeCluster, clusters, ...} the reference partition
//   genResult        — Layer 1 result (used to slice sub-genResult per iter)
//   dimredResult     — Layer 1.5 result (sliced parallel to genResult)
//   algo             — clustering registry entry
//   params           — params for that algorithm
//   B                — number of bootstrap iterations (default 25)
//   subsampleFrac    — fraction of nodes to keep per iter (default 0.8)
//   seed             — base RNG seed for sample indices
//   onProgress       — callback(iter, total) called as each worker
//                      completes (NOT in iter order — workers complete
//                      in fastest-first order under parallel firing)
//   abortSignal      — {aborted: bool}; checked pre-flight and during scoring
//
// Returns Promise<{
//   perCluster: [{clusterId, memberCount, meanJaccard, classification}],
//   aggregate:  {nClusters, nStable, nDoubtful, nUnstable, fractionStable, meanJaccard},
//   bootstrapsRun: int,
// }>.
export async function bootstrapStability({
  refClusterResult,
  genResult,
  dimredResult,
  algo,
  params,
  B = 25,
  subsampleFrac = 0.5,   // ↓ from 0.8 under §6.18.7 (Hennig 2008 §3.2)
  seed = 12345,
  minMembers = DEFAULT_MIN_MEMBERS,    // §6.18.9 B9
  noiseHandling = "exclude",           // §6.18.9 B8 — "exclude" | "asCluster" | "penalise"
  onProgress = null,
  abortSignal = null,
}) {
  const nLen = refClusterResult.nodeCluster.length;
  const refLabelsRaw = refClusterResult.nodeCluster;

  // Noise accounting (always; observational). Reads off the raw labels
  // before any asCluster remap so "fraction of noise points in the
  // reference clustering" is a property of the clustering, not the
  // scoring mode.
  let noiseInRef = 0;
  for (let i = 0; i < nLen; i++) if (refLabelsRaw[i] === -1) noiseInRef++;
  const noiseFraction = nLen > 0 ? noiseInRef / nLen : 0;

  // §6.18.9 B8 — asCluster mode: remap -1 to a synthetic NOISE_ID
  // both for ref labels (here) and for each iter's candidate labels
  // (inside the iter loop). NOISE_ID is one above the max real label
  // in the reference; per-iter cand will use the same id so they
  // match each other when bipartite is solved.
  let NOISE_ID = -1;
  let refLabels = refLabelsRaw;
  if (noiseHandling === "asCluster") {
    let maxLbl = -1;
    for (let i = 0; i < nLen; i++) if (refLabelsRaw[i] > maxLbl) maxLbl = refLabelsRaw[i];
    NOISE_ID = maxLbl + 1;
    refLabels = new Int32Array(nLen);
    for (let i = 0; i < nLen; i++) {
      refLabels[i] = refLabelsRaw[i] === -1 ? NOISE_ID : refLabelsRaw[i];
    }
  }

  // refClusterIds is the set of cluster ids we'll average across.
  // In asCluster mode include the NOISE_ID; otherwise exclude -1 as before.
  const refClusterIds = noiseHandling === "asCluster"
    ? [...new Set(Array.from(refLabels))].filter(id => id >= 0).sort((a, b) => a - b)
    : refClusterResult.clusters.map(c => c.id).filter(id => id >= 0);

  const n = nLen;

  // Per-cluster running tally of max-Jaccards across iters.
  const sumJ   = new Map();
  const countJ = new Map();
  for (const id of refClusterIds) { sumJ.set(id, 0); countJ.set(id, 0); }

  // Pre-generate every subsample set up front (deterministic walk of
  // the shared mulberry32 sequence — same sequence the serial version
  // consumed iter-by-iter, so results are byte-identical at the same
  // seed). This unblocks parallel firing of the worker calls.
  const rng = mulberry32(seed >>> 0);
  const subsets = [];
  for (let it = 0; it < B; it++) {
    const subSet = sampleSubset(n, subsampleFrac, rng);
    const subIds = Array.from(subSet).sort((a, b) => a - b);
    subsets.push({ subSet, subIds });
  }

  // Bail before spawning anything if the caller already cancelled.
  if (abortSignal && abortSignal.aborted) {
    return finalise(refClusterIds, n, refLabels, sumJ, countJ, 0, noiseHandling, noiseFraction);
  }

  // Fire all B inferences concurrently. Sub-genResult + sub-dimredResult
  // are per-iter unique buffers, so we transfer the dimred buffer to
  // skip the structured-clone copy on the way to the worker.
  let completed = 0;
  const promises = subsets.map(({ subIds }, it) => {
    const k = subIds.length;
    if (k < 2) return Promise.resolve({ ok: false, skipped: true, it });

    const subGen    = sliceGenResult(genResult, subIds);
    const subDimred = sliceDimredResult(dimredResult, subIds);

    return runInferRemote(algo, subGen, params, subDimred, {
      signal:         abortSignal,
      transferDimred: true,   // subDimred is a per-iter unique buffer; safe to detach
    })
      .then(candResult => {
        completed++;
        if (onProgress) onProgress(completed, B);
        return { ok: true, it, candResult };
      })
      .catch(err => {
        // AbortError is expected on user-triggered cancel — don't pollute
        // the console with B copies of it. Other errors still log.
        if (!err || err.name !== "AbortError") {
          console.error("[bootstrap] worker call failed on iter", it, err);
        }
        completed++;
        if (onProgress) onProgress(completed, B);
        return { ok: false, it, err };
      });
  });

  const settled = await Promise.all(promises);

  // Score serially. Each iter is independent and cheap (bestMatchJaccard
  // is O(refClusters × candClusters × avg-set-overlap), no infer work).
  let iters = 0;
  for (const s of settled) {
    if (abortSignal && abortSignal.aborted) break;
    if (!s.ok) continue;
    const { it, candResult } = s;
    const { subSet, subIds } = subsets[it];
    const k = subIds.length;

    // candResult.nodeCluster is keyed by SUB ids (0..k-1). Map back to
    // original ids by lifting to a full-size labels array filled with -1.
    // In asCluster mode the per-iter -1 (cand noise) gets remapped to
    // NOISE_ID, the same id we used for ref noise, so the bipartite
    // match treats noise-vs-noise as a real cluster pairing.
    const candLabelsFull = new Int32Array(n).fill(-1);
    for (let li = 0; li < k; li++) {
      const lbl = candResult.nodeCluster[li];
      candLabelsFull[subIds[li]] = (noiseHandling === "asCluster" && lbl === -1)
        ? NOISE_ID
        : lbl;
    }

    // Score: bipartite-matched Jaccard per reference cluster,
    // restricted to the subsample (so reference members not in this
    // subsample don't penalise the score). Each candidate cluster is
    // matched to at most one reference — no double-counting (B3).
    // minMembers (B9) drops refs with < N in-subsample members; they
    // simply don't appear in the match output → countJ stays put for
    // them this iter (a cluster that never reaches threshold sticks
    // at meanJaccard 0, countJ 0 in the final output).
    const matches = bipartiteMatchJaccard(refLabels, candLabelsFull, subSet, { minMembers });
    for (const id of refClusterIds) {
      const m = matches.get(id);
      if (!m) continue;   // ref cluster fell below minMembers this iter
      sumJ.set(id, sumJ.get(id) + m.jaccard);
      countJ.set(id, countJ.get(id) + 1);
    }
    iters++;
  }

  return finalise(refClusterIds, n, refLabels, sumJ, countJ, iters, noiseHandling, noiseFraction);
}

// Build the perCluster + aggregate output from the running tallies.
function finalise(refClusterIds, n, refLabels, sumJ, countJ, iters, noiseHandling, noiseFraction) {
  const memberCount = new Map();
  for (let i = 0; i < n; i++) {
    const id = refLabels[i];
    if (id < 0) continue;
    memberCount.set(id, (memberCount.get(id) || 0) + 1);
  }
  const perCluster = refClusterIds.map(id => {
    const cnt = countJ.get(id) || 0;
    const meanJ = cnt > 0 ? sumJ.get(id) / cnt : 0;
    return {
      clusterId:      id,
      memberCount:    memberCount.get(id) || 0,
      meanJaccard:    meanJ,
      classification: classifyJaccard(meanJ),
    };
  });

  // Two aggregate Jaccards exposed for the §6.18.7 B4 fix:
  //   meanJaccard_macro      — size-weighted (large clusters dominate)
  //   meanJaccard_unweighted — one-cluster-one-vote (small clusters
  //                            visible)
  // Spotting "macro high, unweighted low" tells the user that small
  // clusters are unstable but big ones aren't.
  // `meanJaccard` is kept as a backwards-compat alias for macro since
  // scorers.js + the persisted Optimise cache still read it.
  let nStable = 0, nDoubtful = 0, nUnstable = 0;
  let weightedSum = 0, weightTotal = 0;
  let unweightedSum = 0;
  for (const p of perCluster) {
    if (p.classification === "stable")   nStable++;
    if (p.classification === "doubtful") nDoubtful++;
    if (p.classification === "unstable") nUnstable++;
    weightedSum   += p.meanJaccard * p.memberCount;
    weightTotal   += p.memberCount;
    unweightedSum += p.meanJaccard;
  }
  let macro      = weightTotal      > 0 ? weightedSum   / weightTotal      : 0;
  let unweighted = perCluster.length > 0 ? unweightedSum / perCluster.length : 0;

  // §6.18.9 B8 — "penalise" mode scales both aggregates by
  // (1 − noiseFraction). A clustering that's 30% noise loses 30% of
  // its stability score regardless of how stable its non-noise
  // clusters are. "exclude" + "asCluster" leave the aggregates as
  // computed; their interpretations of -1 differ at the matching
  // layer, not the aggregate layer.
  const penaltyApplied = noiseHandling === "penalise" && noiseFraction > 0;
  let rawMacro = macro, rawUnweighted = unweighted;
  if (penaltyApplied) {
    const factor = 1 - noiseFraction;
    macro      *= factor;
    unweighted *= factor;
  }

  const aggregate = {
    nClusters:              perCluster.length,
    nStable, nDoubtful, nUnstable,
    fractionStable:         perCluster.length > 0 ? nStable / perCluster.length : 0,
    meanJaccard:            macro,        // legacy alias == macro (penalised when applicable)
    meanJaccard_macro:      macro,
    meanJaccard_unweighted: unweighted,
    noiseFraction,                         // always reported (observational)
    noiseHandling,                         // surfaces the mode that produced these numbers
  };
  if (penaltyApplied) {
    aggregate.meanJaccard_macro_raw      = rawMacro;
    aggregate.meanJaccard_unweighted_raw = rawUnweighted;
  }

  return { perCluster, aggregate, bootstrapsRun: iters, scoreVersion: SCORE_VERSION };
}

// Pick approximately frac × n distinct ids in [0, n).
function sampleSubset(n, frac, rng) {
  const target = Math.max(2, Math.min(n, Math.round(n * frac)));
  const out = new Set();
  while (out.size < target) {
    out.add(Math.floor(rng() * n));
  }
  return out;
}

function sliceGenResult(genResult, subIds) {
  const subNodes = subIds.map((origId, localIdx) => {
    const orig = genResult.nodes[origId];
    return { ...orig, id: localIdx };
  });
  return { ...genResult, nodes: subNodes };
}

function sliceDimredResult(dimredResult, subIds) {
  const d  = dimredResult.d;
  const src = dimredResult.data;
  const out = new Float32Array(subIds.length * d);
  for (let li = 0; li < subIds.length; li++) {
    const oi = subIds[li];
    for (let k = 0; k < d; k++) out[li * d + k] = src[oi * d + k];
  }
  return {
    method: dimredResult.method,
    params: dimredResult.params,
    n:      subIds.length,
    d,
    data:   out,
  };
}
