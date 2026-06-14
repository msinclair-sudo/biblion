// Fruchterman–Reingold force-directed layout in 3D.
//
// Pure function: input is the citation graph + per-node timestamps +
// a layout seed; output is a deterministic Float32Array(n × 3) of
// positions. The module never sees basePos or any generation
// metadata — that information would bias the "pure citation
// topology" arrangement and the blend module's per-component Kabsch
// alignment is the right place to pin orientation to basePos.
//
// Per iteration:
//
//   Repulsion    f_rep(d) = k² / d              every pair
//   Attraction   f_att(d) = d² / k              every citation edge
//   Time anchor  f_t(p, t) = (1−t) · tBias · k  pull toward origin,
//                                                weak for newest nodes,
//                                                strong for oldest
//
// Cooling: linearly anneal the per-iteration max displacement from
// `initialTempFraction · R` down to `finalTempFraction · R` over the
// iteration count. With the time anchor on, every node feels at
// least a baseline pull toward origin so isolated nodes don't drift
// to infinity under pure repulsion.
//
// k (ideal edge length) is set so the available volume divided
// evenly across n nodes gives spacing ≈ k. For R=60 and n=400 that's
// k ≈ 16, comparable to typical basePos spacing — keeps the layout's
// scale in the same ballpark as basePos, simplifying alignment.
//
// Cost: O(iterations × n²) for repulsion + O(iterations × |E|) for
// attraction. n=400 / iters=200 is ~32 M JS ops, runs in ~1 s. Only
// recomputes when the citation graph changes (cached by the caller).

import { mulberry32 } from "../rng.js";

export const ID = "fruchterman-reingold";

export const defaultParams = () => ({
  iterations: 200,
  // Working half-extent. Output positions land roughly within
  // [−worldR, worldR]³, mirroring basePos's range so the blend
  // module's alignment doesn't have to scale.
  worldR: 60,
  // Time-axis bias: per-node radial anchor (Hooke's law toward
  // origin — force linear in radius, so equilibrium is finite even
  // for isolated nodes whose only counterforce is repulsion).
  // Multiplied by (1 − t_node) so old (low-t) nodes feel a stronger
  // pull and end up more central; young (high-t) nodes drift
  // outward. Floor at 0.2 keeps even t=1 nodes anchored enough that
  // sparse / disconnected graphs don't fly apart. The cladogram is
  // unrooted — radial only, no privileged axis.
  tBias: 5.0,
  // Cooling envelope. Linear from initial to final temperature over
  // the iteration count. Caps per-iteration node displacement.
  initialTempFraction: 0.20,
  finalTempFraction:   0.005,
  // Hard outer wall as a multiplier on worldR. After each iteration,
  // any node beyond this radius gets snapped back to the wall. The
  // soft Hooke anchor handles equilibrium for normal graphs, but
  // self-repelling clouds of isolated nodes can pile up arbitrarily
  // far without something to bound them. The wall is generous so
  // it only clamps pathological cases — connected layouts settle
  // inside it long before iteration end.
  outerWallFraction:   1.5,
});

export function compute({ n, edges, t, seed, params = {} }) {
  const p = { ...defaultParams(), ...params };
  const rng = mulberry32(((seed >>> 0) ^ 0xC173C173) >>> 0);

  if (n === 0) return new Float32Array(0);

  const R = p.worldR;
  const volume = Math.pow(2 * R, 3);
  const k  = Math.pow(volume / n, 1 / 3);
  const k2 = k * k;
  const T_FLOOR = 0.2;                          // min anchor multiplier (for newest nodes)

  const positions = new Float32Array(n * 3);
  const disp      = new Float32Array(n * 3);

  // Initial positions: uniform in cube [−R/3, R/3]³. Cube rather than
  // sphere is fine — the layout reorganises within the first dozen
  // iterations and initial shape barely matters as long as nodes are
  // well-separated.
  for (let i = 0; i < n; i++) {
    positions[i*3]   = (rng() * 2 - 1) * R / 3;
    positions[i*3+1] = (rng() * 2 - 1) * R / 3;
    positions[i*3+2] = (rng() * 2 - 1) * R / 3;
  }

  const iters = Math.max(1, p.iterations | 0);
  const tempInit  = R * p.initialTempFraction;
  const tempFinal = R * p.finalTempFraction;

  for (let iter = 0; iter < iters; iter++) {
    // Linear cooling.
    const temp = tempInit + (tempFinal - tempInit) * (iter / Math.max(1, iters - 1));

    // Reset displacement accumulator.
    for (let i = 0; i < n * 3; i++) disp[i] = 0;

    // Repulsion: every unordered pair.
    for (let i = 0; i < n; i++) {
      const ix = positions[i*3], iy = positions[i*3+1], iz = positions[i*3+2];
      for (let j = i + 1; j < n; j++) {
        let dx = ix - positions[j*3];
        let dy = iy - positions[j*3+1];
        let dz = iz - positions[j*3+2];
        let d2 = dx*dx + dy*dy + dz*dz;
        if (d2 < 1e-9) {
          // Coincident — kick apart with a small random direction so
          // future iterations have a gradient to follow.
          dx = (rng() - 0.5) * 1e-3;
          dy = (rng() - 0.5) * 1e-3;
          dz = (rng() - 0.5) * 1e-3;
          d2 = dx*dx + dy*dy + dz*dz;
        }
        // Force on i: (delta / d) · (k² / d) = delta · k² / d²
        const factor = k2 / d2;
        disp[i*3]   += dx * factor;  disp[i*3+1] += dy * factor;  disp[i*3+2] += dz * factor;
        disp[j*3]   -= dx * factor;  disp[j*3+1] -= dy * factor;  disp[j*3+2] -= dz * factor;
      }
    }

    // Attraction: along each citation edge.
    for (let e = 0; e < edges.length; e++) {
      const u = edges[e][0], v = edges[e][1];
      let dx = positions[v*3]   - positions[u*3];
      let dy = positions[v*3+1] - positions[u*3+1];
      let dz = positions[v*3+2] - positions[u*3+2];
      const d2 = dx*dx + dy*dy + dz*dz;
      const d = Math.sqrt(d2) || 1e-6;
      // Force on u toward v: (delta / d) · (d² / k) = delta · d / k
      const factor = d / k;
      disp[u*3]   += dx * factor;  disp[u*3+1] += dy * factor;  disp[u*3+2] += dz * factor;
      disp[v*3]   -= dx * factor;  disp[v*3+1] -= dy * factor;  disp[v*3+2] -= dz * factor;
    }

    // Time-axis radial anchor (Hooke's law toward origin: force
    // proportional to current radius). Linear scaling with r is what
    // makes the equilibrium FINITE for isolated nodes — at any radius
    // the anchor matches the diverging repulsion sum, so disconnected
    // components settle at sensible distances instead of escaping
    // to infinity. p.tBias is the spring constant; (1 − t_i) modulates
    // it per node so older nodes feel a stronger pull.
    if (p.tBias > 0 && t) {
      for (let i = 0; i < n; i++) {
        const px = positions[i*3], py = positions[i*3+1], pz = positions[i*3+2];
        const ti = +t[i] || 0;
        const ka = Math.max(T_FLOOR, 1 - ti) * p.tBias;
        disp[i*3]   -= px * ka;
        disp[i*3+1] -= py * ka;
        disp[i*3+2] -= pz * ka;
      }
    }

    // Apply displacement, capped at the cooling temperature.
    for (let i = 0; i < n; i++) {
      const dx = disp[i*3], dy = disp[i*3+1], dz = disp[i*3+2];
      const d2 = dx*dx + dy*dy + dz*dz;
      if (d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      const move = d > temp ? temp : d;
      const s = move / d;
      positions[i*3]   += dx * s;
      positions[i*3+1] += dy * s;
      positions[i*3+2] += dz * s;
    }

    // Hard outer-wall clamp. Pure-repulsion clouds (many isolated
    // nodes) would otherwise inflate without bound — the soft Hooke
    // anchor falls behind a self-repelling cloud's diverging energy.
    // Wall sits well outside the typical equilibrium so connected
    // layouts never feel it.
    const wallR  = R * p.outerWallFraction;
    const wallR2 = wallR * wallR;
    for (let i = 0; i < n; i++) {
      const px = positions[i*3], py = positions[i*3+1], pz = positions[i*3+2];
      const r2 = px*px + py*py + pz*pz;
      if (r2 > wallR2) {
        const s = wallR / Math.sqrt(r2);
        positions[i*3]   = px * s;
        positions[i*3+1] = py * s;
        positions[i*3+2] = pz * s;
      }
    }
  }

  return positions;
}
