// 2D viewer panel.
//
// Sibling of viewer-3d. Renders the same data through the same
// colour-mode helpers, just on a 2D canvas via `force-graph` (the
// 2D companion to 3d-force-graph by the same author — canvas-based,
// scales well past the million-node mark where WebGL spheres start
// to thrash).
//
// Position source: state._basePos2d (Float32Array(n*2)). Produced by
// Layer 1.5's viz2d sub-stage; null until the user picks a 2-d-
// producing algorithm there. When null, the panel renders an empty-
// state hint — same lazy-render gate as viewer-3d.
//
// No blend here. The blend is a 3D-only concept (α-interpolation
// between basePos and aligned citation layout in 3-space); the 2D
// viewer just paints _basePos2d.

import ForceGraph from "force-graph";
import { getState, setTabConfig, clearAllHighlights, setSelection } from "../state.js";
import {
  getColourModeOptions, nodeColourFor, DEFAULT_COLOUR_MODE, highlightSignature,
  anyHighlightActive, pinnedSignature, tagsSignature, selectionSignature, ghostBaseColour,
  citationEdgeVisible,
} from "../viewer-shared/colour-modes.js";

export const ID = "viewer-2d";
export const LABEL = "2D viewer";
export const DESCRIPTION = "Canvas-based 2D scatter — reads state._basePos2d. Faster than the 3D viewer at large scale; populates once a 2-d viz reduction has run.";
// Same WebGL/teardown reasoning as viewer-3d: one instance.
export const SINGLETON = true;

const DEFAULT_NODE_R = 3;

// Node-radius multiplier driven by the viewer's size slider (state.view.nodeScale).
function nodeScale() { return (getState().view || {}).nodeScale ?? 1; }

export function mount(container, _state, config = {}, tabContext = null) {
  let colourMode = config.colourMode || DEFAULT_COLOUR_MODE;

  container.innerHTML = "";
  container.style.height = "100%";
  container.style.position = "relative";

  const graphDiv = document.createElement("div");
  graphDiv.style.width    = "100%";
  graphDiv.style.height   = "100%";
  graphDiv.style.position = "absolute";
  graphDiv.style.inset    = "0";
  container.appendChild(graphDiv);

  // Empty-state overlay — same look as the 3D viewer's.
  const emptyOverlay = document.createElement("div");
  emptyOverlay.className = "viewer-3d-empty";    // reuse 3D's CSS class for visual parity
  emptyOverlay.style.display = "none";
  container.appendChild(emptyOverlay);

  function showEmptyState(text) {
    emptyOverlay.textContent = text;
    emptyOverlay.style.display = "flex";
    if (Graph) Graph.graphData({ nodes: [], links: [] });
  }
  function hideEmptyState() {
    emptyOverlay.style.display = "none";
  }

  let Graph = null;
  let lastDataRevision = -1;
  let resizeObs = null;
  let lastSelSig = "";

  // Colour-mode dropdown reuses the same builder as viewer-3d.
  const colourOverlay = buildColourModeOverlay({
    initial: colourMode,
    getOptions: () => getColourModeOptions(getState()),
    onChange:  (mode) => {
      colourMode = mode;
      persistTabPartial({ colourMode: mode });
      if (Graph) Graph.nodeColor(nodeColour);
    },
  });
  container.appendChild(colourOverlay.root);

  // Deselect-all control — mirrors viewer-3d. Clears the J25 highlight channel
  // and the single state.selection, so the colour-by colours every node again.
  // Shown only while a selection is active (toggled in the update loop).
  const deselectBtn = document.createElement("button");
  deselectBtn.className = "viewer-3d-deselect";   // reuse 3D's styling
  deselectBtn.type = "button";
  deselectBtn.textContent = "Deselect all nodes";
  deselectBtn.title = "Clear the node selection";
  deselectBtn.style.display = "none";
  deselectBtn.addEventListener("click", () => {
    clearAllHighlights();
    setSelection({ type: null, id: null });
  });
  container.appendChild(deselectBtn);
  const syncDeselectBtn = (s) => {
    const active = anyHighlightActive(s) || !!(s.selection && s.selection.type);
    deselectBtn.style.display = active ? "" : "none";
  };
  syncDeselectBtn(getState());

  function init() {
    const rect = graphDiv.getBoundingClientRect();
    // force-graph's API differs slightly from 3d-force-graph's
    // (no linkOpacity, link styling lives in linkColor's rgba). We
    // don't render links here so most of that doesn't matter — keep
    // the chain narrow to what force-graph 1.43 actually exposes.
    Graph = ForceGraph()(graphDiv)
      .width(Math.max(1, rect.width))
      .height(Math.max(1, rect.height))
      .backgroundColor("#06080c")
      .nodeRelSize(DEFAULT_NODE_R * nodeScale())
      .nodeColor(nodeColour)
      .nodeVisibility(ghostVisible)
      .nodeCanvasObjectMode(ghostMode)
      .nodeCanvasObject(ghostCanvas)
      .nodeLabel((n) => `#${n.id} · cluster ${n.clusterId} · t=${(n.t ?? 0).toFixed(2)}`)
      // Only ghost-incident citation edges are added (see rebuildData); a faint
      // neutral line so a ghost visibly connects to the real papers citing it.
      .linkColor(() => "rgba(150,150,150,0.45)")
      .linkWidth(() => 0.5)
      .cooldownTicks(0)        // we pin positions; no simulation needed
      .warmupTicks(0)
      .d3VelocityDecay(1.0);   // zero-out integration alongside our pinned x/y

    // Disable d3-force forces — we own positions.
    const charge = Graph.d3Force("charge"); if (charge && charge.strength) charge.strength(0);
    const link   = Graph.d3Force("link");   if (link   && link.strength)   link.strength(0);
    const center = Graph.d3Force("center"); if (center && center.strength) center.strength(0);

    resizeObs = new ResizeObserver((entries) => {
      if (!Graph) return;
      const r = entries[0].contentRect;
      Graph.width(Math.max(1, r.width)).height(Math.max(1, r.height));
    });
    resizeObs.observe(graphDiv);
  }

  function rebuildData() {
    if (!Graph) return;
    const s = getState();
    if (!s.genResult) {
      showEmptyState("Load or generate a dataset to render.");
      return;
    }
    if (!s._basePos2d) {
      showEmptyState("Pick a 2-d visualisation reduction in the dim-reduction layer to render this dataset.");
      return;
    }
    hideEmptyState();

    const nodes = [];
    for (const n of s.genResult.nodes) {
      const cid = s.clusterResult ? s.clusterResult.nodeCluster[n.id] : -1;
      nodes.push({
        id:        n.id,
        kind:      "node",
        t:         n.t,
        originId:  n.originId,
        clusterId: cid,
        isGhost:   !!n.isGhost,                  // structural ghost → hatched marker
        fx:        s._basePos2d[n.id * 2],       // fx/fy pin position in force-graph
        fy:        s._basePos2d[n.id * 2 + 1],
      });
    }

    // Citation links: only the GHOST-INCIDENT ones, and only when ghosts are
    // shown — so a ghost connects visibly to the real papers citing it without
    // cluttering the canvas with the full citation graph (real↔real edges stay
    // a 3D-only concern). No arrows.
    const links = [];
    const showCit = (s.view || {}).showCitations;
    if (s.citationResult && s.citationResult.citations) {
      const isGhost = (id) => !!(s.genResult.nodes[id] && s.genResult.nodes[id].isGhost);
      for (const c of s.citationResult.citations) {
        const touchesGhost = isGhost(c.source) || isGhost(c.target);
        // 2D intentionally renders only the ghost-incident edges (real↔real edges
        // clutter the canvas); like 3D they obey the Show-citations + ghost toggles.
        if (touchesGhost && citationEdgeVisible(touchesGhost, showCit, ghostsShown())) {
          links.push({ source: c.source, target: c.target });
        }
      }
    }

    Graph.graphData({ nodes, links });
    // Re-centre the view on the data extents so a fresh layout fills
    // the panel.
    if (typeof Graph.zoomToFit === "function") {
      // Small timeout so canvas has rendered once before we measure.
      setTimeout(() => { try { Graph.zoomToFit(400, 60); } catch (_) {} }, 50);
    }
  }

  function nodeColour(n) {
    return nodeColourFor(n, getState(), colourMode);
  }

  // Ghost markers: hidden when the toggle is off; otherwise drawn as a hatched
  // disc so a structural node never reads as a real paper. The stripes use the
  // node's normal mode colour (so it still conveys cluster lean / dim state).
  function ghostsShown() { return (getState().view || {}).showGhosts !== false; }
  function ghostVisible(n) { return ghostsShown() || !n.isGhost; }
  function ghostMode(n) { return n.isGhost ? "replace" : undefined; }
  function ghostCanvas(n, ctx, scale) {
    if (!n.isGhost) return;
    const R = DEFAULT_NODE_R * nodeScale();
    const col = nodeColourFor(n, getState(), colourMode);   // stripes: cluster/dim lean
    const ringCol = ghostBaseColour(n, getState());          // ring: ghost-kind tone
    const lw = Math.max(0.4, 0.7 / (scale || 1));
    ctx.save();
    ctx.beginPath();
    ctx.arc(n.x, n.y, R, 0, 2 * Math.PI);
    ctx.fillStyle = "#0b0e13";        // dark fill so the stripes read
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    const step = 1.6;
    for (let d = -2 * R; d <= 2 * R; d += step) {   // 45° diagonal hatch
      ctx.beginPath();
      ctx.moveTo(n.x - R + d, n.y - R);
      ctx.lineTo(n.x + R + d, n.y + R);
      ctx.stroke();
    }
    ctx.restore();
    ctx.beginPath();                  // ring (in the kind tone) keeps the edge crisp
    ctx.arc(n.x, n.y, R, 0, 2 * Math.PI);
    ctx.strokeStyle = ringCol;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  function repaintSelection() {
    if (!Graph) return;
    Graph.nodeColor(nodeColour);
  }

  function persistTabPartial(partial) {
    if (!tabContext) return;
    setTabConfig(tabContext.slot, tabContext.tabId, partial);
  }

  init();
  if (Graph) rebuildData();
  lastDataRevision = getState().engineRevision;
  // J25: highlight-channel fingerprint — see viewer-3d. A change repaints via
  // the cheap nodeColor accessor (no rebuildData).
  let lastHlSig = highlightSignature(getState());
  let lastPinSig = pinnedSignature(getState());
  let lastTagSig = tagsSignature(getState());
  let lastShowGhosts = ghostsShown();
  let lastShowCit = (getState().view || {}).showCitations === true;
  let lastNodeScale = nodeScale();

  return {
    update(s) {
      syncDeselectBtn(s);
      if (!Graph) return;
      if (s.engineRevision !== lastDataRevision) {
        rebuildData();
        lastDataRevision = s.engineRevision;
        lastSelSig = selectionSignature(s);
        lastHlSig = highlightSignature(s);
        lastPinSig = pinnedSignature(s);
        lastTagSig = tagsSignature(s);
        colourOverlay.refreshOptions();
        return;
      }
      // Selection-only OR highlight-only OR pin-only OR tag-only change: repaint.
      const selSig = selectionSignature(s);
      const selChanged = selSig !== lastSelSig;
      const hlSig = highlightSignature(s);
      const hlChanged = hlSig !== lastHlSig;
      const pinSig = pinnedSignature(s);
      const pinChanged = pinSig !== lastPinSig;
      const tagSig = tagsSignature(s);
      const tagChanged = tagSig !== lastTagSig;
      const showGhosts = (s.view || {}).showGhosts !== false;
      const ghostChanged = showGhosts !== lastShowGhosts;
      const showCit = (s.view || {}).showCitations === true;
      const citChanged = showCit !== lastShowCit;
      const ns = (s.view || {}).nodeScale ?? 1;
      const nodeScaleChanged = ns !== lastNodeScale;
      if (selChanged || hlChanged || pinChanged || tagChanged || ghostChanged || citChanged || nodeScaleChanged) {
        lastSelSig = selSig;
        lastHlSig     = hlSig;
        lastPinSig    = pinSig;
        lastTagSig    = tagSig;
        lastShowGhosts = showGhosts;
        lastShowCit   = showCit;
        if (nodeScaleChanged) {
          lastNodeScale = ns;
          // Re-render at the new radius; ghost hatch reads the scale on repaint.
          Graph.nodeRelSize(DEFAULT_NODE_R * ns);
        }
        // Ghost-incident links depend on showGhosts + showCitations, so either
        // toggle must rebuild the link set (node visibility is reactive, links not).
        if (ghostChanged || citChanged) rebuildData();
        if (tagChanged) colourOverlay.refreshOptions();
        repaintSelection();
      }
    },
    destroy() {
      if (resizeObs) {
        try { resizeObs.disconnect(); } catch (_) {}
        resizeObs = null;
      }
      if (Graph && typeof Graph._destructor === "function") {
        try { Graph._destructor(); } catch (_) {}
      }
      Graph = null;
      container.innerHTML = "";
    },
  };
}

/* ── shared colour-mode overlay ────────────────────────────────────── */
// Same widget as viewer-3d's. Duplicated rather than imported because
// viewer-3d's lives inline in that file; if we add a third viewer,
// promote this to viewer-shared/overlay.js.
function buildColourModeOverlay({ initial, getOptions, onChange }) {
  const root = document.createElement("div");
  root.className = "viewer-3d-colour-mode";    // reuse 3D's styling

  const label = document.createElement("span");
  label.className = "viewer-3d-colour-mode-label";
  label.textContent = "Colour by:";
  root.appendChild(label);

  const select = document.createElement("select");
  select.className = "viewer-3d-colour-mode-select";
  root.appendChild(select);

  let current = initial;

  function rebuildOptions() {
    const opts = getOptions();
    if (current === "cluster:finest") {
      const lastConcrete = opts
        .map(o => o.value)
        .filter(v => /^cluster:\d+$/.test(v))
        .pop();
      if (lastConcrete) {
        current = lastConcrete;
        if (typeof onChange === "function") onChange(current);
      }
    }
    select.innerHTML = "";
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === current) opt.selected = true;
      select.appendChild(opt);
    }
  }

  select.addEventListener("change", () => {
    current = select.value;
    onChange(current);
  });

  rebuildOptions();
  return { root, refreshOptions: rebuildOptions };
}
