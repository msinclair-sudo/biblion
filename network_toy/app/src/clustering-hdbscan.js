// Clustering layer — HDBSCAN.
//
// Stage 2 (canonical extraction):
//   - Core distances + mutual reachability + MST.
//   - Build a binary dendrogram from the MST edges in ascending weight
//     order. Each merge becomes a node with `deathLambda = 1 / weight`.
//   - Walk the dendrogram top-down (root → leaves) and build a CONDENSED
//     tree by gating splits on `min_cluster_size`: real splits only
//     happen when both sides reach the threshold. Otherwise the smaller
//     side dissolves into noise w.r.t. the parent.
//   - Compute per-cluster STABILITY = Σ_p (λ_p_falls_out − λ_birth_C)
//     over the cluster's points.
//   - EOM extraction: bottom-up greedy. Select C if S(C) > Σ children's
//     selected stability; else pass children's selection through.
//   - Points outside any selected cluster are noise; at Stage 2 (no
//     `allowsNoise` yet) they get bucketed into a single trailing
//     "everything else" cluster so the contract holds.
//
// Math + algorithm reference: doc/clustering.md §4.2.
// Output contract: doc/clustering.md §1, validated by contracts/cluster.js.
//
// Reads basePos only. Does NOT mutate the input. Always satisfies the
// shared cluster-output contract — the caller can swap this with
// mutual-k-NN with no other code changes.
//
// Ghost nodes (ghost-node spec §4.4): this module knows NOTHING about
// ghosts. The fit is excluded from ghosts upstream — clustering-cascade.js
// slices the genResult/dimredResult down to the m embedded nodes before
// calling infer, so the distance matrix here is built over embedded nodes
// only, and the cascade re-expands the m-node result back to n (assigning
// each ghost its nearest embedded neighbour's label). Keep it that way: do
// not add ghost branches to the clustering math.

import { pairwiseDistancesParallel } from "./workers/parallel-distance.js";
import { buildMultiLevel }           from "./clustering-multilevel.js";

const TABLEAU10 = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ab",
];

export const defaultHdbscanParams = () => ({
  minSamples: 5,
  minClusterSize: 5,
  // "eom"  → classic excess-of-mass extraction. Picks the maximally
  //          stable cluster frontier. Can bifurcate (root + 1 stranded
  //          leaf) when the dendrogram is highly imbalanced — typical
  //          for overlapping Gaussians where one big component nibbles
  //          tiny pieces off its edge.
  // "leaf" → pick every leaf of the condensed tree. Finer-grained and
  //          more uniform cluster counts; pair with selectionEpsilon to
  //          merge tiny leaves up to a coarser scale.
  selectionMethod: "eom",
  // Post-selection merge threshold (in d_mreach distance units, i.e.
  // the same scale as basePos distances). Any selected cluster whose
  // birth distance < selectionEpsilon walks up its parent chain to the
  // first ancestor with birth distance ≥ selectionEpsilon (never the
  // root). 0 disables. Mirrors sklearn's `cluster_selection_epsilon`.
  selectionEpsilon: 0,
  // "absorb"     → soft-absorb noise into the most likely stable cluster
  //                (sklearn's approximate_predict scoring). Result has no
  //                noise pseudo-cluster; noiseFlags still reports the
  //                pre-absorption decision so debug overlays can show
  //                which points HDBSCAN considered noise.
  // "singletons" → each noise point becomes its own cluster.
  noiseMode: "absorb",
});

export function inferHdbscan(genResult, params = {}, dimredResult) {
  const nodes = genResult.nodes;
  const n = nodes.length;
  const minSamples     = Math.max(1, Math.min(Math.max(1, n - 1), (params.minSamples ?? 5) | 0));
  const minClusterSize = Math.max(2, Math.min(Math.max(2, n), (params.minClusterSize ?? 5) | 0));
  const selectionMethod  = (params.selectionMethod === "leaf") ? "leaf" : "eom";
  const selectionEpsilon = Math.max(0, +params.selectionEpsilon || 0);
  const noiseMode      = (params.noiseMode === "singletons") ? "singletons" : "absorb";
  const echoParams = { minSamples, minClusterSize, selectionMethod, selectionEpsilon, noiseMode };

  if (n === 0) {
    return {
      method: "hdbscan",
      params: echoParams,
      clusters: [],
      nodeCluster: new Int32Array(0),
      structureEdges: [],
      noiseFlags: new Uint8Array(0),
    };
  }
  if (n === 1) {
    return {
      method: "hdbscan",
      params: echoParams,
      clusters: [trivialCluster(0, nodes[0].basePos || ZERO3, 0, 1, NaN)],
      nodeCluster: new Int32Array([0]),
      structureEdges: [],
      noiseFlags: new Uint8Array([0]),
    };
  }

  // Single-run path = build the model + extract at the one minClusterSize.
  // (The split lets multi-layer reuse ONE model across many sizes — see
  // buildHdbscanModel / extractHdbscanLevel below.)
  const model = buildHdbscanModel(genResult, params, dimredResult);
  return extractHdbscanLevel(model, params);
}

// Build the expensive, minClusterSize-INDEPENDENT part of HDBSCAN: the
// pairwise distances, core distances (depend on minSamples), the
// mutual-reachability MST, and the single-linkage dendrogram. A multi-
// layer ladder at a SHARED minSamples reuses one model and only re-runs
// the cheap per-size extraction (extractHdbscanLevel) for each layer — so
// the O(n²) distance + MST is paid once, not once per layer.
//
// Returns a model object consumed by extractHdbscanLevel. n < 2 is
// degenerate (no MST); callers handle those tiny cases directly.
export function buildHdbscanModel(genResult, params = {}, dimredResult, opts = {}) {
  const nodes = genResult.nodes;
  const n = nodes.length;
  const minSamples = Math.max(1, Math.min(Math.max(1, n - 1), (params.minSamples ?? 5) | 0));
  if (n < 2) return { nodes, n, minSamples, degenerate: true };

  // dimredResult is the canonical input from the new shell; legacy
  // (main.js) calls without it, so we pack basePos into a flat 3-d buffer.
  if (!dimredResult) dimredResult = packBasePos(nodes);

  // 1. Pairwise Euclidean distance matrix in dim-reduced space. The O(n²·d)
  //    build is the dominant cost; callers (e.g. the multi-layer worker) can
  //    fan it out across cores and pass it in via opts.dist to skip the
  //    single-threaded path here.
  const dist = (opts.dist instanceof Float32Array && opts.dist.length === n * n)
    ? opts.dist
    : pairwiseDistances(dimredResult, n);
  // 2. Core distance per node = distance to the k_min-th nearest other node.
  const coreDist = computeCoreDistances(dist, n, minSamples);
  // 3. Prim's MST under d_mreach(i,j) = max(coreDist(i), coreDist(j), dist(i,j)).
  const mstEdges = primMSTMutualReach(dist, coreDist, n);
  const mstAsc = mstEdges.slice().sort((a, b) => a.w - b.w);
  // 4. Single-linkage dendrogram over the MST (ascending weight).
  const dendro = buildDendrogram(mstAsc, n);

  return { nodes, n, minSamples, dist, coreDist, mstEdges, dendro, degenerate: false };
}

// Extract one flat partition from a built model at a given minClusterSize
// (+ selection knobs). Cheap relative to buildHdbscanModel — condense →
// stabilities → select → resolve noise → clusterResult. Returns the same
// ClusterResult shape inferHdbscan returns.
export function extractHdbscanLevel(model, params = {}) {
  const { nodes, n } = model;
  const minClusterSize = Math.max(2, Math.min(Math.max(2, n), (params.minClusterSize ?? 5) | 0));
  const selectionMethod  = (params.selectionMethod === "leaf") ? "leaf" : "eom";
  const selectionEpsilon = Math.max(0, +params.selectionEpsilon || 0);
  const noiseMode      = (params.noiseMode === "singletons") ? "singletons" : "absorb";
  const echoParams = { minSamples: model.minSamples, minClusterSize, selectionMethod, selectionEpsilon, noiseMode };

  if (model.degenerate || n < 2) {
    // Degenerate model — mirror inferHdbscan's tiny-n outputs.
    if (n === 0) {
      return { method: "hdbscan", params: echoParams, clusters: [], nodeCluster: new Int32Array(0), structureEdges: [], noiseFlags: new Uint8Array(0) };
    }
    return {
      method: "hdbscan", params: echoParams,
      clusters: [trivialCluster(0, (nodes[0] && nodes[0].basePos) || ZERO3, 0, 1, NaN)],
      nodeCluster: new Int32Array([0]), structureEdges: [], noiseFlags: new Uint8Array([0]),
    };
  }

  const { dist, coreDist, mstEdges, dendro } = model;

  // 5. Condense the dendrogram, gated by minClusterSize.
  const condensed = condenseDendrogram(dendro, n, minClusterSize);
  // 6. Stability for every condensed cluster.
  computeStabilities(condensed);
  // 7. Cluster selection (EOM or leaf), then optional epsilon merge.
  let selectedNodes = (selectionMethod === "leaf") ? leafSelect(condensed) : eomSelect(condensed);
  if (selectionEpsilon > 0) {
    selectedNodes = applyEpsilonMerge(selectedNodes, condensed, selectionEpsilon);
  }
  // 8. Initial labels — stable points only (rest = -1, resolved next).
  const stableLabels = assignStableLabels(selectedNodes, condensed, n);
  // 9. Record pre-absorption noise + resolve final labels per noiseMode.
  const noiseFlags = new Uint8Array(n);
  for (let i = 0; i < n; i++) noiseFlags[i] = (stableLabels[i] === -1) ? 1 : 0;

  const numStableClusters = countDistinct(stableLabels);
  const stabilityById = new Map();
  for (const cn of selectedNodes) stabilityById.set(cn.label, cn.stability);

  let nodeCluster, clusters;
  if (noiseMode === "absorb") {
    ({ nodeCluster, clusters } = resolveByAbsorption(
      stableLabels, noiseFlags, numStableClusters, stabilityById,
      coreDist, dist, condensed, selectedNodes, nodes, n,
    ));
  } else {
    ({ nodeCluster, clusters } = resolveBySingletons(
      stableLabels, noiseFlags, numStableClusters, stabilityById,
      nodes, n,
    ));
  }

  // 10. structureEdges = the full MST (structural backbone for overlays).
  const structureEdges = mstEdges.map(e => [Math.min(e.i, e.j), Math.max(e.i, e.j)]);
  // 11. Surface the condensed tree (MLC-0) for this size.
  const condensedTree = serializeCondensedTree(condensed, n, minClusterSize);

  return {
    method: "hdbscan",
    params: echoParams,
    clusters,
    nodeCluster,
    structureEdges,
    noiseFlags,
    condensedTree,
  };
}

// Multi-level HDBSCAN (MLC §9 / §4). ONE run — one distance matrix, one
// MST, one condensed tree — from which we extract a coarse→fine ladder of
// partitions by cutting the tree at the discovered λ-shelves. Async
// because the distance matrix fans out across cores
// (pairwiseDistancesParallel); the per-layer frontier + MST-absorption is
// O(n log n) and pure (clustering-multilevel.js), so the layers add almost
// nothing over a single HDBSCAN run.
//
// Returns { method, multiLevel, layers, levels } where `levels` is the
// clusterLevels[] shape the cascade/state expect ([{uid, scope, clusterResult}],
// coarse→fine). The coarsest level carries the condensedTree for surfacing
// + persistence. Empty levels for a degenerate (too-small / structureless)
// input — the caller reports that.
export async function inferHdbscanMultiLevel(genResult, params = {}, dimredResult, opts = {}) {
  const nodes = genResult.nodes;
  const n = nodes.length;
  const minSamples     = Math.max(1, Math.min(Math.max(1, n - 1), (params.minSamples ?? 5) | 0));
  const minClusterSize = Math.max(2, Math.min(Math.max(2, n), (params.minClusterSize ?? 5) | 0));

  if (n < 3) return { method: "hdbscan", multiLevel: true, layers: [], levels: [] };
  if (!dimredResult) dimredResult = packBasePos(nodes);

  // Build the model once (parallel distance matrix → coreDist → MST →
  // dendrogram → condensed tree → stabilities).
  const dist     = await pairwiseDistancesParallel(dimredResult, n, opts);
  const coreDist = computeCoreDistances(dist, n, minSamples);
  const mstEdges = primMSTMutualReach(dist, coreDist, n);
  const mstAsc   = mstEdges.slice().sort((a, b) => a.w - b.w);
  const dendro   = buildDendrogram(mstAsc, n);
  const condensed = condenseDendrogram(dendro, n, minClusterSize);
  computeStabilities(condensed);

  const tree = serializeCondensedTree(condensed, n, minClusterSize);
  const { layers, levels } = buildMultiLevel(tree, mstEdges, nodes, {
    capLayers:   opts.capLayers,
    minClusters: opts.minClusters,
    uidPrefix:   opts.uidPrefix,
  });

  // Surface the tree on the coarsest level (mirrors the single-level path
  // where L0 carries it) so the bridge/scoring work + save/load have it.
  if (levels[0]) levels[0].clusterResult.condensedTree = tree;

  return { method: "hdbscan", multiLevel: true, layers, levels };
}

function countDistinct(labels) {
  const seen = new Set();
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== -1) seen.add(labels[i]);
  }
  return seen.size;
}

/* ── helpers ────────────────────────────────────────────────────────────── */

// Cluster centre/spread fallback when nodes carry no basePos (real-
// data path before viz sub-stage runs). Centre/spread is viz-only;
// zero is a sentinel that doesn't lie about real geometry.
const ZERO3 = [0, 0, 0];

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

function pairwiseDistances(dimredResult, n) {
  // Float32Array(n*n), symmetric, zero on the diagonal. Reads positions
  // from the dim-reduced flat buffer so HDBSCAN runs in whatever space
  // Layer 1.5 produced (3-d basePos under identity, 50-d UMAP at scale).
  const pos = dimredResult.data;
  const d   = dimredResult.d;
  const D   = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const ai = i * d;
    for (let j = i + 1; j < n; j++) {
      const bj = j * d;
      let sq = 0;
      for (let k = 0; k < d; k++) {
        const v = pos[ai + k] - pos[bj + k];
        sq += v * v;
      }
      const dist = Math.sqrt(sq);
      D[i * n + j] = dist;
      D[j * n + i] = dist;
    }
  }
  return D;
}

function computeCoreDistances(dist, n, minSamples) {
  const core = new Float32Array(n);
  // k_min-th nearest neighbour: sort the (n-1) other distances, take
  // index (minSamples - 1). If minSamples is larger than the available
  // neighbours, clamp to the largest available.
  const k = Math.min(minSamples - 1, n - 2);
  const buf = new Array(n - 1);
  for (let i = 0; i < n; i++) {
    let idx = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      buf[idx++] = dist[i * n + j];
    }
    buf.sort((a, b) => a - b);
    core[i] = buf[Math.max(0, k)];
  }
  return core;
}

function primMSTMutualReach(dist, coreDist, n) {
  // Prim's algorithm on the dense graph weighted by d_mreach.
  // Standard implementation: maintain `inTree[i]`, `bestEdge[i]` (best
  // weight to reach i from the current tree), and `parent[i]` (which
  // tree node achieves that weight).
  const inTree   = new Uint8Array(n);
  const bestEdge = new Float32Array(n);
  const parent   = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    bestEdge[i] = Infinity;
    parent[i] = -1;
  }
  bestEdge[0] = 0;

  const edges = [];
  for (let iter = 0; iter < n; iter++) {
    // Pick the not-in-tree node with smallest bestEdge.
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!inTree[i] && bestEdge[i] < best) {
        best = bestEdge[i];
        u = i;
      }
    }
    if (u === -1) break;       // disconnected — shouldn't happen on a complete graph
    inTree[u] = 1;
    if (parent[u] !== -1) {
      edges.push({ i: parent[u], j: u, w: bestEdge[u] });
    }

    // Relax edges from u to all not-in-tree neighbours.
    const cu = coreDist[u];
    for (let v = 0; v < n; v++) {
      if (inTree[v] || v === u) continue;
      const d = dist[u * n + v];
      const cv = coreDist[v];
      const w = d > cu ? (d > cv ? d : cv) : (cu > cv ? cu : cv);  // max of three
      if (w < bestEdge[v]) {
        bestEdge[v] = w;
        parent[v] = u;
      }
    }
  }
  return edges;
}

// Build a per-cluster metadata entry by scanning nodes whose nodeCluster
// matches the requested clusterValue. Centred + RMS spread + count, with
// the caller's chosen `id` and `stability` (NaN for noise / mutual-k-NN).
function buildClusterEntry(nodes, nodeCluster, clusterValue, id, stability) {
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodeCluster[i] !== clusterValue) continue;
    const p = nodes[i].basePos || ZERO3;
    cx += p[0]; cy += p[1]; cz += p[2];
    count++;
  }
  if (count > 0) { cx /= count; cy /= count; cz /= count; }
  let sqDev = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodeCluster[i] !== clusterValue) continue;
    const p = nodes[i].basePos || ZERO3;
    const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
    sqDev += dx*dx + dy*dy + dz*dz;
  }
  const spread = count > 0 ? Math.sqrt(sqDev / count) : 0;
  return trivialCluster(id, [cx, cy, cz], spread, count, stability);
}

function trivialCluster(id, centre, spread, count, stability) {
  return {
    id,
    centre: [centre[0], centre[1], centre[2]],
    spread,
    count,
    colour: TABLEAU10[((id % TABLEAU10.length) + TABLEAU10.length) % TABLEAU10.length],
    stability,
  };
}

/* ── dendrogram + condensed tree + EOM ─────────────────────────────────── */

// Build the binary dendrogram from MST edges (ascending weight). Each merge
// produces an internal node with id n + k (for k-th merge). Leaves get ids
// [0, n). Each internal node tracks its children plus the weight at which
// the merge happened (= 1 / λ for that merge).
//
// Returns an array indexed by node id. Leaf entries are minimal stubs;
// internal entries carry { isLeaf:false, left, right, weight }.
function buildDendrogram(mstAsc, n) {
  const totalNodes = n + mstAsc.length;
  const tree = new Array(totalNodes);
  for (let i = 0; i < n; i++) {
    tree[i] = { id: i, isLeaf: true, parent: -1 };
  }
  // Component representative tracking — initially each leaf maps to itself.
  // After merging, both sides' rep is updated to point at the new internal
  // node. Path compression keeps lookups fast.
  const rep = new Int32Array(totalNodes).fill(-1);
  for (let i = 0; i < n; i++) rep[i] = i;
  const findRep = (i) => {
    let cur = i;
    while (rep[cur] !== cur) cur = rep[cur];
    // path compression
    let walk = i;
    while (rep[walk] !== cur) { const next = rep[walk]; rep[walk] = cur; walk = next; }
    return cur;
  };

  for (let k = 0; k < mstAsc.length; k++) {
    const e = mstAsc[k];
    const ra = findRep(e.i);
    const rb = findRep(e.j);
    const newId = n + k;
    tree[newId] = {
      id: newId,
      isLeaf: false,
      left: ra,
      right: rb,
      weight: e.w,            // d_mreach
      parent: -1,
    };
    rep[ra] = newId;
    rep[rb] = newId;
    rep[newId] = newId;
    tree[ra].parent = newId;
    tree[rb].parent = newId;
  }
  return tree;
}

// Compute, for every dendrogram node, the array of leaf ids beneath it.
// This is reused by condensation and stability.
function computeLeafLists(dendro, n) {
  const leaves = new Array(dendro.length);
  for (let i = 0; i < dendro.length; i++) {
    if (dendro[i].isLeaf) leaves[i] = [i];
  }
  // Internal nodes are appended to dendro in build order, so all children
  // already have leaves[] populated by the time we visit them.
  for (let i = n; i < dendro.length; i++) {
    leaves[i] = leaves[dendro[i].left].concat(leaves[dendro[i].right]);
  }
  return leaves;
}

// Walk the dendrogram from the root downward, building the condensed tree.
//
// At each internal dendrogram node we have left/right children. Three cases:
//   (1) Both sides have ≥ minClusterSize leaves
//        → real split. Both sides become condensed-tree nodes with
//          birthLambda = 1 / dendro_node.weight.
//   (2) Both sides have < minClusterSize
//        → cluster dies here. All leaves below this dendrogram node become
//          noise w.r.t. the parent condensed cluster (their λ_falls_out =
//          1 / dendro_node.weight).
//   (3) One side ≥ threshold, other side <
//        → persistence. The big side continues as the parent's condensed
//          cluster. The small side's leaves fall out as noise w.r.t. the
//          parent (λ_falls_out = 1 / dendro_node.weight).
//
// Output: array of condensed-tree nodes. Each has:
//   {
//     id,                 // internal id, contiguous from 0
//     parentId,           // condensed-tree parent, or -1 for root cluster
//     dendroId,           // the dendrogram node where this cluster was born
//     birthLambda,        // λ at which this cluster came into existence
//     leafEvents: [{ leafId, fallsOutLambda }, ...],
//                         // every point that ever belonged to this cluster
//                         //   and the λ at which it left (either through
//                         //   small-side persistence or final split)
//     childIds: [],       // condensed-tree children
//     stability,          // filled by computeStabilities()
//     label,              // filled by assignStableLabels() with the cluster id
//   }
function condenseDendrogram(dendro, n, minClusterSize) {
  const leaves = computeLeafLists(dendro, n);
  const condensed = [];

  // Root of the dendrogram is the last internal node added.
  // Special edge case: n === 1 → no internal nodes. Caller handles this.
  if (dendro.length <= n) return condensed;
  const rootDendroId = dendro.length - 1;

  // The root cluster is born at λ = 0 (i.e. weight = ∞) by convention —
  // it always exists. Birth lambda = 0 means stability contributions
  // start from the moment a leaf first leaves a child of root.
  const rootCondensed = makeCondensedNode(condensed, -1, rootDendroId, 0);

  // Recursive descent. At each call we have:
  //   cdId      — condensed-tree id we're currently filling
  //   dnodeId   — the dendrogram node we're visiting next (a child of the
  //               condensed cluster's birth dendro node)
  //   parentDeathWeight — the d_mreach at which this branch was last split.
  //                       Determines the λ_falls_out for any leaf that exits
  //                       at this point.
  // Returns nothing; mutates condensed.
  // Iterative tree walk. The original recursive version blew the JS
  // call stack at n=5000 on degenerate trees (long chains of
  // single-sided splits — which is exactly what density-unfriendly
  // input geometry like raw PCA produces; see §6.9 follow-up).
  // Worklist for the true-split case (spawns two new condensed
  // clusters). The dominant degenerate case — single-side-persists —
  // is handled by the inner `while (true)` loop with manual tail-
  // call elision, so the worklist itself stays O(tree-branching),
  // not O(tree-depth).
  function visit(rootCdId, rootDnodeId) {
    const worklist = [[rootCdId, rootDnodeId]];
    while (worklist.length > 0) {
      let [cdId, dnodeId] = worklist.pop();
      while (true) {
        const cnode = dendro[dnodeId];
        if (cnode.isLeaf) break;
        const left = cnode.left, right = cnode.right;
        const leftN = leaves[left].length;
        const rightN = leaves[right].length;
        const dieLambda = cnode.weight > 0 ? (1 / cnode.weight) : Infinity;

        const leftBig = leftN >= minClusterSize;
        const rightBig = rightN >= minClusterSize;

        if (leftBig && rightBig) {
          // True split. Spawn two new condensed clusters; defer the
          // right side to the worklist, continue inline on the left.
          const leftCd = makeCondensedNode(condensed, cdId, left, dieLambda);
          const rightCd = makeCondensedNode(condensed, cdId, right, dieLambda);
          worklist.push([rightCd, right]);
          cdId = leftCd;
          dnodeId = left;
          continue;
        } else if (!leftBig && !rightBig) {
          // Both small — entire branch dies. Every leaf under this
          // dendro node falls out of the parent condensed cluster at
          // dieLambda.
          for (const leafId of leaves[dnodeId]) {
            condensed[cdId].leafEvents.push({ leafId, fallsOutLambda: dieLambda });
          }
          break;
        } else {
          // One side persists. The small side's leaves fall out at
          // dieLambda. The big side continues belonging to this
          // condensed cluster; loop instead of recursing.
          const big   = leftBig ? left : right;
          const small = leftBig ? right : left;
          for (const leafId of leaves[small]) {
            condensed[cdId].leafEvents.push({ leafId, fallsOutLambda: dieLambda });
          }
          dnodeId = big;
        }
      }
    }
  }

  visit(rootCondensed, rootDendroId);

  // Any leaves that never "fell out" (because the entire dendrogram below
  // their condensed cluster was their cluster) fell out at λ = ∞.
  // Equivalently, they survived until the data ran out. For stability they
  // contribute (∞ − birthLambda), which is meaningless. Standard HDBSCAN
  // treats this case by capping λ at the maximum λ observed in the tree,
  // i.e. the death lambda of the deepest split below the cluster — but
  // for a leaf that never fell out, that's the maximum of its own line.
  //
  // Practical fix: any leaf in `leaves[birthDendroIdOfCondensedCluster]`
  // not present in leafEvents is assigned fallsOutLambda = the largest
  // lambda observed anywhere in the cluster's leafEvents (or birthLambda
  // if there are none — in which case its stability contribution is 0).
  const seenInEvents = condensed.map(() => new Set());
  for (let c = 0; c < condensed.length; c++) {
    for (const ev of condensed[c].leafEvents) seenInEvents[c].add(ev.leafId);
  }
  for (let c = 0; c < condensed.length; c++) {
    const cn = condensed[c];
    const leavesUnder = leaves[cn.dendroId];
    let maxLambda = cn.birthLambda;
    for (const ev of cn.leafEvents) {
      if (ev.fallsOutLambda > maxLambda && ev.fallsOutLambda !== Infinity) {
        maxLambda = ev.fallsOutLambda;
      }
    }
    for (const leafId of leavesUnder) {
      if (!seenInEvents[c].has(leafId)) {
        cn.leafEvents.push({ leafId, fallsOutLambda: maxLambda });
      }
    }
  }
  return condensed;
}

function makeCondensedNode(condensed, parentId, dendroId, birthLambda) {
  const id = condensed.length;
  const node = {
    id,
    parentId,
    dendroId,
    birthLambda,
    leafEvents: [],
    childIds: [],
    stability: 0,
    label: -1,
  };
  condensed.push(node);
  if (parentId >= 0) condensed[parentId].childIds.push(id);
  return id;
}

// Stability per condensed cluster:
//   stability(C) = Σ_p (λ_p_falls_out − λ_birth(C))
function computeStabilities(condensed) {
  for (const cn of condensed) {
    let s = 0;
    for (const ev of cn.leafEvents) {
      const fall = ev.fallsOutLambda === Infinity ? cn.birthLambda : ev.fallsOutLambda;
      s += Math.max(0, fall - cn.birthLambda);
    }
    cn.stability = s;
  }
}

// Project the internal condensed tree into a compact, structured-clone-
// safe shape for downstream multi-level extraction (MLC-0 → MLC-1).
//
// Node-parallel typed arrays (index = condensed node id, root = 0):
//   parent[i]        condensed-tree parent id, -1 for the root cluster
//   birthLambda[i]   λ at which cluster i came into existence (lower λ =
//                    coarser / earlier; the root is born at λ = 0)
//   stability[i]     EOM stability Σ_p (λ_fall − λ_birth)
//   size[i]          number of leaves ever under cluster i
//   selectedLabel[i] the flat cluster id this node became if EOM-selected,
//                    else -1. Lets a consumer map a tree cut back to the
//                    shipped nodeCluster labels.
//
// Per-leaf membership (index = point id, length n) — the deepest cluster
// each point reaches, which is all you need to flatten the tree at any λ:
//   leafHome[p]      deepest condensed node containing p (its home), or -1
//   leafLambda[p]    λ at which p finally falls out of its home (i.e. the
//                    finest density at which p is still clustered)
//
// To flatten at a query λ_cut: a point p is noise iff λ_cut > leafLambda[p];
// otherwise its cluster is the deepest ancestor of leafHome[p] (walking up
// `parent`) whose birthLambda ≤ λ_cut. O(numNodes + n) to ship, vs the
// O(n·depth) raw leafEvents.
function serializeCondensedTree(condensed, n, minClusterSize) {
  const numNodes = condensed.length;
  const parent        = new Int32Array(numNodes);
  const birthLambda   = new Float64Array(numNodes);
  const stability     = new Float64Array(numNodes);
  const size          = new Int32Array(numNodes);
  const selectedLabel = new Int32Array(numNodes);
  for (let i = 0; i < numNodes; i++) {
    const cn = condensed[i];
    parent[i]        = cn.parentId;
    birthLambda[i]   = cn.birthLambda;
    stability[i]     = cn.stability;
    // After the condensation fixup pass, every leaf ever under a node has
    // an event there, so leafEvents.length is exactly the cluster size.
    size[i]          = cn.leafEvents.length;
    selectedLabel[i] = Number.isInteger(cn.label) ? cn.label : -1;
  }

  // Deepest membership per leaf. Every ancestor of p's home also carries
  // an event for p (nested membership), so the home is simply the event
  // with the largest birthLambda. The home's recorded fallsOutLambda is
  // p's final exit λ.
  const leafHome   = new Int32Array(n).fill(-1);
  const leafLambda = new Float64Array(n);
  const homeBirth  = new Float64Array(n).fill(-Infinity);
  for (let c = 0; c < numNodes; c++) {
    const b = condensed[c].birthLambda;
    for (const ev of condensed[c].leafEvents) {
      const p = ev.leafId;
      if (b >= homeBirth[p]) {
        homeBirth[p]  = b;
        leafHome[p]   = c;
        leafLambda[p] = ev.fallsOutLambda;
      }
    }
  }

  return {
    numNodes,
    n,
    minClusterSize,
    root: numNodes > 0 ? 0 : -1,
    parent, birthLambda, stability, size, selectedLabel,
    leafHome, leafLambda,
  };
}

// EOM cluster selection. Bottom-up: for each node, compare its own
// stability vs the sum of the selected stability across its children.
// Returns the array of selected condensed nodes.
function eomSelect(condensed) {
  if (condensed.length === 0) return [];
  // Process nodes in reverse-id order; descendants always have higher ids
  // (we always created children after parents... actually we create them
  // BEFORE parents in this implementation since parents are spawned at
  // splits and children spawn during the recursion. Compute order safely
  // by leaf-distance from root — easier to just compute selection bottom
  // up via a recursive post-order traversal.)
  const selectedStability = new Array(condensed.length).fill(0);
  const isSelected = new Array(condensed.length).fill(false);

  // We need to process leaves of the condensed tree first.
  function postOrder(id) {
    const cn = condensed[id];
    let childSum = 0;
    for (const cid of cn.childIds) {
      postOrder(cid);
      childSum += selectedStability[cid];
    }
    if (cn.childIds.length === 0) {
      // Leaf condensed cluster — always candidate; its selectedStability is its own stability.
      isSelected[id] = true;
      selectedStability[id] = cn.stability;
    } else if (cn.stability > childSum) {
      // Select self, deselect descendants.
      deselectDescendants(id);
      isSelected[id] = true;
      selectedStability[id] = cn.stability;
    } else {
      // Pass children's selection through.
      isSelected[id] = false;
      selectedStability[id] = childSum;
    }
  }
  function deselectDescendants(id) {
    for (const cid of condensed[id].childIds) {
      isSelected[cid] = false;
      selectedStability[cid] = 0;
      deselectDescendants(cid);
    }
  }

  // Start from the root (id 0).
  postOrder(0);

  // EOM convention: never select the root cluster itself (the whole-data
  // catchall). If the root happened to be picked, drop it and pass through
  // its children's selection — otherwise everything is "one big cluster"
  // and we lose the point of the algorithm.
  if (isSelected[0] && condensed[0].childIds.length > 0) {
    isSelected[0] = false;
    for (const cid of condensed[0].childIds) {
      reSelectIfDeselected(cid, isSelected, condensed, selectedStability);
    }
  }

  const out = [];
  for (let i = 0; i < condensed.length; i++) if (isSelected[i]) out.push(condensed[i]);
  return out;
}

// Leaf-selection mode. Returns every condensed-tree node with no children
// (excluding the root, which is never a valid cluster — and is itself a
// leaf only in the degenerate single-cluster case where condensation
// produced no splits). Predictable cluster count and immune to the EOM
// "S(C) > Σ S(children-selected)" bifurcation, but produces lots of tiny
// clusters when minClusterSize is small. Pair with selectionEpsilon to
// roll fine leaves up to a coarser scale.
function leafSelect(condensed) {
  if (condensed.length === 0) return [];
  const out = [];
  for (const cn of condensed) {
    if (cn.parentId === -1) continue;          // skip root
    if (cn.childIds.length === 0) out.push(cn);
  }
  return out;
}

// Post-selection epsilon merge. For each currently-selected cluster, walk
// up its parent chain until we hit an ancestor whose birth distance
// (= 1 / birthLambda) is at least `epsilon`. Never select the root; if a
// walk would land on the root, stop one short. De-duplicate so siblings
// that walked up to the same ancestor only contribute it once.
//
// Equivalent to sklearn's `cluster_selection_epsilon`. Distance units
// are the same as `basePos` distances (= mutual-reachability distance),
// so the user's intuition for "merge anything finer than this scale"
// holds directly.
function applyEpsilonMerge(selectedNodes, condensed, epsilon) {
  if (selectedNodes.length === 0 || epsilon <= 0) return selectedNodes;
  // birthLambda > 1/epsilon means birth distance < epsilon → too fine.
  const epsilonLambda = 1 / epsilon;
  const seen = new Set();
  const out = [];
  for (const cn of selectedNodes) {
    let cur = cn;
    while (cur.parentId !== -1 && cur.birthLambda > epsilonLambda) {
      const parent = condensed[cur.parentId];
      if (parent.parentId === -1) break;       // never select the root
      cur = parent;
    }
    if (!seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
    }
  }
  return out;
}

// When un-selecting the root, re-run the same EOM rule on each child. If
// the child had been deselected because its parent was selected, it now
// needs to be reconsidered.
function reSelectIfDeselected(id, isSelected, condensed, selectedStability) {
  if (isSelected[id]) return;
  const cn = condensed[id];
  let childSum = 0;
  for (const cid of cn.childIds) childSum += selectedStability[cid];
  if (cn.childIds.length === 0 || cn.stability > childSum) {
    // Select self, descendants stay deselected.
    isSelected[id] = true;
    selectedStability[id] = cn.stability;
  } else {
    // Pass through to children.
    selectedStability[id] = childSum;
    for (const cid of cn.childIds) {
      reSelectIfDeselected(cid, isSelected, condensed, selectedStability);
    }
  }
}

// Stable-only label assignment: writes labels [0..numStableClusters) for
// every point that lives under a selected condensed cluster, and -1 for
// anything else (= noise). The caller resolves -1 according to the
// noiseMode (absorb | singletons).
function assignStableLabels(selectedNodes, condensed, n) {
  const labels = new Int32Array(n).fill(-1);
  if (condensed.length === 0) return labels;

  const isSelected = new Array(condensed.length).fill(false);
  for (const cn of selectedNodes) isSelected[cn.id] = true;

  // Each selected cluster gets a contiguous label.
  let nextLabel = 0;
  const assigned = new Map();
  for (const cn of selectedNodes) {
    cn.label = nextLabel;
    assigned.set(cn.id, nextLabel);
    nextLabel++;
  }

  function deepestSelectedAncestor(cdId) {
    let cur = cdId;
    while (cur !== -1) {
      if (isSelected[cur]) return cur;
      cur = condensed[cur].parentId;
    }
    return -1;
  }

  // Each leaf inherits the label of its deepest selected ancestor.
  // leafEvents capture which condensed cluster a leaf "passed through"
  // on its way to falling out; the owning cluster is the deepest
  // selected ancestor of that node.
  for (const cn of condensed) {
    const ownerCdId = deepestSelectedAncestor(cn.id);
    if (ownerCdId === -1) continue;
    const ownerLabel = assigned.get(ownerCdId);
    for (const ev of cn.leafEvents) {
      if (labels[ev.leafId] === -1) labels[ev.leafId] = ownerLabel;
    }
  }

  return labels;
}

/* ── Stage 3 noise handling ─────────────────────────────────────────────── */

// "absorb" path. For each noise point p, compute a soft membership score
// over every stable cluster C, mirroring sklearn's approximate_predict:
//
//     score(p, C)  =  λ_p_in_C · stability(C)
//
// where λ_p_in_C is the lambda at which p would have first been pulled
// into C — i.e. 1 / (smallest d_mreach between p and any current member
// of C), provided that lambda is at least C's birth lambda. If p never
// connects to C above its birth lambda, score is 0.
//
// Assign p to the highest-scoring cluster. If every cluster scores 0
// (the point genuinely belongs nowhere in the level set hierarchy), p
// stays unclassified — at this stage we hand-pick the closest cluster
// by raw d_mreach as a last resort, since the noiseMode contract is
// "absorb everything" and "stays as -1 forever" violates that.
function resolveByAbsorption(stableLabels, noiseFlags, numStableClusters,
                             stabilityById, coreDist, dist, condensed,
                             selectedNodes, nodes, n) {
  const labels = new Int32Array(stableLabels);

  if (numStableClusters === 0) {
    // No stable clusters at all — nothing to absorb into. Treat
    // everything as one cluster so the contract holds (every node
    // gets a non-negative id).
    for (let i = 0; i < n; i++) labels[i] = 0;
    const single = buildClusterEntry(nodes, labels, 0, 0, NaN);
    return { nodeCluster: labels, clusters: [single] };
  }

  // Pre-compute, per stable cluster, the list of node ids assigned to it
  // (so we can scan d_mreach efficiently).
  const membersByLabel = Array.from({ length: numStableClusters }, () => []);
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) membersByLabel[labels[i]].push(i);
  }

  // Per-cluster birth lambda. Cluster label l corresponds to a selected
  // condensed node — find it, read birthLambda.
  const birthLambdaByLabel = new Float64Array(numStableClusters);
  for (const cn of selectedNodes) {
    if (cn.label >= 0 && cn.label < numStableClusters) {
      birthLambdaByLabel[cn.label] = cn.birthLambda;
    }
  }

  for (let p = 0; p < n; p++) {
    if (labels[p] !== -1) continue;     // already stable

    let bestLabel = -1;
    let bestScore = -Infinity;
    let fallbackLabel = -1;
    let fallbackBestMReach = Infinity;

    for (let l = 0; l < numStableClusters; l++) {
      const stab = stabilityById.get(l);
      if (!Number.isFinite(stab) || stab <= 0) continue;
      const members = membersByLabel[l];
      if (members.length === 0) continue;

      // Smallest d_mreach from p to any member of cluster l.
      let bestMReach = Infinity;
      const cp = coreDist[p];
      for (const q of members) {
        const dq = dist[p * n + q];
        const cq = coreDist[q];
        const w = dq > cp ? (dq > cq ? dq : cq) : (cp > cq ? cp : cq);
        if (w < bestMReach) bestMReach = w;
      }
      if (bestMReach < fallbackBestMReach) {
        fallbackBestMReach = bestMReach;
        fallbackLabel = l;
      }
      const lambda = bestMReach > 0 ? (1 / bestMReach) : Infinity;
      // Score is zero if the cluster's level set never reached p's
      // density (lambda below cluster birth means p connects only at
      // a more-permissive density than the cluster ever existed at).
      if (lambda < birthLambdaByLabel[l]) continue;
      const score = lambda * stab;
      if (score > bestScore) {
        bestScore = score;
        bestLabel = l;
      }
    }

    // If no cluster scored > 0 (e.g. all stabilities are NaN/0, or the
    // point's lambda is below every cluster's birth), fall back to the
    // smallest-d_mreach cluster. This guarantees every noise point lands
    // somewhere in absorb mode, matching the user's "absorb everything"
    // expectation.
    labels[p] = (bestLabel !== -1) ? bestLabel : (fallbackLabel !== -1 ? fallbackLabel : 0);
  }

  // Build per-cluster metadata. Member counts now include absorbed
  // points, so centroids and spreads come from the full membership.
  const clusters = [];
  for (let c = 0; c < numStableClusters; c++) {
    const stab = stabilityById.get(c);
    clusters.push(buildClusterEntry(nodes, labels, c, c, Number.isFinite(stab) ? stab : NaN));
  }
  return { nodeCluster: labels, clusters };
}

// "singletons" path. Each noise point gets its own cluster. Stable
// clusters keep their EOM labels; singletons use ids
// [numStableClusters .. numStableClusters + numNoise). All singletons
// share the noise grey colour so the visual stays legible even when
// the legend is busy.
function resolveBySingletons(stableLabels, noiseFlags, numStableClusters,
                             stabilityById, nodes, n) {
  const labels = new Int32Array(stableLabels);
  const clusters = [];
  for (let c = 0; c < numStableClusters; c++) {
    const stab = stabilityById.get(c);
    clusters.push(buildClusterEntry(nodes, labels, c, c, Number.isFinite(stab) ? stab : NaN));
  }
  let nextId = numStableClusters;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;
    labels[i] = nextId;
    const p = nodes[i].basePos || ZERO3;
    clusters.push({
      id: nextId,
      centre: [p[0], p[1], p[2]],
      spread: 0,
      count: 1,
      colour: "#7a8090",          // noise grey, shared across all singletons
      stability: NaN,
    });
    nextId++;
  }
  return { nodeCluster: labels, clusters };
}
