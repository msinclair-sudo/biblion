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
import { getState, setTabConfig }      from "../state.js";
import {
  getColourModeOptions, nodeColourFor, DEFAULT_COLOUR_MODE,
} from "../viewer-shared/colour-modes.js";

export const ID = "viewer-2d";
export const LABEL = "2D viewer";
export const DESCRIPTION = "Canvas-based 2D scatter — reads state._basePos2d. Faster than the 3D viewer at large scale; populates once a 2-d viz reduction has run.";
// Same WebGL/teardown reasoning as viewer-3d: one instance.
export const SINGLETON = true;

const DEFAULT_NODE_R = 3;

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
  let lastSelection = null;

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
      .nodeRelSize(DEFAULT_NODE_R)
      .nodeColor(nodeColour)
      .nodeLabel((n) => `#${n.id} · cluster ${n.clusterId} · t=${(n.t ?? 0).toFixed(2)}`)
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
        fx:        s._basePos2d[n.id * 2],       // fx/fy pin position in force-graph
        fy:        s._basePos2d[n.id * 2 + 1],
      });
    }

    // Citation links: drop for now. Adding directed arrows in 2D is
    // doable but clutters the canvas at any density. Could surface as
    // a toggle later.
    const links = [];

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

  return {
    update(s) {
      if (!Graph) return;
      if (s.engineRevision !== lastDataRevision) {
        rebuildData();
        lastDataRevision = s.engineRevision;
        lastSelection = s.selection;
        colourOverlay.refreshOptions();
        return;
      }
      const selChanged =
        !lastSelection ||
        lastSelection.type !== s.selection.type ||
        lastSelection.id   !== s.selection.id;
      if (selChanged) {
        lastSelection = s.selection;
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
