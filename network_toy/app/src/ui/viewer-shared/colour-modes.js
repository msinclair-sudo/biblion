// Shared colour-mode helpers used by viewer-3d AND viewer-2d.
//
// The two viewers render different geometries but they're looking at
// the same data and the same node-metadata. So the dropdown options
// + the per-node colour resolver + the selection-dim logic all live
// in one place. Pulling them into a shared module means changing a
// colour rule (e.g. a new mode) updates both viewers atomically.

import { tGradient, inDegGradient, boundaryScoreGradient } from "../gradients.js";

export const DEFAULT_COLOUR_MODE = "cluster:finest";
export const DIMMED_COLOUR       = "#3a3f4a";
export const UNKNOWN_COLOUR      = "#888";

// ── gradient scaling stats, memoised on the source array reference ──────
// The colour resolver runs once PER NODE PER FRAME, so scanning the whole
// in-degree / year array on every call (as the old code did) is O(n²) per
// frame. Cache the derived stats keyed on the source typed-array identity;
// the arrays are reassigned (never mutated in place), so an identity check is
// a safe cache key.

let _inDegStats = { ref: null, max: 1, logMax: 1 };
export function inDegStats(citationResult) {
  const arr = citationResult && citationResult.inDeg;
  if (!arr) return { max: 1, logMax: Math.log1p(1) };
  if (_inDegStats.ref !== arr) {
    let max = 1;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    _inDegStats = { ref: arr, max, logMax: Math.log1p(max) };
  }
  return _inDegStats;
}

let _dispStats = { ref: null, max: 1, logMax: 1 };
export function displacementStats(nodeDisplacement) {
  const arr = nodeDisplacement && nodeDisplacement.dist;
  if (!arr) return { max: 1, logMax: Math.log1p(1) };
  if (_dispStats.ref !== arr) {
    let max = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    max = max || 1;
    _dispStats = { ref: arr, max, logMax: Math.log1p(max) };
  }
  return _dispStats;
}

let _yearStats = { ref: null, min: null, max: null };
export function yearStats(genResult) {
  const nodes = genResult && genResult.nodes;
  if (!nodes) return { min: null, max: null };
  if (_yearStats.ref !== nodes) {
    let min = Infinity, max = -Infinity;
    for (const nd of nodes) {
      const y = nd && nd.year;
      if (Number.isFinite(y)) { if (y < min) min = y; if (y > max) max = y; }
    }
    _yearStats = Number.isFinite(min)
      ? { ref: nodes, min, max }
      : { ref: nodes, min: null, max: null };
  }
  return _yearStats;
}

// Build the colour-by dropdown's options from the current state.
//
// "cluster:N"      → level index N
// "cluster:finest" → legacy alias for the last level (resolved
//                     downstream; not surfaced as a dropdown option)
// "origin"         → generator origin colour
// "t"              → gradient on node.t (cool → warm)
// "inDeg"          → gradient on citation in-degree (cool → warm)
// "bridge"         → bridge nodes by parent colour, others greyed
// "boundaryScore"  → gradient on per-node boundary score
export function getColourModeOptions(state) {
  const opts = [];
  const levels = state.clusterLevels || [];
  if (levels.length > 0) {
    for (let i = 0; i < levels.length; i++) {
      opts.push({
        value: `cluster:${i}`,
        label: levels.length > 1 ? `Cluster (level ${i})` : "Cluster",
      });
    }
  }
  // (Pre-fusion cluster labels are no longer a colour mode — pre/post-fusion
  // is now a workflow FORK. Select the pre or post fusion-branch card to see
  // its clustering; the viewer follows the selected branch.)
  if (state.bridgeAnalysis) {
    opts.push({ value: "bridge",        label: "Bridge clusters" });
    opts.push({ value: "boundaryScore", label: "Boundary score (gradient)" });
  }
  if (state.genResult && state.genResult.origins) {
    opts.push({ value: "origin", label: "Origin (generator label)" });
  }
  // Publication year (real years on real data; normalised t fallback on toy).
  const ys = yearStats(state.genResult);
  opts.push({
    value: "year",
    label: (ys.min != null) ? `Publication year (${ys.min}–${ys.max})` : "Time (t)",
  });
  if (state.citationResult) {
    opts.push({ value: "inDeg:raw", label: "Citation in-degree (count)" });
    opts.push({ value: "inDeg",     label: "Citation in-degree (normalised)" });
    opts.push({ value: "inDeg:log", label: "Citation in-degree (log)" });
  }
  // Pre→post fusion node displacement (when a node-displacement card has run).
  if (state.nodeDisplacement && state.nodeDisplacement.dist) {
    opts.push({ value: "displacement",     label: "Fusion displacement (normalised)" });
    opts.push({ value: "displacement:log", label: "Fusion displacement (log)" });
  }
  return opts;
}

// Resolve the cluster-result for a cluster:* mode.
// Returns null for non-cluster modes or when no clustering exists.
export function clusterResultForMode(state, mode) {
  if (!mode) return null;
  if (!mode.startsWith("cluster")) return null;
  const levels = state.clusterLevels || [];
  if (levels.length === 0) return null;
  if (mode === "cluster:finest") return levels[levels.length - 1].clusterResult;
  const idx = parseInt(mode.slice(8), 10);
  if (Number.isFinite(idx) && idx >= 0 && idx < levels.length) {
    return levels[idx].clusterResult;
  }
  return levels[levels.length - 1].clusterResult;
}

// Resolve a node's base colour for the active mode. `node` is the
// projection the viewer puts on each datum — must carry id, originId
// (when toy), t. Cluster IDs are read from state, not the node.
export function baseColourFor(node, state, mode) {
  if (mode && (mode.startsWith("cluster:") || mode === "cluster")) {
    const cr = clusterResultForMode(state, mode);
    if (cr) {
      const cid = cr.nodeCluster[node.id];
      const cluster = cid >= 0 ? cr.clusters[cid] : null;
      return cluster ? cluster.colour : UNKNOWN_COLOUR;
    }
    return UNKNOWN_COLOUR;
  }
  if (mode === "origin") {
    const origins = state.genResult && state.genResult.origins;
    if (origins && node.originId != null && origins[node.originId]) {
      return origins[node.originId].colour;
    }
    return UNKNOWN_COLOUR;
  }
  if (mode === "t" || mode === "year") {
    // Publication-year gradient over the real [minYear, maxYear] range.
    // Falls back to the normalised node.t when no real years exist (toy data).
    const ys = yearStats(state.genResult);
    if (ys.min != null && Number.isFinite(node.year)) {
      const span = ys.max - ys.min;
      return tGradient(span > 0 ? (node.year - ys.min) / span : 0);
    }
    return tGradient(+node.t || 0);
  }
  if (mode === "inDeg" || mode === "inDeg:log" || mode === "inDeg:raw") {
    const cit = state.citationResult;
    if (cit && cit.inDeg) {
      const c = cit.inDeg[node.id] || 0;
      const { max, logMax } = inDegStats(cit);
      // raw + linear both map onto [0,max] linearly (raw is the same hue ramp,
      // surfaced as a distinct option so the legend reads real counts); log
      // spreads the long low-degree tail so it isn't crushed by hub outliers.
      const t = (mode === "inDeg:log")
        ? (logMax > 0 ? Math.log1p(c) / logMax : 0)
        : (max > 0 ? c / max : 0);
      return inDegGradient(t);
    }
    return UNKNOWN_COLOUR;
  }
  if (mode === "displacement" || mode === "displacement:log") {
    const nd = state.nodeDisplacement;
    if (nd && nd.dist) {
      const d = nd.dist[node.id] || 0;
      const { max, logMax } = displacementStats(nd);
      const t = (mode === "displacement:log")
        ? (logMax > 0 ? Math.log1p(d) / logMax : 0)
        : (max > 0 ? d / max : 0);
      return inDegGradient(t);
    }
    return UNKNOWN_COLOUR;
  }
  if (mode === "bridge") {
    const ba = state.bridgeAnalysis;
    if (!ba) return UNKNOWN_COLOUR;
    if (!ba.perNodeIsBridge[node.id]) return DIMMED_COLOUR;
    const coarse = state.clusterLevels[ba.coarseLevel].clusterResult;
    const cid = coarse.nodeCluster[node.id];
    const cluster = cid >= 0 ? coarse.clusters[cid] : null;
    return cluster ? cluster.colour : UNKNOWN_COLOUR;
  }
  if (mode === "boundaryScore") {
    const ba = state.bridgeAnalysis;
    if (!ba) return UNKNOWN_COLOUR;
    return boundaryScoreGradient(ba.perNodeScore[node.id] || 0);
  }
  return UNKNOWN_COLOUR;
}

// Does this node match the user's current selection? Returns
//   true   — match, render at base colour
//   false  — non-match, render dimmed
//   null   — selection type doesn't dim (e.g. tBin), use base
export function nodeMatchesSelection(node, state, sel) {
  if (!sel || !sel.type) return null;
  if (sel.type === "cluster") {
    const levels = state.clusterLevels || [];
    if (levels.length === 0) return null;
    const lvlIdx = (sel.level == null)
      ? levels.length - 1
      : Math.max(0, Math.min(levels.length - 1, sel.level));
    const cl = levels[lvlIdx];
    if (!cl) return null;
    return cl.clusterResult.nodeCluster[node.id] === sel.id;
  }
  if (sel.type === "origin") {
    return node.originId === sel.id;
  }
  if (sel.type === "node") {
    return node.id === sel.id;
  }
  return null;
}

// Selection focus (J25). The highlight channel (state.highlights.bySource) is
// the multi-source node-SELECTION set — scoring-card picks, SQL-search hits,
// viewer selections, etc. When ANY selection is active the viewers grey out
// every non-selected node and render the selected ones at their normal
// colour-by colour (see nodeColourFor): the colour-by stays the primary
// colouring, selection only dims the rest. So we need membership predicates,
// not a glow colour.

// True when at least one highlight source has members → a selection is active.
export function anyHighlightActive(state) {
  const hs = state.highlights;
  if (!hs || !hs.bySource) return false;
  for (const source in hs.bySource) {
    const g = hs.bySource[source];
    if (g && g.ids && g.ids.size > 0) return true;
  }
  return false;
}

// True when this node is in any highlight source's id set (i.e. selected).
export function isNodeHighlighted(node, state) {
  const hs = state.highlights;
  if (!hs || !hs.bySource) return false;
  for (const source in hs.bySource) {
    const g = hs.bySource[source];
    if (g && g.ids && g.ids.has(node.id)) return true;
  }
  return false;
}

// Cheap fingerprint of the highlight channel — each viewer caches the prior
// tick's signature and, when it changes, repaints via the nodeColor accessor
// only (no rebuildData). Size + a small id-sum per source is enough to catch
// add / clear / membership changes at toy/dev-subset sizes without hashing
// every id every tick.
export function highlightSignature(state) {
  const hs = state.highlights;
  if (!hs || !hs.bySource) return "";
  const parts = [];
  for (const source of Object.keys(hs.bySource).sort()) {
    const g = hs.bySource[source];
    if (!g || !g.ids) continue;
    let sum = 0;
    for (const id of g.ids) sum += id;
    parts.push(`${source}:${g.ids.size}:${sum}:${g.colour || ""}`);
  }
  return parts.join("|");
}

// Final node colour. The active colour mode is the PRIMARY colouring; node
// selection only dims the rest. The single function each viewer calls per node
// per frame.
//
// Composition:
//   1. base colour for the active mode;
//   2. selection focus — when any nodes are selected (via the J25 highlight
//      channel and/or the single state.selection), every NON-selected node
//      drops to DIMMED_COLOUR (grey) while selected nodes keep their base
//      colour-by colour. With nothing selected, every node shows its base
//      colour. This replaces the old per-source "glow" recolour: selection
//      reads as colour-by-on-grey, not a flat highlight hue.
export function nodeColourFor(node, state, mode) {
  const base = baseColourFor(node, state, mode);
  const matched = nodeMatchesSelection(node, state, state.selection);   // true | false | null
  if (anyHighlightActive(state)) {
    // Focus on the highlight selection set; also keep a single-selection match
    // visible when both mechanisms are in play.
    return (isNodeHighlighted(node, state) || matched === true) ? base : DIMMED_COLOUR;
  }
  // No highlight set → fall back to the single-selection dim (cluster / origin
  // / node picks from the tables). null = this selection type doesn't dim.
  if (matched === null) return base;
  return matched ? base : DIMMED_COLOUR;
}
