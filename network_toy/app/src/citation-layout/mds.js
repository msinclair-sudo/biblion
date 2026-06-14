// MDS (multidimensional scaling) on graph-distance.
//
// The dendrogram-flavoured counterpart to fr.js. Where FR encodes
// only the topology (which nodes are connected), MDS encodes the
// graph-shortest-path distance between every pair within a component
// — a 1–2–3 chain has |x_1 − x_3| ≈ 2 · |x_1 − x_2|, exactly because
// graph distance d(1, 3) = 2 = 2 · d(1, 2).
//
// Per-component layout (matches blend/align.js's per-component
// alignment): a connected component's nodes are positioned by MDS
// among themselves; cross-component pairs are deliberately omitted
// from the stress function. There's no path between disconnected
// components, so there's no graph distance to preserve, so we don't
// invent a fictional one — alignment in blend/align.js places each
// component at its basePos centroid afterwards. Singletons trivially
// land at origin (alignment translates them to basePos).
//
// Optimisation: SMACOF (Scaling by MAjorising a COmplicated Function),
// the standard MDS iteration. Stress is
//
//   σ  =  Σ_pairs ( |x_i − x_j|  −  scaleD · d_ij )²
//
// Each SMACOF iteration is the Guttman transform — for each node i,
// the new position is the centroid of "ideal positions for i" derived
// from each pair:
//
//   new_x_i  =  (1 / (m−1)) · Σ_{j≠i} [ x_j  +  (t_ij / |x_i−x_j|) · (x_i − x_j) ]
//
// where t_ij = scaleD · d_ij. This is automatically degree-normalised
// (the 1/(m−1)) factor) so dense components don't blow up; converges
// monotonically on a quadratic majoriser of the stress, no learning
// rate or temperature schedule required.
//
// Encapsulation as in FR: pure function, layout module never sees
// basePos. Output Float32Array(n × 3); per-component alignment in
// blend/align.js handles placement and scale-to-basePos.

import { mulberry32 } from "../rng.js";

export const ID = "mds-graph-distance";

export const defaultParams = () => ({
  // SMACOF iteration count. Each iteration is the Guttman transform
  // (per-node centroid update); convergence is monotonic. 200 is
  // plenty for components up to a few hundred nodes.
  iterations: 200,
  // World units per graph hop. After alignment scales each component
  // to basePos's extent, this only affects the layout's natural
  // density before scaling — a smaller value gives tighter
  // intermediate layouts but the final visible scale is the same.
  scaleD: 12,
});

export function compute({ n, edges, t: _t, seed, params = {} }) {
  const p = { ...defaultParams(), ...params };
  const rng = mulberry32(((seed >>> 0) ^ 0xD5D55DD5) >>> 0);

  const positions = new Float32Array(n * 3);
  if (n === 0) return positions;

  // Adjacency list (undirected — citations are directed but for layout
  // purposes a citation u→v means u and v are graph-adjacent).
  const adj = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = [];
  for (let e = 0; e < edges.length; e++) {
    const u = edges[e][0], v = edges[e][1];
    adj[u].push(v);
    adj[v].push(u);
  }

  // Connected components (DFS / iterative).
  const comp = new Int32Array(n).fill(-1);
  let numComps = 0;
  const stack = [];
  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1) continue;
    const cid = numComps++;
    stack.length = 0;
    stack.push(start);
    while (stack.length > 0) {
      const x = stack.pop();
      if (comp[x] !== -1) continue;
      comp[x] = cid;
      const ax = adj[x];
      for (let k = 0; k < ax.length; k++) {
        if (comp[ax[k]] === -1) stack.push(ax[k]);
      }
    }
  }

  // Group node ids by component.
  const compNodes = new Array(numComps);
  for (let i = 0; i < numComps; i++) compNodes[i] = [];
  for (let i = 0; i < n; i++) compNodes[comp[i]].push(i);

  for (const ids of compNodes) {
    if (ids.length === 1) {
      // Singleton — origin, alignment translates to basePos.
      const id = ids[0];
      positions[id*3] = 0; positions[id*3+1] = 0; positions[id*3+2] = 0;
      continue;
    }
    layoutComponent(ids, adj, positions, p, rng);
  }

  return positions;
}

// MDS on a single connected component. Builds the m×m graph-distance
// matrix via BFS from each node, then iterates spring-relaxation
// toward target distances scaleD · d_ij.
function layoutComponent(ids, adj, positions, p, rng) {
  const m = ids.length;

  // Map global node id → local index in this component.
  const localIdx = new Map();
  for (let k = 0; k < m; k++) localIdx.set(ids[k], k);

  // BFS from each node. dist[k*m + l] = graph distance between ids[k]
  // and ids[l]. Within-component, every pair is reachable so no
  // sentinel is needed for "no path".
  const dist = new Int32Array(m * m);
  const queue = new Int32Array(m);
  for (let k = 0; k < m; k++) {
    // Reset row to -1; mark source as 0.
    for (let l = 0; l < m; l++) dist[k*m + l] = -1;
    dist[k*m + k] = 0;
    let head = 0, tail = 0;
    queue[tail++] = ids[k];
    while (head < tail) {
      const x = queue[head++];
      const xLocal = localIdx.get(x);
      const dx = dist[k*m + xLocal];
      const ax = adj[x];
      for (let n = 0; n < ax.length; n++) {
        const y = ax[n];
        const yLocal = localIdx.get(y);
        if (yLocal === undefined) continue;     // belongs to a different component (shouldn't happen)
        if (dist[k*m + yLocal] === -1) {
          dist[k*m + yLocal] = dx + 1;
          queue[tail++] = y;
        }
      }
    }
  }

  // Initial positions: random in a cube whose half-extent matches the
  // expected layout scale. Helps SMACOF convergence by starting
  // already at roughly the right magnitude.
  const localPos = new Float32Array(m * 3);
  const init = p.scaleD * 0.5;
  for (let k = 0; k < m; k++) {
    localPos[k*3]   = (rng() * 2 - 1) * init;
    localPos[k*3+1] = (rng() * 2 - 1) * init;
    localPos[k*3+2] = (rng() * 2 - 1) * init;
  }

  // SMACOF Guttman iterations. Per node i, the new position is
  //   new_x_i = (1 / (m−1)) · Σ_{j≠i} [ x_j + (t_ij / d_ij) · (x_i − x_j) ]
  // computed from the previous iteration's positions atomically (Jacobi-
  // style — read all old, write all new, swap). Monotonically decreases
  // stress; no learning rate or stiffness needed.
  const newPos = new Float32Array(m * 3);
  const invDenom = 1 / (m - 1);
  for (let iter = 0; iter < p.iterations; iter++) {
    for (let i = 0; i < m; i++) {
      const ix = localPos[i*3], iy = localPos[i*3+1], iz = localPos[i*3+2];
      let sx = 0, sy = 0, sz = 0;
      for (let j = 0; j < m; j++) {
        if (j === i) continue;
        const target = p.scaleD * dist[i*m + j];
        const dx = ix - localPos[j*3];
        const dy = iy - localPos[j*3+1];
        const dz = iz - localPos[j*3+2];
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d < 1e-9) {
          // Coincident pair: limit of (target/d) · (x_i − x_j) is 0
          // (numerator vanishes faster than denominator), so the
          // contribution is just x_j.
          sx += localPos[j*3];   sy += localPos[j*3+1];   sz += localPos[j*3+2];
        } else {
          const ratio = target / d;
          sx += localPos[j*3]   + ratio * dx;
          sy += localPos[j*3+1] + ratio * dy;
          sz += localPos[j*3+2] + ratio * dz;
        }
      }
      newPos[i*3]   = sx * invDenom;
      newPos[i*3+1] = sy * invDenom;
      newPos[i*3+2] = sz * invDenom;
    }
    // Atomic swap.
    for (let i = 0; i < m * 3; i++) localPos[i] = newPos[i];
  }

  // Copy local positions into the global output array.
  for (let k = 0; k < m; k++) {
    positions[ids[k]*3]   = localPos[k*3];
    positions[ids[k]*3+1] = localPos[k*3+1];
    positions[ids[k]*3+2] = localPos[k*3+2];
  }
}
