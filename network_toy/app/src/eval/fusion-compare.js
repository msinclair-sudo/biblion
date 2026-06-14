// Pre-fusion vs post-fusion partition comparison (§6.19 step 8 + §6.15
// follow-up: cross-view NMI).
//
// The fusion blender (Layer 1.5's `graph-diffusion`) reweights each
// paper's embedding toward its citation neighbours. The user's
// question: *how much does this actually reorganise my topic map?*
//
// We answer with two complementary views:
//
//   1. **Aggregate metrics** — single numbers describing the
//      partition-to-partition gap.
//        - ARI(pre, post)        — chance-corrected agreement
//        - NMI(pre, post)        — information-theoretic agreement
//        - macro Jaccard         — bipartite-matched mean Jaccard between
//                                  ref clusters and best-matched candidate
//        - cluster counts        — what changed in the cluster taxonomy
//        - noise fractions       — how density-class boundaries shifted
//
//   2. **Per-cluster + per-node breakdown** — *which* clusters and
//      *which* papers moved most.
//        - per-cluster row: pre-cluster → best post-match (id + Jaccard
//          + member count + biggest-loss summary)
//        - per-node retention: 1 − |prePeers ∩ postPeers| / |prePeers|
//          — how thoroughly a paper's pre-fusion neighbourhood was
//          dispersed by fusion. 0 = peers intact; 1 = none of its old
//          peers ended up in its new cluster.
//
// Source-agnostic: the caller passes any two clusterResults (a level from
// each of two clusterings — e.g. the pre- and post-fusion branch ladders).
// Pure: no state reads, no DOM, computes in a single pass.

import { adjustedRandIndex }       from "./ari.js";
import { normalisedMutualInformation } from "./nmi.js";
import { bipartiteMatchJaccard, jaccardSimilarity } from "./jaccard.js";

/**
 * @param {ClusterResult} preCr     Pre-fusion clusterLevels[level].clusterResult
 * @param {ClusterResult} postCr    Post-fusion clusterLevels[level].clusterResult
 * @param {object} [opts]
 * @param {number} [opts.topMoversN=20]  How many top-mover rows to surface.
 * @returns {FusionCompareResult}
 *
 * FusionCompareResult shape:
 *   {
 *     aggregate: {
 *       ari, nmi_arith, nmi_geom, macroJaccard,
 *       nClustersPre, nClustersPost,
 *       noiseFractionPre, noiseFractionPost,
 *       nReorganised,                       // count(retention < 0.5)
 *     },
 *     perCluster: [{                         // one row per pre-cluster
 *       preId, postId,                       // post = best match (or -1 if none)
 *       jaccard,                             // Jaccard of pre members ∩ post members
 *       memberCount, retainedCount, lostCount,
 *       biggestPostShare: {postId, count}    // where most of pre's members ended up
 *                                            // post-fusion (could differ from best
 *                                            // match — best match is mutual; biggest
 *                                            // share is unilateral)
 *     }, ...],
 *     perNodeRetention: Float32Array(n),     // retention score per paper, 0..1
 *     topMovers: [{                          // sorted by retention asc (most-moved first)
 *       nodeIdx, preId, postId, retention,
 *     }, ...],
 *   }
 */
export function compareFusionPartitions(preCr, postCr, opts = {}) {
  const { topMoversN = 20 } = opts;
  if (!preCr || !postCr) {
    throw new Error("[fusion-compare] both preCr and postCr required");
  }
  if (preCr.nodeCluster.length !== postCr.nodeCluster.length) {
    throw new Error("[fusion-compare] partition length mismatch");
  }
  const n = preCr.nodeCluster.length;

  // ── Aggregate metrics ──
  const ari = adjustedRandIndex(preCr.nodeCluster, postCr.nodeCluster);
  const nmi = normalisedMutualInformation(preCr.nodeCluster, postCr.nodeCluster);

  // Bipartite-matched mean Jaccard. We use macro (size-weighted) to
  // match the §6.18.7 scorer convention; gives more weight to large
  // clusters being preserved.
  const matchMap = bipartiteMatchJaccard(preCr.nodeCluster, postCr.nodeCluster);
  let weightedSum = 0, weightTotal = 0;
  // Build member-set Maps once for reuse (used for retention too).
  const preGroups  = buildGroups(preCr.nodeCluster);
  const postGroups = buildGroups(postCr.nodeCluster);
  for (const [preId, info] of matchMap) {
    const w = preGroups.get(preId).size;
    weightedSum += info.jaccard * w;
    weightTotal += w;
  }
  const macroJaccard = weightTotal > 0 ? weightedSum / weightTotal : NaN;

  const noiseFractionPre  = countLabel(preCr.nodeCluster,  -1) / n;
  const noiseFractionPost = countLabel(postCr.nodeCluster, -1) / n;

  // ── Per-cluster rows ──
  const perCluster = [];
  // Sorted pre ids; -1 noise excluded — it's not a real cluster.
  const preIds = [...preGroups.keys()].filter(id => id >= 0).sort((a, b) => a - b);
  for (const preId of preIds) {
    const preMembers = preGroups.get(preId);
    const match = matchMap.get(preId) || { bestCandLabel: -1, jaccard: 0 };

    // Where did members of preId end up? Tally post-cluster ids over preMembers.
    const postTally = new Map();
    for (const i of preMembers) {
      const post = postCr.nodeCluster[i];
      postTally.set(post, (postTally.get(post) || 0) + 1);
    }
    // Biggest-share post-cluster (ignoring noise unless that's all there is).
    let biggestPostId = -1, biggestCount = -1;
    for (const [postId, count] of postTally) {
      if (postId < 0) continue;
      if (count > biggestCount) { biggestPostId = postId; biggestCount = count; }
    }
    // Fall back to noise if no non-noise post-id received any.
    if (biggestCount <= 0 && postTally.has(-1)) {
      biggestPostId = -1; biggestCount = postTally.get(-1);
    }

    // Retained = how many pre members are in the bipartite-matched post cluster.
    let retainedCount = 0;
    if (match.bestCandLabel >= 0 && postGroups.has(match.bestCandLabel)) {
      const postSet = postGroups.get(match.bestCandLabel);
      for (const i of preMembers) {
        if (postSet.has(i)) retainedCount++;
      }
    }
    const memberCount = preMembers.size;
    perCluster.push({
      preId,
      postId:           match.bestCandLabel,
      jaccard:          match.jaccard,
      memberCount,
      retainedCount,
      lostCount:        memberCount - retainedCount,
      biggestPostShare: { postId: biggestPostId, count: biggestCount },
    });
  }

  // ── Per-node retention ──
  // For each paper i, retention = |prePeers(i) ∩ postPeers(i)| / |prePeers(i)|
  // where prePeers(i) excludes i itself.
  const perNodeRetention = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const preLabel  = preCr.nodeCluster[i];
    const postLabel = postCr.nodeCluster[i];
    if (preLabel < 0 || postLabel < 0) { perNodeRetention[i] = NaN; continue; }
    const prePeers  = preGroups.get(preLabel);
    const postPeers = postGroups.get(postLabel);
    if (!prePeers || prePeers.size <= 1) { perNodeRetention[i] = 1.0; continue; }
    let intersect = 0;
    for (const j of prePeers) {
      if (j !== i && postPeers && postPeers.has(j)) intersect++;
    }
    perNodeRetention[i] = intersect / (prePeers.size - 1);
  }
  let nReorganised = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(perNodeRetention[i]) && perNodeRetention[i] < 0.5) nReorganised++;
  }

  // Top movers (retention asc).
  const candidates = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(perNodeRetention[i])) continue;
    candidates.push({ nodeIdx: i, retention: perNodeRetention[i] });
  }
  candidates.sort((a, b) => a.retention - b.retention);
  const topMovers = candidates.slice(0, topMoversN).map(c => ({
    nodeIdx:   c.nodeIdx,
    preId:     preCr.nodeCluster[c.nodeIdx],
    postId:    postCr.nodeCluster[c.nodeIdx],
    retention: c.retention,
  }));

  return {
    aggregate: {
      ari,
      nmi_arith:        nmi.nmi_arith,
      nmi_geom:         nmi.nmi_geom,
      macroJaccard,
      nClustersPre:     preCr.clusters ? preCr.clusters.length : preIds.length,
      nClustersPost:    postCr.clusters ? postCr.clusters.length
                                       : [...postGroups.keys()].filter(id => id >= 0).length,
      noiseFractionPre,
      noiseFractionPost,
      nReorganised,
    },
    perCluster,
    perNodeRetention,
    topMovers,
  };
}

// Helpers — kept private to this module so we don't expose duplicate
// counting machinery (jaccard.js's buildGroups is module-private).

function buildGroups(labels) {
  const m = new Map();
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    let s = m.get(l);
    if (!s) { s = new Set(); m.set(l, s); }
    s.add(i);
  }
  return m;
}

function countLabel(labels, target) {
  let n = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] === target) n++;
  return n;
}
