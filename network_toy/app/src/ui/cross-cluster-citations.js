// Cross-cluster citation degree — pure derivation on top of a clustering
// ladder + the citation edges. For each committed layer, every citation edge
// (directed citing → cited, in node-index space) is mapped to a cluster pair
// (a → b) via that layer's nodeCluster, building a directed cluster×cluster
// flow matrix. From it we surface:
//
//   matrix[a][b]     citations from cluster a → cluster b (a==b = intra).
//   perCluster[a]    { outDeg, inDeg, intra, size }
//                      outDeg = citations a makes to OTHER clusters (Σ_{b≠a} M[a][b])
//                      inDeg  = citations a receives from OTHER clusters (Σ_{b≠a} M[b][a])
//                      intra  = M[a][a]
//   topLinks         strongest inter-cluster flows {a, b, count} (a≠b), desc.
//
// Normalised views are derived on demand in the panel (out-fraction =
// M[a][b] / rowOut[a]); we keep the raw matrix + sizes so either can be shown.
//
// Pure + edges-only (no DOM, no distances). Mirrors bridge-analysis.js's
// all-layers shape so the card/panel follow the same pattern.

// One layer's cross-cluster citation analysis.
//   cr    : { nodeCluster: Int32Array, clusters: [{id, count|members}] }
//   edges : flat [src, dst, …] in node-index space, directed citing→cited.
function computeLayer(cr, edges) {
  const nodeCluster = cr.nodeCluster;
  const k = cr.clusters.length;
  // cluster id → dense row index (ids are usually 0..k-1 but don't assume).
  const idToIdx = new Map();
  cr.clusters.forEach((c, i) => idToIdx.set(c.id, i));

  const matrix = Array.from({ length: k }, () => new Array(k).fill(0));
  let edgesUsed = 0, edgesDropped = 0;
  for (let e = 0; e < edges.length; e += 2) {
    const s = edges[e], d = edges[e + 1];
    const cs = nodeCluster[s], cd = nodeCluster[d];
    if (cs < 0 || cd < 0) { edgesDropped++; continue; }   // noise endpoint
    const ai = idToIdx.get(cs), bi = idToIdx.get(cd);
    if (ai === undefined || bi === undefined) { edgesDropped++; continue; }
    matrix[ai][bi] += 1;
    edgesUsed++;
  }

  const perCluster = cr.clusters.map((c, a) => {
    let outDeg = 0, inDeg = 0;
    for (let b = 0; b < k; b++) {
      if (b === a) continue;
      outDeg += matrix[a][b];
      inDeg  += matrix[b][a];
    }
    return {
      id:    c.id,
      size:  c.count || (c.members && c.members.length) || 0,
      intra: matrix[a][a],
      outDeg,
      inDeg,
    };
  });

  // Top inter-cluster links (a ≠ b), strongest first.
  const links = [];
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      if (a === b || matrix[a][b] === 0) continue;
      links.push({ a: cr.clusters[a].id, b: cr.clusters[b].id, count: matrix[a][b] });
    }
  }
  links.sort((x, y) => y.count - x.count);

  return { k, clusterIds: cr.clusters.map(c => c.id), matrix, perCluster, topLinks: links, edgesUsed, edgesDropped };
}

/**
 * Cross-cluster citation degree across ALL committed layers.
 *
 * @param {Array} clusterLevels  [{uid, clusterResult:{nodeCluster, clusters}}], coarse→fine.
 * @param {number[]} rawCitationEdges  flat [src,dst,…], directed citing→cited.
 * @returns {null | { nLevels, totalEdges, byLayer: [{ layer, uid, k, matrix,
 *                    perCluster, topLinks, edgesUsed, edgesDropped }] }}
 *          null when there are no levels or no edges.
 */
export function computeCrossClusterAllLayers(clusterLevels, rawCitationEdges) {
  if (!clusterLevels || clusterLevels.length === 0) return null;
  const edges = Array.isArray(rawCitationEdges) ? rawCitationEdges : [];
  if (edges.length === 0) return null;

  const byLayer = clusterLevels.map((lvl, i) => {
    const layer = computeLayer(lvl.clusterResult, edges);
    return { layer: i, uid: lvl.uid, ...layer };
  });

  return {
    nLevels:    clusterLevels.length,
    totalEdges: edges.length / 2,
    byLayer,
  };
}
