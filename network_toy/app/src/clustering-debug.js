// Clustering debug visualization.
//
// Lives entirely separate from the clustering pure module. Reads a
// ClusterResult (see doc/clustering.md §1) and produces:
//   - per-cluster centroid markers (a custom THREE gizmo, distinct from
//     the origin gizmo so the two cannot be confused);
//   - graph links for `clusterResult.structureEdges` (algorithm-specific:
//     mutual k-NN edges for the mutual-k-NN algorithm, MST edges for
//     HDBSCAN).
//
// Toggles via debugFlags. All flags default OFF — the production view
// should not show clustering debug noise. Open Debug ▾ to enable.

const CENTROID_NODE_PREFIX = "centroid:";

export const clusterDebugFlags = {
  showCentroids: false,
  showStructureEdges: false,
  // Mark every node where clusterResult.noiseFlags[i] === 1 with a
  // wireframe ring. Independent of the algorithm's noiseMode — even if
  // a noise point was absorbed into a stable cluster, this overlay
  // surfaces the algorithm's pre-absorption decision.
  showNoiseRings: false,
};

// Inject extra "node" entries (centroid markers) and "link" entries
// (structureEdges from the active algorithm) into a graph-data object.
// Caller is responsible for merging these with whatever else they want
// to draw.
export function decorateGraphData(graphData, clusterResult) {
  if (!clusterResult) return graphData;
  const { clusters, structureEdges } = clusterResult;

  if (clusterDebugFlags.showCentroids) {
    for (const c of clusters) {
      // Skip the noise pseudo-cluster (id -1) — there's no meaningful
      // centroid for "the noise points" and rendering one at [0,0,0]
      // is misleading.
      if (c.id === -1) continue;
      graphData.nodes.push({
        id: CENTROID_NODE_PREFIX + c.id,
        kind: "centroid",
        clusterId: c.id,
        x:  c.centre[0], y:  c.centre[1], z:  c.centre[2],
        fx: c.centre[0], fy: c.centre[1], fz: c.centre[2],
      });
    }
  }
  if (clusterDebugFlags.showStructureEdges) {
    for (const [i, j] of structureEdges) {
      graphData.links.push({
        source: i,
        target: j,
        kind: "structure-edge",
      });
    }
  }
  return graphData;
}

// Centroid gizmo — a small wire-tetrahedron, deliberately a different shape
// from the origin (octahedron+crosshair) so the two read as distinct concepts.
// Coloured with the cluster's own colour.
export function buildCentroidMarker(THREE, cluster) {
  const group = new THREE.Group();
  const colour = new THREE.Color(cluster.colour);
  const mat = new THREE.LineBasicMaterial({
    color: colour, transparent: true, opacity: 0.85,
  });
  const r = 2.6;
  // Tetrahedron vertices (regular, centred at origin).
  const v = [
    [ r,  r,  r],
    [ r, -r, -r],
    [-r,  r, -r],
    [-r, -r,  r],
  ];
  const edges = [
    [0,1],[0,2],[0,3],
    [1,2],[1,3],
    [2,3],
  ];
  const flat = [];
  for (const [a, b] of edges) flat.push(...v[a], ...v[b]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  group.add(new THREE.LineSegments(geom, mat));
  group.userData.kind = "centroid-marker";
  return group;
}

// Build a noise-decorated data-node mesh. Returns a Group containing:
//   - a sphere matching the node's cluster colour (replaces the default
//     sphere that the library would draw in extend=false mode)
//   - a wireframe ring around it (the noise marker)
//
// Used by main.js when nodeThreeObject is called for a data node whose
// noiseFlags[i] === 1 and the showNoiseRings overlay is on. Independent
// of the noiseMode the algorithm ran with — a soft-absorbed noise point
// is still flagged in noiseFlags, so the ring still appears.
//
// The lib uses .nodeRelSize(2) and reads node "val" for radius scaling.
// For a data node with val=1, the rendered sphere radius is roughly
// nodeRelSize * cbrt(val) = 2. The ring sits outside that.
const NOISE_RING_COLOUR = "#ffffff";
const NOISE_SPHERE_SEGMENTS = 12;
export function buildNoiseDecoratedNode(THREE, colourHex) {
  const group = new THREE.Group();

  // Replacement sphere matching the data node's colour. Slightly smaller
  // than the lib's default so the ring forms a clear halo around it.
  const sphereGeom = new THREE.SphereGeometry(1.8, NOISE_SPHERE_SEGMENTS, NOISE_SPHERE_SEGMENTS);
  const sphereMat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(colourHex || "#cfd8e3"),
  });
  const sphere = new THREE.Mesh(sphereGeom, sphereMat);
  group.add(sphere);

  // Ring. Three perpendicular line loops so the marker reads as a halo
  // from any view angle — a single planar ring becomes invisible when
  // viewed edge-on.
  const ringRadius = 3.5;
  const ringSegments = 24;
  const ringMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(NOISE_RING_COLOUR),
    transparent: true,
    opacity: 0.9,
  });
  for (const axis of ["xy", "xz", "yz"]) {
    const verts = new Float32Array(ringSegments * 3);
    for (let i = 0; i < ringSegments; i++) {
      const t = (i / ringSegments) * Math.PI * 2;
      const c = Math.cos(t) * ringRadius;
      const s = Math.sin(t) * ringRadius;
      if (axis === "xy") { verts[i*3] = c; verts[i*3+1] = s; verts[i*3+2] = 0; }
      else if (axis === "xz") { verts[i*3] = c; verts[i*3+1] = 0; verts[i*3+2] = s; }
      else { verts[i*3] = 0; verts[i*3+1] = c; verts[i*3+2] = s; }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    group.add(new THREE.LineLoop(geom, ringMat));
  }

  group.userData.kind = "noise-decorated-node";
  return group;
}

export const __CENTROID_NODE_PREFIX = CENTROID_NODE_PREFIX;
