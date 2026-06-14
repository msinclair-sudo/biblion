// Citation layout algorithm registry.
//
// One entry per algorithm, same pattern as clustering-registry and
// citations/registry. The blend module (Phase 3) consumes this
// registry to produce alignedCitationPos for the α=1 endpoint of the
// blend.
//
// Adding a new algorithm = one new entry here + the algorithm
// module. No other file should grow a switch on algorithm id.

import * as fr        from "./fr.js";
import * as mds       from "./mds.js";
import * as umapGraph from "./umap-graph.js";

export const ALGORITHMS = [
  {
    id:           fr.ID,
    label:        "Fruchterman–Reingold (3D)",
    description:  "Force-directed cladogram-flavoured layout: every pair repels, citation edges attract, plus a time-axis radial anchor that draws older nodes toward the centre. Encodes which nodes are connected; edge LENGTHS are arbitrary (set by FR's force balance, not by graph distance). Unrooted — no privileged axis.",
    defaultParams: fr.defaultParams,
    compute:      fr.compute,
    modalSchema:  [
      {
        key:   "iterations",
        label: "iterations",
        kind:  "int",
        min:   50, max: 600, step: 10,
        format: (v) => String(v),
        hint:  "More iterations = better convergence, slower recompute. 200 is fine for n ≤ 500.",
        sweepValues: [100, 200, 400],
      },
      {
        key:   "tBias",
        label: "time bias",
        kind:  "range",
        min:   0, max: 15, step: 0.5,
        format: (v) => (+v).toFixed(1),
        hint:  "Strength of the radial anchor that pulls older nodes (low t) toward origin. Higher = stronger centring; floor of 0.2 always applies so newest nodes can't escape under pure repulsion. Default 5 keeps connected layouts inside the world; sparse graphs may benefit from higher values.",
        sweepValues: [1, 3, 5, 8, 12],
      },
    ],
  },
  {
    id:           umapGraph.ID,
    label:        "UMAP on citation graph",
    description:  "Treats the citation adjacency as a precomputed k-NN graph and runs UMAP for a 3-D embedding. Preserves *local* citation neighbourhoods (1-hop and 2-hop), not global pairwise distances — which is why this dodges both FR's sparsity-driven spherical collapse and MDS's nested-shell failure mode at large n. Best choice for real citation networks at n ≥ 1000 with one giant component.",
    defaultParams: umapGraph.defaultParams,
    compute:      umapGraph.compute,
    modalSchema:  [
      {
        key:   "nNeighbors",
        label: "neighbours per point",
        kind:  "int",
        min:   4, max: 50, step: 1,
        format: (v) => String(v),
        hint:  "Citation-graph neighbours considered for each paper (includes the paper itself, so 15 = self + 14 cited/citing). Higher emphasises global structure; lower preserves tight communities. 15 is umap-learn's default for graph-like data.",
        sweepValues: [10, 15, 25, 40],
      },
      {
        key:   "minDist",
        label: "minimum cluster spacing",
        kind:  "range",
        min:   0.0, max: 1.0, step: 0.05,
        format: (v) => (+v).toFixed(2),
        hint:  "Minimum distance between points in tight clusters. Lower = tighter community packing (good for separation); higher = more uniform spread. Per-component alignment scales the final extent to basePos, so this only affects the relative density of the α=1 endpoint.",
        sweepValues: [0.05, 0.1, 0.25, 0.5],
      },
      {
        key:   "iterations",
        label: "epochs",
        kind:  "int",
        min:   50, max: 2000, step: 50,
        format: (v) => String(v),
        hint:  "UMAP optimisation epochs. 500 converges in ~3 s at n=5000; lower values trade stability for speed. Higher than 1000 rarely improves visible structure.",
        sweepValues: [200, 500, 1000],
      },
    ],
  },
  {
    id:           mds.ID,
    label:        "MDS (graph-distance preserving)",
    description:  "Dendrogram-flavoured layout: per-pair distance in 3D matches graph-shortest-path distance (in graph hops). A 1–2–3 chain ends up collinear with |x_1 − x_3| = 2·|x_1 − x_2|, exactly because graph distance d(1,3)=2. Per-component (each connected component is a separate MDS problem); cross-component pairs are deliberately omitted from the stress function — there's no path so there's no graph distance to preserve. Alignment in blend/align.js handles cross-component placement via basePos.",
    defaultParams: mds.defaultParams,
    compute:      mds.compute,
    modalSchema:  [
      {
        key:   "iterations",
        label: "iterations",
        kind:  "int",
        min:   50, max: 600, step: 10,
        format: (v) => String(v),
        hint:  "SMACOF iterations on the stress function. 200 converges well for components ≤ a few hundred nodes.",
        sweepValues: [100, 200, 400],
      },
      {
        key:   "scaleD",
        label: "scale per hop",
        kind:  "range",
        min:   1, max: 30, step: 0.5,
        format: (v) => (+v).toFixed(1),
        hint:  "World units per graph hop, i.e. target distance for adjacent nodes. Per-component alignment scales the final layout to match basePos extent, so this only affects the intermediate density — the final visible scale is the same.",
        sweepValues: [6, 12, 18, 24],
      },
    ],
  },
];

const BY_ID = new Map(ALGORITHMS.map(a => [a.id, a]));

export function getAlgorithm(id) {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`[CitationLayoutRegistry] unknown algorithm "${id}"`);
  return a;
}

export function listAlgorithms() {
  return ALGORITHMS.slice();
}
