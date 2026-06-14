// Physics debug — overlays for the layout solver.
//
// Currently one toggle:
//   - showDisplacement: draws a coloured line from each node's live
//     position to its Kabsch-aligned basePos, encoding non-rigid
//     deformation only (rigid translation + rotation drift removed
//     by the alignment).

export const physicsDebugFlags = {
  showDisplacement: false,
};

const NEUTRAL = [140, 140, 150];
const STRETCH = [255,  30, 110];

// Cyclic Jacobi eigendecomposition for a symmetric 4×4 matrix.
// Input N is row-major Float64Array(16). Returns {eigvals, V} where V is
// row-major; column j of V is the eigenvector for eigvals[j]. Used by
// the displacement overlay to extract Horn's optimal-rotation quaternion.
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

// Build a single THREE.LineSegments holding two vertices per data node:
// the live position and the basePos. Vertex colours are written every
// frame by updateDisplacementOverlay so each segment can encode its own
// displacement magnitude. frustumCulled disabled because positions move
// every frame and the bounding box the lib computes once is stale.
export function buildDisplacementOverlay(THREE, nData) {
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array(nData * 6);   // 2 verts × 3 coords
  const colors    = new Float32Array(nData * 6);
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color",    new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
  });
  const lines = new THREE.LineSegments(geom, mat);
  lines.frustumCulled = false;
  lines.userData.kind = "displacement-overlay";
  return lines;
}

// Refresh segment endpoints and colours from current state. `graphNodes`
// is Graph.graphData().nodes (a mix of data + debug gizmos; we filter to
// kind:"node"). `getBasePos(id)` returns the [x,y,z] frozen position for
// data node id, or undefined.
//
// Rigid alignment (Kabsch via Horn's quaternion method). The hybrid
// spring force has a rigid-body-invariant equilibrium: basePos plus ANY
// rotation + translation satisfies every pair's rest-length constraint
// identically. Asymmetric transient forces during α sweeps push the
// network through both translation and rotational drift, and there's no
// centering or anti-rotation force to undo it — so over many α cycles
// the network ends up at some rigidly-transformed copy of basePos.
// Drawing lines to the *original* basePos would show that drift as
// (false) deformation. We solve for the optimal R, t that aligns
// basePos to current, draw the segment to R·basePos + t instead, so the
// overlay reports only NON-rigid residual.
//
// Colour is on a FIXED scale: dist=0 → grey, dist≥DISPLACEMENT_SCALE →
// fully saturated STRETCH. MIN_DISPLACEMENT_VISIBLE skips short segments
// so per-node integration noise after alignment doesn't render.
const DISPLACEMENT_SCALE = 50;
const MIN_DISPLACEMENT_VISIBLE = 1;
export function updateDisplacementOverlay(obj, graphNodes, getBasePos) {
  // Pass 1: centroids.
  let cx = 0, cy = 0, cz = 0;
  let bcx = 0, bcy = 0, bcz = 0;
  let ncount = 0;
  for (const node of graphNodes) {
    if (node.kind && node.kind !== "node") continue;
    const bp = getBasePos(node.id);
    if (!bp) continue;
    cx += node.x; cy += node.y; cz += node.z;
    bcx += bp[0]; bcy += bp[1]; bcz += bp[2];
    ncount++;
  }
  if (ncount === 0) return;
  cx /= ncount; cy /= ncount; cz /= ncount;
  bcx /= ncount; bcy /= ncount; bcz /= ncount;

  // Pass 2: cross-correlation sums S_jk = Σ a_j · b_k  where
  // a = basePos − basePos centroid, b = current − current centroid.
  let Sxx=0, Sxy=0, Sxz=0;
  let Syx=0, Syy=0, Syz=0;
  let Szx=0, Szy=0, Szz=0;
  for (const node of graphNodes) {
    if (node.kind && node.kind !== "node") continue;
    const bp = getBasePos(node.id);
    if (!bp) continue;
    const ax = bp[0] - bcx, ay = bp[1] - bcy, az = bp[2] - bcz;
    const bx = node.x - cx, by = node.y - cy, bz = node.z - cz;
    Sxx += ax*bx; Sxy += ax*by; Sxz += ax*bz;
    Syx += ay*bx; Syy += ay*by; Syz += ay*bz;
    Szx += az*bx; Szy += az*by; Szz += az*bz;
  }

  // Horn's 4×4 symmetric matrix N. Eigenvector of largest eigenvalue
  // gives the unit quaternion of the optimal rotation.
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
  // Pick eigenvector of largest eigenvalue. V is row-major; eigenvector
  // i is column i.
  let best = 0;
  for (let i = 1; i < 4; i++) if (eigvals[i] > eigvals[best]) best = i;
  let qw = V[0*4 + best];
  let qx = V[1*4 + best];
  let qy = V[2*4 + best];
  let qz = V[3*4 + best];
  const qn = Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz) || 1;
  qw /= qn; qx /= qn; qy /= qn; qz /= qn;

  // Quaternion → 3×3 rotation matrix (row-major).
  const r00 = 1 - 2*qy*qy - 2*qz*qz;
  const r01 = 2*qx*qy - 2*qw*qz;
  const r02 = 2*qx*qz + 2*qw*qy;
  const r10 = 2*qx*qy + 2*qw*qz;
  const r11 = 1 - 2*qx*qx - 2*qz*qz;
  const r12 = 2*qy*qz - 2*qw*qx;
  const r20 = 2*qx*qz - 2*qw*qy;
  const r21 = 2*qy*qz + 2*qw*qx;
  const r22 = 1 - 2*qx*qx - 2*qy*qy;

  const positions = obj.geometry.attributes.position.array;
  const colors    = obj.geometry.attributes.color.array;
  const capacity  = positions.length / 6;
  let written = 0;
  for (const node of graphNodes) {
    if (node.kind && node.kind !== "node") continue;
    if (written >= capacity) break;
    const bp = getBasePos(node.id);
    if (!bp) continue;
    // Aligned basePos endpoint: R · (basePos − basePos centroid) + current centroid.
    const ax = bp[0] - bcx, ay = bp[1] - bcy, az = bp[2] - bcz;
    const tx = r00*ax + r01*ay + r02*az + cx;
    const ty = r10*ax + r11*ay + r12*az + cy;
    const tz = r20*ax + r21*ay + r22*az + cz;
    const dx = node.x - tx, dy = node.y - ty, dz = node.z - tz;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist < MIN_DISPLACEMENT_VISIBLE) continue;
    const m = Math.min(1, dist / DISPLACEMENT_SCALE);
    const r = (NEUTRAL[0] + (STRETCH[0] - NEUTRAL[0]) * m) / 255;
    const g = (NEUTRAL[1] + (STRETCH[1] - NEUTRAL[1]) * m) / 255;
    const b = (NEUTRAL[2] + (STRETCH[2] - NEUTRAL[2]) * m) / 255;
    const off = written * 6;
    positions[off+0] = node.x; positions[off+1] = node.y; positions[off+2] = node.z;
    positions[off+3] = tx;     positions[off+4] = ty;     positions[off+5] = tz;
    colors[off+0] = r; colors[off+1] = g; colors[off+2] = b;
    colors[off+3] = r; colors[off+4] = g; colors[off+5] = b;
    written++;
  }
  // Collapse unused tail segments to a single point at origin so they
  // don't render visible lines.
  for (let i = written * 6; i < positions.length; i++) {
    positions[i] = 0;
    colors[i] = 0;
  }
  obj.geometry.attributes.position.needsUpdate = true;
  obj.geometry.attributes.color.needsUpdate = true;
}
