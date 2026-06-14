// Toy data source — wraps the existing Gaussian-mixture generator.
//
// Produces a DataSourceResult whose nodes carry per-node basePos and
// originId (the generator's mixture-component label). No embedding —
// at toy scale basePos is 3-d already, so Layer 1.5's identity stage
// uses it directly. The viz sub-stage stays at identity (skip)
// because basePos is already in viz space.
//
// The data panel uses UI-friendly param names (`origins`, `spread`)
// while generation.js takes generator-internal names
// (`pointsOfOrigin`, `spreadScale`). This wrapper translates so the
// state shape matches what the panel writes.

import { generate } from "../generation.js";
import { computeBayesOptimalAri } from "../eval/bayes-ari.js";

export const defaultToyParams = () => ({
  seed:      42,
  nodeCount: 400,
  origins:   6,
  spread:    1.0,
  density:   0.3,
  intraRate: 0.5,
  crossRate: 0.2,
});

export function produceToy(params = {}) {
  const merged = { ...defaultToyParams(), ...params };
  const gen    = generate({
    seed:           merged.seed,
    nodeCount:      merged.nodeCount,
    pointsOfOrigin: merged.origins,
    spreadScale:    merged.spread,
  });

  // §6.18.10 B5 — compute the Bayes-optimal ARI ceiling for the
  // generated mixture. Because the mixture components overlap at
  // any reasonable spread, even an optimal classifier scores < 1.0
  // against originId. Surfacing the ceiling alongside the achieved
  // ARI lets users read "0.85 / 0.92 = 92% of optimal" rather than
  // "0.85 — looks low". One-shot ~ms cost at toy n=400.
  const bayesOptimalAri = computeBayesOptimalAri(gen.nodes, gen.origins);

  // generate() already returns nodes with id, originId, t, basePos +
  // origins; just relabel/forward into the data-source contract shape.
  return {
    method:  "toy",
    params:  merged,
    nodes:   gen.nodes,
    origins: gen.origins,
    bayesOptimalAri,
  };
}
