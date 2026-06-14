// Base edges (semantic embedding edges).
//
// Visual-only per dynamics.md §4 — the physics uses every pair's basePos
// distance regardless of how many base edges we draw. This module picks
// which pairs to *show* as edges:
//
//   - target_pairs = round(density · n*(n-1)/2)
//   - the chosen target_pairs are the closest pairs by Euclidean basePos
//     distance (i.e. shortest "semantic distance" first).
//
// Returns a link list ready to merge into the graph data. No mutation, no
// rendering; render concerns (colour, gamma) live in main.js.
//
// We sort the full pair list once; for n=500 that's ~125k pairs which is
// fine on every modern machine. If we ever push n into the thousands we'd
// switch to a partial-quickselect.

export function buildBaseEdges(genResult, density) {
  const d = Math.max(0, Math.min(1, +density || 0));
  const nodes = genResult.nodes;
  const n = nodes.length;
  if (d === 0 || n < 2) return [];

  const totalPairs = (n * (n - 1)) / 2;
  const target = Math.round(totalPairs * d);
  if (target <= 0) return [];

  const pairs = new Array(totalPairs);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const a = nodes[i].basePos;
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j].basePos;
      const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
      pairs[p++] = [dx*dx + dy*dy + dz*dz, i, j];
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);

  const links = [];
  const limit = Math.min(target, pairs.length);
  for (let k = 0; k < limit; k++) {
    const [, i, j] = pairs[k];
    links.push({ source: i, target: j, kind: "base" });
  }
  return links;
}
