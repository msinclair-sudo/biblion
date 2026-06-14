// Cross-algorithm parameter sweep.
//
// Enumerates configurations across (algorithms × per-algorithm
// modal-schema sweep grids), runs each one's clustering, and scores
// the result via a pluggable scorer (see eval/scorers.js). Returns a
// ranked list, top-N first.
//
// Async with progress + abort:
//   * onProgress(idx, total, label) fires after each config completes.
//   * abortSignal.aborted = true breaks out of the loop early; the
//     function resolves with whatever was scored so far.
//
// algo.infer calls run in clustering-worker.js via runInferRemote so
// the main thread stays responsive across long sweeps (A1 in §6.18).
// Configs are still iterated sequentially today; per-config parallelism
// is a future cheap win on top.

import { runInferRemote } from "./run-infer-remote.js";

export async function sweepAcrossAlgorithms({
  algorithms,        // array of clustering registry entries
  genResult,
  dimredResult,
  scorer,            // from eval/scorers.js
  topN = 5,
  resolutionOnly = true,    // when true, only sweep fields tagged `resolution: true`
                            // — pin everything else to the algorithm's defaults.
                            // Keeps the search space tractable for cross-algo runs.
  onProgress = null,
  abortSignal = null,
}) {
  // Enumerate (algoId, params) configs. Each algorithm's axes come
  // from its modalSchema; when resolutionOnly is set we sweep only
  // the resolution-tagged fields (and pin the rest to defaults).
  const configs = [];
  for (const algo of algorithms) {
    const defaults = algo.defaultParams ? algo.defaultParams() : {};
    const axes = (algo.modalSchema || []).map(field => {
      const isRes = !!field.resolution;
      const shouldSweep = resolutionOnly ? isRes : true;
      if (shouldSweep && Array.isArray(field.sweepValues) && field.sweepValues.length > 0) {
        return { key: field.key, values: field.sweepValues };
      }
      if (shouldSweep && field.kind === "select") {
        return { key: field.key, values: (field.options || []).map(o => o.value) };
      }
      // Pin to default (or undefined if no default).
      return { key: field.key, values: [defaults[field.key]] };
    });
    for (const params of cartesian(axes)) {
      configs.push({ algo, params });
    }
  }

  const total = configs.length;
  const results = [];

  for (let i = 0; i < total; i++) {
    if (abortSignal && abortSignal.aborted) break;
    const { algo, params } = configs[i];
    const label = `${algo.id} ${formatParams(params)}`;

    let scored = null;
    try {
      const cr = await runInferRemote(algo, genResult, params, dimredResult, { signal: abortSignal });
      const ctx = { abortSignal, onIterProgress: null };   // bootstrap parallelises internally
      const s  = scorer.isAsync
        ? await scorer.score(genResult, dimredResult, cr, algo, params, ctx)
        : scorer.score(genResult, dimredResult, cr, algo, params);
      scored = {
        algoId:      algo.id,
        algoLabel:   algo.label || algo.id,
        params,
        primary:     s.primary,
        secondary:   s.secondary,
        numClusters: s.numClusters,
        extra:       s.extra,
        // A3: cache the cr so per-row Apply can skip re-infer in the
        // engine cascade. Runtime-only — stripped before save.
        _cr:         cr,
      };
    } catch (e) {
      // AbortError is expected when the user cancels; let the outer
      // loop's abortSignal check pick it up naturally without logging
      // noise. The break exits the for loop immediately, so the
      // results.push below doesn't run with a null scored.
      if (e && e.name === "AbortError") break;
      console.error(`[sweep] config ${i+1}/${total} (${label}) threw:`, e);
      scored = {
        algoId:      algo.id,
        algoLabel:   algo.label || algo.id,
        params,
        primary:     -Infinity,
        secondary:   0,
        numClusters: 0,
        error:       String(e.message || e),
      };
    }
    results.push(scored);
    if (onProgress) onProgress(i + 1, total, label);
    // No explicit yield needed: `await runInferRemote(...)` above is a
    // real async boundary (worker spawn + postMessage round-trip) so
    // the main thread already gets repaint chances between configs.
  }

  results.sort((a, b) => {
    const ap = Number.isFinite(a.primary) ? a.primary : -Infinity;
    const bp = Number.isFinite(b.primary) ? b.primary : -Infinity;
    if (bp !== ap) return bp - ap;
    const as = +a.secondary || 0;
    const bs = +b.secondary || 0;
    return bs - as;
  });

  return {
    ranked:        results,
    top:           results.slice(0, topN),
    totalConfigs:  total,
    completed:     results.length,
  };
}

function cartesian(axes) {
  if (axes.length === 0) return [{}];
  const out = [];
  const acc = {};
  const recurse = (idx) => {
    if (idx === axes.length) { out.push({ ...acc }); return; }
    const ax = axes[idx];
    for (const v of ax.values) {
      acc[ax.key] = v;
      recurse(idx + 1);
    }
  };
  recurse(0);
  return out;
}

function formatParams(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${formatVal(v)}`)
    .join(" ");
}

function formatVal(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return String(v);
}

// ── Target-range sweep ──────────────────────────────────────────────
//
// Two-phase guided search for "the most stable settings that produce
// between `targetMin` and `targetMax` clusters". Much cheaper than
// the full cartesian sweep when the user knows what cluster count
// they're aiming for.
//
// Phase 1 — Broad probe.
//   Latin-hypercube sample `phase1Count` configs per algorithm across
//   resolution-tagged fields. Run each clustering, record its cluster
//   count. Keep configs whose count lands in [targetMin, targetMax].
//
// Phase 2 — Refine.
//   For each Phase-1 hit, generate neighbour configs by perturbing
//   each int/range resolution field by ±refineStep. Run those too.
//   This hones in on the right region without exhaustively searching
//   the param space.
//
// Scoring:
//   If `runBootstrap` is true, Phase-2 configs are bootstrap-Jaccard
//   scored (eval/bootstrap.js) and `primary` is set to mean Jaccard.
//   Otherwise, `primary` = inverse distance from the target midpoint
//   ((targetMin+targetMax)/2), so configs that hit the centre of the
//   target band rank highest.
//
// Result rows shape matches sweepAcrossAlgorithms so the Optimise tab
// can render them with the same code path.

import { sampleLatinHypercube } from "./lhs.js";
import { bootstrapStability   } from "./bootstrap.js";
import { bestMatchJaccard     } from "./jaccard.js";

export async function runTargetRangeSweep({
  algorithms,
  genResult,
  dimredResult,
  n,                          // explicit n so the sampler doesn't have to read genResult.nodes
  targetMin,
  targetMax,
  phase1Count   = 30,
  refineStep    = 3,
  refineFields  = null,       // null = use resolution-tagged fields
  runBootstrap  = false,
  // bootstrapOpts is passed through to bootstrapStability when
  // runBootstrap is on. Empty defaults so bootstrap.js's own defaults
  // (B=25, subsampleFrac=0.5, minMembers=3, noiseHandling="exclude")
  // flow through unless the caller overrides.
  bootstrapOpts = {},
  seed          = 42,
  onProgress    = null,       // (phase, idx, total, label) => void
  abortSignal   = null,
}) {
  if (!(targetMin >= 1) || !(targetMax >= targetMin)) {
    throw new Error(`runTargetRangeSweep: invalid target range [${targetMin}, ${targetMax}]`);
  }

  // ── Phase 1: LHS probe. ────────────────────────────────────────
  const phase1 = [];
  let phase1Total = phase1Count * algorithms.length;
  let phase1Idx = 0;

  for (const algo of algorithms) {
    const schema = algo.modalSchema || [];
    const resolutionKeys = schema.filter(f => f.resolution).map(f => f.key);
    const fieldsToSample = resolutionKeys.length > 0 ? resolutionKeys : schema.map(f => f.key);
    const samples = sampleLatinHypercube(algo, phase1Count, seed ^ hashStr(algo.id), { fields: fieldsToSample });

    for (const params of samples) {
      if (abortSignal && abortSignal.aborted) break;
      const label = `${algo.id} [phase 1] ${formatParams(params)}`;
      const entry = { algoId: algo.id, algoLabel: algo.label || algo.id, params, numClusters: 0, inRange: false };
      try {
        const cr = await runInferRemote(algo, genResult, params, dimredResult, { signal: abortSignal });
        entry.numClusters = cr.clusters.length;
        entry.inRange     = (entry.numClusters >= targetMin && entry.numClusters <= targetMax);
        // Cache the clusterResult so Phase 2 doesn't have to re-run
        // the same config when expanding neighbours that happen to
        // collide with a Phase-1 hit. A2 in §6.18 audit.
        entry._cr = cr;
      } catch (e) {
        if (e && e.name === "AbortError") break;
        entry.error = String(e.message || e);
      }
      phase1.push(entry);
      phase1Idx++;
      if (onProgress) onProgress("phase1", phase1Idx, phase1Total, label);
      // No explicit yield: `await runInferRemote(...)` above is a real
      // async boundary so the main thread already gets repaint chances.
    }
    if (abortSignal && abortSignal.aborted) break;
  }

  // Phase-1 hits = configs that produced cluster counts in the band.
  // B12 (§6.18.8): when nothing hit the band, fall back to the K
  // closest-to-band Phase-1 configs and refine those so the user
  // gets something to look at rather than an empty results table.
  // "Closest" = smallest distance from numClusters to [min, max]
  // (zero inside the band, positive outside). Skipping errored
  // entries (no numClusters available).
  const FALLBACK_K = 3;
  const inRangeHits = phase1.filter(e => e.inRange);
  let hits;
  let usedFallback = false;
  if (inRangeHits.length > 0) {
    hits = inRangeHits;
  } else {
    const scorable = phase1.filter(e => !e.error && Number.isFinite(e.numClusters));
    const distance = (e) => Math.max(0, targetMin - e.numClusters, e.numClusters - targetMax);
    scorable.sort((a, b) => distance(a) - distance(b));
    hits = scorable.slice(0, FALLBACK_K);
    usedFallback = hits.length > 0;
  }

  // Cache every Phase-1 cr keyed by (algoId, stableStringify(params))
  // so Phase 2's neighbour expansion can skip re-inferring base
  // configs that already ran. expandNeighbours always includes the
  // base config in its output, so without this cache every hit was
  // re-inferred. A2 in §6.18 audit.
  const phase1CrByKey = new Map();
  for (const e of phase1) {
    if (e._cr) {
      phase1CrByKey.set(`${e.algoId}|${stableStringify(e.params)}`, e._cr);
    }
  }

  // ── Phase 2: refine neighbourhoods. ────────────────────────────
  // For each hit, perturb its int/range resolution fields by ±refineStep
  // and collect the resulting configs. Dedupe by stringified params so
  // overlapping neighbourhoods don't waste work.
  const phase2Configs = [];
  const seenKeys = new Set();
  for (const hit of hits) {
    const algo = algorithms.find(a => a.id === hit.algoId);
    if (!algo) continue;
    const schema   = algo.modalSchema || [];
    const resKeys  = refineFields != null
      ? new Set(refineFields)
      : new Set(schema.filter(f => f.resolution).map(f => f.key));
    const neighbours = expandNeighbours(hit.params, schema, resKeys, refineStep);
    for (const p of neighbours) {
      const k = `${algo.id}|${stableStringify(p)}`;
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      phase2Configs.push({ algo, params: p, cacheKey: k });
    }
  }

  const phase2 = [];
  let phase2CacheHits = 0;
  for (let i = 0; i < phase2Configs.length; i++) {
    if (abortSignal && abortSignal.aborted) break;
    const { algo, params, cacheKey } = phase2Configs[i];
    const label = `${algo.id} [phase 2] ${formatParams(params)}`;
    const entry = {
      algoId:      algo.id,
      algoLabel:   algo.label || algo.id,
      params,
      numClusters: 0,
      primary:     -Infinity,
      secondary:   0,
      extra:       {},
    };
    let didAwait = false;
    try {
      // A2: reuse the Phase-1 cr when its (algo, params) match this
      // Phase-2 candidate — base configs always do, plus the occasional
      // ±step neighbour that happened to coincide with a different
      // Phase-1 sample.
      const cachedCr = phase1CrByKey.get(cacheKey);
      let cr;
      if (cachedCr) {
        cr = cachedCr;
        phase2CacheHits++;
      } else {
        cr = await runInferRemote(algo, genResult, params, dimredResult, { signal: abortSignal });
        didAwait = true;
      }
      // Cache this cr too, so downstream (per-row Apply / future
      // re-runs in the same sweep) can pick it up.
      entry._cr = cr;
      entry.numClusters = cr.clusters.length;
      entry.inRange     = (entry.numClusters >= targetMin && entry.numClusters <= targetMax);
      if (runBootstrap) {
        // Bootstrap-Jaccard against the same algo + params on
        // subsamples. primary = aggregate.meanJaccard_macro (size-
        // weighted) — same metric the stability scorer uses.
        //
        // B10 (§6.18.8): seed is derived from (seed, algoId, params)
        // not the Phase-2 array index, so identical configs across
        // runs (or under cache-driven reordering) get identical
        // subsample sequences. Without this fix, the same (algo,
        // params) could score differently depending on what order
        // Phase 2 happened to walk the candidates in.
        const boot = await bootstrapStability({
          algo, params,
          refClusterResult: cr,        // bootstrapStability's param name
          genResult, dimredResult,
          // Spread caller's bootstrapOpts (B, subsampleFrac,
          // noiseHandling, minMembers) so bootstrap.js's per-arg
          // defaults flow through when the caller omits.
          ...bootstrapOpts,
          seed:          configSeed(seed, algo.id, params),
          abortSignal,
        });
        didAwait = true;
        const meanJ = boot.aggregate ? boot.aggregate.meanJaccard : NaN;
        entry.primary   = Number.isFinite(meanJ) ? meanJ : 0;
        entry.secondary = entry.numClusters;
        entry.extra     = {
          meanJaccard:   meanJ,
          fractionStable: boot.aggregate ? boot.aggregate.fractionStable : NaN,
          perCluster:    boot.perCluster || [],
          bootstrapsRun: boot.bootstrapsRun || 0,
        };
      } else {
        // No bootstrap: primary = proximity to target-band midpoint
        // (1 / (1 + distance)), normalised so 1.0 is the midpoint
        // exactly and falls off as we move away. Configs that
        // overshoot the band end up with low primary.
        const mid = (targetMin + targetMax) / 2;
        const dist = Math.abs(entry.numClusters - mid);
        entry.primary   = 1 / (1 + dist);
        entry.secondary = entry.numClusters;
      }
    } catch (e) {
      if (e && e.name === "AbortError") break;
      entry.error = String(e.message || e);
    }
    phase2.push(entry);
    if (onProgress) onProgress("phase2", i + 1, phase2Configs.length, label);
    // Only yield when the iter did no real awaiting — happens on the
    // cache-hit + no-bootstrap path, which is otherwise a tight loop
    // through pure JS that would block repaints. When we did await
    // (worker infer or bootstrap), the event loop already got its turn.
    if (!didAwait) await yieldTick();
  }

  // Rank Phase-2 results: in-range configs first (descending primary),
  // out-of-range second (by proximity to band). Out-of-range can happen
  // when ± refineStep walks a Phase-1 hit just outside the target band.
  const ranked = phase2.slice().sort((a, b) => {
    if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
    const ap = Number.isFinite(a.primary) ? a.primary : -Infinity;
    const bp = Number.isFinite(b.primary) ? b.primary : -Infinity;
    if (bp !== ap) return bp - ap;
    return (b.secondary || 0) - (a.secondary || 0);
  });

  return {
    phase1, phase2, ranked,
    // hitCount is the count of *in-band* Phase-1 hits seeded into
    // Phase 2 — stays 0 when the fallback fires (no real hits found),
    // even though Phase 2 ran. usedFallback distinguishes the cases.
    hitCount:        inRangeHits.length,
    usedFallback,    // true when Phase 2 ran on the K closest-to-band Phase-1 configs (B12)
    totalConfigs:    phase1.length + phase2.length,
    completed:       phase1.length + phase2.length,
    phase2CacheHits, // how many Phase-2 candidates were served from Phase-1's cache
    settings:        { targetMin, targetMax, phase1Count, refineStep, runBootstrap, seed },
  };
}

// Expand neighbours of `params` by perturbing each int/range field
// in `resKeys` by ±step (step away from the base value, clamped to
// the field's [min, max]). The base config itself is always included.
function expandNeighbours(params, schema, resKeys, step) {
  if (step <= 0) return [{ ...params }];
  const fields = schema.filter(f => resKeys.has(f.key));
  // Per-field neighbour values.
  const perField = fields.map(f => {
    if (f.kind === "int" || f.kind === "range") {
      const base = Number(params[f.key]);
      const isInt = f.kind === "int";
      const min = +f.min, max = +f.max;
      const stepSize = isInt ? 1 : Math.max(0.001, +f.step || 0.05);
      const vals = new Set([base]);
      for (let d = 1; d <= step; d++) {
        const lo = base - d * stepSize;
        const hi = base + d * stepSize;
        if (lo >= min) vals.add(isInt ? Math.round(lo) : +lo.toFixed(4));
        if (hi <= max) vals.add(isInt ? Math.round(hi) : +hi.toFixed(4));
      }
      return { key: f.key, values: [...vals] };
    }
    if (f.kind === "select") {
      // For select fields, neighbourhood = all options (small set).
      return { key: f.key, values: (f.options || []).map(o => o.value) };
    }
    return { key: f.key, values: [params[f.key]] };
  });
  return cartesian(perField).map(combo => ({ ...params, ...combo }));
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return h >>> 0;
}

// Deterministic seed derived from (sweep seed, algoId, stable params).
// Identical (algoId, params) gives the identical bootstrap subsample
// sequence regardless of Phase-2 iteration order. Used by §6.18.8 B10.
function configSeed(baseSeed, algoId, params) {
  return ((baseSeed >>> 0) ^ hashStr(`${algoId}|${stableStringify(params)}`)) >>> 0;
}

function stableStringify(obj) {
  // Sort keys so {a:1, b:2} and {b:2, a:1} produce the same string.
  const keys = Object.keys(obj).sort();
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return JSON.stringify(out);
}

function yieldTick() {
  // Macro-task yield. Same shape as bootstrap.js's inner loop yield.
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ── Legacy wrapper ──────────────────────────────────────────────────
// Pre-existing main.js (legacy shell) calls sweepAlgorithm with a
// synchronous ARI signature. Keep it working.
import { adjustedRandIndex } from "./ari.js";

export function sweepAlgorithm(algo, genResult, dimredResult, groundTruth, pendingParams, topN = 5) {
  // Some legacy call sites pass groundTruth in slot 3 (no dimredResult).
  // Detect and shuffle.
  let g = genResult, dr = dimredResult, gt = groundTruth, pp = pendingParams, n = topN;
  if (groundTruth instanceof Int32Array && !(dimredResult && dimredResult.data instanceof Float32Array)) {
    // Old 4-arg signature: (algo, genResult, groundTruth, params, topN)
    g  = genResult;
    dr = undefined;
    gt = dimredResult;   // was 'groundTruth' in old slot
    pp = groundTruth;    // was 'pendingParams' in old slot
    n  = pendingParams !== undefined ? pendingParams : 5;
  }
  const axes = (algo.modalSchema || []).map(field => {
    if (Array.isArray(field.sweepValues) && field.sweepValues.length > 0) {
      return { key: field.key, values: field.sweepValues };
    }
    if (field.kind === "select") {
      return { key: field.key, values: (field.options || []).map(o => o.value) };
    }
    return { key: field.key, values: [pp ? pp[field.key] : undefined] };
  });
  const combos = cartesian(axes);
  const results = [];
  for (const params of combos) {
    let r;
    try { r = algo.infer(g, params, dr); }
    catch (e) {
      results.push({ params, ari: NaN, numClusters: 0, error: String(e.message || e) });
      continue;
    }
    const ari = adjustedRandIndex(r.nodeCluster, gt);
    results.push({ params, ari, numClusters: r.clusters.length });
  }
  results.sort((a, b) => {
    const ap = Number.isFinite(a.ari) ? a.ari : -Infinity;
    const bp = Number.isFinite(b.ari) ? b.ari : -Infinity;
    return bp - ap;
  });
  return { top: results.slice(0, n), totalCombos: combos.length };
}
