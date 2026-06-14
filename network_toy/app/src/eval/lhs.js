// Latin-hypercube sampler for algorithm modal schemas.
//
// Given a registry algorithm (with its modalSchema) and a sample
// count N, produces N parameter sets that uniformly cover the
// per-field range. Each numeric field is divided into N equal-
// probability bins; one value is drawn from each bin, then the
// per-field sequences are independently shuffled so the joint
// distribution is space-filling (no two samples share a bin on any
// axis).
//
// Used by the target-range sweep (eval/sweep.js's runTargetRangeSweep):
// Phase 1 samples a coarse set of configs; Phase 2 refines around
// hits in the cluster-count target band.
//
// Per-field scale:
//   field.scale === "log"  → log-uniform within [min, max]. Requires
//                             min > 0; if min is 0 we silently fall
//                             through to linear (log undefined at 0).
//   anything else / absent → linear-uniform within [min, max].
//
// kind handling:
//   "int"    → round each sampled value, clamp to [min, max], dedupe
//              within the field's bins (if N > distinct values
//              available, late bins repeat — LHS guarantee weakens
//              gracefully).
//   "range"  → keep as float; format may round for display.
//   "select" → cycle through field.options.value in shuffled order
//              (N samples may repeat options if N > option count).
//
// Determinism: caller passes a seed; the sampler threads it through
// mulberry32 so the same (algorithm, count, seed) always produces the
// same samples.

import { mulberry32 } from "../rng.js";

/**
 * Sample `count` parameter sets covering the algorithm's modalSchema.
 *
 * @param {object} algorithm  Registry entry with modalSchema + defaultParams.
 * @param {number} count      How many parameter sets to draw.
 * @param {number} seed       RNG seed (passes through mulberry32).
 * @param {object} [opts]
 * @param {string[]} [opts.fields]  Restrict sampling to these field keys; others
 *                                  pin to the algorithm's defaults. Useful for
 *                                  resolution-only sampling.
 * @returns {Array<object>}   Array of `count` parameter objects, ready to feed
 *                            into algo.infer(...).
 */
export function sampleLatinHypercube(algorithm, count, seed, opts = {}) {
  if (count <= 0) return [];
  const rng = mulberry32(seed >>> 0);
  const defaults = algorithm.defaultParams ? algorithm.defaultParams() : {};
  const schema = algorithm.modalSchema || [];

  // Per-field bin sequences. Each field produces an array of `count`
  // sampled values, then we shuffle each so the joint distribution
  // is space-filling. (Without the shuffle, all samples would land
  // on the diagonal of the unit hypercube.)
  const fieldSamples = {};
  const restrict = opts.fields ? new Set(opts.fields) : null;

  for (const field of schema) {
    if (restrict && !restrict.has(field.key)) {
      // Pin to default — broadcast a single value across all samples.
      fieldSamples[field.key] = new Array(count).fill(defaults[field.key]);
      continue;
    }
    fieldSamples[field.key] = sampleField(field, count, rng);
  }

  // Assemble per-sample parameter objects. Start from defaults so
  // any unsampled / unschematised fields keep their default values.
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const params = { ...defaults };
    for (const key of Object.keys(fieldSamples)) {
      params[key] = fieldSamples[key][i];
    }
    out[i] = params;
  }
  return out;
}

// Sample `count` values for one field, applying the field's scale +
// kind rules. Returned array is already shuffled (Fisher-Yates) so
// independent fields together form an LHS.
function sampleField(field, count, rng) {
  if (field.kind === "select") {
    const opts = (field.options || []).map(o => o.value);
    if (opts.length === 0) return new Array(count).fill(undefined);
    // Sample with stratification: cycle through opts so each appears
    // roughly count/opts.length times. Then shuffle.
    const samples = new Array(count);
    for (let i = 0; i < count; i++) samples[i] = opts[i % opts.length];
    return shuffle(samples, rng);
  }

  const min = +field.min;
  const max = +field.max;
  const isInt = field.kind === "int";
  // Log-scale needs strictly positive min. Fall through to linear
  // silently if the field's min is 0 — happens for selectionEpsilon
  // and min_dist where 0 is a meaningful value the user picks.
  const useLog = field.scale === "log" && min > 0 && max > 0;

  // Stratified sample: divide [0, 1) into `count` equal bins, draw
  // one fractional offset per bin, then map through linear or log
  // interpolation onto [min, max].
  const samples = new Array(count);
  for (let i = 0; i < count; i++) {
    const u = (i + rng()) / count;   // ∈ [i/count, (i+1)/count)
    let v;
    if (useLog) {
      const lmin = Math.log(min);
      const lmax = Math.log(max);
      v = Math.exp(lmin + u * (lmax - lmin));
    } else {
      v = min + u * (max - min);
    }
    if (isInt) {
      v = Math.round(v);
      if (v < min) v = min;
      else if (v > max) v = max;
    }
    samples[i] = v;
  }
  return shuffle(samples, rng);
}

// In-place Fisher-Yates shuffle keyed off the supplied RNG.
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
