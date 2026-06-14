// Lloyd's k-means with k-means++ initialisation. Used as the eval
// baseline: "what's the best you could do with this many points if
// you knew the right K and were allowed to assume convex blobs?"
// Density-based methods like HDBSCAN should approach this on
// well-separated mixtures and fall short on heavily-overlapping ones.
//
// Pure: no DOM, no app state. Takes raw points + k.

export function kmeans(points, k, opts = {}) {
  const restarts = opts.restarts ?? 5;
  const maxIter  = opts.maxIter  ?? 100;
  const rng      = opts.rng      ?? Math.random;

  const n = points.length;
  if (n === 0 || k <= 0) return { labels: new Int32Array(0), inertia: 0 };
  k = Math.min(k, n);

  let bestLabels = null;
  let bestInertia = Infinity;
  for (let r = 0; r < restarts; r++) {
    const out = singleRun(points, k, maxIter, rng);
    if (out.inertia < bestInertia) {
      bestInertia = out.inertia;
      bestLabels  = out.labels;
    }
  }
  return { labels: bestLabels, inertia: bestInertia };
}

function singleRun(points, k, maxIter, rng) {
  const n = points.length;
  const dim = points[0].length;

  // k-means++ init.
  const centroids = new Array(k);
  centroids[0] = points[Math.floor(rng() * n)].slice();
  const minDist = new Float32Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    const q = centroids[c - 1];
    for (let i = 0; i < n; i++) {
      const p = points[i];
      let d = 0;
      for (let j = 0; j < dim; j++) { const dd = p[j] - q[j]; d += dd * dd; }
      if (d < minDist[i]) minDist[i] = d;
      total += minDist[i];
    }
    let r = rng() * total;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      r -= minDist[i];
      if (r <= 0) { pick = i; break; }
    }
    centroids[c] = points[pick].slice();
  }

  const labels = new Int32Array(n);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let bestC = 0, bestD = Infinity;
      const p = points[i];
      for (let c = 0; c < k; c++) {
        const q = centroids[c];
        let d = 0;
        for (let j = 0; j < dim; j++) { const dd = p[j] - q[j]; d += dd * dd; }
        if (d < bestD) { bestD = d; bestC = c; }
      }
      if (labels[i] !== bestC) { labels[i] = bestC; changed = true; }
    }
    if (!changed) break;
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      const p = points[i];
      for (let j = 0; j < dim; j++) sums[c][j] += p[j];
      counts[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let j = 0; j < dim; j++) centroids[c][j] = sums[c][j] / counts[c];
    }
  }

  let inertia = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i], q = centroids[labels[i]];
    let d = 0;
    for (let j = 0; j < dim; j++) { const dd = p[j] - q[j]; d += dd * dd; }
    inertia += d;
  }
  return { labels, inertia };
}
