// Shared colour-mode helpers used by viewer-3d AND viewer-2d.
//
// The two viewers render different geometries but they're looking at
// the same data and the same node-metadata. So the dropdown options
// + the per-node colour resolver + the selection-dim logic all live
// in one place. Pulling them into a shared module means changing a
// colour rule (e.g. a new mode) updates both viewers atomically.

import { tGradient, inDegGradient, boundaryScoreGradient } from "../gradients.js";
import { getIdByRow } from "../../datasource/sqlite.js";

export const DEFAULT_COLOUR_MODE = "cluster:finest";
export const DIMMED_COLOUR       = "#3a3f4a";
export const UNKNOWN_COLOUR      = "#888";
export const PINNED_COLOUR       = "#ffffff";   // white-emphasis pin (top layer)
// Ghost (structure-only) markers. Distinct muted tones — NOT the noise grey
// (#888) nor a vivid cluster hue — so a ghost never reads as a real paper. The
// 2D viewer hatches in the node's real colour over this; the 3D viewer (spheres
// can't hatch cheaply) falls back to this as a flat fill.
//   missing-data — a real paper missing only an abstract (enrichment candidate):
//                  a warm muted tan, reading as "almost real".
//   pending      — an identifier-only co-cited stub: cool slate, more peripheral.
export const GHOST_COLOUR          = "#6b6f7a";   // default / pending (back-compat)
export const GHOST_COLOUR_PENDING  = "#6b6f7a";
export const GHOST_COLOUR_MISSING  = "#9a8a63";

// Whether a citation edge should be drawn, given the two view toggles and
// whether the edge touches a ghost. All citation edges obey the global "Show
// citations" toggle (and share its colour/opacity); ghost-incident edges
// additionally require ghosts to be shown, so hiding ghosts also hides their
// edges. Pure, so the viewers and their tests share one source of truth.
export function citationEdgeVisible(touchesGhost, showCitations, showGhosts) {
  if (!showCitations) return false;
  return touchesGhost ? !!showGhosts : true;
}

// The ghost's base tone by kind, read off the canonical node entry. Falls back
// to the missing-data tone for legacy nodes that predate ghostKind (most ghosts
// are missing-data), and to the shared default if the node can't be resolved.
export function ghostBaseColour(node, state) {
  const nd = state && state.genResult && state.genResult.nodes[node.id];
  const kind = nd && nd.ghostKind;
  if (kind === "pending") return GHOST_COLOUR_PENDING;
  if (kind === "missing-data") return GHOST_COLOUR_MISSING;
  return GHOST_COLOUR_MISSING;
}

// True when this node is a structural "ghost" (no embedding/metadata — see
// doc/ghost-nodes.md). The viewer node projection only carries an id, so we
// resolve the flag off the canonical genResult.nodes entry.
export function isGhostNode(node, state) {
  if (!node || !state || !state.genResult) return false;
  const nd = state.genResult.nodes[node.id];
  return !!(nd && nd.isGhost);
}

// Flat colour for a ghost in renderers that can't hatch (the 3D sphere viewer;
// the 2D canvas does the real hatch). Applies the SAME pin/selection-dim
// envelope as nodeColourFor so a ghost greys out when a selection focus
// excludes it, rather than popping at its distinct colour.
export function ghostNodeColour(node, state) {
  if (state && state.pinnedNodes && state.pinnedNodes.has(node.id)) return PINNED_COLOUR;
  const base = ghostBaseColour(node, state);
  const matched = nodeMatchesSelection(node, state, state.selection);
  if (anyHighlightActive(state)) {
    return (isNodeHighlighted(node, state) || matched === true) ? base : DIMMED_COLOUR;
  }
  if (matched === false) return DIMMED_COLOUR;
  return base;
}

// Categorical palette for the "tag" colour mode (Tableau-10). Shared with the
// tags-list panel's swatches so a tag's colour matches across viewer + panel.
export const TAG_PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ab",
];

// tag name → colour, assigning palette slots in sorted order of all distinct
// tags currently in state.tags. Memoised on the tags-map identity (the state
// mutators replace the map, never mutate it, so identity is a safe cache key).
let _tagColourCache = { ref: null, byTag: new Map() };
export function tagColourMap(state) {
  const tags = (state && state.tags) || {};
  if (_tagColourCache.ref === tags) return _tagColourCache.byTag;
  const names = new Set();
  for (const pid in tags) for (const t of tags[pid]) names.add(t);
  const byTag = new Map();
  [...names].sort().forEach((t, i) => byTag.set(t, TAG_PALETTE[i % TAG_PALETTE.length]));
  _tagColourCache = { ref: tags, byTag };
  return byTag;
}

// Fingerprint of state.tags — distinct-tag count + total assignments. A change
// here repaints the viewer via the cheap nodeColor accessor (no rebuild).
export function tagsSignature(state) {
  const t = (state && state.tags) || {};
  let papers = 0, assigns = 0;
  for (const pid in t) { papers += 1; assigns += t[pid] ? t[pid].length : 0; }
  return `${papers}:${assigns}`;
}

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
    // Citation in-degree is heavily right-skewed (a few hubs, a long low tail),
    // so LINEAR normalisation crushes nearly every node into the bottom of the
    // gradient (they all read as one colour) while only the hubs reach the top —
    // it looks binned. Log scaling spreads the tail across the gradient, so it's
    // the sensible default ("Citation in-degree"); the linear ramp stays as an
    // explicit option. (The "inDeg:raw" value is colour-identical to linear —
    // raw counts already show in the in-deg table column — so it's dropped from
    // the menu; baseColourFor still resolves it for any older saved tab config.)
    opts.push({ value: "inDeg:log", label: "Citation in-degree" });
    opts.push({ value: "inDeg",     label: "Citation in-degree (linear)" });
  }
  // Pre→post fusion node displacement (when a node-displacement card has run).
  if (state.nodeDisplacement && state.nodeDisplacement.dist) {
    opts.push({ value: "displacement",     label: "Fusion displacement (normalised)" });
    opts.push({ value: "displacement:log", label: "Fusion displacement (log)" });
  }
  // User tags (only once at least one paper is tagged).
  if (state.tags && Object.keys(state.tags).length > 0) {
    opts.push({ value: "tag", label: "Tag" });
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
  if (mode === "tag") {
    // Tags are keyed by paperId; map the node index → paperId via the corpus.
    const tags = state.tags || {};
    const pid = getIdByRow(node.id);
    const list = pid != null ? tags[pid] : null;
    if (!list || list.length === 0) return DIMMED_COLOUR;   // untagged → grey
    // A node may carry several tags; colour by the alphabetically-first so the
    // choice is deterministic and matches the sorted palette assignment.
    const first = list.slice().sort()[0];
    return tagColourMap(state).get(first) || UNKNOWN_COLOUR;
  }
  return UNKNOWN_COLOUR;
}

// Does this node match the user's current selection? Returns
//   true   — match, render at base colour
//   false  — non-match, render dimmed
//   null   — selection has no type / not a dimming type, use base
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
  if (sel.type === "nodes") {
    // Generic grouping/bin selection (node-table year bins, etc.) — carries its
    // resolved ids. Memoise the Set since this runs per node on every repaint.
    return selectionIdSet(sel).has(node.id);
  }
  return null;
}

// Memoised Set for a {type:"nodes", ids} selection. state.selection is a fresh
// object per selection change, so a one-slot cache keyed on its identity is
// enough to avoid rebuilding the Set for every node in nodeColourFor.
let _selSetRef = null;
let _selSet = null;
function selectionIdSet(sel) {
  if (sel !== _selSetRef) {
    _selSetRef = sel;
    _selSet = new Set((sel && sel.ids) || []);
  }
  return _selSet;
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

// The set of node ids the viewer currently treats as SELECTED — the data
// source for the Selected-papers panel. Mirrors nodeColourFor's "not greyed
// when a selection is active" predicate: the union of every highlight source's
// ids PLUS the nodes matching the single state.selection (cluster / node /
// origin / nodes). Empty when nothing is selected (panel shows empty, matching the
// viewer colouring everything by colour-by).
export function selectedNodeIds(state) {
  const ids = new Set();
  const hs = state.highlights;
  if (hs && hs.bySource) {
    for (const source in hs.bySource) {
      const g = hs.bySource[source];
      if (g && g.ids) for (const id of g.ids) ids.add(id);
    }
  }
  const sel = state.selection;
  const nodes = (state.genResult && state.genResult.nodes) || [];
  if (sel && sel.type === "node") {
    if (Number.isInteger(sel.id)) ids.add(sel.id);
  } else if (sel && sel.type === "cluster") {
    const levels = state.clusterLevels || [];
    if (levels.length) {
      const lvlIdx = (sel.level == null)
        ? levels.length - 1
        : Math.max(0, Math.min(levels.length - 1, sel.level));
      const cr = levels[lvlIdx] && levels[lvlIdx].clusterResult;
      const nc = cr && cr.nodeCluster;
      if (nc) for (let id = 0; id < nc.length; id++) if (nc[id] === sel.id) ids.add(id);
    }
  } else if (sel && sel.type === "origin") {
    for (const nd of nodes) if (nd && nd.originId === sel.id) ids.add(nd.id);
  } else if (sel && sel.type === "nodes" && Array.isArray(sel.ids)) {
    // Generic grouping/bin selection (year bins, …) carries its node ids.
    for (const id of sel.ids) ids.add(id);
  }
  return ids;
}

// Cheap fingerprint of the pinned-node set — viewers cache the prior tick's
// value and repaint via the nodeColor accessor (no rebuildData) when it
// changes. Same shape as highlightSignature: size + id-sum.
export function pinnedSignature(state) {
  const p = state.pinnedNodes;
  if (!p || p.size === 0) return "";
  let sum = 0;
  for (const id of p) sum += id;
  return `${p.size}:${sum}`;
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
  // White-pin emphasis (Selected-papers panel) wins over everything: a pinned
  // node renders pure white regardless of colour-by / selection-dim. Every
  // other node is unaffected (the pin is a top layer, not a focus filter).
  if (state.pinnedNodes && state.pinnedNodes.has(node.id)) return PINNED_COLOUR;
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
