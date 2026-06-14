// Stage 1 — within-cluster neighbourhoods.
//
// Pure function. Mutual k-NN connected components, run per cluster on its
// own member set. Neighbourhood IDs are unique across the whole dataset.
//
// Math reference: doc/dynamics.md §3.1.
//
// Reads:
//   - genResult.nodes[i].basePos
//   - clusterResult.nodeCluster[i]
// Mutates: nothing.
//
// Output:
//   {
//     neighbourK,
//     neighbourhoods: [{
//       id, clusterId, members:[i,...], centroid:[x,y,z], count
//     }],
//     nodeNeighbourhood: Int32Array            nodeNeighbourhood[i] = Ng id
//   }

export const defaultNeighbourhoodParams = () => ({
  neighbourK: 3,
});

export function inferNeighbourhoods(genResult, clusterResult, params = {}) {
  const nodes = genResult.nodes;
  const n = nodes.length;
  const K_req = Math.max(1, (params.neighbourK ?? 3) | 0);

  const nodeNeighbourhood = new Int32Array(n);
  const neighbourhoods = [];

  if (n === 0 || clusterResult.clusters.length === 0) {
    return { neighbourK: K_req, neighbourhoods, nodeNeighbourhood };
  }

  // Group node indices by cluster id.
  const byCluster = Array.from({ length: clusterResult.clusters.length }, () => []);
  for (let i = 0; i < n; i++) byCluster[clusterResult.nodeCluster[i]].push(i);

  for (let c = 0; c < byCluster.length; c++) {
    const M = byCluster[c];
    const m = M.length;
    if (m === 0) continue;

    // Edge case — singleton cluster: one neighbourhood with the lone member.
    if (m === 1) {
      const ngId = neighbourhoods.length;
      const p = nodes[M[0]].basePos;
      neighbourhoods.push({
        id: ngId, clusterId: c, members: [M[0]],
        centroid: [p[0], p[1], p[2]], count: 1,
      });
      nodeNeighbourhood[M[0]] = ngId;
      continue;
    }

    const K = Math.min(K_req, m - 1);

    // 1. For each i ∈ M, find its top-K nearest neighbours within M (basePos).
    const topK = new Array(m);
    for (let a = 0; a < m; a++) {
      const i = M[a];
      const pi = nodes[i].basePos;
      const dists = new Array(m - 1);
      let idx = 0;
      for (let b = 0; b < m; b++) {
        if (b === a) continue;
        const j = M[b];
        const pj = nodes[j].basePos;
        const dx = pi[0] - pj[0], dy = pi[1] - pj[1], dz = pi[2] - pj[2];
        dists[idx++] = [dx*dx + dy*dy + dz*dz, b];
      }
      dists.sort((p, q) => p[0] - q[0]);
      const set = new Set();
      for (let k = 0; k < K; k++) set.add(dists[k][1]);
      topK[a] = set;
    }

    // 2. Mutual k-NN union-find on the local index space [0..m).
    const parent = new Int32Array(m);
    for (let a = 0; a < m; a++) parent[a] = a;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let a = 0; a < m; a++) {
      for (const b of topK[a]) {
        if (b > a && topK[b].has(a)) union(a, b);
      }
    }

    // 3. Compress local roots into neighbourhood ids (globally unique).
    const localToNg = new Map();
    for (let a = 0; a < m; a++) {
      const r = find(a);
      if (!localToNg.has(r)) {
        const ngId = neighbourhoods.length;
        localToNg.set(r, ngId);
        neighbourhoods.push({
          id: ngId, clusterId: c, members: [], centroid: [0, 0, 0], count: 0,
        });
      }
      const ngId = localToNg.get(r);
      const i = M[a];
      const ng = neighbourhoods[ngId];
      ng.members.push(i);
      const p = nodes[i].basePos;
      ng.centroid[0] += p[0]; ng.centroid[1] += p[1]; ng.centroid[2] += p[2];
      ng.count++;
      nodeNeighbourhood[i] = ngId;
    }
  }

  // Finalise centroids.
  for (const ng of neighbourhoods) {
    if (ng.count > 0) {
      ng.centroid[0] /= ng.count;
      ng.centroid[1] /= ng.count;
      ng.centroid[2] /= ng.count;
    }
  }

  return { neighbourK: K_req, neighbourhoods, nodeNeighbourhood };
}
