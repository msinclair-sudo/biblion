// 3D viewer panel.
//
// Ports the core 3d-force-graph setup from the legacy main.js into
// the new panel contract: mount(container, state, config) returns
// { update(state), destroy() }. Reads engine outputs from state and
// rebuilds graph data when state.engineRevision bumps.
//
// Live position is the per-frame blend (1-α)·basePos + α·alignedCit.
// The blend hook is registered with d3-force-3d once per panel
// instance; getters read current state every tick so slider drag,
// citation reroll, and regeneration take effect on the next frame.
//
// d3VelocityDecay = 1.0 zeros velocities every tick — the lib's
// `x += vx; vx *= 0` integration becomes a no-op alongside the
// blend hook's direct writes to node.x/y/z. Charge / link / center
// forces are explicitly disabled so nothing fights the blend.
//
// Simplified vs legacy: no debug overlays (origins, centroids,
// noise rings, base edges, structure edges). Keeps just data
// nodes coloured by cluster + citation links. Extra overlays land
// in slice 6 once the panel system is exercised.

import { makeBlendForce }                  from "../../blend/blend.js";
import { buildBaseEdges }                   from "../../base-edges.js";
import { getState, setTabConfig, clearAllHighlights, setSelection } from "../state.js";
import {
  getColourModeOptions, nodeColourFor, DEFAULT_COLOUR_MODE, highlightSignature,
  anyHighlightActive, pinnedSignature, tagsSignature,
  isGhostNode, ghostNodeColour,
} from "../viewer-shared/colour-modes.js";

// Per-edge-kind static styling. Widths + default colours + arrow
// flags live here; runtime colour is read from state.view (the colour
// pickers in the viewer settings popup write there), falling back to
// .colour as a hard-coded backstop when the view-state colour is missing.
const EDGE_STYLE = {
  citation:        { colour: "#8a8a8a", width: 0.3, arrows: true  }, // arrows gated by state.view.citArrows
  base:            { colour: "#5a6878", width: 0.3, arrows: false },
  "structure-edge":{ colour: "#5dd39e", width: 0.6, arrows: false },
};

// Map link.kind → state.view colour-field name. Keeping this as a
// small lookup avoids an if/else cascade in the colour accessor.
const COLOUR_KEY = {
  citation:        "citColour",
  base:            "baseColour",
  "structure-edge":"structureColour",
};

// Base sphere radius before the size-slider multiplier (state.view.nodeScale).
const BASE_NODE_REL = 2;
function nodeScale() { return (getState().view || {}).nodeScale ?? 1; }

export const ID = "viewer-3d";
export const LABEL = "3D viewer";
export const DESCRIPTION = "Live blend visualisation; per-frame interpolation between basePos and aligned citation layout.";
// WebGL context budget + 3d-force-graph teardown noise → only one
// instance allowed across all slots at any time. The panel-picker
// modal filters this out when an instance already exists somewhere.
export const SINGLETON = true;
// Keep the WebGL viewer ALIVE across tab switches — the panel system
// detaches/re-attaches its DOM instead of destroy + remount. Tearing
// 3d-force-graph down and rebuilding it rendered a blank canvas on the
// first switch back (and leaked WebGL contexts). Never destroyed until its
// tab is actually closed.
export const KEEP_ALIVE = true;

const R_GLOBAL = 60;        // matches generation.js's working half-extent

const DEFAULT_CAMERA = {
  // Speeds are 0..1 fractions of TrackballControls' native rate (1.0 native).
  // Defaults of 0.3 are ~3× slower than native for finer control on dense
  // graphs; user can dial up to 1.0 in 0.01 steps via the settings popup.
  rotateSpeed:  0.3,
  zoomSpeed:    0.3,
  panSpeed:     0.3,
  // 3d-force-graph uses TrackballControls. staticMoving=false (its default)
  // gives the camera inertia/coasting after mouse release — the "acceleration"
  // feel. We default to true (no inertia, click-and-stick) and let the user
  // re-enable smooth motion via the settings popup if they want it.
  smoothMotion: false,
};

// Colour-mode helpers + dropdown options + per-node resolver all
// live in viewer-shared/colour-modes.js so the 2D viewer paints the
// same data with the same rules.

export function mount(container, _state, config = {}, tabContext = null) {
  // Apply config defaults — anything missing uses DEFAULT_CAMERA.
  const cam = { ...DEFAULT_CAMERA, ...config };
  let colourMode = config.colourMode || DEFAULT_COLOUR_MODE;

  // The lib needs an absolutely-sized div to anchor itself in.
  container.innerHTML = "";
  container.style.height = "100%";
  container.style.position = "relative";

  const graphDiv = document.createElement("div");
  graphDiv.style.width    = "100%";
  graphDiv.style.height   = "100%";
  graphDiv.style.position = "absolute";
  graphDiv.style.inset    = "0";
  container.appendChild(graphDiv);

  // Empty-state overlay — shown when there's no genResult or no 3-d
  // basePos (real-data mode without a viz reduction picked). Rendered
  // above the graphDiv but below the colour-mode + settings overlays.
  const emptyOverlay = document.createElement("div");
  emptyOverlay.className = "viewer-3d-empty";
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

  // Hoist these so the overlays' callbacks don't hit TDZ if they fire
  // synchronously during build.
  let Graph = null;
  let lastDataRevision = -1;
  let resizeObs = null;
  let lastSelection = null;
  let lastFusionBlend = null;

  // Settings overlay (gear button + popup with sliders).
  const settingsRoot = buildSettingsOverlay(container, cam, (newCam) => {
    Object.assign(cam, newCam);
    applyCameraToControls();
    persistCamConfig(newCam);
  });

  // Colour-mode overlay (top-left dropdown). Updated reactively
  // whenever state changes (e.g. new cluster levels appear).
  const colourOverlay = buildColourModeOverlay({
    initial: colourMode,
    getOptions: () => getColourModeOptions(getState()),
    onChange:  (mode) => {
      colourMode = mode;
      persistTabPartial({ colourMode: mode });
      if (Graph && Graph.refresh) Graph.refresh();
      // also re-paint via accessor re-evaluation
      if (Graph) Graph.nodeColor(nodeColour);
    },
  });
  container.appendChild(colourOverlay.root);

  // Deselect-all control (top-left, under the colour-mode dropdown). Clears the
  // node selection — both the J25 highlight channel and the single
  // state.selection — so the colour-by returns to colouring every node. Shown
  // only while a selection is active (toggled in the reactive update loop).
  const deselectBtn = document.createElement("button");
  deselectBtn.className = "viewer-3d-deselect";
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

  // J20: fusion-blend overlay (bottom-left, vertical). Adopts the global
  // #fusion-blend-row host so it sits over the layout it blends. main.js
  // wires + gates the host's inputs by id; we just relocate it here. The
  // host stays in #blend-control when no viewer is mounted.
  const fusionOverlay = buildFusionBlendOverlay(container);

  // (Graph / lastDataRevision / resizeObs / lastSelection hoisted above)

  function init() {
    if (!window.ForceGraph3D) {
      console.warn("[viewer-3d] ForceGraph3D not loaded yet");
      return;
    }
    const rect = graphDiv.getBoundingClientRect();
    Graph = window.ForceGraph3D()(graphDiv)
      .width(Math.max(1, rect.width))
      .height(Math.max(1, rect.height))
      .backgroundColor("#06080c")
      .nodeRelSize(BASE_NODE_REL * nodeScale())
      .nodeOpacity(1.0)
      .cooldownTicks(Infinity)        // keep ticking forever; blend needs it
      .warmupTicks(60);

    // Disable default forces — blend hook owns positions.
    const charge = Graph.d3Force("charge"); if (charge && charge.strength) charge.strength(0);
    const link   = Graph.d3Force("link");   if (link   && link.strength)   link.strength(0);
    const center = Graph.d3Force("center"); if (center && center.strength) center.strength(0);

    // Blend hook reads state through getters every tick. The active
    // slider is `fusionBlend` = pre-fusion basePos ↔ post-fusion basePos
    // (the citation-aware re-embedding endpoint). The outer basePos ↔
    // citation `blend` slider was removed (J14); makeBlendForce treats a
    // missing getBlend as α = 0.
    Graph.d3Force("blend", makeBlendForce({
      getBasePos:            () => getState()._basePos,
      getBasePosPreFusion:   () => getState()._basePosPreFusion,
      getAlignedCitationPos: () => getState().alignedCitationLayout,
      getFusionBlend:        () => getState().fusionBlend,
    }));
    Graph.d3VelocityDecay(1.0);

    applyCameraToControls();

    Graph.cameraPosition(
      { x: 0, y: 0, z: R_GLOBAL * 4 },
      { x: 0, y: 0, z: 0 },
      0,
    );

    resizeObs = new ResizeObserver((entries) => {
      if (!Graph) return;
      const r = entries[0].contentRect;
      Graph.width(Math.max(1, r.width)).height(Math.max(1, r.height));
    });
    resizeObs.observe(graphDiv);
  }

  // Build node + link arrays from current engine outputs.
  function rebuildData() {
    if (!Graph) return;
    const s = getState();
    if (!s.genResult) {
      showEmptyState("Load or generate a dataset to render.");
      return;
    }
    // Without a 3-d basePos we can't place anything. Real-data ingest
    // hits this path until the user picks a 3-d viz reduction (e.g.
    // UMAP-3) in the dim-reduction layer — that's the lazy-render gate
    // the user asked for: large datasets don't auto-display.
    if (!s._basePos) {
      showEmptyState("Pick a 3-d visualisation reduction in the dim-reduction layer to render this dataset.");
      return;
    }
    hideEmptyState();

    const view = s.view || {};
    // Ghosts off → drop the structural nodes entirely (and, below, any link
    // touching one). A ghost with no embedding still carries citation edges,
    // so hiding the node without its links would orphan-create it.
    const showGhosts = view.showGhosts !== false;
    const isGhostId = (id) => !!(s.genResult.nodes[id] && s.genResult.nodes[id].isGhost);

    const nodes = [];
    const liveById = readLivePositions(Graph);
    for (const n of s.genResult.nodes) {
      if (!showGhosts && n.isGhost) continue;
      const cid = s.clusterResult ? s.clusterResult.nodeCluster[n.id] : -1;
      const seed = liveById.get(n.id);
      // Carry whatever per-node fields the colour modes / labels need.
      // Colours themselves are computed on the fly via the nodeColor
      // accessor (so swapping mode without rebuilding works).
      nodes.push({
        id:        n.id,
        kind:      "node",
        t:         n.t,
        originId:  n.originId,
        clusterId: cid,
        isGhost:   !!n.isGhost,
        x: seed ? seed.x : (s._basePos ? s._basePos[n.id*3]   : 0),
        y: seed ? seed.y : (s._basePos ? s._basePos[n.id*3+1] : 0),
        z: seed ? seed.z : (s._basePos ? s._basePos[n.id*3+2] : 0),
      });
    }

    const linkOk = (a, b) => showGhosts || (!isGhostId(a) && !isGhostId(b));
    const links = [];
    if (view.showCitations && s.citationResult && s.citationResult.citations) {
      for (const c of s.citationResult.citations) {
        if (linkOk(c.source, c.target)) links.push({ source: c.source, target: c.target, kind: "citation" });
      }
    }
    if (view.showStructure && s.clusterResult && s.clusterResult.structureEdges) {
      for (const e of s.clusterResult.structureEdges) {
        if (linkOk(e[0], e[1])) links.push({ source: e[0], target: e[1], kind: "structure-edge" });
      }
    }
    if (view.showBase && s.genResult && s._basePos) {
      // buildBaseEdges reads basePos per node; ensure each node carries
      // it as the helper expects (engine syncs this on every dimred).
      for (const e of buildBaseEdges(s.genResult, view.baseDensity)) {
        if (linkOk(e.source, e.target)) links.push({ source: e.source, target: e.target, kind: "base" });
      }
    }

    Graph
      .nodeColor(nodeColour)
      .nodeOpacity(1.0)
      .nodeVal(() => 1)
      .nodeLabel((n) => `#${n.id} · cluster ${n.clusterId} · t=${(n.t ?? 0).toFixed(2)}`)
      .linkColor(linkColour)
      .linkWidth(linkWidth)
      .linkOpacity(0.9)           // baseline; per-link opacity via linkMaterial below
      .linkMaterial(linkMaterial)
      .linkDirectionalArrowLength(linkArrowLength)
      .linkDirectionalArrowRelPos(1)
      .graphData({ nodes, links });

    Graph.d3ReheatSimulation();
  }

  // Per-link accessors dispatch on `link.kind`.
  function linkColour(l) {
    const view = getState().view || {};
    const key = COLOUR_KEY[l.kind];
    const fromView = key ? view[key] : null;
    if (fromView) return fromView;
    return (EDGE_STYLE[l.kind] && EDGE_STYLE[l.kind].colour) || "#888888";
  }
  function linkWidth(l) {
    return (EDGE_STYLE[l.kind] && EDGE_STYLE[l.kind].width) || 0.5;
  }
  function linkArrowLength(l) {
    // Arrows only on citations, and only when the toggle is on.
    if (l.kind !== "citation") return 0;
    return getState().view && getState().view.citArrows ? 2.2 : 0;
  }

  // 3d-force-graph caches LineBasicMaterials keyed by colour, so two
  // links of the same colour share ONE material instance — which means
  // setting per-link opacity by setting material.opacity mutates every
  // link of that colour. We sidestep the cache by returning a *fresh*
  // material per link (cheap at our edge counts). Opacity per kind
  // comes from state.view; the per-link material is the only path that
  // lets citation opacity vary independently from base / structure.
  function linkMaterial(l) {
    const T = window.THREE;
    if (!T) return null;
    const colour = linkColour(l);
    let opacity = 0.5;
    const v = getState().view || {};
    if (l.kind === "citation")        opacity = clamp01(v.citOpacity ?? 0.6);
    else if (l.kind === "base")       opacity = 0.35;
    else if (l.kind === "structure-edge") opacity = 0.55;
    return new T.LineBasicMaterial({
      color: new T.Color(colour),
      transparent: true,
      opacity,
    });
  }

  function clamp01(x) { return Math.max(0, Math.min(1, +x || 0)); }

  // Cheap fingerprint of state.view — joined string of every field
  // the renderer reads. update() compares against the prior tick's
  // signature to decide whether to rebuild graphData.
  function viewSignature(v) {
    if (!v) return "";
    return [
      v.showCitations ? "1" : "0",
      v.showBase      ? "1" : "0",
      v.showStructure ? "1" : "0",
      v.citArrows     ? "1" : "0",
      v.showGhosts === false ? "0" : "1",
      (+v.citOpacity  || 0).toFixed(3),
      (+v.baseDensity || 0).toFixed(4),
      v.citColour       || "",
      v.baseColour      || "",
      v.structureColour || "",
    ].join(":");
  }

  // Single delegation to the shared resolver (mode + selection dim). Ghosts are
  // the exception: spheres can't hatch cheaply (the 2D viewer does the real
  // hatch), so a ghost renders in a distinct flat GHOST_COLOUR — but still
  // pinned/dimmed via the same envelope as nodeColourFor so a selection focus
  // greys non-selected ghosts too.
  function nodeColour(n) {
    const s = getState();
    if (isGhostNode(n, s)) return ghostNodeColour(n, s);
    return nodeColourFor(n, s, colourMode);
  }

  // Re-evaluate node colours without rebuilding graphData. Cheap;
  // 3d-force-graph re-reads the colour accessor on refresh().
  function repaintSelection() {
    if (!Graph) return;
    Graph.nodeColor(nodeColour);
    if (Graph.refresh) Graph.refresh();
  }

  // Snapshot the previous tick's live positions so a rebuild
  // (cluster recolour, citation reroll, etc.) doesn't reset nodes
  // back to basePos.
  function readLivePositions(graph) {
    const m = new Map();
    if (!graph) return m;
    const prev = graph.graphData();
    if (prev && prev.nodes) {
      for (const n of prev.nodes) {
        if (n.kind !== "node") continue;
        m.set(n.id, { x: n.x, y: n.y, z: n.z });
      }
    }
    return m;
  }

  // Apply the current camera-speed values to the live controls.
  // Called on init and whenever the settings overlay changes them.
  function applyCameraToControls() {
    if (!Graph) return;
    const ctrls = Graph.controls();
    if (!ctrls) return;
    ctrls.rotateSpeed = cam.rotateSpeed;
    ctrls.zoomSpeed   = cam.zoomSpeed;
    ctrls.panSpeed    = cam.panSpeed;
    // staticMoving is the TrackballControls switch for "no inertia."
    // dynamicDampingFactor only matters when staticMoving=false; we
    // still set it so toggling smoothMotion back on gives a sensible
    // damping rate without the user having to find another knob.
    ctrls.staticMoving           = !cam.smoothMotion;
    ctrls.dynamicDampingFactor   = cam.smoothMotion ? 0.2 : 0;
    // OrbitControls equivalent — kept defensive in case 3d-force-graph
    // is ever switched to controlType('orbit'). Otherwise no-op.
    if ("enableDamping" in ctrls) ctrls.enableDamping = !!cam.smoothMotion;
  }

  // Persist the camera config back into our tab's config so values
  // survive a panel re-mount (data reload / panel switch). The tab
  // context is supplied at mount; without it we silently no-op
  // (e.g. a stand-alone usage outside the panel system).
  function persistCamConfig(_partial) {
    if (!tabContext) return;
    setTabConfig(tabContext.slot, tabContext.tabId, { ...cam });
  }

  // Same for colour-mode and other tab-local config bits.
  function persistTabPartial(partial) {
    if (!tabContext) return;
    setTabConfig(tabContext.slot, tabContext.tabId, partial);
  }

  // Initial mount.
  init();
  if (Graph) rebuildData();
  lastDataRevision = getState().engineRevision;
  lastFusionBlend  = getState().fusionBlend;
  let lastNodeScale = getState().view?.nodeScale ?? 1;
  let lastViewSig  = viewSignature(getState().view);
  // J25: highlight-channel fingerprint — a change here repaints colours via the
  // cheap nodeColor accessor (no rebuildData / engine recompute).
  let lastHlSig    = highlightSignature(getState());
  // Pinned (white-emphasis) set — repaint via the nodeColor accessor on change.
  let lastPinSig   = pinnedSignature(getState());
  // Tag set — repaint when tags change so "colour by tag" updates live.
  let lastTagSig   = tagsSignature(getState());

  return {
    update(s) {
      // Toggle the deselect-all control whenever selection state changes
      // (cheap; independent of the Graph being ready).
      syncDeselectBtn(s);
      if (!Graph) return;
      // Rebuild on either: new engine output, or view-flag change
      // (citation/base/structure toggles, opacity, density, arrows).
      // View-only rebuilds are cheap — same node positions (restored
      // via readLivePositions) and at toy/dev-subset sizes the link
      // arrays are small.
      const dataChanged = s.engineRevision !== lastDataRevision;
      const viewSig     = viewSignature(s.view);
      const viewChanged = viewSig !== lastViewSig;
      if (dataChanged || viewChanged) {
        rebuildData();
        lastDataRevision = s.engineRevision;
        lastViewSig      = viewSig;
        lastSelection    = s.selection;
        if (dataChanged) {
          // New engine output may have added/removed cluster levels —
          // refresh the dropdown options.
          colourOverlay.refreshOptions();
        }
        return;
      }

      // Fusion-slider change: d3-force-3d's tick loop quiesces when the
      // network looks settled (instantly true under deterministic
      // blending), so the blend hook stops firing and slider drags go
      // ignored. Reheat + resume so the tick loop runs again and the
      // hook picks up the new fusionBlend. Matches the legacy shell's
      // behaviour (main.js:1270-1277).
      if (s.fusionBlend !== lastFusionBlend) {
        lastFusionBlend = s.fusionBlend;
        try { Graph.d3ReheatSimulation(); }   catch (_) {}
        try { Graph.resumeAnimation();   }   catch (_) {}
      }

      // Node size-slider change: live-resize spheres, no graph rebuild.
      const ns = s.view?.nodeScale ?? 1;
      if (ns !== lastNodeScale) {
        lastNodeScale = ns;
        try { Graph.nodeRelSize(BASE_NODE_REL * ns); } catch (_) {}
        try { Graph.refresh(); } catch (_) {}
      }

      // Selection-only OR highlight-only change: re-paint colours, no rebuild.
      // Both flow through the same cheap nodeColor accessor (repaintSelection),
      // which the shared resolver now composes the highlight glow into.
      const selChanged =
        !lastSelection ||
        lastSelection.type !== s.selection.type ||
        lastSelection.id   !== s.selection.id;
      const hlSig = highlightSignature(s);
      const hlChanged = hlSig !== lastHlSig;
      const pinSig = pinnedSignature(s);
      const pinChanged = pinSig !== lastPinSig;
      const tagSig = tagsSignature(s);
      const tagChanged = tagSig !== lastTagSig;
      if (selChanged || hlChanged || pinChanged || tagChanged) {
        lastSelection = s.selection;
        lastHlSig     = hlSig;
        lastPinSig    = pinSig;
        lastTagSig    = tagSig;
        // The "Tag" colour option appears once tags exist / disappears when the
        // last is removed — keep the dropdown in sync at that boundary.
        if (tagChanged) colourOverlay.refreshOptions();
        repaintSelection();
      }
    },
    destroy() {
      if (resizeObs) {
        try { resizeObs.disconnect(); } catch (_) {}
        resizeObs = null;
      }
      // J19: re-park the relocated edge-controls host (hidden) back on the
      // body before tearing the overlay down, so its ec-* inputs survive and
      // a later viewer remount can re-adopt them.
      const edgeHost = document.getElementById("edge-controls-host");
      if (edgeHost) {
        edgeHost.hidden = true;
        document.body.appendChild(edgeHost);
      }
      // J20: re-park the relocated fusion-blend row (hidden) back on the body
      // before tearing the overlay down, so its inputs + main.js wiring/gating
      // survive and a later viewer remount can re-adopt them. Strip the
      // overlay's vertical-orientation inline styling so a re-adopt starts clean.
      const fusionRow = document.getElementById("fusion-blend-row");
      if (fusionRow) {
        fusionRow.removeAttribute("style");
        fusionRow.style.display = "none";
        document.body.appendChild(fusionRow);
      }
      if (fusionOverlay) fusionOverlay.remove();
      if (settingsRoot) settingsRoot.remove();
      if (colourOverlay && colourOverlay.root) colourOverlay.root.remove();

      const g = Graph;
      Graph = null;

      if (g) {
        // Tear down 3d-force-graph SYNCHRONOUSLY and in an order that
        // actually stops it. The old code deferred _destructor() to a RAF,
        // which leaked one WebGL context + a running animation loop PER
        // teardown — after enough tab switches the browser hits its
        // ~16-context limit and the live viewer's context is lost (the
        // "crash" on switching back).
        //
        //   1. pause the render/tick loop;
        //   2. dispose the controls;
        //   3. run the destructor NOW to release the WebGL context.
        //
        // A frame queued just before step 1 can still fire its tick after
        // the destructor nulled the layout — an unavoidable internal
        // 3d-force-graph bug. swallowStaleTick() below catches just that
        // one error for a moment so it can't surface as uncaught.
        // (Note: do NOT call graphData({}) here — it RESTARTS the animation
        // loop, undoing pauseAnimation.)
        const swallowStaleTick = (e) => {
          const msg = (e && (e.message || (e.error && e.error.message))) || "";
          if (/reading '?tick'?/.test(msg)) {
            e.preventDefault();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          }
        };
        window.addEventListener("error", swallowStaleTick, true);
        setTimeout(() => window.removeEventListener("error", swallowStaleTick, true), 1500);

        try { g.pauseAnimation && g.pauseAnimation(); } catch (_) {}
        try {
          const c = g.controls && g.controls();
          if (c && c.dispose) c.dispose();
        } catch (_) {}
        try { g._destructor && g._destructor(); } catch (_) {}
      }

      container.innerHTML = "";
    },
  };
}

/* ── colour-mode overlay (top-left) ────────────────────────────────── */

function buildColourModeOverlay({ initial, getOptions, onChange }) {
  const root = document.createElement("div");
  root.className = "viewer-3d-colour-mode";

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

    // Migrate the legacy `cluster:finest` alias to a concrete level
    // once levels are available, so the dropdown reflects the real
    // selection. Old saved tab configs may still hold the alias.
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

  return {
    root,
    refreshOptions: rebuildOptions,
  };
}

/* ── fusion-blend overlay (bottom-left, vertical) ──────────────────────── */

// Relocate the global #fusion-blend-row host into a bottom-left overlay and
// orient its range input vertically. The host's inputs (#fusion-blend-slider
// / #fusion-blend-readout) are wired + show/hide-gated by main.js by id, so
// this function only handles placement + orientation, never wiring. Returns
// the overlay root (or null if the host isn't present) so mount()/destroy()
// can add + remove it. appendChild relocates the existing element, keeping
// its wiring intact (same approach as the J19 edge-controls host).
function buildFusionBlendOverlay(container) {
  const fusionRow = document.getElementById("fusion-blend-row");
  if (!fusionRow) return null;

  const root = document.createElement("div");
  root.className = "viewer-3d-fusion-blend";
  // No CSS class is styled for this overlay (viewer-3d.css is owned
  // elsewhere), so position + orient inline. z-index sits above the empty
  // overlay (5) and level with the other corner overlays (10).
  root.style.position = "absolute";
  root.style.left = "8px";
  root.style.bottom = "8px";
  root.style.zIndex = "10";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.alignItems = "center";
  root.style.gap = "6px";
  root.style.padding = "8px 6px";
  root.style.background = "rgba(40, 44, 52, 0.85)";
  root.style.border = "1px solid var(--border-light)";
  root.style.borderRadius = "3px";
  root.style.userSelect = "none";

  // Vertical orientation: a column flex with the range input flipped to run
  // bottom→top. writing-mode is the standards-track way; the WebKit appearance
  // hint covers older Chromium. The label sits above, the readout below.
  fusionRow.style.display = "flex";
  fusionRow.style.flexDirection = "column";
  fusionRow.style.alignItems = "center";
  fusionRow.style.gap = "6px";
  fusionRow.style.margin = "0";

  const slider = fusionRow.querySelector("#fusion-blend-slider");
  if (slider) {
    slider.style.writingMode = "vertical-lr";
    slider.style.direction = "rtl";              // 0 at the bottom, 1 at the top
    slider.style.webkitAppearance = "slider-vertical";
    slider.style.width = "auto";
    slider.style.height = "120px";
  }

  root.appendChild(fusionRow);
  container.appendChild(root);
  return root;
}

/* ── settings overlay ───────────────────────────────────────────────── */

function buildSettingsOverlay(container, cam, onChange) {
  const root = document.createElement("div");
  root.className = "viewer-3d-settings";

  const toggle = document.createElement("button");
  toggle.className = "viewer-3d-settings-toggle";
  toggle.title = "Camera speed";
  toggle.textContent = "⚙";
  root.appendChild(toggle);

  const popup = document.createElement("div");
  popup.className = "viewer-3d-settings-popup";

  const heading = document.createElement("h4");
  heading.textContent = "Camera";
  popup.appendChild(heading);

  popup.appendChild(speedRow("Rotate", "rotateSpeed", cam.rotateSpeed, cam, onChange));
  popup.appendChild(speedRow("Zoom",   "zoomSpeed",   cam.zoomSpeed,   cam, onChange));
  popup.appendChild(speedRow("Pan",    "panSpeed",    cam.panSpeed,    cam, onChange));

  popup.appendChild(toggleRow(
    "Smooth motion",
    "smoothMotion",
    cam.smoothMotion,
    cam,
    onChange,
    "Camera inertia after mouse release. Off = click-and-stick.",
  ));

  const hint = document.createElement("div");
  hint.style.fontSize = "10px";
  hint.style.color = "var(--text-faint)";
  hint.style.marginTop = "6px";
  hint.textContent = "0–1 fraction of native speed";
  popup.appendChild(hint);

  // J19: adopt the relocated edge colour/toggle controls. The host
  // (#edge-controls-host) is a global singleton in index.html — main.js's
  // mountEdgeControls wires its ec-* inputs once at boot. We just move the
  // host into this popup so the controls live with the viewer they drive.
  // appendChild relocates the existing element (keeps wiring intact).
  const edgeHost = document.getElementById("edge-controls-host");
  if (edgeHost) {
    const edgeHeading = document.createElement("h4");
    edgeHeading.textContent = "Edges";
    popup.appendChild(edgeHeading);
    edgeHost.hidden = false;
    popup.appendChild(edgeHost);
  }

  root.appendChild(popup);
  container.appendChild(root);

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    popup.classList.toggle("open");
  });
  // Click outside the popup closes it.
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) popup.classList.remove("open");
  });

  return root;
}

function toggleRow(labelText, key, value, cam, onChange, title = "") {
  const row = document.createElement("div");
  row.className = "viewer-3d-settings-row toggle";
  row.title = title;

  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);

  const wrap = document.createElement("div");
  wrap.style.gridColumn = "2 / 4";
  wrap.style.display = "flex";
  wrap.style.justifyContent = "flex-end";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!value;
  input.addEventListener("change", (e) => {
    cam[key] = e.target.checked;
    onChange({ [key]: e.target.checked });
  });
  wrap.appendChild(input);
  row.appendChild(wrap);

  return row;
}

function speedRow(labelText, key, value, cam, onChange) {
  const row = document.createElement("div");
  row.className = "viewer-3d-settings-row";

  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);

  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = "1";
  input.step = "0.01";
  input.value = String(value);
  row.appendChild(input);

  const readout = document.createElement("span");
  readout.className = "readout";
  readout.textContent = (+value).toFixed(2);
  row.appendChild(readout);

  input.addEventListener("input", (e) => {
    const v = +e.target.value;
    cam[key] = v;
    readout.textContent = v.toFixed(2);
    onChange({ [key]: v });
  });

  return row;
}
