// Panel: method receipt — auto-generated defensibility paragraph.
//
// The §6.18 endpoint was being able to point at the Optimise output
// and say "this is the best config of those I considered, under
// metric M, with stability quantified by bootstrap protocol P, on
// data D; here are the assumptions M and P make and how they
// might fail." This panel literally renders that paragraph,
// assembled from the live state — clustering algo + params, the
// active scorer + bootstrap settings (from the latest sweep when
// present, otherwise defaults), the Bayes-optimal ARI ceiling for
// the data (when computed).
//
// Read-only. Re-renders on every state change so the receipt stays
// in sync with whatever the user has actually applied. A copy-to-
// clipboard button makes it easy to drop straight into a paper or
// supervisor email.

import { getState, subscribe }    from "../state.js";
import { getSelectedStep, getStepAncestors, getStep, listSteps } from "../workflow.js";
import { getAlgorithm as getClusteringAlgo } from "../../clustering-registry.js";
import {
  SCORE_VERSION, DEFAULT_MIN_MEMBERS, HENNIG_STABLE, HENNIG_DOUBTFUL,
}                                  from "../../eval/bootstrap.js";

// Clustering output cards — a plain tree-cut clustering and a
// sweep-selected multi-layer ladder both stand in as "the clustering"
// for the receipt. Mirrors CLUSTERING_LIKE_TYPES in layer-descriptors.js.
// The PICKER card materialises clusterLevels (the producer sweep only scores
// candidates), so it's the clustering-equivalent the receipt describes.
const CLUSTERING_LIKE_TYPES = ["clustering", "multiLevelPicker"];

export const ID          = "method-receipt";
export const LABEL       = "Method receipt";
export const DESCRIPTION = "Auto-generated defensibility paragraph describing the active clustering's methodology (algorithm, params, bootstrap protocol, data fixture, scoring). Updates as state changes.";
export const SINGLETON   = true;

export function mount(container, _state, _config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-method-receipt";
  container.appendChild(wrap);

  function render() {
    wrap.innerHTML = "";
    const s = getState();

    const head = document.createElement("div");
    head.className = "panel-mr-header";
    const title = document.createElement("div");
    title.className = "panel-mr-title";
    title.textContent = "Method receipt";
    head.appendChild(title);
    const sub = document.createElement("div");
    sub.className = "panel-mr-sub";
    sub.textContent = "Reads from the currently-applied state. Copy-paste-ready.";
    head.appendChild(sub);
    wrap.appendChild(head);

    const text = buildReceipt(s);
    const block = document.createElement("pre");
    block.className = "panel-mr-text";
    block.textContent = text;
    wrap.appendChild(block);

    const actions = document.createElement("div");
    actions.className = "panel-mr-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "panel-mr-copy";
    copyBtn.textContent = "Copy to clipboard";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text)
        .then(() => {
          copyBtn.textContent = "Copied ✓";
          setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 1500);
        })
        .catch(err => {
          console.error("[method-receipt] clipboard write failed:", err);
          copyBtn.textContent = "Copy failed";
          setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 1500);
        });
    });
    actions.appendChild(copyBtn);
    wrap.appendChild(actions);
  }

  render();
  const unsub = subscribe(() => render());
  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}

// Build the defensibility paragraph from current state. Returns
// plain text (newlines preserved). Designed to be honest about
// unknowns — when a field isn't available (no sweep run yet, toy
// data without ARI ceiling, etc.), the paragraph says so explicitly
// rather than filling in a misleading default.
function buildReceipt(state) {
  const lines = [];

  // ── Clustering: describe the SELECTED card, not the global config. ──
  // The workflow tree is the primary surface; a card's params/result are
  // selection-driven, whereas state.layerParams.clustering is the global
  // singleton that lags behind whatever card is actually being viewed.
  // Walk the selection's ancestry to the nearest clustering-like card so
  // analysis cards (bridge/scoring/labelling) report their upstream
  // clustering rather than "none".
  const clustStep = findClusteringCard();
  const lvls = state.clusterLevels || [];
  if (clustStep && lvls.length > 0) {
    if (clustStep.type === "multiLevelPicker") {
      describeMultiLevel(lines, clustStep, lvls);
    } else {
      describeClustering(lines, clustStep, lvls);
    }
  } else {
    lines.push("Clustering: none applied yet.");
  }
  lines.push("");

  // ── Data fixture. ──
  const ds = state.dataSource;
  if (ds) {
    const mode = ds.mode || "?";
    const conf = (ds.configs && ds.configs[mode]) || {};
    if (mode === "toy") {
      const gen = state.genResult;
      const n = gen ? gen.nodes.length : "?";
      const origins = conf.origins != null ? conf.origins : "?";
      const seed    = conf.seed    != null ? conf.seed    : "?";
      const spread  = conf.spread  != null ? conf.spread  : "?";
      lines.push(`Data: toy Gaussian-mixture, n=${n}, ${origins} origins, spread=${spread}, seed=${seed}.`);
    } else if (mode === "real") {
      const subset = conf.subset || "(unknown subset)";
      const gen = state.genResult;
      const n = gen ? gen.nodes.length : "?";
      lines.push(`Data: real (${subset}), n=${n}.`);
    } else {
      lines.push(`Data: ${mode}, n=${state.genResult ? state.genResult.nodes.length : "?"}.`);
    }
  }
  lines.push("");

  // ── Dim-reduction pipeline. ──
  const dimred = state.layerParams && state.layerParams.dimred;
  if (dimred) {
    const slots = ["noise", "fusion", "compression", "viz", "viz2d"];
    const activeSlots = slots.filter(s => dimred[s] && dimred[s].method && dimred[s].method !== "identity");
    if (activeSlots.length > 0) {
      lines.push("Dim-reduction:");
      for (const slot of activeSlots) {
        const cfg = dimred[slot];
        const params = cfg.params ? Object.entries(cfg.params)
          .filter(([k]) => k !== "adjacency")    // huge; skip for readability
          .map(([k, v]) => `${k}=${formatParamVal(v)}`)
          .join(", ") : "(defaults)";
        lines.push(`  ${slot}: ${cfg.method}${params ? " — " + params : ""}`);
      }
    } else {
      lines.push("Dim-reduction: all slots at identity (no transformation).");
    }
  }
  lines.push("");

  // ── Bootstrap protocol. Prefer the SELECTED multi-layer card's own
  // settings (its ladder was sweep-selected against these), then the
  // latest Optimise sweep settings, then defaults. ──
  const opt = state.evalResults && state.evalResults.optimise;
  const sweepSettings = opt && opt.settings ? opt.settings : null;
  // The picker card's sweep settings live on its producer parent.
  const producerCard = clustStep && clustStep.type === "multiLevelPicker" && clustStep.parentId
    ? getStep(clustStep.parentId) : null;
  const cardSettings  = producerCard && producerCard.result
    ? producerCard.result.settings : null;
  const B = cardSettings   && cardSettings.B   != null ? cardSettings.B
          : sweepSettings  && sweepSettings.B  != null ? sweepSettings.B
          : 10;
  const subFrac     = 0.5;   // hard default; not surfaced in settings yet
  const noiseHandl  = sweepSettings && sweepSettings.noiseHandling || "exclude";
  const minMembers  = DEFAULT_MIN_MEMBERS;
  lines.push(`Bootstrap protocol (SCORE_VERSION ${SCORE_VERSION}):`);
  lines.push(`  Subsampling without replacement, fraction=${subFrac}, B=${B} iterations.`);
  lines.push(`  Bipartite-matched Jaccard scoring (no greedy double-counting).`);
  lines.push(`  Reference clusters with < ${minMembers} in-subsample members excluded per iter.`);
  lines.push(`  Noise handling: "${noiseHandl}"${noiseHandlingExplanation(noiseHandl)}.`);
  lines.push(`  Hennig thresholds: stable ≥ ${HENNIG_STABLE}, doubtful ${HENNIG_DOUBTFUL}–${HENNIG_STABLE}, unstable < ${HENNIG_DOUBTFUL} (used for colour breakdown only — primary metrics are macro / unweighted mean Jaccard).`);
  lines.push("");

  // ── Latest sweep (if any). ──
  if (opt && opt.ranked && opt.ranked.length > 0) {
    const scorerLabel = opt.scorerLabel || opt.scorerId || "(unknown scorer)";
    const top = opt.ranked[0];
    const finiteVals = opt.ranked.map(r => r.primary).filter(v => Number.isFinite(v));
    let distSummary = "";
    if (finiteVals.length >= 2) {
      const sorted = finiteVals.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const mean = finiteVals.reduce((s, v) => s + v, 0) / finiteVals.length;
      const sd = Math.sqrt(finiteVals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / finiteVals.length);
      distSummary = ` (others spanned [${sorted[0].toFixed(3)}, ${sorted[sorted.length - 1].toFixed(3)}], median ${median.toFixed(3)}, sd ${sd.toFixed(3)})`;
    }
    lines.push(`Latest sweep: ranked best of ${opt.totalConfigs} considered by "${scorerLabel}".`);
    lines.push(`  Top row: ${top.algoLabel || top.algoId}, primary=${formatScalar(top.primary)}, ${top.numClusters} clusters${distSummary}.`);
    lines.push("");
  } else {
    lines.push("Latest sweep: none in this session.");
    lines.push("");
  }

  // ── Bayes-optimal ARI ceiling (toy only). ──
  const gen = state.genResult;
  if (gen && Number.isFinite(gen.bayesOptimalAri)) {
    lines.push(`Bayes-optimal ARI ceiling for this mixture: ${gen.bayesOptimalAri.toFixed(3)}.`);
    lines.push(`  (Achieved ARI should be read as a fraction of optimal, not as an absolute.)`);
  }

  // ── Closing pointer. ──
  lines.push("");
  lines.push("References: doc/eval.md (full Optimise spec), doc/plan.md §6.18 (hardening pass audit).");

  return lines.join("\n");
}

// Find the clustering output card the receipt should describe:
//   1. the selected card if it is itself clustering-like;
//   2. otherwise the nearest clustering-like ancestor (so an analysis
//      card like bridge/scoring/labelling reports its upstream clustering);
//   3. otherwise (nothing selected, or a selection off the clustering
//      branch) the most-recently-completed clustering-like card anywhere
//      in the tree — so the receipt still describes the applied
//      clustering rather than "none".
// Returns null only when no clustering-like card exists at all.
function findClusteringCard() {
  const sel = getSelectedStep();
  if (sel) {
    if (CLUSTERING_LIKE_TYPES.includes(sel.type)) return sel;
    const ancestors = getStepAncestors(sel.id);   // root → sel
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (CLUSTERING_LIKE_TYPES.includes(ancestors[i].type)) return ancestors[i];
    }
  }
  // Fallback 1: latest clustering-like card with a result. listSteps is
  // BFS order; the last match is the deepest/most-recent on the tree.
  const candidates = CLUSTERING_LIKE_TYPES
    .flatMap(t => listSteps({ type: t }))
    .filter(s => s.result);
  if (candidates.length) return candidates[candidates.length - 1];

  // Fallback 2: no workflow tree in scope (e.g. a freshly-reset test
  // page, or a project that hasn't migrated). Synthesise a card from the
  // global layerParams.clustering so the receipt still describes the
  // applied clustering. Shape matches a plain clustering card's params.
  const cfg = getState().layerParams && getState().layerParams.clustering;
  if (cfg && cfg.method) return { type: "clustering", params: cfg, result: null };
  return null;
}

// Plain (tree-cut) clustering card: params carry { method, levels }, one
// config entry per level. Describe each level's algorithm params verbatim.
function describeClustering(lines, step, lvls) {
  const cfg = step.params || {};
  const algoId = cfg.method;
  let algoLabel = algoId;
  try {
    const a = getClusteringAlgo(algoId);
    algoLabel = a && a.label ? a.label : algoId;
  } catch (_) { /* registry might not know it; use id */ }
  const finest = lvls[lvls.length - 1].clusterResult;
  const nClusters = finest ? finest.clusters.length : "?";
  lines.push(`Clustering: ${algoLabel} (${algoId}), ${lvls.length} level${lvls.length > 1 ? "s" : ""}, ${nClusters} clusters at the finest level.`);

  const cfgLevels = Array.isArray(cfg.levels) ? cfg.levels : [];
  cfgLevels.forEach((lvl, i) => {
    const params = lvl.params ? Object.entries(lvl.params)
      .map(([k, v]) => `${k}=${formatParamVal(v)}`)
      .join(", ") : "(defaults)";
    const scopeTag = i === 0 ? "global" : (lvl.scope || "within-parent");
    lines.push(`  L${i} [${scopeTag}]: ${params}`);
  });
}

// Multi-layer (§9, producer/picker split) card: the ladder is NOT a set of
// per-level configs — it is one HDBSCAN model (shared minSamples, leaf) whose
// candidate partitions are bootstrap-scored; the USER then picks granularities
// off the reproducibility curve as the layers. `step` is the PICKER card; its
// producer parent carries the sweep settings (minSamples / floor). Describe
// the selection contract, which is stable; deliberately avoid asserting the
// internal shelf/absorb mechanism here.
function describeMultiLevel(lines, step, lvls) {
  const p = step.params || {};                       // { pickedCounts }
  // Settings live on the producer (the picker's parent), not the picker.
  const producer = step.parentId ? getStep(step.parentId) : null;
  const set = (producer && producer.result && producer.result.settings) || {};
  const minSamples = set.minSamples;
  const floor      = set.floor;
  const finest = lvls[lvls.length - 1].clusterResult;
  const nClusters = finest ? finest.clusters.length : "?";
  const picked = Array.isArray(p.pickedCounts) ? p.pickedCounts.slice().sort((a, b) => a - b) : null;

  lines.push(`Clustering: HDBSCAN multi-layer ladder, ${lvls.length} user-picked level${lvls.length > 1 ? "s" : ""}, ${nClusters} clusters at the finest level.`);
  lines.push(`  One HDBSCAN model (leaf selection, minSamples=${minSamples != null ? minSamples : "?"}); the layers are partitions of that model at the granularities you picked, not independent per-level fits.`);
  lines.push(`  Selection: candidate partitions bootstrap-scored (reproducibility vs. cluster count); you chose the layers off the curve${picked ? ` (counts ${picked.join(", ")})` : ""}. Guide floor=${floor != null ? floor : "?"}.`);
}

function noiseHandlingExplanation(mode) {
  if (mode === "exclude")   return " (drop -1 noise points from both reference and bootstrap before matching)";
  if (mode === "asCluster") return " (remap -1 to a synthetic NOISE_ID; noise-vs-noise contributes to matching)";
  if (mode === "penalise")  return " (drop -1 from matching; multiply aggregates by 1 - noise fraction)";
  return "";
}

function formatScalar(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(2);
  return v.toFixed(3);
}

function formatParamVal(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}
