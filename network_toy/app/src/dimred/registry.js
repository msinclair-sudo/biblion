// Dim-reduction algorithm registry (Layer 1.5).
//
// Layer 1.5 has THREE stages: noise reduction, dimension compression
// (clustering input), and visualisation reduction (viewer / blend
// input). Compression and viz are siblings — both fork off the noise
// stage's output. Each entry declares which slots it's eligible for
// via a `family` array of strings ("noise" | "compression" | "viz" |
// "any"). "any" means usable in any slot — currently just `identity`,
// which acts as "skip this stage".
//
// Adding a new algorithm = one entry here. `listAlgorithms(slot)`
// filters; the dim-reduction modal renders one section per slot and
// drops in only the matching entries.
//
// Contract: every `compute` returned must satisfy the contract in
// app/src/dimred/contract.js, validated by validateDimredResult. The
// validator runs in engine.js on every redimred() so contract
// violations surface immediately when adding a new algorithm.
//
// New algorithm signature: `compute(input, params)` where input is
// `{n, d, data: Float32Array(n*d)}`. Stages chain: stage 1's output
// (which is itself a DimredResult) becomes stage 2's input.

import { computeIdentity, defaultIdentityParams } from "./identity.js";
import { computePca,      defaultPcaParams      } from "./pca.js";
import { computeUmap,     defaultUmapParams     } from "./umap.js";
import * as graphDiffusion                       from "./graph-diffusion.js";

export const ALGORITHMS = [
  {
    id: "identity",
    label: "Identity (skip)",
    family: ["any"],
    description: "Don't reduce — pass the data straight through. Use this to skip a stage you don't need.",
    defaultParams: defaultIdentityParams,
    compute: (input, params) => computeIdentity(input, params),
    modalSchema: [],
  },
  {
    id: "pca",
    label: "PCA",
    family: ["noise"],
    description: "Squashes high-dimensional data onto its main axes of variation. Useful for cleaning up noise BEFORE running UMAP — it strips out tiny variations that don't carry real structure. PCA on its own is rarely a great clustering input for embeddings; pair it with UMAP in the compression stage.",
    defaultParams: defaultPcaParams,
    // Slot-specific defaults override defaultParams() when the user
    // picks an algorithm in a particular slot. PCA is only registered
    // for the noise slot; we recommend 100 (the locked denoiser size).
    defaultParamsForSlot: (_slot) => ({ n_components: 100 }),
    compute: (input, params) => computePca(input, params),
    modalSchema: [
      {
        key: "n_components",
        label: "Output dimensions",
        kind: "int",
        min: 1, max: 200, step: 1,
        format: (v) => String(v),
        hint: "How many directions to keep. Recommended: 100 — keeps the signal in 768-d embeddings while dropping noise. Compute clamps automatically when the input has fewer dimensions, so it's safe to leave at 100 even for toy data.",
        sweepValues: [50, 100, 200],
      },
    ],
  },
  {
    id: graphDiffusion.ID,
    label: "Graph diffusion (citation-aware)",
    family: ["fusion"],
    description: "Pulls papers that cite each other closer in feature space while keeping each paper anchored to its original SPECTER2 vector. Anchored graph diffusion (APPNP): X' = (1−α)·X + α·(D⁻¹A)·X' iterated k times. Requires citation edges loaded at ingest time — toy data sources skip this stage.",
    defaultParams:        graphDiffusion.defaultParams,
    defaultParamsForSlot: (_slot) => ({ alpha: 0.3, iterations: 4 }),
    compute: (input, params) => graphDiffusion.compute(input, params),
    modalSchema: [
      {
        key:   "alpha",
        label: "Citation influence (α)",
        kind:  "range",
        min:   0, max: 0.95, step: 0.05,
        format: (v) => (+v).toFixed(2),
        hint:  "How much each paper's vector is pulled toward its citation neighbours per iteration. 0 = no fusion (identical to identity); higher = more citation influence on the topic map. Recommended start: 0.3 — mild fusion that preserves SPECTER2's semantic content.",
        sweepValues: [0.1, 0.3, 0.5, 0.7],
      },
      {
        key:   "iterations",
        label: "Diffusion depth (k)",
        kind:  "int",
        min:   1, max: 20, step: 1,
        format: (v) => String(v),
        hint:  "How many hops information propagates. Each iteration moves citation influence one hop further. Recommended 4 — covers most short-path influence on a giant component. Higher dilutes the original SPECTER2 signal more.",
        sweepValues: [2, 4, 8, 12],
      },
    ],
  },
  {
    id: "umap",
    label: "UMAP",
    family: ["compression", "viz", "viz2d"],
    description: "Builds a map that keeps similar points near each other. Use it in the compression stage to give clustering a clean ~100-d input; use it in the visualisation stage to reduce to 3-d (or 2-d) for the viewer.",
    defaultParams: defaultUmapParams,
    // Slot-specific defaults — these are the locked values from
    // clustering-research §4. Compression: tight clusters (min_dist=0)
    // at 50-d with broad neighbours (50). Viz (3-d): a few looser
    // clusters at 3-d with smaller neighbour windows (15) — better
    // for an interactive viewer. Viz2d: 2-d analogue with a distinct
    // seed so the 2D and 3D fits don't sync. Distinct random_state
    // per slot so re-running one doesn't accidentally jiggle others.
    defaultParamsForSlot: (slot) => {
      if (slot === "compression") {
        // n_components bumped 50 → 100 per §6.9 dim-sweep validation
        // (2026-05-25): on the BFS-5000 fixture, ARI(50, 100) = 0.806
        // ± 0.063 — below the 0.9 threshold for "50-d preserves enough
        // information". ARI(100, 200) = 1.000 exactly, so information
        // saturates by d=100 (no point going higher).
        // See doc/dim-sweep-results.md.
        return { n_components: 100, n_neighbors: 50, min_dist: 0.0, metric: "cosine", random_state: 42 };
      }
      if (slot === "viz") {
        return { n_components: 3,  n_neighbors: 15, min_dist: 0.1, metric: "cosine", random_state: 43 };
      }
      if (slot === "viz2d") {
        return { n_components: 2,  n_neighbors: 15, min_dist: 0.1, metric: "cosine", random_state: 44 };
      }
      return defaultUmapParams();
    },
    compute: (input, params) => computeUmap(input, params),
    modalSchema: [
      {
        key: "n_components",
        label: "Output dimensions",
        kind: "int",
        min: 1, max: 200, step: 1,
        format: (v) => String(v),
        hint: "How many dimensions the map should have. Recommended: 100 for compression (clustering input — §6.9 found ARI(50, 100) = 0.806 on BFS-5000, below the 0.9 threshold for 50-d defensibility; ARI(100, 200) = 1.000 so information saturates by 100), 3 for the 3-d viewer, 2 for a flat scatterplot.",
        sweepValues: [3, 10, 30, 50, 100, 200],
      },
      {
        key: "n_neighbors",
        label: "Neighbours per point",
        kind: "int",
        min: 2, max: 100, step: 1,
        format: (v) => String(v),
        hint: "How many nearby points each point looks at when building the map. Recommended: 50 for compression (broader context, better global structure for clustering), 15 for visualisation (tighter local groups). Small values zoom into local detail; large values bias toward the big picture.",
        sweepValues: [5, 15, 30, 50, 100],
      },
      {
        key: "min_dist",
        label: "Cluster tightness",
        kind: "range",
        min: 0, max: 1, step: 0.05,
        format: (v) => (+v).toFixed(2),
        hint: "How tightly to pack points within a cluster. Recommended: 0 for compression (clusters as compact as possible — best for clustering), 0.1 for visualisation (slightly spread out for readable rendering).",
        sweepValues: [0.0, 0.1, 0.25, 0.5],
      },
      {
        key: "metric",
        label: "Distance metric",
        kind: "select",
        options: [
          { value: "cosine",    label: "Cosine (best for text/embeddings)" },
          { value: "euclidean", label: "Euclidean (best for spatial data)" },
        ],
        hint: "How to measure 'closeness' between points. Cosine is right for word/document embeddings (it ignores raw magnitude); Euclidean is right when the coordinates have direct spatial meaning, like the toy generator's basePos.",
        sweepValues: ["cosine"],
      },
    ],
  },
];

const BY_ID = new Map(ALGORITHMS.map(a => [a.id, a]));

export function getAlgorithm(id) {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`[DimredRegistry] unknown algorithm "${id}"`);
  return a;
}

// `slot` is optional. When omitted, returns every entry. Otherwise
// returns entries whose family array includes the slot OR includes
// "any".
export function listAlgorithms(slot) {
  if (!slot) return ALGORITHMS.slice();
  return ALGORITHMS.filter(a => {
    const fam = Array.isArray(a.family) ? a.family : [a.family];
    return fam.includes(slot) || fam.includes("any");
  });
}
