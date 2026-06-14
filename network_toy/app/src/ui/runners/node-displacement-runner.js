// Node-displacement runner — a cross-branch comparison card. Wired with the
// two fusion branches (refIds: [preBranchId, postBranchId]); both share a
// dimred ancestor that carries the pre + post basePos. We read those, run the
// pure displacement compute (align pre→post, per-node distance), and return
// the ranked movers for the panel + a per-node dist array for the colour mode.

import { getStep, getStepAncestors } from "../workflow.js";
import { computeDisplacement }       from "../../eval/node-displacement.js";

// Walk up from a branch card to the dimred ancestor carrying both basePos.
function dimredAncestorOf(stepId) {
  const anc = getStepAncestors(stepId);
  for (let i = anc.length - 1; i >= 0; i--) {
    if (anc[i].type === "dimred" && anc[i].result) return anc[i];
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.preBranchId
 * @param {string} opts.postBranchId
 * @returns {(ctx) => Promise<object>}
 */
export function buildNodeDisplacementJob({ preBranchId, postBranchId }) {
  return async function runNodeDisplacementJob(ctx) {
    const preB  = getStep(preBranchId);
    const postB = getStep(postBranchId);
    if (!preB || !postB) {
      throw new Error("[node-displacement-runner] a referenced fusion branch no longer exists");
    }
    // Both branches descend from the same dimred card (the fork). Read its
    // carried embeddings: _basePos = post, _basePosPreFusion = pre.
    const dimred = dimredAncestorOf(postBranchId) || dimredAncestorOf(preBranchId);
    const r = dimred && dimred.result;
    const postBP = r && r._basePos;
    const preBP  = r && r._basePosPreFusion;
    if (!(preBP instanceof Float32Array) || !(postBP instanceof Float32Array)) {
      throw new Error(
        "Node displacement needs both pre- and post-fusion 3D layouts — run a " +
        "dim-reduction with graph-diffusion fusion (it forks into pre/post " +
        "branches with both layouts).");
    }
    const n = postBP.length / 3;

    ctx.setPhase    && ctx.setPhase("aligning pre → post");
    ctx.setProgress && ctx.setProgress(0.3);
    const disp = computeDisplacement(preBP, postBP, n);
    if (!disp) throw new Error("[node-displacement-runner] displacement compute failed (layout mismatch)");
    ctx.setProgress && ctx.setProgress(1);

    return {
      capturedAt:   new Date().toISOString(),
      nodeDisplacement: {
        dist:        disp.dist,
        correlation: disp.correlation,
        max:         disp.max,
        mean:        disp.mean,
        // Keep the top movers inline (full ranking is large at n=5000); the
        // panel shows the head, the colour mode uses the full dist array.
        topMovers:   disp.ranked.slice(0, 100),
      },
      n,
      maxDisplacement: disp.max,
    };
  };
}
