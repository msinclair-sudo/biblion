// Cluster-labels runner — the labelling "analysis layer" card (MLC §7).
//
// Labels EVERY level of the parent clustering-like card's ladder by the
// requested methods, in one static pass. Labels don't drift once computed
// (the cluster topology is fixed); if the upstream clustering changes, the
// card goes stale (red dot) and the user re-runs it — so there's no live
// recompute downstream. Scoring reads these stored labels.
//
// Like the other analysis runners it reads its clustering from the parent
// card's snapshot (immutable per §10.D1), and the embedding / node table
// from live state (staged by the queue from this branch's ancestry just
// before the job runs).

import { getState }      from "../state.js";
import { getStep, findClusterLevels } from "../workflow.js";
import { labelClusters } from "../../labelling/cluster-labels.js";
import { getNodeText, hasSqliteText } from "../../datasource/sqlite.js";

/**
 * @param {object} opts
 * @param {string}   opts.parentStepId   The attach parent (may be a bridge
 *                                        card); levels resolve from the
 *                                        nearest clustering ancestor above it.
 * @param {string[]} opts.methods        Label method ids to run (subset of
 *                                        the labelling registry).
 * @returns {(ctx:{signal,setPhase,setProgress}) => Promise<object>}
 */
export function buildLabellingJob({ parentStepId, methods }) {
  return async function runLabellingJob(ctx) {
    const parent = getStep(parentStepId);
    if (!parent) {
      throw new Error(`[cluster-labels-runner] parent step "${parentStepId}" no longer exists`);
    }
    // Walk up to the nearest clustering ladder (the bridge card between
    // picker and labelling carries no clusterLevels of its own).
    const levels = findClusterLevels(parentStepId).levels;
    if (levels.length === 0) {
      throw new Error("[cluster-labels-runner] no clustering levels found above this card to label");
    }

    // Labelling ctx — embedding + node table from live (staged) state.
    // getText is live from the biblion SQLite corpus when loaded (unlocks
    // c-TF-IDF / TF-IDF); undefined for toy/real sources (those gate the
    // text methods off).
    const s = getState();
    const labelCtx = {
      embedding: s.embedding || (s._basePos ? { d: 3, data: s._basePos } : null),
      nodes:     (s.genResult && s.genResult.nodes) || [],
      getText:   hasSqliteText() ? getNodeText : undefined,
    };

    const byLevel = {};
    let methodInfo = null;
    for (let i = 0; i < levels.length; i++) {
      ctx.setPhase    && ctx.setPhase(`level ${i + 1} / ${levels.length}`);
      ctx.setProgress && ctx.setProgress(levels.length ? i / levels.length : 0);
      const lvl = levels[i];
      const out = labelClusters(lvl.clusterResult, labelCtx, { methods });
      byLevel[lvl.uid] = out;
      if (!methodInfo) methodInfo = out.methods;   // availability is level-invariant
    }
    ctx.setProgress && ctx.setProgress(1);

    return {
      capturedAt: new Date().toISOString(),
      methods:    [...methods],
      methodInfo,                 // [{id, label, available, reason?}]
      byLevel,                    // { [levelUid]: { methods, perCluster } }
      nLevels:    levels.length,
    };
  };
}
