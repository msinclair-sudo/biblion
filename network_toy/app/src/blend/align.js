// Per-connected-component Procrustes alignment of citationPos to
// basePos. Procrustes = Kabsch (rotation + translation) plus a
// uniform scale factor, computed in closed form. We use the
// similarity flavour rather than the rigid one because FR's natural
// edge length k = (volume / n)^(1/3) is a global value that doesn't
// know how spread-out a particular component "should be" — a
// 20-node component whose basePos cluster is tightly packed gets
// laid out at FR's natural density and ends up much larger than the
// basePos arrangement of those same nodes. Without per-component
// scale, the citation arrangement at α=1 has citation edges way
// longer than at α=0; the user sees a jarring scale mismatch
// rather than a topology change. Adding uniform scale per component
// fixes that without compromising the topology — uniform scaling
// is a similarity transform, so angles and intra-component
// distance ratios survive intact; only the absolute scale shifts.
//
// Per-component (not whole-graph) Procrustes is the right
// granularity:
//
//   - A connected citation cluster has its INTERNAL geometry
//     dictated by FR (carries real topological information). We
//     preserve that by applying a similarity transform — rotation
//     × scale × translation only, no per-node deformation.
//   - The component's overall position, orientation, AND scale in
//     space are undetermined by topology. We pick the choice that
//     minimises Σ |s·R·a + t − b|² over all such transforms.
//   - An isolated node is a singleton component. Procrustes on a
//     single point degenerates to pure translation (no rotation, no
//     scale defined): the node lands exactly at its basePos.
//     Isolated nodes have zero topological constraint, so this is
//     the right answer — their citation position should default to
//     where basePos says they belong.
//
// Whole-graph Procrustes instead of per-component would force a
// single similarity transform across the whole layout — components
// whose basePos centroids are far apart, or whose intrinsic
// densities differ, can't all be aligned simultaneously.
//
// Encapsulation: this module is the ONLY place where citationPos
// and basePos meet. The layout module never sees basePos; the
// blend's per-frame lerp consumes the OUTPUT of this alignment, not
// the raw FR positions.

import { mulberry32 } from "../rng.js";

// Compute alignedCitationPos by:
//   1. Building connected components of the citation graph.
//   2. For each component, computing the optimal similarity
//      transform (rotation R + uniform scale s + translation t)
//      that minimises Σ |s·R·a + t − b|² where a is centred
//      citationPos and b is centred basePos. R from Horn's
//      quaternion (largest-eigenvalue eigenvector); s in closed
//      form from the largest eigenvalue and the source norm.
//   3. Applying that transform to those nodes' positions.
//
// Returns a freshly-allocated Float32Array(n × 3). Inputs are not
// mutated.
//
// Singletons (degree-0 nodes / 1-node components) get their basePos
// directly — no rotation or scale defined for one point.
//
// Two-node components: rotation around the axis between the two
// points is undefined, scale is well-defined (one edge length).
// The Horn-quaternion solver picks one valid rotation; the scale
// formula reduces to basePosEdgeLength / citationPosEdgeLength.
export function alignByComponent({ basePos, citationPos, edges, n }) {
  if (n === 0) return { aligned: new Float32Array(0), correlation: NaN };
  if (basePos.length !== n * 3) throw new Error("alignByComponent: basePos length mismatch");
  if (citationPos.length !== n * 3) throw new Error("alignByComponent: citationPos length mismatch");

  const aligned = new Float32Array(n * 3);

  const comp = unionFind(n, edges);
  const groups = new Map();    // componentId → array of node ids
  for (let i = 0; i < n; i++) {
    const c = comp[i];
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  }

  // Aggregate per-component correlation contributions to produce a
  // single global correlation coefficient — Σ trace(R_c · S_c) /
  // Σ √(sumA_c² · sumB_c²). Singletons contribute 0/0 (no scale or
  // rotation defined); skip them in the aggregation. The result is
  // a number in [0, 1] measuring how well this layout aligns with
  // basePos: 0 = uncorrelated random, 1 = perfectly aligned.
  let corrNumer = 0;
  let corrDenom = 0;

  for (const ids of groups.values()) {
    if (ids.length === 1) {
      // Singleton: just place at basePos. No alignment math.
      const id = ids[0];
      aligned[id*3]   = basePos[id*3];
      aligned[id*3+1] = basePos[id*3+1];
      aligned[id*3+2] = basePos[id*3+2];
      continue;
    }
    const stats = alignSubset(ids, basePos, citationPos, aligned);
    if (stats && Number.isFinite(stats.traceRS) && stats.sumA2 > 0 && stats.sumB2 > 0) {
      corrNumer += stats.traceRS;
      corrDenom += Math.sqrt(stats.sumA2 * stats.sumB2);
    }
  }

  const correlation = corrDenom > 0 ? Math.max(0, Math.min(1, corrNumer / corrDenom)) : NaN;
  return { aligned, correlation };
}

// Globally align `source` to `target` (same Horn/quaternion +
// match-RMS-scale machinery as alignByComponent, but as a single
// whole-graph similarity transform instead of per-component).
//
// Designed for the fusion-comparison slider: pre-fusion and
// post-fusion basePos are two UMAP-3 fits of nearly-identical
// embeddings; UMAP picks an arbitrary rotation each run, so the
// two layouts agree topologically but disagree on orientation.
// Linear interpolation between unaligned layouts produces nonsense
// intermediate paths. Aligning source-to-target first means the
// slider walks the *short route* between them.
//
// Returns the aligned source (Float32Array(n*3)) plus the same
// correlation scalar in [0, 1] that alignByComponent returns. No
// edges needed — all nodes are treated as one rigid body.
export function alignGlobal({ target, source, n }) {
  if (n === 0) return { aligned: new Float32Array(0), correlation: NaN };
  if (target.length !== n * 3) throw new Error("alignGlobal: target length mismatch");
  if (source.length !== n * 3) throw new Error("alignGlobal: source length mismatch");
  const aligned = new Float32Array(n * 3);
  const ids = new Array(n);
  for (let i = 0; i < n; i++) ids[i] = i;
  const stats = alignSubset(ids, target, source, aligned);
  const correlation =
    (stats && Number.isFinite(stats.traceRS) && stats.sumA2 > 0 && stats.sumB2 > 0)
      ? Math.max(0, Math.min(1, stats.traceRS / Math.sqrt(stats.sumA2 * stats.sumB2)))
      : NaN;
  return { aligned, correlation };
}

// Compute optimal similarity transform aligning citationPos[ids] →
// basePos[ids], write the transformed positions into `out`, and
// return the per-component scalars the caller needs to aggregate
// the global correlation coefficient:
//   { traceRS: eigvals[best], sumA2, sumB2 }
function alignSubset(ids, basePos, citationPos, out) {
  const m = ids.length;

  // Centroids.
  let cx=0, cy=0, cz=0, bcx=0, bcy=0, bcz=0;
  for (const i of ids) {
    cx  += citationPos[i*3];     cy  += citationPos[i*3+1];     cz  += citationPos[i*3+2];
    bcx += basePos[i*3];         bcy += basePos[i*3+1];         bcz += basePos[i*3+2];
  }
  cx/=m; cy/=m; cz/=m; bcx/=m; bcy/=m; bcz/=m;

  // Cross-correlation S = Σ a · bᵀ where a = citation−c, b = base−bc.
  // Reads "rotation that maps citation-centred → base-centred", i.e.
  // R applied to citationPos relative coords yields basePos relative
  // coords. Also accumulate Σ|a|² and Σ|b|² (sums of squared centred
  // norms) for the scale calculation below.
  let Sxx=0,Sxy=0,Sxz=0,Syx=0,Syy=0,Syz=0,Szx=0,Szy=0,Szz=0;
  let sumA2 = 0, sumB2 = 0;
  for (const i of ids) {
    const ax = citationPos[i*3]   - cx,  ay = citationPos[i*3+1] - cy,  az = citationPos[i*3+2] - cz;
    const bx = basePos[i*3]       - bcx, by = basePos[i*3+1]     - bcy, bz = basePos[i*3+2]     - bcz;
    Sxx += ax*bx; Sxy += ax*by; Sxz += ax*bz;
    Syx += ay*bx; Syy += ay*by; Syz += ay*bz;
    Szx += az*bx; Szy += az*by; Szz += az*bz;
    sumA2 += ax*ax + ay*ay + az*az;
    sumB2 += bx*bx + by*by + bz*bz;
  }

  // Horn's symmetric 4×4 N matrix. Eigenvector of largest eigenvalue
  // is the unit quaternion of the optimal rotation.
  const N = new Float64Array(16);
  N[0]  =  Sxx + Syy + Szz;
  N[5]  =  Sxx - Syy - Szz;
  N[10] = -Sxx + Syy - Szz;
  N[15] = -Sxx - Syy + Szz;
  N[1]  = N[4]  = Syz - Szy;
  N[2]  = N[8]  = Szx - Sxz;
  N[3]  = N[12] = Sxy - Syx;
  N[6]  = N[9]  = Sxy + Syx;
  N[7]  = N[13] = Szx + Sxz;
  N[11] = N[14] = Syz + Szy;

  const { eigvals, V } = jacobiEigenSym4(N);
  let best = 0;
  for (let i = 1; i < 4; i++) if (eigvals[i] > eigvals[best]) best = i;
  let qw = V[0*4 + best];
  let qx = V[1*4 + best];
  let qy = V[2*4 + best];
  let qz = V[3*4 + best];
  const qn = Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz) || 1;
  qw /= qn; qx /= qn; qy /= qn; qz /= qn;

  const r00 = 1 - 2*qy*qy - 2*qz*qz;
  const r01 = 2*qx*qy - 2*qw*qz;
  const r02 = 2*qx*qz + 2*qw*qy;
  const r10 = 2*qx*qy + 2*qw*qz;
  const r11 = 1 - 2*qx*qx - 2*qz*qz;
  const r12 = 2*qy*qz - 2*qw*qx;
  const r20 = 2*qx*qz - 2*qw*qy;
  const r21 = 2*qy*qz + 2*qw*qx;
  const r22 = 1 - 2*qx*qx - 2*qy*qy;

  // Match-the-RMS-norm scale rather than Procrustes-optimal scale.
  // The two coincide when the layouts are perfectly aligned and
  // diverge as alignment quality drops:
  //
  //   s_procrustes  =  trace(R·S) / Σ|a|²    = eigvals[best] / sumA2
  //   s_match_rms   =  √( Σ|b|² / Σ|a|² )
  //
  // The ratio s_procrustes / s_match_rms is the cosine of the
  // alignment angle in (sumA², sumB²)-normalised space — a
  // correlation coefficient between R·a and b. For citation-driven
  // and basePos-driven layouts this comes out around 0.5 in
  // practice: citations ARE generated from basePos (the taste
  // network biases edges toward spatially-close pairs in basePos),
  // so the topologies are correlated; but FR finds its own 3D
  // embedding of that topology (its own radial t-anchor, its own
  // per-component density), so the absolute positions and
  // orientations disagree even when the topology agrees.
  //
  // Procrustes-optimal would minimise RMSD by shrinking the source
  // proportional to alignment quality — half-correlated → half the
  // size. That makes citation edges visibly shorter than basePos
  // edges. We don't want that; we want the citation arrangement
  // to sit at the same VISUAL SCALE as basePos so the user can
  // compare topologies without the slider zooming out at α=1.
  //
  // s = √(Σ|b|² / Σ|a|²) achieves that: source's RMS norm equals
  // target's, regardless of how well orientations agree. R still
  // does the orientation work; s decouples scale from alignment
  // quality so partial correlation doesn't shrink the layout.
  let s;
  if (sumA2 < 1e-9) {
    s = 1;          // source coincident — no scale defined, fall back
  } else {
    s = Math.sqrt(sumB2 / sumA2);
  }
  if (!Number.isFinite(s) || s <= 0) s = 1;

  // For each node in the component:
  //   aligned = s · R · (citation − c) + bc
  // Topology survives — uniform scaling is a similarity transform,
  // so angles and intra-component distance ratios are preserved;
  // only the absolute scale of the component shifts to match basePos.
  for (const i of ids) {
    const dx = citationPos[i*3]   - cx;
    const dy = citationPos[i*3+1] - cy;
    const dz = citationPos[i*3+2] - cz;
    const rx = r00*dx + r01*dy + r02*dz;
    const ry = r10*dx + r11*dy + r12*dz;
    const rz = r20*dx + r21*dy + r22*dz;
    out[i*3]   = s * rx + bcx;
    out[i*3+1] = s * ry + bcy;
    out[i*3+2] = s * rz + bcz;
  }

  return { traceRS: eigvals[best], sumA2, sumB2 };
}

// Connected components by union-find. Returns Int32Array(n) where
// each entry is the component representative id (chosen as the
// smallest id in that component after path compression).
function unionFind(n, edges) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(x) {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let w = x;
    while (parent[w] !== r) { const nx = parent[w]; parent[w] = r; w = nx; }
    return r;
  }
  function unite(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) {
      // Keep the smaller id as the representative for stable output.
      if (ra < rb) parent[rb] = ra;
      else         parent[ra] = rb;
    }
  }
  for (const e of edges) unite(e[0], e[1]);
  // Final pass: compress every node to its root.
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = find(i);
  return out;
}

// Cyclic Jacobi eigendecomposition for a symmetric 4×4 matrix.
// Same implementation as physics-debug.js (kept local so this
// module has no dependencies on debug code). Returns {eigvals, V}
// where V is row-major; column j is the eigenvector for eigvals[j].
function jacobiEigenSym4(N) {
  const A = new Float64Array(N);
  const V = new Float64Array(16);
  V[0] = V[5] = V[10] = V[15] = 1;
  for (let iter = 0; iter < 50; iter++) {
    let p = 0, q = 1, maxAbs = Math.abs(A[1]);
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const v = Math.abs(A[i*4 + j]);
        if (v > maxAbs) { maxAbs = v; p = i; q = j; }
      }
    }
    if (maxAbs < 1e-12) break;
    const apq = A[p*4 + q];
    const app = A[p*4 + p];
    const aqq = A[q*4 + q];
    const theta = (aqq - app) / (2 * apq);
    const t = (theta >= 0 ? 1 : -1) /
              (Math.abs(theta) + Math.sqrt(theta*theta + 1));
    const c = 1 / Math.sqrt(t*t + 1);
    const s = t * c;
    A[p*4 + p] = app - t * apq;
    A[q*4 + q] = aqq + t * apq;
    A[p*4 + q] = A[q*4 + p] = 0;
    for (let i = 0; i < 4; i++) {
      if (i === p || i === q) continue;
      const aip = A[i*4 + p];
      const aiq = A[i*4 + q];
      A[i*4 + p] = A[p*4 + i] = c * aip - s * aiq;
      A[i*4 + q] = A[q*4 + i] = s * aip + c * aiq;
    }
    for (let i = 0; i < 4; i++) {
      const vip = V[i*4 + p];
      const viq = V[i*4 + q];
      V[i*4 + p] = c * vip - s * viq;
      V[i*4 + q] = s * vip + c * viq;
    }
  }
  return { eigvals: [A[0], A[5], A[10], A[15]], V };
}
