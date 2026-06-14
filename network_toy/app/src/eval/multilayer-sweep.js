// Multi-layer-from-sweep — auto-detect a coarse→fine ladder of the most
// REPRODUCIBLE HDBSCAN partitions (§9 revamp; HDBSCAN-only).
//
// The old design did one HDBSCAN run and cut its condensed tree by
// persistence — which couldn't give good clusters at every scale (one
// minClusterSize can't fit all granularities) and picked levels the user
// didn't choose. This finds the levels empirically instead:
//
//   Phase 1 (cheap):  extract a partition at many minClusterSize values
//                     over ONE shared model (buildHdbscanModel) → a
//                     (size → clusterCount) map. No bootstrap.
//   Plateaus:         a count that holds across a WIDE band of sizes is a
//                     robust granularity → one candidate per distinct count.
//   Phase 2 (bounded):bootstrap-Jaccard ONLY those candidates → a
//                     reproducibility score each. This is the only costly part.
//   Select shelves:   local maxima of reproducibility across cluster count,
//                     above a floor, capped at K → the layers (coarse→fine).
//
// The pure helpers (logSpacedSizes / findPlateauCandidates /
// buildLayersFromPicks) carry the algorithmic decisions and are unit-tested
// without compute; the orchestrator (runMultilayerSweep) ties them to
// extract + bootstrap.

import { extractHdbscanLevel } from "../clustering-hdbscan.js";
// bootstrap.js is imported DYNAMICALLY inside runPhase2Score — it pulls
// the worker-spawning eval chain (run-infer-remote), which we don't want
// loaded when the clustering worker imports runPhase1 for Phase 1.

/**
 * Log-spaced minClusterSize grid from 2 up to ~n/2 — the upper bound where
 * a cluster must hold half the points, forcing the coarsest (~2-cluster)
 * level so genuinely coarse shelves are reachable. Deduped + ascending.
 * @param {number} n
 * @param {number} [count=25]
 * @returns {number[]}
 */
export function logSpacedSizes(n, count = 25) {
  const lo = 2;
  const hi = Math.max(4, Math.floor(n / 2));
  if (hi <= lo) return [lo];
  const out = new Set();
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    out.add(Math.max(2, Math.round(lo * Math.pow(hi / lo, t))));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Collapse the (size → count) sweep into one candidate per distinct cluster
 * count, choosing the size at the MIDDLE of that count's widest contiguous
 * size-plateau (the most robust representative). plateauWidth = number of
 * grid sizes in that plateau (higher = the granularity is more stable to
 * the knob). Counts < 2 (degenerate) are dropped.
 *
 * @param {Array<{size:number, count:number, _cr?:object}>} pairs
 * @returns {Array<{count:number, size:number, plateauWidth:number, _cr?:object}>}
 *          ascending by count (coarse → fine).
 */
export function findPlateauCandidates(pairs) {
  if (!pairs || pairs.length === 0) return [];
  const sorted = pairs.slice().sort((a, b) => a.size - b.size);
  // Contiguous runs of equal count.
  const plateaus = [];
  let run = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].count === run[0].count) run.push(sorted[i]);
    else { plateaus.push(run); run = [sorted[i]]; }
  }
  plateaus.push(run);

  const byCount = new Map();
  for (const pl of plateaus) {
    const count = pl[0].count;
    if (count < 2) continue;
    const mid = pl[Math.floor(pl.length / 2)];
    const cand = { count, size: mid.size, plateauWidth: pl.length, _cr: mid._cr };
    const prev = byCount.get(count);
    if (!prev || cand.plateauWidth > prev.plateauWidth) byCount.set(count, cand);
  }
  return [...byCount.values()].sort((a, b) => a.count - b.count);
}

// (selectShelves removed 2026-06-01: layer selection is now a manual pick on
// the reproducibility curve, not an auto floor+cap+separation heuristic. The
// sweep scores every candidate and hands the whole curve to the picker card;
// the user clicks the granularities they want. See
// doc/multilevel-card-split-plan.md.)

// Drop the bulky condensed tree from a clusterResult — the new multi-layer
// design relates levels by overlap, not by cutting a tree, so the per-level
// condensedTree is dead weight on the worker→main transfer.
function slimClusterResult(cr) {
  if (!cr) return cr;
  const { condensedTree, ...rest } = cr;
  return rest;
}

/**
 * PHASE 1 — runs WHERE THE MODEL LIVES (the clustering worker). Extracts a
 * partition at every grid size over the one shared model, collapses to
 * plateau candidates, and returns them with slim clusterResults (small
 * enough to post back to the main thread). No bootstrap here.
 *
 * @param {object} opts
 * @param {object} opts.model            from buildHdbscanModel.
 * @param {object} [opts.params={}]
 * @param {number} [opts.sizeGridCount=25]
 * @returns {Array<{size, count, plateauWidth, clusterResult}>}
 */
export function runPhase1({ model, params = {}, sizeGridCount = 25 }) {
  const n = model.n;
  const sizes = logSpacedSizes(n, sizeGridCount);
  const pairs = [];
  for (const size of sizes) {
    const cr = extractHdbscanLevel(model, { ...params, minClusterSize: size });
    pairs.push({ size, count: cr.clusters.length, _cr: cr });
  }
  return findPlateauCandidates(pairs).map(c => ({
    size:          c.size,
    count:         c.count,
    plateauWidth:  c.plateauWidth,
    clusterResult: slimClusterResult(c._cr),
  }));
}

/**
 * PHASE 2 (score) — runs ON THE MAIN THREAD so bootstrapStability fans its
 * B re-clusterings out across workers. Bootstraps EVERY candidate (with
 * minClusterSize scaled by the subsample fraction so coarse levels aren't
 * falsely penalised — a coarse cluster ~minClusterSize shrinks to ~f·size
 * in an f-subsample and would otherwise dissolve) and returns the full set
 * of scored candidates plus a curve. It does NOT pick layers: selection is
 * now a manual click on the curve (the picker card), so the candidates —
 * each retaining its slim clusterResult (nodeCluster intact) — are handed
 * through whole. commitMultiLevelLayers() later builds clusterLevels[] from
 * the candidates the user clicks, with no sweep re-run.
 *
 * @param {object} opts
 * @param {Array} opts.candidates         from runPhase1 (each w/ clusterResult).
 * @param {object} opts.genResult
 * @param {object} opts.dimredResult
 * @param {object} opts.algo              hdbscan registry entry.
 * @param {object} [opts.params={}]
 * @param {object} [opts.bootstrapOpts={}]
 * @param {(phase, idx, total)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{candidates, curve}>}  candidates keep their clusterResult;
 *          curve is the lightweight metadata view for the picker chart.
 */
export async function runPhase2Score({
  candidates, genResult, dimredResult, algo, params = {},
  bootstrapOpts = {}, onProgress = null, abortSignal = null,
}) {
  const { bootstrapStability } = await import("./bootstrap.js");
  const frac = Number.isFinite(bootstrapOpts.subsampleFrac) ? bootstrapOpts.subsampleFrac : 0.5;
  for (let i = 0; i < candidates.length; i++) {
    if (abortSignal && abortSignal.aborted) break;
    const c = candidates[i];
    const bootMcs = Math.max(2, Math.round(c.size * frac));
    try {
      const boot = await bootstrapStability({
        refClusterResult: c.clusterResult,
        genResult, dimredResult, algo,
        params: { ...params, minClusterSize: bootMcs },
        ...bootstrapOpts,
        abortSignal,
      });
      c.stability = boot.aggregate.meanJaccard_macro;
    } catch (e) {
      if (e && e.name === "AbortError") break;
      c.stability = null;
      c.error = String(e.message || e);
    }
    if (onProgress) onProgress("phase2", i + 1, candidates.length);
  }

  const curve = candidates.map(c => ({
    count:        c.count,
    size:         c.size,
    stability:    Number.isFinite(c.stability) ? c.stability : null,
    plateauWidth: c.plateauWidth,
  }));

  return { candidates, curve };
}

/**
 * Build clusterLevels[] from the user-picked candidates (coarse→fine). Pure:
 * given the scored candidates from runPhase2Score and the cluster counts the
 * user clicked, it returns the ladder in the clusterLevels[] shape the
 * cascade/state expect — no compute, no sweep re-run. Unknown picks (a count
 * not in candidates) are skipped.
 *
 * @param {Array} candidates    scored candidates (each w/ count, size, stability, clusterResult).
 * @param {number[]} pickedCounts  cluster counts the user selected.
 * @param {string} [uidPrefix="ML"]
 * @returns {Array<{uid, scope, clusterResult, minClusterSize, numClusters, stability}>}
 */
export function buildLayersFromPicks(candidates, pickedCounts, uidPrefix = "ML") {
  const byCount = new Map((candidates || []).map(c => [c.count, c]));
  const picked = [...new Set(pickedCounts || [])]
    .map(cnt => byCount.get(cnt))
    .filter(Boolean)
    .sort((a, b) => a.count - b.count);   // coarse → fine
  return picked.map((c, layer) => ({
    uid:            `${uidPrefix}-L${layer}`,
    scope:          "global",
    clusterResult:  c.clusterResult,
    minClusterSize: c.size,
    numClusters:    c.count,
    stability:      c.stability,
  }));
}

/**
 * All-in-one against a prebuilt model (used by tests + any single-thread
 * caller). Production splits Phase 1 (worker) from Phase 2 (main thread).
 * Returns the scored candidates + curve (no layer selection).
 */
export async function runMultilayerSweep(opts) {
  const candidates = runPhase1({
    model: opts.model, params: opts.params, sizeGridCount: opts.sizeGridCount,
  });
  return runPhase2Score({ ...opts, candidates });
}
