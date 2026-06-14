// Stage 4 — pair sampling.
//
// Pure function. Bernoulli per-pair draws using rates derived from the
// pair's category (intra/cross × in-taste/off-taste × same/diff
// neighbourhood). Rates are scaled per category to hit the user's budget.
//
// Math reference: doc/dynamics.md §3.4.
//
// Reads:
//   - genResult.nodes[i].t                       (newer-cites-older)
//   - clusterResult.nodeCluster[i]               (intra vs cross)
//   - neighbourhoodResult.nodeNeighbourhood[i]   (intra: same vs diff Ng)
//   - tasteResult.tasteByNeighbourhood[Ng]       (cross: in-taste vs off-taste)
// Mutates: nothing.
//
// Output:
//   {
//     seed, params,
//     citations: [{source, target}],
//     hasCit: Uint8Array(n*n),       symmetric, used by spring force
//     inDeg:  Int32Array(n),
//     pools: { intraValid, crossValid, intraPicked, crossPicked },
//   }

import { mulberry32 } from "./rng.js";

export const defaultCitationParams = () => ({
  samplingSeed: 17,
  density: 0.0,
  intraRate: 0.0,
  crossRate: 0.0,
  epsilonIntra: 0.05,    // soft rate for cross-neighbourhood-same-cluster
  epsilonCross: 0.01,    // soft rate for off-taste cross-cluster
});

export function generateCitations(genResult, clusterResult, neighbourhoodResult, tasteResult, params = {}) {
  const seed = (params.samplingSeed ?? 17) >>> 0;
  const density   = clamp01(params.density);
  const intraRate = clamp01(params.intraRate);
  const crossRate = clamp01(params.crossRate);
  const epsIntra  = Math.max(0, +params.epsilonIntra || 0);
  const epsCross  = Math.max(0, +params.epsilonCross || 0);
  const fracIntra = Math.min(1, density * intraRate);
  const fracCross = Math.min(1, density * crossRate);

  const nodes = genResult.nodes;
  const n = nodes.length;
  const nodeCluster      = clusterResult.nodeCluster;
  const nodeNeighbourhood= neighbourhoodResult.nodeNeighbourhood;
  const tasteByNg        = tasteResult.tasteByNeighbourhood;

  const citations = [];
  const hasCit = new Uint8Array(n * n);
  const inDeg  = new Int32Array(n);

  if (n === 0) {
    return {
      seed, params: { density, intraRate, crossRate, epsIntra, epsCross },
      citations, hasCit, inDeg,
      pools: { intraValid: 0, crossValid: 0, intraPicked: 0, crossPicked: 0 },
    };
  }

  // ── First pass: enumerate valid pairs and assign rates ────────────────
  // Single allocation of triplets: [src, tgt, rate, isIntra].
  // intra rate = 1 (same Ng) or epsIntra (diff Ng, same cluster)
  // cross rate = 1 (in taste)  or epsCross (off taste)
  const intraPairs = [];   // {src, tgt, rate}
  const crossPairs = [];
  for (let i = 0; i < n; i++) {
    const ti = nodes[i].t;
    const ci = nodeCluster[i];
    const ngi = nodeNeighbourhood[i];
    const taste = tasteByNg[ngi];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (ti <= nodes[j].t) continue;             // newer cites older
      const cj = nodeCluster[j];
      if (ci === cj) {
        const rate = (nodeNeighbourhood[j] === ngi) ? 1.0 : epsIntra;
        if (rate > 0) intraPairs.push([i, j, rate]);
      } else {
        const rate = (taste && taste.has(cj)) ? 1.0 : epsCross;
        if (rate > 0) crossPairs.push([i, j, rate]);
      }
    }
  }

  // ── Per-category scale to hit the budget ──────────────────────────────
  // Σ rate_i = expected Σ Bernoulli(rate_i) = expected count if scale=1.
  // We want expected count = fracCategory · |valid pairs|, so scale =
  // target / Σ rate. Clamp to [0, 1] (over-budget would mean scale > 1
  // which would push some rates above 1 — undefined for Bernoulli).
  // "valid pairs" includes ε-rated pairs because they are still drawable.
  const intraValidExact = intraPairs.length;
  const crossValidExact = crossPairs.length;

  let sumIntra = 0;
  for (const p of intraPairs) sumIntra += p[2];
  let sumCross = 0;
  for (const p of crossPairs) sumCross += p[2];

  const targetIntra = fracIntra * intraValidExact;
  const targetCross = fracCross * crossValidExact;

  const scaleIntra = sumIntra > 0 ? Math.min(1, targetIntra / sumIntra) : 0;
  const scaleCross = sumCross > 0 ? Math.min(1, targetCross / sumCross) : 0;

  // ── Bernoulli draw per pair ───────────────────────────────────────────
  const rng = mulberry32(seed);
  let intraPicked = 0;
  let crossPicked = 0;

  for (const [src, tgt, rate] of intraPairs) {
    const p = rate * scaleIntra;
    if (p > 0 && rng() < p) {
      citations.push({ source: src, target: tgt });
      hasCit[src * n + tgt] = 1;
      hasCit[tgt * n + src] = 1;
      inDeg[tgt]++;
      intraPicked++;
    }
  }
  for (const [src, tgt, rate] of crossPairs) {
    const p = rate * scaleCross;
    if (p > 0 && rng() < p) {
      citations.push({ source: src, target: tgt });
      hasCit[src * n + tgt] = 1;
      hasCit[tgt * n + src] = 1;
      inDeg[tgt]++;
      crossPicked++;
    }
  }

  return {
    seed,
    params: { density, intraRate, crossRate, epsIntra, epsCross },
    citations, hasCit, inDeg,
    pools: {
      intraValid: intraValidExact,
      crossValid: crossValidExact,
      intraPicked, crossPicked,
    },
  };
}

function clamp01(x) { return Math.max(0, Math.min(1, +x || 0)); }
