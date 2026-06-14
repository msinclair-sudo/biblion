// Bayes-optimal ARI ceiling for a Gaussian-mixture dataset.
//
// Why this exists (§6.18.10 B5): the toy generates points from a
// Gaussian mixture. Each point has a true `originId` (the component
// it was drawn from). A clustering algorithm tries to recover the
// origin partition from positions alone. But when components overlap
// (which they do at any reasonable `spread`), even the optimal Bayes
// classifier — which knows the true model and applies argmax over
// posterior — misclassifies some fraction of points. So ARI against
// originId can never reach 1.0; it has an upper bound determined by
// component separability.
//
// Reporting ARI naked is misleading: "0.85" looks low until you
// know the ceiling is 0.92, at which point "0.85" reads as
// "92% of optimal — algorithm did well". `bayesOptimalAri` provides
// that calibration.
//
// Method:
//   1. For each node x_i, compute log-posterior over each component k:
//        log P(c=k|x) ∝ log P(x|c=k) + log P(c=k)
//      where P(x|c) is the diagonal Gaussian PDF and P(c) is the
//      empirical prior (count_k / N) on the actual sample.
//   2. bayesLabel[i] = argmax_k posterior. This is the optimal
//      classifier's labelling.
//   3. ari = adjustedRandIndex(bayesLabels, originIds).
//
// Using empirical priors (observed counts) rather than the generative
// weights makes the ceiling reflect "what an optimal classifier
// achieves on THIS sample" rather than "in the limit". More useful as
// a calibration for the actually-reported ARI.

import { adjustedRandIndex } from "./ari.js";

/**
 * Compute the Bayes-optimal ARI ceiling for a Gaussian-mixture dataset.
 *
 * @param {Array<{originId:int, basePos:[x,y,z]}>} nodes
 * @param {Array<{id:int, centre:[x,y,z], spread:[sx,sy,sz]}>} origins
 *        Generator components (centre + diagonal sigma per axis).
 * @returns {number} ARI in [0, 1]. NaN if inputs are degenerate.
 */
export function computeBayesOptimalAri(nodes, origins) {
  if (!nodes || !origins || nodes.length === 0 || origins.length === 0) {
    return NaN;
  }
  const N = nodes.length;
  const K = origins.length;

  // Empirical priors from the actual sample. Add a tiny floor so a
  // component with zero observed samples doesn't crash log().
  const counts = new Array(K).fill(0);
  for (const node of nodes) {
    const k = node.originId | 0;
    if (k >= 0 && k < K) counts[k]++;
  }
  const logPrior = counts.map(c => Math.log(Math.max(c, 1e-9) / N));

  // Per-component diagonal-Gaussian log-normalising constants.
  // log P(x|c) = -0.5 * sum_d ((x_d - mu_d)/sigma_d)^2 - sum_d log(sigma_d)
  //              - 0.5 * d * log(2π)
  // Drop the constant -0.5*d*log(2π) (cancels in argmax).
  const negLogNorm = origins.map(o => {
    const s = o.spread;
    return -(Math.log(s[0]) + Math.log(s[1]) + Math.log(s[2]));
  });

  const bayesLabels = new Int32Array(N);
  const origLabels  = new Int32Array(N);

  for (let i = 0; i < N; i++) {
    const node = nodes[i];
    origLabels[i] = node.originId | 0;
    const x = node.basePos;

    let bestK    = 0;
    let bestLogP = -Infinity;
    for (let k = 0; k < K; k++) {
      const mu = origins[k].centre;
      const s  = origins[k].spread;
      const dx = (x[0] - mu[0]) / s[0];
      const dy = (x[1] - mu[1]) / s[1];
      const dz = (x[2] - mu[2]) / s[2];
      const logPx = -0.5 * (dx * dx + dy * dy + dz * dz) + negLogNorm[k];
      const logP  = logPx + logPrior[k];
      if (logP > bestLogP) {
        bestLogP = logP;
        bestK    = k;
      }
    }
    bayesLabels[i] = bestK;
  }

  return adjustedRandIndex(bayesLabels, origLabels);
}
