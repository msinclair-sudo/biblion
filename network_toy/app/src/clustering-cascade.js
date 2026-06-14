// Multi-level clustering cascade — shared by the main-thread engine
// (engine.js) and the clustering worker (workers/clustering-worker.js).
//
// Extracted from engine.js so the worker can run the full cascade
// inside one job: send the inputs once, get the levels[] array back
// once, no per-level postMessage chatter.
//
// Pure: no state reads, no DOM. Inputs:
//   algo          a clustering registry entry (resolves to the same
//                 module on both threads — the registry is pure)
//   nodesSlim     [{ id, basePos: [x,y,z] }] — the minimum the
//                 algorithms actually read off genResult.nodes.
//                 Anything else the algorithms used to read (`origin`,
//                 `t`, `cite`) isn't touched by the clustering layer.
//   levelCfgs     state.layerParams.clustering.levels — each level's
//                 { uid, scope, params }
//   dimredResult  the full-n DimredResult (compression slot output)
//   allowNoise    bool (read off algo.allowsNoise on the caller side)
//   n             nodes.length, for contract validation
//   precomputedLevels (optional) — sparse [cr | null] indexed by level.
//                 If non-null at level i AND `i === 0` (only global level
//                 0 is safely cacheable today — within-parent levels are
//                 derived from the parent's clustering and can't be lifted
//                 from a sibling sweep result), the cascade skips
//                 `algo.infer` for that level and uses the supplied cr
//                 directly. Caller responsibility to ensure the cr was
//                 produced with the same (algo, params) the level cfg
//                 carries. Used by A3 (§6.18.3) to avoid re-running the
//                 sweep's infer on per-row Apply.
//
// Returns: levels[] in the same shape engine.js used to produce —
// each entry { uid, scope: "global" | "within-parent", clusterResult }.

import { validateClusterResult } from "./contracts/cluster.js";

// Ghost-node clustering (ghost-node spec §4.4). Ghosts (`isGhost`, the last
// n-m node indices by the contract's ghosts-last invariant) are positioned
// by fusion but have no semantic embedding, so they are EXCLUDED from the
// clustering fit: every level runs the algorithm on the m embedded nodes
// only, then each ghost is assigned post-hoc to the cluster of its nearest
// EMBEDDED citation neighbour (or -1 / the reserved structural label if it
// has none). This is the single code path — the per-level call is wrapped by
// `runLevelOnEmbedded` whether or not ghosts are present; with no ghosts the
// wrapper is the identity and the clustering math is untouched.
//
// opts (added for §4.4):
//   ghostMask     Uint8Array(n), 1 = ghost. Null/absent ⇒ no ghosts.
//   citationEdges flat number[] of [src, dst, …] node-index pairs (the
//                 data source's rawCitationEdges). Used to find each
//                 ghost's embedded citation neighbours.
export function runClusterLevels(algo, nodesSlim, levelCfgs, dimredResult, allowNoise, n, opts = {}) {
  const precomputedLevels = opts.precomputedLevels || [];
  const levels = [];
  let parent = null;
  // The clustering algorithms expect a genResult-shaped object — but
  // only read .nodes off it. Build a minimal stub once.
  const genStub = { nodes: nodesSlim };

  // Ghost bookkeeping (null when the source has no ghosts → identity path).
  const ghosts = buildGhostContext(opts.ghostMask, opts.citationEdges, dimredResult, n);

  for (let i = 0; i < levelCfgs.length; i++) {
    const lvl = levelCfgs[i];
    const isGlobal = (i === 0) || lvl.scope === "global";
    let cr;
    // Only L0 (always global) is safely cacheable from sweep results.
    // Higher-level globals could be too, but the matching gets fragile
    // and we don't have a use case yet.
    const cached = (i === 0) ? precomputedLevels[i] : null;
    if (cached) {
      // A cached cr is already full-n (produced + validated for n upstream by
      // the Optimise sweep). The sweep applies the SAME §4.4 ghost exclusion as
      // this cascade (it fits on the m embedded nodes and expands ghosts via
      // expandGhostResult before caching), so a sweep-cached L0 is already
      // ghost-correct and is reused verbatim.
      cr = cached;
    } else {
      cr = runLevelOnEmbedded(ghosts, n, allowNoise, (subGen, subDimred, subParent) =>
        isGlobal
          ? algo.infer(subGen, lvl.params, subDimred)
          : clusterWithinParents(algo, subGen, subParent, lvl.params, subDimred),
        genStub, dimredResult, parent,
      );
    }
    validateClusterResult(cr, n, { allowNoise });
    levels.push({ uid: lvl.uid, scope: isGlobal ? "global" : "within-parent", clusterResult: cr });
    parent = cr;
  }
  return levels;
}

// Run one clustering level on the m embedded nodes only, then expand the
// result back to all n nodes by assigning each ghost its nearest embedded
// citation neighbour's label (ghost-node spec §4.4). `runFit(subGen,
// subDimred, subParent)` performs the actual clustering on the embedded
// subproblem and must return a ClusterResult shaped over the m embedded
// nodes (in embedded index order). When there are no ghosts this is a
// straight pass-through — the clustering math is identical.
function runLevelOnEmbedded(ghosts, n, allowNoise, runFit, genStub, dimredResult, parent) {
  if (!ghosts) return runFit(genStub, dimredResult, parent);

  const { embToFull, m } = ghosts;
  // Embedded subproblem: slice nodes + dimred rows + parent labels down to
  // the m embedded indices. embToFull[localIdx] = full node index. Because
  // ghosts are the last n-m indices, embToFull is just [0..m-1] today, but
  // we go through the map so the path is correct if that ever changes.
  const subNodes = new Array(m);
  for (let li = 0; li < m; li++) subNodes[li] = genStub.nodes[embToFull[li]];
  const subGen = { ...genStub, nodes: subNodes };
  const subDimred = sliceDimred(dimredResult, embToFull);
  const subParent = parent ? sliceParentLabels(parent, embToFull, m) : null;

  const subCr = runFit(subGen, subDimred, subParent);
  return expandGhostResult(subCr, ghosts, n, allowNoise);
}

// Reserved label/colour for "structural" ghosts — ghosts with no embedded
// citation neighbour to inherit a cluster from (ghost-node spec §4.4).
const STRUCTURAL_COLOUR = "#5a5f6a";

// Expand an m-node (embedded-only) ClusterResult to a full-n ClusterResult,
// assigning each ghost the label of its nearest embedded citation neighbour.
// A ghost with no embedded neighbour is "structural": -1 when the algorithm
// allows noise, else a single reserved trailing cluster (the contract bans
// -1 under allowNoise=false). Remaps every n-indexed field — nodeCluster,
// structureEdges, cluster counts, and (HDBSCAN's) condensedTree per-leaf
// arrays — from embedded index space back to full node-index space.
export function expandGhostResult(subCr, ghosts, n, allowNoise) {
  const { embToFull, fullToEmb, ghostNbrFull, m } = ghosts;
  const baseClusterCount = subCr.clusters.filter(c => c.id >= 0).length;
  // Reserved id for structural ghosts: -1 (noise) when allowed, else a new
  // trailing cluster id appended after the embedded clusters.
  const structuralId = allowNoise ? -1 : baseClusterCount;

  // 1. nodeCluster: embedded nodes carry their fit label; ghosts inherit the
  //    label of their nearest embedded citation neighbour, or the structural
  //    id if none.
  const sub = subCr.nodeCluster;
  const full = new Int32Array(n).fill(-1);
  for (let li = 0; li < m; li++) full[embToFull[li]] = sub[li];
  let anyStructural = false;
  for (let i = 0; i < n; i++) {
    if (fullToEmb[i] !== -1) continue;          // embedded — already set
    const nbr = ghostNbrFull[i];                // full index of nearest embedded neighbour
    if (nbr !== -1) full[i] = sub[fullToEmb[nbr]];
    else { full[i] = structuralId; anyStructural = true; }
  }

  // 2. Cluster metadata: re-count over the full nodeCluster so `count`
  //    matches the contract (ghosts now contribute). Centres/spreads are
  //    viz-only and come from the embedded fit; absorbing ghosts into the
  //    counts is enough for the contract + legend. Append the reserved
  //    structural cluster when needed under allowNoise=false.
  let clusterDefs = subCr.clusters.slice();
  if (anyStructural && !allowNoise) {
    clusterDefs.push({
      id: structuralId, centre: [0, 0, 0], spread: 0, count: 0,
      colour: STRUCTURAL_COLOUR, stability: NaN,
    });
  } else if (anyStructural && allowNoise && !clusterDefs.some(c => c.id === -1)) {
    // Structural ghosts became noise (id -1) but the embedded fit emitted no
    // noise entry — append the contract's single trailing noise cluster.
    clusterDefs.push({
      id: -1, centre: [0, 0, 0], spread: 0, count: 0,
      colour: STRUCTURAL_COLOUR, stability: NaN,
    });
  }
  // Count by cluster id (id -1 = the trailing noise entry under allowNoise).
  const countById = new Map();
  for (let i = 0; i < n; i++) {
    const c = full[i];
    countById.set(c, (countById.get(c) || 0) + 1);
  }
  const clusters = clusterDefs.map(cl => ({ ...cl, count: countById.get(cl.id) || 0 }));

  // 3. structureEdges: built over embedded indices → remap to full indices,
  //    re-orienting i<j to satisfy the contract.
  const structureEdges = subCr.structureEdges.map(([a, b]) => {
    const fa = embToFull[a], fb = embToFull[b];
    return fa < fb ? [fa, fb] : [fb, fa];
  });

  const out = { ...subCr, nodeCluster: full, clusters, structureEdges };

  // 4. noiseFlags (optional): embedded flags lifted to full; ghosts are
  //    flagged structural-noise iff they got the reserved -1 label.
  if (subCr.noiseFlags instanceof Uint8Array) {
    const nf = new Uint8Array(n);
    for (let li = 0; li < m; li++) nf[embToFull[li]] = subCr.noiseFlags[li];
    for (let i = 0; i < n; i++) if (fullToEmb[i] === -1) nf[i] = (full[i] === -1) ? 1 : 0;
    out.noiseFlags = nf;
  }

  // 5. condensedTree (optional, HDBSCAN): node-parallel arrays are index-
  //    independent and pass through; only the per-leaf arrays (length m) and
  //    `n` need lifting. A ghost's leaf home/lambda are inherited from its
  //    neighbour so multi-level extraction places it with that neighbour at
  //    every cut; a structural ghost (no neighbour) gets leafHome = root.
  if (subCr.condensedTree && typeof subCr.condensedTree === "object") {
    out.condensedTree = expandCondensedTree(subCr.condensedTree, ghosts, n);
  }
  return out;
}

function expandCondensedTree(t, ghosts, n) {
  const { embToFull, fullToEmb, ghostNbrFull, m } = ghosts;
  const leafHome   = new Int32Array(n).fill(t.numNodes > 0 ? t.root : -1);
  const leafLambda = new Float64Array(n);
  for (let li = 0; li < m; li++) {
    leafHome[embToFull[li]]   = t.leafHome[li];
    leafLambda[embToFull[li]] = t.leafLambda[li];
  }
  for (let i = 0; i < n; i++) {
    if (fullToEmb[i] !== -1) continue;
    const nbr = ghostNbrFull[i];
    if (nbr !== -1) {
      leafHome[i]   = t.leafHome[fullToEmb[nbr]];
      leafLambda[i] = t.leafLambda[fullToEmb[nbr]];
    }
    // else: structural ghost stays at root (born at λ=0), so any cut keeps
    // it in the catch-all rather than fabricating a finer membership.
  }
  return { ...t, n, leafHome, leafLambda };
}

// Build the ghost context once per cascade: the embedded↔full index maps,
// m = #embedded, and for each ghost its nearest embedded citation neighbour
// (full index, or -1). Returns null when there are no ghosts so the rest of
// the cascade takes the untouched identity path.
export function buildGhostContext(ghostMask, citationEdges, dimredResult, n) {
  if (!(ghostMask instanceof Uint8Array) || ghostMask.length !== n) return null;
  let anyGhost = false;
  for (let i = 0; i < n; i++) if (ghostMask[i] === 1) { anyGhost = true; break; }
  if (!anyGhost) return null;

  const fullToEmb = new Int32Array(n).fill(-1);
  const embToFullArr = [];
  for (let i = 0; i < n; i++) {
    if (ghostMask[i] === 1) continue;
    fullToEmb[i] = embToFullArr.length;
    embToFullArr.push(i);
  }
  const m = embToFullArr.length;
  const embToFull = Int32Array.from(embToFullArr);

  const ghostNbrFull = nearestEmbeddedNeighbour(ghostMask, fullToEmb, citationEdges, dimredResult, n);
  return { embToFull, fullToEmb, ghostNbrFull, m };
}

// For each ghost, the nearest EMBEDDED citation neighbour by Euclidean
// distance in the fused (dimred) space. Citation edges are undirected for
// this purpose (a ghost cited by A and citing B is adjacent to both).
// Returns Int32Array(n): for a ghost, the full index of its nearest
// embedded neighbour or -1 (no embedded citation neighbour); -1 for
// embedded nodes (unused). Ghost→ghost edges are ignored — a ghost's label
// must be anchored to a real, fitted node.
function nearestEmbeddedNeighbour(ghostMask, fullToEmb, citationEdges, dimredResult, n) {
  const out = new Int32Array(n).fill(-1);
  if (!Array.isArray(citationEdges) || citationEdges.length < 2) return out;

  // Adjacency of embedded neighbours per ghost.
  const nbrs = new Map();                        // ghost full idx → number[]
  const addEdge = (g, e) => {
    if (ghostMask[g] !== 1 || ghostMask[e] === 1) return;  // need ghost→embedded
    let a = nbrs.get(g); if (!a) nbrs.set(g, a = []); a.push(e);
  };
  for (let k = 0; k + 1 < citationEdges.length; k += 2) {
    const s = citationEdges[k] | 0, d = citationEdges[k + 1] | 0;
    if (s < 0 || s >= n || d < 0 || d >= n) continue;
    addEdge(s, d);
    addEdge(d, s);
  }

  const data = dimredResult && dimredResult.data;
  const dim  = dimredResult && dimredResult.d;
  const havePos = (data && dim > 0 && data.length >= n * dim);
  for (const [g, cand] of nbrs) {
    if (cand.length === 0) continue;
    if (!havePos) { out[g] = cand[0]; continue; }  // no geometry → first neighbour
    let best = cand[0], bestSq = Infinity;
    const gOff = g * dim;
    for (const e of cand) {
      const eOff = e * dim;
      let sq = 0;
      for (let kk = 0; kk < dim; kk++) { const v = data[gOff + kk] - data[eOff + kk]; sq += v * v; }
      if (sq < bestSq) { bestSq = sq; best = e; }
    }
    out[g] = best;
  }
  return out;
}

// Slice a parent ClusterResult's nodeCluster down to the embedded subset and
// re-compact the parent cluster ids to a contiguous 0..k-1 range (a parent
// cluster that contained only ghosts disappears from the embedded view).
// Returns a minimal parent-shaped object — clusterWithinParents only reads
// .clusters.length, .clusters[p].colour, and .nodeCluster.
function sliceParentLabels(parent, embToFull, m) {
  const remap = new Map();
  const subLabels = new Int32Array(m);
  const keptOrder = [];
  for (let li = 0; li < m; li++) {
    const pc = parent.nodeCluster[embToFull[li]];
    let nc = remap.get(pc);
    if (nc === undefined) { nc = remap.size; remap.set(pc, nc); keptOrder.push(pc); }
    subLabels[li] = nc;
  }
  const clusters = keptOrder.map((origPc, idx) => {
    const src = parent.clusters[origPc] || {};
    return { ...src, id: idx };
  });
  return { ...parent, clusters, nodeCluster: subLabels };
}

// Within-parent: run the algorithm separately on each parent cluster's
// member set, stitch into a single globally-numbered ClusterResult.
// Singletons / empty parents become trivial single-cluster outputs.
function clusterWithinParents(algo, genResult, parent, params, dimredResult) {
  const n = genResult.nodes.length;
  const numParents = parent.clusters.length;
  const nodeCluster = new Int32Array(n);
  const clusters = [];
  const structureEdges = [];
  let nextId = 0;

  const byParent = Array.from({ length: numParents }, () => []);
  for (let i = 0; i < n; i++) byParent[parent.nodeCluster[i]].push(i);

  for (let p = 0; p < numParents; p++) {
    const ids = byParent[p];
    if (ids.length === 0) continue;

    if (ids.length === 1) {
      const orig = ids[0];
      const node = genResult.nodes[orig];
      nodeCluster[orig] = nextId;
      clusters.push({
        id:        nextId,
        centre:    [node.basePos[0], node.basePos[1], node.basePos[2]],
        spread:    0,
        count:     1,
        colour:    parent.clusters[p].colour,
        stability: NaN,
      });
      nextId++;
      continue;
    }

    const subNodes = ids.map((origId, localIdx) => {
      const orig = genResult.nodes[origId];
      return { ...orig, id: localIdx };
    });
    const subDimred = sliceDimred(dimredResult, ids);
    const subResult = algo.infer({ ...genResult, nodes: subNodes }, params, subDimred);

    for (let localIdx = 0; localIdx < ids.length; localIdx++) {
      const subCid = subResult.nodeCluster[localIdx];
      nodeCluster[ids[localIdx]] = subCid >= 0 ? nextId + subCid : -1;
    }
    for (const sc of subResult.clusters) {
      if (sc.id < 0) continue;
      clusters.push({ ...sc, id: nextId + sc.id });
    }
    for (const e of subResult.structureEdges) {
      structureEdges.push([ids[e[0]], ids[e[1]]]);
    }
    nextId += subResult.clusters.length;
  }

  return {
    method: parent.method,
    params,
    clusters,
    nodeCluster,
    structureEdges,
  };
}

export function sliceDimred(dimredResult, ids) {
  const d   = dimredResult.d;
  const src = dimredResult.data;
  const out = new Float32Array(ids.length * d);
  for (let li = 0; li < ids.length; li++) {
    const oi = ids[li];
    for (let k = 0; k < d; k++) out[li * d + k] = src[oi * d + k];
  }
  return {
    method: dimredResult.method,
    params: dimredResult.params,
    n:      ids.length,
    d,
    data:   out,
  };
}

// Slim a full genResult.nodes array to what the clustering layer
// actually reads. Used by engine.js when building the worker payload.
// Per-node: id + basePos. Skips origin, t, embedding, citation lists.
export function slimNodesForClustering(nodes) {
  const out = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const bp = n.basePos || [0, 0, 0];
    out[i] = { id: n.id, basePos: [bp[0], bp[1], bp[2]] };
  }
  return out;
}
