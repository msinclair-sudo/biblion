// Fusion-branch runner — the branch card is a ROUTER, not a compute step.
// When fusion produced two embeddings (pre- and post-fusion), the workflow
// forks into a pre branch and a post branch; each branch carries one endpoint
// downstream. The actual routing (projecting the chosen embedding into the
// legacy dimredResult / _basePos slots) happens in the projection layer
// (projectFusionBranch). This prep job just stamps the card so it exists in
// the tree, is selectable, and records which endpoint it carries.

/**
 * @param {object} opts
 * @param {"pre"|"post"} opts.endpoint
 * @returns {(ctx) => Promise<object>}
 */
export function buildFusionBranchJob({ endpoint }) {
  return async function runFusionBranchJob(ctx) {
    ctx.setPhase    && ctx.setPhase(endpoint === "pre" ? "pre-fusion branch" : "post-fusion branch");
    ctx.setProgress && ctx.setProgress(1);
    return { capturedAt: new Date().toISOString(), endpoint };
  };
}
