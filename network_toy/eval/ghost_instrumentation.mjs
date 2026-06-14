// Ghost-node positioning — Part C Step-1 INSTRUMENTATION harness (spec §5).
//
// Authoritative design: claude_doc_dump/ghost-node-positioning-spec.md §5 Step 1.
// This is the *instrument-before-commit* harness: it measures the current
// (imputed-anchor / masked-conduit) fusion pipeline on a graph with ghosts so
// the Step-1 gate (variance-collapse vs surviving-bridge) can be read off real
// numbers rather than assumed.
//
// It reuses the pure JS pipeline modules DIRECTLY in node (no browser, no build
// step): pca.js (noise stage, fit-on-real-only), graph-diffusion.js (masked
// no-self-anchor APPNP fusion, §4.3) and clustering-hdbscan.js (HDBSCAN fit on
// embedded nodes only, §4.4). Importing these in node requires the sibling
// package.json `"type":"module"` marker; the browser app ignores that file.
//
// ── What this computes (spec §5 Step 1 bullets) ─────────────────────────────
//   (a) low-variance-collapse detector:
//         - ghost-vs-real per-channel variance ratio (mean over channels of
//           var_ghost[c] / var_real[c]), plus the raw mean variances.
//         - Dirichlet energy of the fused vectors over the citation graph
//           E = Σ_{(i,j)∈E} ‖x_i − x_j‖²  (low energy ⇒ oversmoothed / collapsed),
//           reported overall and split by edge type (real-real, real-ghost,
//           ghost-ghost) so a ghost-side collapse is attributable.
//   (b) bridge co-cluster / proximity signal:
//         - bridged real pairs = (A,B) that share a degree≥2 ghost, have NO
//           direct A–B edge (and no shared real neighbour — a stricter "no
//           other short path" proxy). For these: mean fused-space distance and
//           HDBSCAN co-cluster rate.
//         - random-shared-ghost NULL: rewire each ghost's real-endpoint set to
//           a random same-size set of real nodes (degree-preserving on the
//           ghost side), re-fuse, recompute the same pairs/metric. Bridged ≫
//           null ⇒ the A→ghost→B bridge does measurable work.
//   (c) contamination: real-node displacement between the with-ghost fused
//         positions and a GHOST-FREE reference embedding (same PCA + APPNP with
//         every ghost edge removed). Reported as a scale-invariant rank
//         correlation of real–real distances (Q4-style, magnitude-robust) plus
//         raw mean per-node displacement.
//
// ── What is headless vs what needs real data ────────────────────────────────
//   HEADLESS (this file, no external setup): everything above is computed from
//   an in-memory embedding matrix + ghost mask + edge list, on the SMALL
//   synthetic graph in smoke_ghost_instrumentation.mjs, or on any matrix you
//   pass to runInstrumentation().
//
//   UMAP-space localisation (spec §5 "stage localisation": pair distance in
//   UMAP space) is INTENTIONALLY SKIPPED here. The toy's UMAP comes from a
//   CDN/esm.sh module that is not runnable headlessly in plain node, so we
//   compute the fused-100d distance + HDBSCAN co-cluster metrics (which already
//   localise washout to fusion-vs-clustering) and flag UMAP as skipped in the
//   report. Run the in-browser Playwright path if UMAP-space numbers are needed.
//
//   REAL-DATA GATE RUN (not done here — needs the fallworm setup):
//     1. biblion: run `materialize_ghost_stubs` on the fallworm db
//        (--min-degree 2) so external endpoints become is_stub=1 structural rows.
//     2. biblion: `advanced snapshot --include-structural` → nodes.jsonl +
//        paper_index.json carry the `structural` flag (ghosts last), then
//        `embed` → embeddings.npy (m embedded rows) + structural_mask.json.
//     3. Load that into this harness: embeddings.npy → Float32Array (m*d),
//        structural_mask → ghostMask (Uint8Array(n), ghosts last), the snapshot
//        citation edges → flat [src,dst,...]. Then call runInstrumentation()
//        exactly as the smoke test does. The metrics + Step-1 gate are identical;
//        only the input matrix changes.
//
// Pure: no DOM, no network, no file writes. Deterministic given a seed.

import { computePca }  from "../app/src/dimred/pca.js";
import { compute as graphDiffusion } from "../app/src/dimred/graph-diffusion.js";
import { inferHdbscan } from "../app/src/clustering-hdbscan.js";
import { mulberry32 }   from "../app/src/rng.js";

// ── small linear-algebra / stats helpers ────────────────────────────────────

// Per-channel population variance over a chosen subset of row indices.
function channelVariances(data, n, d, rowIdx) {
  const cnt = rowIdx.length;
  const out = new Float64Array(d);
  if (cnt === 0) return out;
  const mean = new Float64Array(d);
  for (const i of rowIdx) {
    const off = i * d;
    for (let c = 0; c < d; c++) mean[c] += data[off + c];
  }
  for (let c = 0; c < d; c++) mean[c] /= cnt;
  for (const i of rowIdx) {
    const off = i * d;
    for (let c = 0; c < d; c++) {
      const v = data[off + c] - mean[c];
      out[c] += v * v;
    }
  }
  for (let c = 0; c < d; c++) out[c] /= cnt;
  return out;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function sqDist(data, d, i, j) {
  const a = i * d, b = j * d;
  let s = 0;
  for (let c = 0; c < d; c++) { const v = data[a + c] - data[b + c]; s += v * v; }
  return s;
}

function dist(data, d, i, j) { return Math.sqrt(sqDist(data, d, i, j)); }

// Spearman-ish rank correlation between two equal-length arrays. Used for the
// scale-invariant displacement metric (Q4): we correlate real–real distance
// RANKINGS, so a uniform rescale of the embedding (which PCA/APPNP magnitude
// changes can introduce) does not masquerade as contamination.
function rankCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Float64Array(n);
    let k = 0;
    while (k < n) {
      let j = k;
      while (j + 1 < n && idx[j + 1][0] === idx[k][0]) j++;
      const avg = (k + j) / 2;       // average rank for ties
      for (let t = k; t <= j; t++) r[idx[t][1]] = avg;
      k = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = mean(Array.from(rx)), my = mean(Array.from(ry));
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    cov += a * b; vx += a * a; vy += b * b;
  }
  return (vx === 0 || vy === 0) ? NaN : cov / Math.sqrt(vx * vy);
}

// ── graph utilities ─────────────────────────────────────────────────────────

// Build an undirected adjacency (Set per node) from a flat [src,dst,...] list.
function buildAdjSets(edges, n) {
  const adj = Array.from({ length: n }, () => new Set());
  for (let k = 0; k < edges.length; k += 2) {
    const u = edges[k] | 0, v = edges[k + 1] | 0;
    if (u === v || u < 0 || v < 0 || u >= n || v >= n) continue;
    adj[u].add(v); adj[v].add(u);
  }
  return adj;
}

// Bridged real pairs: (A,B) both real, sharing a degree≥2 ghost, with no direct
// A–B edge and no shared REAL neighbour (a conservative "no other short path"
// proxy so we isolate the A→ghost→B bridge). Deduplicated, A<B.
function bridgedRealPairs(adj, ghostMask, minGhostDegree = 2) {
  const isGhost = (i) => ghostMask[i] === 1;
  const pairs = new Map();   // "A,B" → {a,b,ghosts:Set}
  const n = adj.length;
  for (let g = 0; g < n; g++) {
    if (!isGhost(g)) continue;
    const realNbrs = [...adj[g]].filter((x) => !isGhost(x));
    if (realNbrs.length < minGhostDegree) continue;
    for (let i = 0; i < realNbrs.length; i++) {
      for (let j = i + 1; j < realNbrs.length; j++) {
        const a = Math.min(realNbrs[i], realNbrs[j]);
        const b = Math.max(realNbrs[i], realNbrs[j]);
        if (adj[a].has(b)) continue;                       // direct edge → not a bridge
        // shared real neighbour ⇒ another short path; exclude.
        let sharedReal = false;
        for (const x of adj[a]) { if (!isGhost(x) && adj[b].has(x)) { sharedReal = true; break; } }
        if (sharedReal) continue;
        const key = a + "," + b;
        if (!pairs.has(key)) pairs.set(key, { a, b, ghosts: new Set() });
        pairs.get(key).ghosts.add(g);
      }
    }
  }
  return [...pairs.values()];
}

// Degree-preserving rewire of ghost→real endpoints (the §5 "random-shared-ghost
// null"). Each ghost keeps its real-degree but points at a random set of real
// nodes; ghost–ghost edges are preserved as-is. Real–real edges are preserved.
function rewireGhostEdges(edges, ghostMask, realIdx, rng) {
  const isGhost = (i) => ghostMask[i] === 1;
  const out = [];
  const realDegByGhost = new Map();
  for (let k = 0; k < edges.length; k += 2) {
    const u = edges[k] | 0, v = edges[k + 1] | 0;
    const ug = isGhost(u), vg = isGhost(v);
    if (ug && vg) { out.push(u, v); continue; }            // ghost–ghost kept
    if (!ug && !vg) { out.push(u, v); continue; }          // real–real kept
    const ghost = ug ? u : v;
    realDegByGhost.set(ghost, (realDegByGhost.get(ghost) || 0) + 1);
  }
  for (const [ghost, deg] of realDegByGhost) {
    const chosen = new Set();
    let guard = 0;
    while (chosen.size < deg && guard < 1000) {
      chosen.add(realIdx[(rng() * realIdx.length) | 0]);
      guard++;
    }
    for (const r of chosen) out.push(ghost, r);
  }
  return out;
}

// ── the one fusion run used everywhere (PCA-on-real-only → masked APPNP) ─────

// Given the full embedding matrix for the m embedded (real) nodes, the ghost
// mask over all n nodes, and the citation edges, produce the dense n×d fused
// matrix exactly as the toy pipeline would (spec §4.2 + §4.3):
//   1. PCA noise stage on the m real rows only (fit-on-real-only).
//   2. masked no-self-anchor APPNP fusion expanding to all n rows.
// `embedding` is { n: m, d, data: Float32Array(m*d) } over real nodes (rows
// 0..m-1 by the ghosts-last invariant). Returns { n, d, data }.
function fuse(embedding, ghostMask, edges, { pcaComponents, alpha, iterations, countGhostsInDegree }) {
  const pca = computePca(embedding, { n_components: pcaComponents });   // m × K
  return graphDiffusion(
    { n: pca.n, d: pca.d, data: pca.data },
    { adjacency: edges, ghostMask, alpha, iterations, countGhostsInDegree },
  );
}

// ── HDBSCAN co-cluster labels over the EMBEDDED nodes only (spec §4.4) ───────

// Slice the fused n×d block down to the m embedded rows, run HDBSCAN, return an
// Int32Array(m) of cluster labels for the embedded nodes (ghosts excluded from
// the fit, per §4.4). nodeCluster index aligns with real-node index (ghosts
// last ⇒ embedded rows are 0..m-1).
function embeddedClusterLabels(fused, m, hdbscanParams) {
  const d = fused.d;
  const sub = new Float32Array(m * d);
  sub.set(fused.data.subarray(0, m * d));
  const nodes = Array.from({ length: m }, () => ({ basePos: [0, 0, 0] }));
  const res = inferHdbscan(
    { nodes },
    hdbscanParams,
    { method: "fused", params: {}, n: m, d, data: sub },
  );
  return res.nodeCluster;
}

// ── metric blocks ───────────────────────────────────────────────────────────

// (a) variance ratio + Dirichlet energy of a fused matrix.
function varianceAndDirichlet(fused, ghostMask, edges) {
  const { n, d, data } = fused;
  const realIdx = [], ghostIdx = [];
  for (let i = 0; i < n; i++) (ghostMask[i] === 1 ? ghostIdx : realIdx).push(i);

  const vReal  = channelVariances(data, n, d, realIdx);
  const vGhost = channelVariances(data, n, d, ghostIdx);
  const meanVarReal  = mean(Array.from(vReal));
  const meanVarGhost = mean(Array.from(vGhost));

  // Per-channel ratio, averaged over channels with non-degenerate real var.
  const ratios = [];
  for (let c = 0; c < d; c++) if (vReal[c] > 1e-12) ratios.push(vGhost[c] / vReal[c]);
  const meanChannelRatio = mean(ratios);

  // Dirichlet energy split by edge type.
  let eAll = 0, eRR = 0, eRG = 0, eGG = 0;
  let cRR = 0, cRG = 0, cGG = 0;
  const isGhost = (i) => ghostMask[i] === 1;
  for (let k = 0; k < edges.length; k += 2) {
    const u = edges[k] | 0, v = edges[k + 1] | 0;
    if (u === v || u < 0 || v < 0 || u >= n || v >= n) continue;
    const w = sqDist(data, d, u, v);
    eAll += w;
    const ug = isGhost(u), vg = isGhost(v);
    if (ug && vg) { eGG += w; cGG++; }
    else if (ug || vg) { eRG += w; cRG++; }
    else { eRR += w; cRR++; }
  }
  return {
    meanVarReal, meanVarGhost,
    varianceRatioGhostOverReal: meanVarReal > 1e-12 ? meanVarGhost / meanVarReal : NaN,
    meanPerChannelVarianceRatio: meanChannelRatio,
    dirichletEnergy: { all: eAll, realReal: eRR, realGhost: eRG, ghostGhost: eGG },
    dirichletEnergyPerEdge: {
      realReal:   cRR ? eRR / cRR : NaN,
      realGhost:  cRG ? eRG / cRG : NaN,
      ghostGhost: cGG ? eGG / cGG : NaN,
    },
    nReal: realIdx.length, nGhost: ghostIdx.length,
  };
}

// (b) bridge proximity + co-cluster, real vs the rewired null.
function bridgeSignal(embedding, ghostMask, edges, opts) {
  const n = ghostMask.length;
  const realIdx = [];
  for (let i = 0; i < n; i++) if (ghostMask[i] === 0) realIdx.push(i);
  const m = realIdx.length;

  const fusedReal = fuse(embedding, ghostMask, edges, opts);
  const adjReal   = buildAdjSets(edges, n);
  const pairs     = bridgedRealPairs(adjReal, ghostMask, opts.minGhostDegree);

  const measure = (fused, pairList) => {
    if (pairList.length === 0) return { nPairs: 0, meanDist: NaN, coClusterRate: NaN };
    const labels = embeddedClusterLabels(fused, m, opts.hdbscan);
    const dists = [];
    let co = 0;
    for (const p of pairList) {
      dists.push(dist(fused.data, fused.d, p.a, p.b));   // a,b are real ⇒ index == row
      if (labels[p.a] === labels[p.b]) co++;
    }
    return { nPairs: pairList.length, meanDist: mean(dists), coClusterRate: co / pairList.length };
  };

  const real = measure(fusedReal, pairs);

  // Null: rewire ghost→real endpoints, re-fuse, and re-measure on the SAME real
  // pair set (the pairs are defined by the real bridge we are testing; the null
  // asks "if those same A,B shared a *random* ghost instead, would they still be
  // close / co-cluster?"). Averaged over several rewires.
  const nullDists = [], nullCo = [];
  for (let t = 0; t < opts.nullSamples; t++) {
    const rng = mulberry32((opts.seed ^ (0x1234 + t * 7919)) >>> 0);
    const rewired = rewireGhostEdges(edges, ghostMask, realIdx, rng);
    const fusedNull = fuse(embedding, ghostMask, rewired, opts);
    const mm = measure(fusedNull, pairs);
    if (Number.isFinite(mm.meanDist)) nullDists.push(mm.meanDist);
    if (Number.isFinite(mm.coClusterRate)) nullCo.push(mm.coClusterRate);
  }
  return {
    nBridgedPairs: pairs.length,
    real,
    null: {
      meanDist: mean(nullDists),
      coClusterRate: mean(nullCo),
      samples: opts.nullSamples,
    },
    // headline gate inputs: bridged ≫ null on co-cluster, bridged ≪ null on dist
    coClusterLift: real.coClusterRate - mean(nullCo),
    distanceRatioRealOverNull: real.meanDist / (mean(nullDists) || NaN),
    fused: fusedReal,
  };
}

// (c) contamination: with-ghost vs ghost-free reference, real nodes only.
function contamination(embedding, ghostMask, edges, fusedWithGhosts, opts) {
  const n = ghostMask.length;
  const realIdx = [];
  for (let i = 0; i < n; i++) if (ghostMask[i] === 0) realIdx.push(i);
  const m = realIdx.length;
  const d = fusedWithGhosts.d;

  // Ghost-free reference: drop every edge that touches a ghost, then fuse with
  // an all-zero mask (pure classic anchored APPNP over the real subgraph). PCA
  // is already real-only, so the reference shares the same noise stage.
  const isGhost = (i) => ghostMask[i] === 1;
  const realEdges = [];
  for (let k = 0; k < edges.length; k += 2) {
    const u = edges[k] | 0, v = edges[k + 1] | 0;
    if (isGhost(u) || isGhost(v)) continue;
    realEdges.push(u, v);
  }
  const refFused = graphDiffusion(
    computePca(embedding, { n_components: opts.pcaComponents }),
    { adjacency: realEdges, ghostMask: null, alpha: opts.alpha, iterations: opts.iterations },
  );

  // Raw mean per-node displacement (real rows only). Magnitude-sensitive.
  // Real nodes share the same index/row space in both fused matrices (ghosts-
  // last), so row r ↔ row r.
  let disp = 0;
  for (let r = 0; r < m; r++) disp += rowDist(fusedWithGhosts.data, refFused.data, d, r);
  const meanDisplacement = disp / m;

  // Scale-invariant: correlate real–real distance rankings (Q4 metric).
  const pick = Math.min(m, opts.maxPairsForCorr || 400);
  const ai = [], bi = [];
  // deterministic sample of real-pair indices
  const rng = mulberry32((opts.seed ^ 0x5a5a) >>> 0);
  const seen = new Set();
  let guard = 0;
  const target = Math.min((pick * (pick - 1)) / 2, opts.maxCorrPairs || 2000);
  while (ai.length < target && guard < target * 50) {
    const a = (rng() * m) | 0, b = (rng() * m) | 0;
    guard++;
    if (a === b) continue;
    const key = Math.min(a, b) + "," + Math.max(a, b);
    if (seen.has(key)) continue;
    seen.add(key); ai.push(Math.min(a, b)); bi.push(Math.max(a, b));
  }
  const dWith = ai.map((a, i) => dist(fusedWithGhosts.data, d, a, bi[i]));
  const dRef  = ai.map((a, i) => dist(refFused.data, refFused.d, a, bi[i]));
  const corr = rankCorrelation(dWith, dRef);

  return {
    meanRealNodeDisplacement: meanDisplacement,
    realRealDistanceRankCorrelation: corr,
    nPairsCorrelated: ai.length,
  };
}

function rowDist(a, b, d, r) {
  const off = r * d;
  let s = 0;
  for (let c = 0; c < d; c++) { const v = a[off + c] - b[off + c]; s += v * v; }
  return Math.sqrt(s);
}

// ── top-level entry ─────────────────────────────────────────────────────────

export const DEFAULT_OPTS = {
  pcaComponents: 8,        // noise stage K (real pipeline uses 100; small here)
  alpha: 0.3,              // APPNP mixing (toy default)
  iterations: 4,           // K diffusion steps (toy default)
  countGhostsInDegree: true,
  minGhostDegree: 2,       // a "ghost" for bridge purposes is degree≥2 (spec)
  nullSamples: 8,          // rewires averaged for the null
  seed: 12345,
  maxPairsForCorr: 400,
  maxCorrPairs: 2000,
  hdbscan: { minSamples: 2, minClusterSize: 2, selectionMethod: "eom", noiseMode: "absorb" },
};

// embedding : { n:m, d, data:Float32Array(m*d) }  — REAL (embedded) nodes only,
//             rows 0..m-1 (ghosts-last invariant).
// ghostMask : Uint8Array(n)  — 1 = ghost. Ghosts MUST be the trailing indices.
// edges     : number[]       — flat [src,dst,...] over all n node indices.
export function runInstrumentation(embedding, ghostMask, edges, userOpts = {}) {
  const opts = { ...DEFAULT_OPTS, ...userOpts, hdbscan: { ...DEFAULT_OPTS.hdbscan, ...(userOpts.hdbscan || {}) } };
  const n = ghostMask.length;
  let m = 0; for (let i = 0; i < n; i++) if (ghostMask[i] === 0) m++;
  if (embedding.n !== m) {
    throw new Error(`runInstrumentation: embedding has ${embedding.n} rows; expected m=${m} embedded (non-ghost) nodes`);
  }
  // ghosts-last invariant check (mirrors graph-diffusion.js so a bad mask fails loud).
  for (let i = 0; i < m; i++) {
    if (ghostMask[i] !== 0) throw new Error(`runInstrumentation: ghostMask violates ghosts-last invariant at index ${i}`);
  }

  const bridge = bridgeSignal(embedding, ghostMask, edges, opts);
  const fused  = bridge.fused;
  const collapse = varianceAndDirichlet(fused, ghostMask, edges);
  const contam   = contamination(embedding, ghostMask, edges, fused, opts);

  return {
    config: {
      n, m, nGhost: n - m,
      pcaComponents: opts.pcaComponents, alpha: opts.alpha, iterations: opts.iterations,
      countGhostsInDegree: opts.countGhostsInDegree, minGhostDegree: opts.minGhostDegree,
      nullSamples: opts.nullSamples, seed: opts.seed,
      umapSpace: "SKIPPED (CDN/esm.sh UMAP not runnable headlessly; fused-100d + HDBSCAN metrics computed instead)",
    },
    lowVarianceCollapse: collapse,    // (a)
    bridgeSignal: {                   // (b)
      nBridgedPairs: bridge.nBridgedPairs,
      real: bridge.real,
      null: bridge.null,
      coClusterLift: bridge.coClusterLift,
      distanceRatioRealOverNull: bridge.distanceRatioRealOverNull,
    },
    contamination: contam,            // (c)
  };
}

// Render a result object as a compact human-readable report (used by the smoke
// runner and re-usable for the real-data gate run).
export function formatReport(r) {
  const f = (x, p = 4) => (Number.isFinite(x) ? x.toFixed(p) : String(x));
  const c = r.config, a = r.lowVarianceCollapse, b = r.bridgeSignal, d = r.contamination;
  const lines = [];
  lines.push("=== Ghost-node Part C Step-1 instrumentation ===");
  lines.push(`graph: n=${c.n}  embedded(real)=${c.m}  ghosts=${c.nGhost}  (minGhostDegree=${c.minGhostDegree})`);
  lines.push(`fusion: PCA K=${c.pcaComponents}, APPNP alpha=${c.alpha}, K=${c.iterations}, countGhostsInDegree=${c.countGhostsInDegree}`);
  lines.push(`UMAP-space: ${c.umapSpace}`);
  lines.push("");
  lines.push("(a) low-variance-collapse detector");
  lines.push(`    mean per-channel variance   real=${f(a.meanVarReal)}  ghost=${f(a.meanVarGhost)}`);
  lines.push(`    ghost/real variance ratio   ${f(a.varianceRatioGhostOverReal)}   (per-channel mean ${f(a.meanPerChannelVarianceRatio)})`);
  lines.push(`    Dirichlet energy /edge      real-real=${f(a.dirichletEnergyPerEdge.realReal)}  real-ghost=${f(a.dirichletEnergyPerEdge.realGhost)}  ghost-ghost=${f(a.dirichletEnergyPerEdge.ghostGhost)}`);
  lines.push("    >> collapse if ghost variance << real (orders of magnitude) and real-ghost Dirichlet energy ~ 0");
  lines.push("");
  lines.push("(b) bridge co-cluster / proximity vs random-shared-ghost null");
  lines.push(`    bridged real pairs (share deg>=2 ghost, no direct edge): ${b.nBridgedPairs}`);
  lines.push(`    fused-space mean distance   bridged=${f(b.real.meanDist)}  null=${f(b.null.meanDist)}  (ratio real/null=${f(b.distanceRatioRealOverNull)})`);
  lines.push(`    HDBSCAN co-cluster rate     bridged=${f(b.real.coClusterRate)}  null=${f(b.null.coClusterRate)}  (lift=${f(b.coClusterLift)})`);
  lines.push("    >> bridge does work if co-cluster lift > 0 and distance ratio < 1");
  lines.push("");
  lines.push("(c) contamination: real positions with ghosts vs ghost-free reference");
  lines.push(`    mean real-node displacement                 ${f(d.meanRealNodeDisplacement)}`);
  lines.push(`    real-real distance rank corr (scale-inv)    ${f(d.realRealDistanceRankCorrelation)}  over ${d.nPairsCorrelated} pairs`);
  lines.push("    >> low contamination if rank corr ~ 1 (real geometry preserved)");
  return lines.join("\n");
}
