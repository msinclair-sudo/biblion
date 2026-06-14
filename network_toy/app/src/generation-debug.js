// Generation debug visualization.
//
// Reads a `generate()` result and produces graph data + scene overlays.
//
// Real data nodes are NOT pinned — Layer 4's physics moves them. They
// start at basePos so α=0 is a clean visual no-op. Origin gizmos and
// centroid markers (debug only) ARE pinned via fx/fy/fz so they sit at
// fixed reference positions regardless of physics.
//
//   - Each origin shown as a special "origin" node at its centre.
//   - One edge per real node, from that node to its origin (so you can
//     see which origin each node was sampled from).
//   - Nodes coloured by originId (matches the origin marker colour).
//   - Wireframe cube at +/- R on each axis to show the bounding volume.
//
// Toggles live in `debugFlags`. Defaults all OFF in production.

const ORIGIN_NODE_PREFIX = "origin:";

export const debugFlags = {
  showOrigins: false,
  showOriginEdges: false,
  showVolume: false,
};

// `liveById`: optional Map<nodeId, {x,y,z,vx,vy,vz}> from the previous graph
// data, so live positions and velocities persist across rebuilds (toggling
// debug overlays, citation rerolls, etc). Pass null on first call.
export function buildDebugGraph(genResult, liveById = null) {
  const { origins, nodes } = genResult;

  const gNodes = [];
  const gLinks = [];

  // Real data nodes — start at basePos but UNPINNED so Layer 4 physics can
  // move them. At α = 0 the spring force already wants every pair at its
  // semantic rest length, so an embedding-positioned node has zero net
  // force and stays put. The caller may pass `liveById` to preserve live
  // positions across rebuilds (e.g. when toggling debug overlays).
  for (const n of nodes) {
    const live = liveById ? liveById.get(n.id) : null;
    gNodes.push({
      id: n.id,
      kind: "node",
      originId: n.originId,
      t: n.t,
      x:  live ? live.x  : n.basePos[0],
      y:  live ? live.y  : n.basePos[1],
      z:  live ? live.z  : n.basePos[2],
      vx: live ? live.vx : 0,
      vy: live ? live.vy : 0,
      vz: live ? live.vz : 0,
    });
  }

  // Origin marker nodes (debug only). Same fx/fy/fz pin.
  if (debugFlags.showOrigins) {
    for (const o of origins) {
      gNodes.push({
        id: ORIGIN_NODE_PREFIX + o.id,
        kind: "origin",
        originId: o.id,
        x:  o.centre[0], y:  o.centre[1], z:  o.centre[2],
        fx: o.centre[0], fy: o.centre[1], fz: o.centre[2],
      });
    }
  }

  // Edges from each real node to its origin marker.
  if (debugFlags.showOrigins && debugFlags.showOriginEdges) {
    for (const n of nodes) {
      gLinks.push({
        source: n.id,
        target: ORIGIN_NODE_PREFIX + n.originId,
        kind: "origin-edge",
        originId: n.originId,
      });
    }
  }

  return { nodes: gNodes, links: gLinks };
}

export function colourForLink(link, origins) {
  if (link.kind === "origin-edge") return origins[link.originId].colour;
  return "#888";
}

// Wireframe cube of half-extent R, drawn as 12 line segments. Returned as a
// THREE.Object3D the caller adds to the scene. We use the THREE namespace
// that 3d-force-graph exposes on the Graph instance to avoid pulling THREE
// in as a separate dependency.
export function buildVolumeOutline(THREE, R) {
  const group = new THREE.Group();
  group.name = "debug-volume";
  if (!debugFlags.showVolume) return group;

  const c = [
    [-R,-R,-R], [ R,-R,-R], [ R, R,-R], [-R, R,-R],
    [-R,-R, R], [ R,-R, R], [ R, R, R], [-R, R, R],
  ];
  const edges = [
    [0,1],[1,2],[2,3],[3,0],
    [4,5],[5,6],[6,7],[7,4],
    [0,4],[1,5],[2,6],[3,7],
  ];
  const verts = [];
  for (const [a, b] of edges) {
    verts.push(c[a][0], c[a][1], c[a][2]);
    verts.push(c[b][0], c[b][1], c[b][2]);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x4aa3ff, transparent: true, opacity: 0.35,
  });
  const lines = new THREE.LineSegments(geom, mat);
  group.add(lines);
  return group;
}

// Origin marker mesh — deliberately not a sphere so it cannot be confused
// with a data node. A small 3-axis crosshair (three coloured-by-origin line
// segments crossing at the centre) wrapped by a hollow wire-octahedron. No
// fill, no shading: it reads as an anchor point, not a data point.
export function buildOriginMarker(THREE, origin) {
  const group = new THREE.Group();
  const colour = new THREE.Color(origin.colour);
  const lineMat = new THREE.LineBasicMaterial({
    color: colour, transparent: true, opacity: 0.9,
  });
  const arm = 4;   // half-length of each crosshair arm, in scene units

  const crosshairVerts = new Float32Array([
    -arm, 0, 0,  arm, 0, 0,
    0, -arm, 0,  0, arm, 0,
    0, 0, -arm,  0, 0, arm,
  ]);
  const cgeom = new THREE.BufferGeometry();
  cgeom.setAttribute("position", new THREE.BufferAttribute(crosshairVerts, 3));
  group.add(new THREE.LineSegments(cgeom, lineMat));

  // Hollow wire octahedron — small diamond cage around the crosshair.
  const r = 2.2;
  const octVerts = [
    [ r, 0, 0], [-r, 0, 0],
    [ 0, r, 0], [ 0,-r, 0],
    [ 0, 0, r], [ 0, 0,-r],
  ];
  const octEdges = [
    [0,2],[0,3],[0,4],[0,5],
    [1,2],[1,3],[1,4],[1,5],
    [2,4],[2,5],[3,4],[3,5],
  ];
  const flat = [];
  for (const [a, b] of octEdges) flat.push(...octVerts[a], ...octVerts[b]);
  const ogeom = new THREE.BufferGeometry();
  ogeom.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  group.add(new THREE.LineSegments(ogeom, lineMat));

  group.userData.kind = "origin-marker";
  return group;
}

export const __ORIGIN_NODE_PREFIX = ORIGIN_NODE_PREFIX;
