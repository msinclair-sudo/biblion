// Per-frame layout blend.
//
// The α=0 endpoint is basePos (the generation-seed Gaussian-mixture
// cloud). The α=1 endpoint is alignedCitationPos (the FR layout,
// per-component-aligned to basePos by ./align.js). Each frame the
// live position of every data node is the linear interpolation:
//
//   live_i = (1 − α) · basePos_i  +  α · alignedCitationPos_i
//
// No state, no constraint solver, no momentum. Slider drives the
// blend directly; the network is a deterministic function of α.
//
// Registered as a d3-force-3d "force" hook so it runs every tick of
// the lib's animation loop. With d3VelocityDecay = 1.0 (set by
// main.js) the lib's integration `x += vx; vx *= 0` becomes a no-op,
// so this hook owns position entirely.

export function makeBlendForce({
  getBasePos,
  getBasePosPreFusion,        // optional — fusion-comparison endpoint A
  getAlignedCitationPos,
  getBlend,
  getFusionBlend,             // optional — defaults to 1 (= use post-fusion basePos)
} = {}) {
  let nodes = [];
  function force(_simAlpha) {
    const n = nodes.length;
    if (n === 0) return;
    const bp = getBasePos();
    if (!bp) return;                   // no basePos = nothing to render
    // alignedCitationPos may be null when the user hasn't applied a
    // citation layout yet (per §6.16 the cascade stops at Layer 3 and
    // citation layout is opt-in). We still want the inner pre/post-
    // fusion blend to be drivable in that state — the fusion slider
    // is meaningful on its own. Effective outer α is forced to 0
    // when cp is missing, and we skip the cp term in the final write.
    const cp = getAlignedCitationPos();
    const stride = bp.length / 3;
    let a = cp ? (+getBlend() || 0) : 0;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    const oneMinusA = 1 - a;

    // Fusion-comparison nested lerp: if a pre-fusion basePos is
    // available AND the fusion-slider isn't pinned at 1 (=post-fusion
    // only), compute an effective basePos as the lerp between pre and
    // post. The outer (basePos ↔ citation) blend then runs against
    // this effective position. Two independent sliders, four-corner
    // navigation: (preFusion semantic) / (postFusion semantic) /
    // (citation aligned to preFusion) / (citation aligned to postFusion).
    const bpPre = getBasePosPreFusion ? getBasePosPreFusion() : null;
    let fb = getFusionBlend ? (+getFusionBlend() || 0) : 1;
    if (fb < 0) fb = 0; else if (fb > 1) fb = 1;
    const useFusionBlend = bpPre && bpPre.length === bp.length && fb < 0.999;
    const oneMinusFb = 1 - fb;

    for (let i = 0; i < n; i++) {
      const ni = nodes[i];
      // Skip debug-only nodes (origins, centroids); they're pinned via
      // fx/fy/fz by the lib, and they're not in the basePos table
      // anyway (basePos is sized to data nodes only).
      if (ni.kind && ni.kind !== "node") continue;
      const id = ni.id;
      if (id < 0 || id >= stride) continue;
      const ix = id * 3, iy = ix + 1, iz = ix + 2;
      // Effective basePos for this node, possibly lerped against
      // the pre-fusion position.
      let bx, by, bz;
      if (useFusionBlend) {
        bx = oneMinusFb * bpPre[ix] + fb * bp[ix];
        by = oneMinusFb * bpPre[iy] + fb * bp[iy];
        bz = oneMinusFb * bpPre[iz] + fb * bp[iz];
      } else {
        bx = bp[ix]; by = bp[iy]; bz = bp[iz];
      }
      if (cp) {
        ni.x = oneMinusA * bx + a * cp[ix];
        ni.y = oneMinusA * by + a * cp[iy];
        ni.z = oneMinusA * bz + a * cp[iz];
      } else {
        // No citation layout → effective basePos (post-fusion-blend)
        // IS the final position. Slider still drives bx/by/bz via the
        // inner fusion lerp above.
        ni.x = bx; ni.y = by; ni.z = bz;
      }
    }
  }
  force.initialize = function (_nodes) { nodes = _nodes; };
  return force;
}
