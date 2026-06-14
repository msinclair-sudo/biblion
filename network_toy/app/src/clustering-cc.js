// Connected-components clustering.
//
// Trivial baseline: build a k-NN graph (directed: each node → its top-K
// nearest neighbours), symmetrise (edge i↔j if either i→j or j→i),
// return connected components as clusters.
//
// Differs from the existing mutual-k-NN algorithm by NOT requiring
// reciprocity — any directed neighbour edge is enough. This makes
// CC much more permissive than mutual k-NN: even small k values
// usually produce one giant cluster on dense data. Useful as a
// baseline reference and for stress-testing the cluster contract
// validator.
//
// Math reference: trivial — connected components on a sparse graph.
// Output conforms to doc/clustering.md §1.

const TABLEAU10 = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ab",
];

// Cluster centre/spread fallback when nodes carry no basePos (real-
// data path before viz sub-stage runs). Centre/spread is viz-only;
// zero is a sentinel that doesn't lie about real geometry.
const ZERO3 = [0, 0, 0];

export const defaultCCParams = () => ({
  k: 8,
});

export function inferConnectedComponents(genResult, params = {}, dimredResult) {
  const nodes = genResult.nodes;
  const n = nodes.length;
  const k = Math.max(1, Math.min(n - 1, +params.k || 8));

  // dimredResult is the canonical input from the new shell; legacy
  // (main.js) calls this without it, in which case we transparently
  // pack basePos into a flat 3-d buffer.
  if (!dimredResult) dimredResult = packBasePos(nodes);
  const pos = dimredResult.data;
  const d   = dimredResult.d;

  // 1. For each node, find its top-k nearest neighbours by Euclidean
  //    distance in dim-reduced space.
  const topK = new Array(n);
  for (let i = 0; i < n; i++) {
    const ai = i * d;
    const dists = new Array(n - 1);
    let idx = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const bj = j * d;
      let sq = 0;
      for (let h = 0; h < d; h++) {
        const v = pos[ai + h] - pos[bj + h];
        sq += v * v;
      }
      dists[idx++] = [sq, j];
    }
    dists.sort((a, b) => a[0] - b[0]);
    const set = new Set();
    for (let h = 0; h < k; h++) set.add(dists[h][1]);
    topK[i] = set;
  }

  // 2. Union-find on the symmetrised graph (any direction counts).
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const structureEdges = [];
  for (let i = 0; i < n; i++) {
    for (const j of topK[i]) {
      if (j > i) {
        union(i, j);
        structureEdges.push([i, j]);
      }
    }
  }

  // 3. Compress roots into contiguous cluster ids.
  const rootToId = new Map();
  const nodeCluster = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!rootToId.has(r)) rootToId.set(r, rootToId.size);
    nodeCluster[i] = rootToId.get(r);
  }

  // 4. Per-cluster aggregates.
  const numClusters = rootToId.size;
  const clusters = new Array(numClusters);
  const sums = new Array(numClusters);
  const counts = new Int32Array(numClusters);
  for (let c = 0; c < numClusters; c++) sums[c] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const c = nodeCluster[i];
    const p = nodes[i].basePos || ZERO3;
    sums[c][0] += p[0]; sums[c][1] += p[1]; sums[c][2] += p[2];
    counts[c]++;
  }
  for (let c = 0; c < numClusters; c++) {
    const cnt = counts[c] || 1;
    const centre = [sums[c][0] / cnt, sums[c][1] / cnt, sums[c][2] / cnt];
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      if (nodeCluster[i] !== c) continue;
      const p = nodes[i].basePos || ZERO3;
      const dx = p[0] - centre[0], dy = p[1] - centre[1], dz = p[2] - centre[2];
      sumSq += dx*dx + dy*dy + dz*dz;
    }
    const spread = counts[c] > 0 ? Math.sqrt(sumSq / counts[c]) : 0;
    clusters[c] = {
      id:        c,
      centre,
      spread,
      count:     counts[c],
      colour:    TABLEAU10[c % TABLEAU10.length],
      stability: NaN,           // CC has no stability concept
    };
  }

  return {
    method:        "connected-components",
    params:        { k },
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
