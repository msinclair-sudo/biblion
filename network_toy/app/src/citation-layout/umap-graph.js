// UMAP on the citation graph.
//
// Third entry in the citation-layout family, alongside FR (force-
// directed cladogram) and MDS (graph-distance preserving). The other
// two collapse on sparse large-scale citation networks — FR pins
// everything to its outer wall (sparsity-driven shell), MDS produces
// nested orbital shells (top eigendirections of the graph-distance
// matrix dominate). UMAP-on-graph dodges both failure modes because
// it preserves *local* manifold structure (citation neighbourhoods),
// not global pairwise distances or all-pairs repulsion equilibria.
//
// Algorithm:
//   1. Symmetrise the directed citation graph (A ∨ Aᵀ). Direction
//      encodes time/flow, but the layout is positional, not
//      directional — citation u → v means u and v are graph-adjacent.
//   2. Build a precomputed k-NN graph from the symmetrised adjacency
//      by BFS-layer expansion per node. Hop-1 neighbours come first
//      with distance 1, hop-2 with distance 2, and so on, until each
//      node has exactly nNeighbors entries (counting self at index 0
//      with distance 0 — umap-js's convention).
//   3. Hand the precomputed k-NN to umap-js via `setPrecomputedKNN`
//      and let UMAP do its fuzzy-simplicial-set + spectral-init +
//      cross-entropy optimisation. Output is centred at origin and
//      scaled by `scaleD` so per-component alignment in blend/align.js
//      lands it at the same visual extent as FR/MDS outputs.
//
// Why not pass shortest-path distance like MDS does?
//   Global shortest-path distance is unreliable on a sparse 5000-node
//   graph with average degree 5 — many pairs are 6+ hops apart and
//   small perturbations swing distances by factors of 2 or more.
//   MDS at this scale produces orbital shells because top
//   eigendirections of that noisy distance matrix dominate. UMAP-on-
//   graph keeps the *direct* neighbour information (1-hop, sometimes
//   2-hop padding) and lets fuzzy simplicial sets pick up larger
//   structure from the local overlaps. Standard practice for graph
//   embedding (see node2vec, DeepWalk, recent citation-map work).
//
// Determinism: all randomness flows through `mulberry32(seed)` —
// same (n, edges, seed, params) → byte-identical output. umap-js's
// `random` parameter accepts a uniform `() → [0, 1)` generator
// directly.
//
// Scale: post-fit, the output is centred at origin and multiplied by
// `scaleD`. UMAP's natural output spans ~[-5, 10]; the per-component
// alignment in blend/align.js does match-RMS scaling against basePos,
// so this scale doesn't affect the final visible extent — but
// centring the raw output simplifies the alignment's centroid math.

// Full URL (not bare specifier) so this module loads identically on
// the main thread AND in Web Workers — see dimred/umap.js for the
// same note. Version-pinned alongside app/index.html's importmap.
import { UMAP } from "https://esm.sh/umap-js@1.4.0";
import { mulberry32 } from "../rng.js";

export const ID = "umap-graph";

export const defaultParams = () => ({
  // UMAP optimisation epochs. umap-js's default is 500 for n ≤ 10k,
  // 200 otherwise. 500 converges reliably at n = 5000 in a few
  // seconds; lower values speed things up at the cost of slightly
  // less stable cluster separation.
  iterations: 500,
  // Number of neighbours per point (INCLUDING self at position 0).
  // 15 is umap-learn's default for graph-like data. Higher values
  // (30–50) emphasise global structure at the cost of local fidelity.
  nNeighbors: 15,
  // Minimum embedded-space distance between points in tight clusters.
  // Lower → tighter clusters (good for community separation, the
  // α=1 endpoint's payoff). Higher → more spread (less clumping
  // after Procrustes alignment).
  minDist: 0.1,
  // Post-fit isotropic scale. UMAP output is roughly in ~[-5, 10];
  // multiplying by scaleD gives a coordinate range comparable to FR/MDS
  // before per-component alignment kicks in.
  scaleD: 12,
});

export function compute({ n, edges, t: _t, seed, params = {} }) {
  const p = { ...defaultParams(), ...params };
  const out = new Float32Array(n * 3);
  if (n === 0) return out;

  // Degenerate small-n cases — UMAP needs at least n_neighbors+1 points
  // to be meaningful. Spread linearly so blend has *something* to
  // interpolate to; alignment will scale this to basePos.
  if (n < 4) {
    for (let i = 0; i < n; i++) out[i * 3] = i * p.scaleD;
    return out;
  }

  // 1. Symmetrised adjacency (Set per node — dedupes parallel edges).
  const adj = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = new Set();
  for (let e = 0; e < edges.length; e++) {
    const u = edges[e][0] | 0, v = edges[e][1] | 0;
    if (u === v) continue;
    if (u < 0 || u >= n || v < 0 || v >= n) continue;
    adj[u].add(v);
    adj[v].add(u);
  }

  // 2. Precomputed k-NN graph via BFS-layer expansion.
  const kTotal = clampInt(p.nNeighbors, 4, Math.max(4, n - 1));
  const { knnIndices, knnDistances } = buildKnnFromBfs(n, adj, kTotal, seed);

  // 3. UMAP fit on the precomputed graph.
  const umap = new UMAP({
    nComponents: 3,
    nNeighbors:  kTotal,
    minDist:     clampFloat(p.minDist, 0, 1),
    nEpochs:     clampInt(p.iterations, 50, 2000),
    random:      mulberry32(((seed >>> 0) ^ 0x9E3779B9) >>> 0),
  });
  umap.setPrecomputedKNN(knnIndices, knnDistances);

  // umap-js's spectral initialisation reads X.length to size the
  // sparse search graph and consults X for the fallback distance
  // function. With precomputed k-NN, the distance fn is never called
  // — but we still need to hand fit() a length-n array. Single-feature
  // index vectors are the cheapest valid shape.
  const X = new Array(n);
  for (let i = 0; i < n; i++) X[i] = [i];

  const Y = umap.fit(X);   // number[][] of shape n × 3

  // 4. Centre + scale into the output buffer.
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += Y[i][0]; cy += Y[i][1]; cz += Y[i][2]; }
  cx /= n; cy /= n; cz /= n;
  const s = p.scaleD;
  for (let i = 0; i < n; i++) {
    out[i * 3]     = (Y[i][0] - cx) * s;
    out[i * 3 + 1] = (Y[i][1] - cy) * s;
    out[i * 3 + 2] = (Y[i][2] - cz) * s;
  }
  return out;
}

// Build a precomputed k-NN graph (umap-js convention: self at index 0
// with distance 0, plus k-1 actual neighbours sorted ascending by hop
// distance).
//
// Layered BFS so we naturally produce ascending-distance ordering.
// Frontier expansion is `for v in frontier: emit v, queue v's
// neighbours into next frontier`. visited[] is reset per node because
// the BFS is per-source.
//
// Padding: when a node's component is small enough that BFS exhausts
// before we hit k-1 actual neighbours, the rest are random unvisited
// nodes at a distance just past the last real hop. UMAP downweights
// these via the fuzzy-set normalisation, but exposing them prevents
// nodes from disappearing into a corner of the embedding.
function buildKnnFromBfs(n, adj, kTotal, seed) {
  const rng = mulberry32(((seed >>> 0) ^ 0xA3B3C3D3) >>> 0);
  const indices   = new Array(n);
  const distances = new Array(n);
  const visited   = new Uint8Array(n);

  // kReal = number of non-self entries we want. Self lives at index 0.
  const kReal = kTotal - 1;

  for (let src = 0; src < n; src++) {
    visited.fill(0);
    visited[src] = 1;

    const idx  = new Array(kTotal);
    const dist = new Array(kTotal);
    idx[0]  = src;
    dist[0] = 0;
    let filled = 1;

    // Layer 1 = direct citation neighbours.
    let frontier = [];
    for (const v of adj[src]) {
      if (!visited[v]) { visited[v] = 1; frontier.push(v); }
    }

    let hop = 1;
    let lastHop = 1;
    while (filled < kTotal && frontier.length > 0) {
      // Emit current frontier into k-NN list.
      for (let i = 0; i < frontier.length && filled < kTotal; i++) {
        idx[filled]  = frontier[i];
        dist[filled] = hop;
        filled++;
      }
      lastHop = hop;
      if (filled >= kTotal) break;

      // Expand into next layer.
      const next = [];
      for (let i = 0; i < frontier.length; i++) {
        const fAdj = adj[frontier[i]];
        for (const w of fAdj) {
          if (!visited[w]) { visited[w] = 1; next.push(w); }
        }
      }
      frontier = next;
      hop++;
    }

    // Pad: BFS exhausted the component before producing kReal neighbours.
    // Sample random unvisited nodes at a distance one hop past the last
    // real layer. Linear scan fallback if random sampling fails to hit
    // (e.g. very small populations of unvisited nodes).
    if (filled < kTotal) {
      const padDist = lastHop + 1;
      let scanCursor = 0;
      while (filled < kTotal) {
        let r = -1;
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = Math.floor(rng() * n);
          if (!visited[candidate]) { r = candidate; break; }
        }
        if (r === -1) {
          while (scanCursor < n && visited[scanCursor]) scanCursor++;
          if (scanCursor >= n) break;
          r = scanCursor++;
        }
        visited[r]   = 1;
        idx[filled]  = r;
        dist[filled] = padDist;
        filled++;
      }
    }

    // In tiny populations (n < kTotal) the loop above may still under-fill.
    // Truncate to actual length — umap-js's loops over `knn[i].length`, not
    // a global `nNeighbors`, so jagged rows are fine for those edge cases.
    indices[src]   = filled === kTotal ? idx  : idx.slice(0, filled);
    distances[src] = filled === kTotal ? dist : dist.slice(0, filled);
  }

  return { knnIndices: indices, knnDistances: distances };
}

function clampInt(x, lo, hi) {
  const v = Math.round(+x || 0);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function clampFloat(x, lo, hi) {
  const v = +x || 0;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
