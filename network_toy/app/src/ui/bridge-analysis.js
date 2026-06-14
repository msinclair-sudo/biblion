// Bridge analysis — pure derivation on top of multi-level clustering.
//
// For a chosen FINE level (default: deepest), each fine cluster's
// members are histogrammed against EVERY coarser level [0, fineLevel-1].
// A fine cluster is a "bridge AT level i" iff its members come from
// two or more clusters at level i.
//
// One coarser level is also chosen as the "comparison" coarseLevel
// (default: fineLevel - 1, the immediate parent). The per-node score
// + per-node bridge flag + bridgeCount surface the comparison-level
// view, which is what viewer-3d's `bridge` and `boundaryScore` colour
// modes paint. The full byLevel breakdown is what the bridge tables
// render.
//
// Returns null when fewer than two levels exist (no parent to bridge),
// or when the requested config is unsatisfiable.
//
// Output shape:
//
//   {
//     fineLevel:   int,
//     coarseLevel: int,                       // the comparison level
//     levels:      int[],                     // [0, 1, ..., fineLevel-1]
//     perCluster: [{
//       fineId, memberCount,
//       byLevel: [{                            // length = fineLevel
//         coarseLevel,                          // = idx into clusterLevels
//         shares: [{id, count, fraction}],     // sorted desc by count
//         spanCount,
//         dominantId, dominantFraction,
//         isBridge,                             // spanCount >= 2
//       }],
//       isBridgeAtCoarse,                      // byLevel[coarseLevel].isBridge
//       isBridgeAny,                           // true at ANY coarser level
//     }],
//     perNodeScore:    Float32Array(n),        // 1 - dominantFraction at coarseLevel
//     perNodeIsBridge: Uint8Array(n),          // bridge flag at coarseLevel
//     bridgeCount:     int,                    // bridges at coarseLevel
//   }
//
// "Boundary score" definition (per node, at the comparison level):
// `1 − dominantFraction`. Interior clusters (one parent at that level)
// score 0; perfectly even mixing → close to 1. Per-node value is
// constant within a fine cluster (bridge-ness is a cluster property).

export function computeBridgeAnalysis(clusterLevels, config = {}) {
  if (!clusterLevels || clusterLevels.length < 2) return null;

  const lastLevelIdx = clusterLevels.length - 1;

  // Resolve fineLevel: explicit config wins, else deepest. Must be ≥ 1
  // (need at least one coarser level to compare against).
  let fineLevel = Number.isInteger(config.fineLevel) ? config.fineLevel : lastLevelIdx;
  if (fineLevel < 1 || fineLevel > lastLevelIdx) fineLevel = lastLevelIdx;

  // Resolve coarseLevel: explicit config wins, else immediate parent.
  // Must be in [0, fineLevel - 1].
  let coarseLevel = Number.isInteger(config.coarseLevel)
    ? config.coarseLevel
    : fineLevel - 1;
  if (coarseLevel < 0 || coarseLevel >= fineLevel) coarseLevel = fineLevel - 1;

  const fine = clusterLevels[fineLevel].clusterResult;
  const n    = fine.nodeCluster.length;

  const levels = [];
  for (let i = 0; i < fineLevel; i++) levels.push(i);

  // Group node ids by fine cluster id (one pass).
  const byFine = new Map();
  for (let i = 0; i < n; i++) {
    const fid = fine.nodeCluster[i];
    if (fid < 0) continue;
    if (!byFine.has(fid)) byFine.set(fid, []);
    byFine.get(fid).push(i);
  }

  // Pre-fetch each coarser level's nodeCluster array for the inner loop.
  const coarseNodeClusters = levels.map(li => clusterLevels[li].clusterResult.nodeCluster);

  const perCluster = [];
  const byFineId   = new Map();

  for (const fineCluster of fine.clusters) {
    const members = byFine.get(fineCluster.id) || [];
    const total   = members.length || 1;

    const byLevel = levels.map((coarseLevelIdx, ci) => {
      const nodeCluster = coarseNodeClusters[ci];
      const counts = new Map();
      for (const nid of members) {
        const cid = nodeCluster[nid];
        counts.set(cid, (counts.get(cid) || 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const shares = sorted.map(([id, count]) => ({
        id, count, fraction: count / total,
      }));
      const spanCount        = shares.length;
      const dominantId       = spanCount > 0 ? shares[0].id       : -1;
      const dominantFraction = spanCount > 0 ? shares[0].fraction : 0;
      return {
        coarseLevel: coarseLevelIdx,
        shares,
        spanCount,
        dominantId,
        dominantFraction,
        isBridge: spanCount >= 2,
      };
    });

    const at = byLevel[coarseLevel];
    const entry = {
      fineId:           fineCluster.id,
      memberCount:      members.length,
      byLevel,
      isBridgeAtCoarse: at ? at.isBridge : false,
      isBridgeAny:      byLevel.some(b => b.isBridge),
    };
    perCluster.push(entry);
    byFineId.set(fineCluster.id, entry);
  }

  // Per-node arrays reflect the comparison (coarseLevel) view —
  // viewer-3d's `bridge` and `boundaryScore` colour modes read these.
  const perNodeScore    = new Float32Array(n);
  const perNodeIsBridge = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const fid = fine.nodeCluster[i];
    const info = fid >= 0 ? byFineId.get(fid) : null;
    if (info) {
      const at = info.byLevel[coarseLevel];
      if (at) {
        perNodeScore[i]    = 1 - at.dominantFraction;
        perNodeIsBridge[i] = at.isBridge ? 1 : 0;
      }
    }
  }

  const bridgeCount = perCluster.reduce(
    (acc, p) => acc + (p.isBridgeAtCoarse ? 1 : 0), 0);

  return {
    fineLevel,
    coarseLevel,
    levels,
    perCluster,
    perNodeScore,
    perNodeIsBridge,
    bridgeCount,
  };
}

// All-layers bridge analysis (§9, the per-layer model). Bridges are a
// PER-LAYER relationship: for every committed layer i ≥ 1, each cluster in
// layer i is checked against the clusters in the layer immediately above it
// (i − 1) — does it straddle ≥ 2 parents there, and which ones. Layer 0 (the
// coarsest) has no parent, so it contributes no bridges.
//
// This is the same comparison the scoring board already does inline per
// column; computing it once on the card means the bridge step is positioned
// in the pipeline (picker → bridge → labelling → scoring) and its result is
// reusable. Each layer reuses the proven single-pair computeBridgeAnalysis
// (fineLevel = i, coarseLevel = i − 1).
//
// Returns null for < 2 levels. Output:
//   {
//     nLevels,
//     byLayer: [{                       // one entry per layer i, i = 1..last
//       layer:        i,
//       coarseLevel:  i - 1,
//       perCluster, perNodeScore, perNodeIsBridge, bridgeCount,   // from the pair
//     }],
//     totalBridges,                     // Σ bridgeCount over layers
//   }
// Lean per-pair bridge count between two candidate partitions of the same n
// nodes. Used to populate the multiLevelPicker heatmap: for every (child,
// parent) where child is finer than parent, count fine clusters that straddle
// ≥ 2 parent clusters. Returns just the count — no perCluster / perNode
// surface — because the heatmap stores L² counts and the full structure would
// be wasteful.
//
// Inputs are bare clusterResults ({ nodeCluster, clusters }), not level
// objects, so the picker can call this over the raw sweep candidates.
export function computeBridgeCountForPair(parentCr, childCr) {
  if (!parentCr || !childCr) return 0;
  const nc = childCr.nodeCluster;
  const pc = parentCr.nodeCluster;
  if (!nc || !pc || nc.length !== pc.length) return 0;
  const n = nc.length;

  // Group node ids by child cluster id, recording the set of parent ids they
  // map to. A child cluster bridges if its members map to ≥ 2 distinct parents.
  const parentsByChild = new Map();
  for (let i = 0; i < n; i++) {
    const cid = nc[i];
    if (cid < 0) continue;
    const pid = pc[i];
    if (pid < 0) continue;
    let set = parentsByChild.get(cid);
    if (!set) { set = new Set(); parentsByChild.set(cid, set); }
    set.add(pid);
  }
  let bridges = 0;
  for (const parents of parentsByChild.values()) {
    if (parents.size >= 2) bridges++;
  }
  return bridges;
}

// Compute bridge counts for every (childIdx, parentIdx) pair where
// childIdx > parentIdx (finer than coarser) across the multiLevel sweep
// candidates. Candidates must be in coarse → fine order (the sweep already
// returns them so).
//
// Returns:
//   {
//     n,                          // candidate count
//     counts: Int32Array(n*n),    // row-major; counts[child * n + parent]
//                                 // only the strict upper triangle is filled
//                                 // (childIdx > parentIdx); other cells 0.
//   }
//
// O(n² · |nodes|) total — for n ≈ 15 candidates and |nodes| ≈ 5000 this is
// ~100 × 5000 = 500k ops, well under a frame.
export function computeBridgesPerPair(candidates) {
  const m = candidates ? candidates.length : 0;
  const counts = new Int32Array(m * m);
  if (m < 2) return { n: m, counts };
  for (let child = 1; child < m; child++) {
    const childCr = candidates[child] && candidates[child].clusterResult;
    if (!childCr) continue;
    for (let parent = 0; parent < child; parent++) {
      const parentCr = candidates[parent] && candidates[parent].clusterResult;
      if (!parentCr) continue;
      counts[child * m + parent] = computeBridgeCountForPair(parentCr, childCr);
    }
  }
  return { n: m, counts };
}

export function computeBridgeAnalysisAllLayers(clusterLevels) {
  if (!clusterLevels || clusterLevels.length < 2) return null;
  const last = clusterLevels.length - 1;
  const byLayer = [];
  let totalBridges = 0;
  for (let i = 1; i <= last; i++) {
    const pair = computeBridgeAnalysis(clusterLevels, { fineLevel: i, coarseLevel: i - 1 });
    if (!pair) continue;
    byLayer.push({
      layer:           i,
      coarseLevel:     i - 1,
      perCluster:      pair.perCluster,
      perNodeScore:    pair.perNodeScore,
      perNodeIsBridge: pair.perNodeIsBridge,
      bridgeCount:     pair.bridgeCount,
    });
    totalBridges += pair.bridgeCount;
  }
  return { nLevels: clusterLevels.length, byLayer, totalBridges };
}
