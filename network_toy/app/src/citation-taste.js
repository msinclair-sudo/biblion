// Stages 2 + 3 — citation taste.
//
// Pure function. Three passes:
//   Pass 1 — each Ng draws an independent taste set T(Ng)_1.
//   Pass 2 — each Ng redraws with a Gaussian-kernel distance-decaying tilt
//            from sibling neighbourhoods in the same cluster.
//   Pass 3 — triangle-completion swap, weighted by neighbourhood
//            representativeness within its cluster.
//
// Math reference: doc/dynamics.md §3.2 + §3.3.
//
// Reads:
//   - clusterResult.clusters[].centre
//   - neighbourhoodResult.neighbourhoods[].centroid + clusterId
// Mutates: nothing.
//
// Output:
//   {
//     seed, params,
//     tasteByNeighbourhood: Set<clusterId>[],   final T(Ng) per neighbourhood
//     tasteByCluster:        Set<clusterId>[],   union per cluster (debug aid)
//   }

import { mulberry32 } from "./rng.js";

export const defaultTasteParams = () => ({
  tasteSeed: 23,
  favouritesMean: 1.5,    // Poisson rate for taste-set size
  sharedTaste: 0.7,       // pass-2 tilt strength
  tasteRange: 18,         // Gaussian kernel σ in scene units (absolute)
  transitiveBoost: 0.4,   // pass-3 swap acceptance multiplier
});

export function buildCitationTaste(clusterResult, neighbourhoodResult, params = {}) {
  const seed = (params.tasteSeed ?? 23) >>> 0;
  const favouritesMean = Math.max(0, +params.favouritesMean || 0);
  const sharedTaste    = Math.max(0, +params.sharedTaste    || 0);
  const tasteRange     = Math.max(0.001, +params.tasteRange || 0.001);
  const transitiveBoost= Math.max(0, +params.transitiveBoost|| 0);

  const numClusters = clusterResult.clusters.length;
  const neighbourhoods = neighbourhoodResult.neighbourhoods;
  const NG = neighbourhoods.length;

  if (numClusters <= 1 || NG === 0) {
    // Degenerate: not enough clusters for cross-citations to make sense.
    return {
      seed, params: { favouritesMean, sharedTaste, tasteRange, transitiveBoost },
      tasteByNeighbourhood: Array.from({ length: NG }, () => new Set()),
      tasteByCluster:        Array.from({ length: numClusters }, () => new Set()),
    };
  }

  const rng = mulberry32(seed);
  const otherClusters = (c) => {
    const out = [];
    for (let d = 0; d < numClusters; d++) if (d !== c) out.push(d);
    return out;
  };

  // Pre-compute neighbourhoods grouped by cluster (for faster pass 2/3).
  const byCluster = Array.from({ length: numClusters }, () => []);
  for (const ng of neighbourhoods) byCluster[ng.clusterId].push(ng);

  // ── Pass 1 — independent taste draws ──────────────────────────────────
  // favCount per Ng is drawn deterministically here and reused in pass 2.
  const favCount = new Int32Array(NG);
  const taste1   = new Array(NG);          // [Ng] -> Array<clusterId>
  for (let g = 0; g < NG; g++) {
    const ng = neighbourhoods[g];
    const others = otherClusters(ng.clusterId);
    const cap = others.length;
    let count = poissonSample(favouritesMean, rng);
    if (count < 1) count = 1;
    if (count > cap) count = cap;
    favCount[g] = count;
    taste1[g] = sampleUniformWithoutReplacement(others, count, rng);
  }

  // ── Pass 2 — distance-decaying shared-taste redraw ────────────────────
  const sigma2 = tasteRange * tasteRange;
  const taste2 = new Array(NG);
  for (let g = 0; g < NG; g++) {
    const ng = neighbourhoods[g];
    const c  = ng.clusterId;
    const siblings = byCluster[c];
    const others = otherClusters(c);

    // popularity(Ng, d): kernel-weighted vote of siblings' pass-1 picks.
    const pop = new Map();   // clusterId -> weight
    for (const ng2 of siblings) {
      if (ng2.id === ng.id) continue;
      const dx = ng.centroid[0] - ng2.centroid[0];
      const dy = ng.centroid[1] - ng2.centroid[1];
      const dz = ng.centroid[2] - ng2.centroid[2];
      const r2 = dx*dx + dy*dy + dz*dz;
      const k = Math.exp(-r2 / (2 * sigma2));
      for (const d of taste1[ng2.id]) {
        pop.set(d, (pop.get(d) || 0) + k);
      }
    }

    // Tilted weights: w(d) = 1 + sharedTaste · popularity(d).
    const weights = others.map(d => 1 + sharedTaste * (pop.get(d) || 0));

    // Sample favCount entries without replacement.
    taste2[g] = sampleWeightedWithoutReplacement(others, weights, favCount[g], rng);
  }

  // ── Pass 3 — triangle-completion swap (mixed cluster + Ng level) ──────
  // Compute cluster-level taste union from pass 2.
  const T_cluster = Array.from({ length: numClusters }, () => new Set());
  for (let g = 0; g < NG; g++) {
    const c = neighbourhoods[g].clusterId;
    for (const d of taste2[g]) T_cluster[c].add(d);
  }

  // triangleScore(c, d): # of third clusters c' that cite both c and d.
  const triangleScore = new Float64Array(numClusters * numClusters);
  for (let cPrime = 0; cPrime < numClusters; cPrime++) {
    const tc = T_cluster[cPrime];
    if (tc.size < 2) continue;
    const arr = Array.from(tc);
    for (let i = 0; i < arr.length; i++) {
      for (let j = 0; j < arr.length; j++) {
        if (i === j) continue;
        const c = arr[i], d = arr[j];
        if (cPrime === c || cPrime === d) continue;
        triangleScore[c * numClusters + d] += 1;
      }
    }
  }

  // Representativeness ρ(Ng) = exp(-r²(Ng, c) / (2σ²)). Centroid distance
  // from cluster centre — already on clusterResult.clusters[c].centre.
  const rho = new Float64Array(NG);
  for (let g = 0; g < NG; g++) {
    const ng = neighbourhoods[g];
    const cc = clusterResult.clusters[ng.clusterId].centre;
    const dx = ng.centroid[0] - cc[0];
    const dy = ng.centroid[1] - cc[1];
    const dz = ng.centroid[2] - cc[2];
    const r2 = dx*dx + dy*dy + dz*dz;
    rho[g] = Math.exp(-r2 / (2 * sigma2));
  }

  // Per-Ng swap: pick a candidate weighted by triangleScore(c, ·), accept
  // with prob transitiveBoost · ρ · normaliser. The normaliser keeps
  // acceptance ≤ 1 even when triangleScore is large.
  //
  // For acceptance normalisation we scale by the maximum triangle score
  // observed for any (c, d) pair, so the strongest signal in the dataset
  // gives acceptance = transitiveBoost · ρ.
  let maxTri = 0;
  for (let i = 0; i < triangleScore.length; i++) {
    if (triangleScore[i] > maxTri) maxTri = triangleScore[i];
  }

  const taste3 = taste2.map(arr => arr.slice());
  if (maxTri > 0 && transitiveBoost > 0) {
    for (let g = 0; g < NG; g++) {
      const ng = neighbourhoods[g];
      const c = ng.clusterId;
      const current = new Set(taste3[g]);
      // Candidate list: clusters d ≠ c not already in T(Ng), weighted by
      // triangleScore(c, d).
      const candidates = [];
      const candWeights = [];
      let total = 0;
      for (let d = 0; d < numClusters; d++) {
        if (d === c || current.has(d)) continue;
        const w = triangleScore[c * numClusters + d];
        if (w > 0) {
          candidates.push(d);
          candWeights.push(w);
          total += w;
        }
      }
      if (total === 0) continue;

      // Pick a candidate weighted by triangle score.
      let r = rng() * total;
      let pickIdx = 0;
      for (; pickIdx < candidates.length; pickIdx++) {
        r -= candWeights[pickIdx];
        if (r <= 0) break;
      }
      if (pickIdx >= candidates.length) pickIdx = candidates.length - 1;
      const d = candidates[pickIdx];

      // Acceptance: transitiveBoost · ρ · (score/maxTri). Each factor in
      // [0, 1], so acceptance ≤ transitiveBoost.
      const accept = transitiveBoost * rho[g] * (candWeights[pickIdx] / maxTri);
      if (rng() < accept && taste3[g].length > 0) {
        // Swap a random existing entry (RNG-deterministic) with d.
        const replaceIdx = Math.floor(rng() * taste3[g].length);
        taste3[g][replaceIdx] = d;
      }
    }
  }

  // Final taste sets.
  const tasteByNeighbourhood = taste3.map(arr => new Set(arr));
  const tasteByCluster = Array.from({ length: numClusters }, () => new Set());
  for (let g = 0; g < NG; g++) {
    const c = neighbourhoods[g].clusterId;
    for (const d of tasteByNeighbourhood[g]) tasteByCluster[c].add(d);
  }

  return {
    seed,
    params: { favouritesMean, sharedTaste, tasteRange, transitiveBoost },
    tasteByNeighbourhood,
    tasteByCluster,
  };
}

/* ── helpers ────────────────────────────────────────────────────────────── */

// Knuth's algorithm for Poisson(λ) — fine for small λ (≤ 30).
function poissonSample(lambda, rng) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

// Uniform sample w/o replacement: partial Fisher-Yates.
function sampleUniformWithoutReplacement(items, count, rng) {
  const arr = items.slice();
  const k = Math.min(count, arr.length);
  for (let i = 0; i < k; i++) {
    const r = i + Math.floor(rng() * (arr.length - i));
    [arr[i], arr[r]] = [arr[r], arr[i]];
  }
  return arr.slice(0, k);
}

// Weighted sample w/o replacement: sequential weighted draw, swap-remove.
function sampleWeightedWithoutReplacement(items, weights, count, rng) {
  const arr = items.slice();
  const w = weights.slice();
  let total = 0;
  for (let i = 0; i < w.length; i++) total += w[i];
  const k = Math.min(count, arr.length);
  const out = [];
  for (let pick = 0; pick < k; pick++) {
    if (total <= 0) break;
    let r = rng() * total;
    let idx = 0;
    for (; idx < arr.length; idx++) { r -= w[idx]; if (r <= 0) break; }
    if (idx >= arr.length) idx = arr.length - 1;
    out.push(arr[idx]);
    total -= w[idx];
    const last = arr.length - 1;
    arr[idx] = arr[last]; w[idx] = w[last];
    arr.pop();            w.pop();
  }
  return out;
}
