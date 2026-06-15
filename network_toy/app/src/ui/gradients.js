// Shared gradient colour functions.
//
// viewer-3d uses these to colour nodes; node-table uses the same
// definitions to colour swatches + the legend bar so the table truly
// reads as the legend for what's on screen. If a gradient changes
// here, both the viewer and the legend track automatically.
//
// Each gradient is a list of [t, [r,g,b]] stops. interp() maps
// t ∈ [0, 1] to a CSS rgb(...) string by linear interpolation.

export const T_STOPS = [
  [0.00, [97, 175, 239]],     // accent blue (cool)
  [0.50, [191, 188, 168]],    // muted middle
  [1.00, [242, 142, 43]],     // warm orange
];

// Viridis — perceptually-uniform sequential palette. With only two
// stops a slate→blue gradient compresses all variation into a narrow
// hue band; values clustered near the top of the range all looked
// like the same blue. Viridis sweeps a wide hue path (purple → blue
// → teal → green → yellow) so even similar values land on visibly
// distinct colours. Standard choice for sequential scientific data.
export const INDEG_STOPS = [
  [0.00, [ 68,   1,  84]],
  [0.25, [ 59,  82, 139]],
  [0.50, [ 33, 144, 141]],
  [0.75, [ 94, 201,  98]],
  [1.00, [253, 231,  37]],
];

export const BOUNDARY_STOPS = [
  [0.00, [58, 63, 74]],       // pure interior
  [0.50, [180, 130, 80]],
  [1.00, [230, 108, 117]],    // perfect mixing
];

// ARI / correlation palette. Bounded [0, 1] (negative ARI is rare and
// not meaningful for the dim-sweep use case; we clamp it). Diverging-
// ish: red for poor agreement, neutral for the 0.5 midpoint, green for
// strong agreement. Used by the dim-sweep panel's heatmap; reusable by
// any future cross-partition comparison.
export const ARI_STOPS = [
  [0.00, [180,  68,  74]],    // poor agreement — close to random
  [0.50, [200, 180, 120]],    // neutral
  [0.90, [120, 180, 100]],    // strong agreement (Hennig "stable" threshold lives here)
  [1.00, [ 60, 140,  80]],    // identical partition (modulo label permutation)
];

// 1–5 cluster-score palette (MLC §5 manual scores). Red (poor, 1) →
// neutral (3) → green (excellent, 5); same diverging family as ARI so
// "good" reads green across the app. scoreColour() takes the raw 1–5
// integer (not a normalised t) since that's what callers carry.
export const SCORE_STOPS = [
  [0.00, [180,  68,  74]],    // 1 — poor
  [0.50, [200, 180, 120]],    // 3 — neutral
  [1.00, [ 60, 140,  80]],    // 5 — excellent
];

export function tGradient(t)              { return interp(T_STOPS, t); }
export function inDegGradient(t)          { return interp(INDEG_STOPS, t); }
export function boundaryScoreGradient(t)  { return interp(BOUNDARY_STOPS, t); }
export function ariGradient(t)            { return interp(ARI_STOPS, t); }

// Map a 1–5 cluster score onto SCORE_STOPS. Values outside [1,5] clamp.
export function scoreColour(score)        { return interp(SCORE_STOPS, ((+score || 1) - 1) / 4); }

/**
 * Generic helper: get the rgb(...) string for a value on a named or
 * explicit palette. Convenience for chart code that doesn't want to
 * import every individual gradient function.
 */
export function heatmapCell(value, palette) {
  const stops = Array.isArray(palette) ? palette
              : palette === "ari"      ? ARI_STOPS
              : palette === "indeg"    ? INDEG_STOPS
              : palette === "boundary" ? BOUNDARY_STOPS
              : palette === "t"        ? T_STOPS
              : T_STOPS;
  return interp(stops, value);
}

function interp(stops, t) {
  const v = Math.max(0, Math.min(1, +t || 0));
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (v - t0) / Math.max(1e-9, t1 - t0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  const last = stops[stops.length - 1][1];
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`;
}

// Render a CSS linear-gradient string for a stops array; useful for
// the legend bar.
export function cssLinearGradient(stops) {
  return "linear-gradient(to right, " + stops.map(([t, [r, g, b]]) =>
    `rgb(${r}, ${g}, ${b}) ${(t * 100).toFixed(0)}%`
  ).join(", ") + ")";
}
