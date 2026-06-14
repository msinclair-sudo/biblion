// Grid sweep over every registered citation-layout algorithm × its
// modalSchema sweep values, ranking by alignment-correlation
// coefficient. Mirrors the cluster-eval sweep (eval/sweep.js) but
// crosses ALGORITHMS as well as params, since the user wants to
// compare different "citation arrangements" (FR vs MDS vs whatever
// else gets added) under the same metric.
//
// Output rows look like:
//   { method, algoLabel, params, correlation, numCitedEdges, error? }
// Sorted descending by correlation (NaN/error rows last).

import { listAlgorithms } from "../citation-layout/registry.js";
import { alignByComponent } from "../blend/align.js";

export function sweepLayouts({ n, edges, t, basePos, baseSeed, topN = 6 }) {
  const algos = listAlgorithms();
  const results = [];

  for (const algo of algos) {
    const axes = buildAxes(algo);
    const combos = cartesian(axes);
    for (const params of combos) {
      let correlation = NaN;
      let error = null;
      try {
        const positions = algo.compute({ n, edges, t, seed: baseSeed, params });
        const r = alignByComponent({ basePos, citationPos: positions, edges, n });
        correlation = r.correlation;
      } catch (e) {
        error = String(e.message || e);
      }
      results.push({
        method: algo.id,
        algoLabel: algo.label,
        params,
        correlation,
        error,
      });
    }
  }

  results.sort((a, b) => {
    const ac = Number.isFinite(a.correlation) ? a.correlation : -Infinity;
    const bc = Number.isFinite(b.correlation) ? b.correlation : -Infinity;
    return bc - ac;
  });
  return { top: results.slice(0, topN), totalCombos: results.length };
}

function buildAxes(algo) {
  const axes = [];
  const defaults = algo.defaultParams();
  for (const field of algo.modalSchema) {
    const values = (Array.isArray(field.sweepValues) && field.sweepValues.length > 0)
      ? field.sweepValues
      : [defaults[field.key]];
    axes.push({ key: field.key, values });
  }
  return axes;
}

function cartesian(axes) {
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
