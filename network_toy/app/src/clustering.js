// Clustering layer — mutual k-NN algorithm.
//
// Pure function: given a generation result + a Layer-1.5 dimredResult,
// recover cluster IDs by building a mutual k-NN graph over the
// dim-reduced positions and taking its connected components.
//
// Math reference: doc/dynamics.md §2.
// Output contract: doc/clustering.md §1, validated by contracts/cluster.js.
//
// Distance is computed in dim-reduced space (dimredResult.data, d-dim).
// Cluster centre/spread are still reported in basePos viz space (3-d) —
// that's a stable promise the cluster contract makes for downstream
// rendering, regardless of how clustering decides what's-near-what.
//
// Does NOT touch originId. Does NOT mutate inputs.
//
// This algorithm does not produce noise points (every node always lands in
// exactly one connected component, even if that component is a singleton).
// `stability` is filled with NaN per cluster — the contract requires the
// field to always be present, but mutual-k-NN has no notion of stability.

const TABLEAU10 = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ab",
];

// Cluster centre/spread is reported in basePos viz space. When the
// active data source supplies no basePos (real-data ingest before
// the viz sub-stage runs), fall back to a zero so clustering doesn't
// crash — centre/spread will be meaningless but correct in shape.
const ZERO3 = [0, 0, 0];

export const defaultClusteringParams = () => ({
  mutualK: 5,
});

export function inferClusters(genResult, params = {}, dimredResult) {
  const nodes = genResult.nodes;
  const n = nodes.length;
  const K = Math.max(1, Math.min(Math.max(1, n - 1), (params.mutualK ?? 5) | 0));

  if (n === 0) {
    return {
      method: "mutualKNN",
      params: { mutualK: K },
      clusters: [],
      nodeCluster: new Int32Array(0),
      structureEdges: [],
    };
  }

  // dimredResult is the canonical input from the new shell; legacy
  // (main.js) calls this without it, in which case we transparently
  // pack basePos into a flat 3-d buffer.
  if (!dimredResult) dimredResult = packBasePos(nodes);
  const pos = dimredResult.data;
  const d   = dimredResult.d;

  // 1. For each node, find its top-K nearest neighbours by dim-reduced distance.
  //    Sort the (n-1) candidates by squared distance, take the first K.
  const topK = new Array(n);
  for (let i = 0; i < n; i++) {
    const ai = i * d;
    const dists = new Array(n - 1);
    let idx = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const bj = j * d;
      let sq = 0;
      for (let k = 0; k < d; k++) {
        const v = pos[ai + k] - pos[bj + k];
        sq += v * v;
      }
      dists[idx++] = [sq, j];
    }
    dists.sort((p, q) => p[0] - q[0]);
    const set = new Set();
    for (let k = 0; k < Math.min(K, dists.length); k++) set.add(dists[k][1]);
    topK[i] = set;
  }

  // 2. Build the mutual k-NN graph and find connected components via union-find.
  //    Edge (i,j) exists iff j ∈ topK(i) AND i ∈ topK(j).
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const structureEdges = [];
  for (let i = 0; i < n; i++) {
    for (const j of topK[i]) {
      if (j > i && topK[j].has(i)) {
        union(i, j);
        structureEdges.push([i, j]);
      }
    }
  }

  // 3. Compress roots → contiguous cluster labels [0..numClusters).
  const roots = new Map();
  let numClusters = 0;
  const nodeCluster = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!roots.has(r)) roots.set(r, numClusters++);
    nodeCluster[i] = roots.get(r);
  }

  // 4. Per-cluster centroid + RMS spread + member count.
  const centroids = Array.from({ length: numClusters }, () => [0, 0, 0]);
  const counts = new Array(numClusters).fill(0);
  for (let i = 0; i < n; i++) {
    const c = nodeCluster[i];
    const p = nodes[i].basePos || ZERO3;
    centroids[c][0] += p[0]; centroids[c][1] += p[1]; centroids[c][2] += p[2];
    counts[c]++;
  }
  for (let c = 0; c < numClusters; c++) {
    if (counts[c] > 0) {
      centroids[c][0] /= counts[c];
      centroids[c][1] /= counts[c];
      centroids[c][2] /= counts[c];
    }
  }
  const sqDevSum = new Float64Array(numClusters);
  for (let i = 0; i < n; i++) {
    const c = nodeCluster[i];
    const p = nodes[i].basePos || ZERO3;
    const cc = centroids[c];
    const dx = p[0] - cc[0], dy = p[1] - cc[1], dz = p[2] - cc[2];
    sqDevSum[c] += dx*dx + dy*dy + dz*dz;
  }
  const clusters = [];
  for (let c = 0; c < numClusters; c++) {
    const spread = counts[c] > 0 ? Math.sqrt(sqDevSum[c] / counts[c]) : 0;
    clusters.push({
      id: c,
      centre: centroids[c],
      spread,
      count: counts[c],
      colour: TABLEAU10[c % TABLEAU10.length],
      stability: NaN,                      // contract requires the field; mutual-k-NN doesn't compute it
    });
  }

  return {
    method: "mutualKNN",
    params: { mutualK: K },
    clusters,
    nodeCluster,
    structureEdges,
  };
}

// Legacy fallback: pack basePos into a DimredResult shape so callers
// that don't yet supply one (legacy main.js) keep working.
function packBasePos(nodes) {
  const n = nodes.length;
  const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = nodes[i].basePos || ZERO3;
    data[i*3] = p[0]; data[i*3+1] = p[1]; data[i*3+2] = p[2];
  }
  return { method: "identity", params: {}, n, d: 3, data };
}
