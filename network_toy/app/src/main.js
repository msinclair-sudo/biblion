// Boot + UI glue.
//
// Production shell: topbar (File, Citations, Debug, Settings, Generate, seed),
// left panel (cluster + citation top-level levers), canvas, right panel
// (cluster legend), bottom bar (edge / node display).
//
// Layered pipeline (each step is a pure module):
//   1. Generation       — Gaussian-mixture sampling (generation.js)
//   2. Clustering       — mutual k-NN over all nodes (clustering.js)
//   3. Neighbourhoods   — mutual k-NN inside each cluster (neighbourhoods.js)
//   4. Taste            — Stages 2 + 3 of dynamics §3 (citation-taste.js)
//   5. Pair sampling    — Stage 4 of dynamics §3 (citations.js)
//
// Each step has its own seed where it makes sense and its own rerun lane.
// Modules don't mutate inputs.

import { generate, defaultGenerationParams, R_GLOBAL } from "./generation.js";
import {
  buildDebugGraph, colourForLink as genColourForLink,
  buildVolumeOutline, buildOriginMarker, debugFlags,
} from "./generation-debug.js";
import { getAlgorithm, listAlgorithms } from "./clustering-registry.js";
import { validateClusterResult } from "./contracts/cluster.js";
import { adjustedRandIndex } from "./eval/ari.js";
import { kmeans } from "./eval/kmeans.js";
import { sweepAlgorithm } from "./eval/sweep.js";
import {
  decorateGraphData as decorateClusterDebug, buildCentroidMarker,
  buildNoiseDecoratedNode, clusterDebugFlags,
} from "./clustering-debug.js";
import { inferNeighbourhoods, defaultNeighbourhoodParams } from "./neighbourhoods.js";
import { buildCitationTaste, defaultTasteParams } from "./citation-taste.js";
import { generateCitations, defaultCitationParams } from "./citations.js";
import {
  decorateGraphData as decorateCitations, citationViewFlags, colourByInDegree,
} from "./citations-debug.js";
import { buildBaseEdges } from "./base-edges.js";
import { makeBlendForce } from "./blend/blend.js";
import { alignByComponent } from "./blend/align.js";
import {
  getAlgorithm as getCitationLayoutAlgorithm,
  listAlgorithms as listCitationLayoutAlgorithms,
} from "./citation-layout/registry.js";
import { sweepLayouts } from "./eval/layout-sweep.js";
import {
  physicsDebugFlags,
  buildDisplacementOverlay, updateDisplacementOverlay,
} from "./physics-debug.js";

const $ = (id) => document.getElementById(id);

const state = {
  // Committed generation params — what the canvas currently shows.
  params: defaultGenerationParams(),
  result: null,

  // Clustering params + result. The active algorithm is `method`; each
  // algorithm gets its own params bag in `byAlgo[id]` so switching back
  // and forth doesn't lose what you'd dialled in for either. Changing
  // either the method OR a slider in the active algorithm's modal
  // reruns the clustering pipeline.
  clusterParams: initialClusterParams(),
  clusterResult: null,

  // Neighbourhoods (Stage 1). neighbourK is in the citation modal; changing
  // it reruns from neighbourhoods downward.
  neighbourhoodParams: defaultNeighbourhoodParams(),
  neighbourhoodResult: null,

  // Taste (Stages 2 + 3). All knobs live in the citation modal.
  tasteParams: defaultTasteParams(),
  tasteResult: null,

  // Pair sampling (Stage 4). Top-level levers (density / intra / cross)
  // live in the left panel; ε's and seed live in the modal.
  citationParams: defaultCitationParams(),
  citationResult: null,

  // Layer 4 — citation-driven layout (Float32Array(n×3)). Recomputed
  // when the citation graph changes via relayoutCitations(); per-frame
  // blend reads this verbatim. Configured via citationLayoutParams.
  // alignmentCorrelation is the [0, 1] correlation coefficient between
  // the aligned citation layout and basePos — surfaced in the
  // citation-layout modal as a quality metric and used as the ranking
  // metric for the layout sweep ("Find best params").
  citationLayout:        null,
  alignedCitationLayout: null,
  alignmentCorrelation:  NaN,
  citationLayoutParams:  initialCitationLayoutParams(),

  // Layer 5 — blend. `blend` is the slider value in [0, 1]: 0 means
  // "show me basePos", 1 means "show me alignedCitationPos". `frozen`
  // pauses the d3 tick loop. _basePos is the flat Float32Array(n×3)
  // form of basePos, populated at generation time and consumed by the
  // blend force every tick alongside alignedCitationLayout.
  blend: 0.0,
  frozen: false,
  _basePos: null,

  // Render mode (bottom bar). "cluster" is the production default.
  colourBy: "cluster",

  // Edge visuals — render-only, no physics impact. Mirrors v1 fields.
  view: {
    showBase:        false,
    baseDensity:     0.05,
    baseGamma:       0.3,        // power transform for base opacity
    baseColour:      "#888888",
    citGamma:        0.3,        // direct linear opacity for citations
    citColour:       "#ff6b35",
    citArrows:       false,      // arrows show direction but get messy
  },
};

let Graph = null;
let volumeObject = null;
let displacementObject = null;

/* ── clustering: registry-backed access ─────────────────────────────────── */

// Initial cluster params: method = first registered algorithm, with each
// algorithm's defaults pre-populated so switching never reads `undefined`.
function initialClusterParams() {
  const algos = listAlgorithms();
  const byAlgo = {};
  for (const a of algos) byAlgo[a.id] = a.defaultParams();
  return { method: algos[0].id, byAlgo };
}

// Initial citation-layout params. Single algorithm registered today
// (Fruchterman–Reingold); structure mirrors clusterParams so future
// algorithms can plug in.
function initialCitationLayoutParams() {
  const algo = getCitationLayoutAlgorithm("fruchterman-reingold");
  return { method: algo.id, params: algo.defaultParams() };
}

function activeAlgorithm() {
  return getAlgorithm(state.clusterParams.method);
}

function activeAlgorithmParams() {
  return state.clusterParams.byAlgo[state.clusterParams.method];
}

/* ── pipeline orchestration ─────────────────────────────────────────────── */
/* Each stage runs only when something at or above it has changed.
 * Helpers re-render at the end so callers don't forget. */

function regenerate() {
  state.result = generate(state.params);
  precomputeBasePos();           // basePos as a flat Float32Array(n×3)
  // Reseed live positions to basePos so blend=0 is a clean visual no-op.
  // (Saved via liveById if you want them preserved across regens — we
  // explicitly do NOT here, because regen changes the embedding.)
  resetLivePositions();
  recluster();
}

// Flatten basePos into a Float32Array(n × 3) for fast iteration in the
// blend force and the alignment pass. Recomputed once per regeneration.
function precomputeBasePos() {
  const nodes = state.result.nodes;
  const n = nodes.length;
  const bp = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = nodes[i].basePos;
    bp[i*3] = p[0]; bp[i*3+1] = p[1]; bp[i*3+2] = p[2];
  }
  state._basePos = bp;
}

// Drop any live position cache so the next graph rebuild seeds nodes at
// basePos. Used after a regen (the embedding has changed; old positions
// are nonsense).
function resetLivePositions() {
  state._liveById = null;
}

function recluster() {
  // Registry-driven dispatch. The active algorithm decides how to cluster;
  // its params live under state.clusterParams.byAlgo[method]. Whatever it
  // returns gets validated against the contract before anything downstream
  // reads it — that catches a contract violation the moment a new algorithm
  // is added.
  const algo = activeAlgorithm();
  state.clusterResult = algo.infer(state.result, activeAlgorithmParams());
  validateClusterResult(state.clusterResult, state.result.nodes.length, {
    allowNoise: !!algo.allowsNoise,
  });
  rebuildClusterLegend();
  reneighbour();
}

function reneighbour() {
  state.neighbourhoodResult = inferNeighbourhoods(
    state.result, state.clusterResult, state.neighbourhoodParams,
  );
  retaste();
}

function retaste() {
  state.tasteResult = buildCitationTaste(
    state.clusterResult, state.neighbourhoodResult, state.tasteParams,
  );
  resample();
}

function resample() {
  state.citationResult = generateCitations(
    state.result, state.clusterResult, state.neighbourhoodResult,
    state.tasteResult, state.citationParams,
  );
  // The citation graph changed → the citation-driven layout needs to
  // be recomputed, then re-aligned to basePos. The blend force
  // consumes alignedCitationLayout every tick, so this is what makes
  // a citation reroll visible at any blend > 0.
  relayoutCitations();
  updateStatus();
  updateCitationStatus();
  loadGraphData();
  if (Graph && !state.frozen) {
    Graph.d3ReheatSimulation();
    Graph.resumeAnimation();
  }
}

// Compute the FR layout of the citation graph and align it per-component
// to basePos. Pure function call — runs once when the citation graph
// changes, cached in state.{citationLayout, alignedCitationLayout}.
function relayoutCitations() {
  if (!state.result || !state.citationResult) return;
  const n = state.result.nodes.length;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = state.result.nodes[i].t;
  const algo = getCitationLayoutAlgorithm(state.citationLayoutParams.method);
  state.citationLayout = algo.compute({
    n,
    edges: state.citationResult.citations.map(c => [c.source, c.target]),
    t,
    // Layout seed derives from the citation sampling seed so the layout
    // is deterministic in lock-step with the citation graph itself.
    seed: state.citationParams.samplingSeed,
    params: state.citationLayoutParams.params,
  });
  const alignResult = alignByComponent({
    basePos:    state._basePos,
    citationPos: state.citationLayout,
    edges:      state.citationResult.citations.map(c => [c.source, c.target]),
    n,
  });
  state.alignedCitationLayout = alignResult.aligned;
  state.alignmentCorrelation  = alignResult.correlation;
}

function updateStatus() {
  const r = state.result, c = state.clusterResult, n = state.neighbourhoodResult, ct = state.citationResult;
  $("status").textContent =
    `seed=${state.params.seed} · origins=${r.origins.length} · ` +
    `nodes=${r.nodes.length} · clusters=${c.clusters.length} · ` +
    `Ng=${n.neighbourhoods.length} · citations=${ct.citations.length}`;
}

function updateCitationStatus() {
  const p = state.citationResult.pools;
  $("cit-status").textContent =
    `intra ${p.intraPicked}/${p.intraValid} · cross ${p.crossPicked}/${p.crossValid}`;
}

/* ── render ─────────────────────────────────────────────────────────────── */

function colourForNode(node) {
  // Centroid markers always wear their cluster colour, regardless of mode.
  if (node.kind === "centroid") {
    return state.clusterResult.clusters[node.clusterId].colour;
  }
  // Origin markers always wear their origin colour.
  if (node.kind === "origin") {
    return state.result.origins[node.originId].colour;
  }
  // Data nodes follow the bottom-bar colour-by selector.
  switch (state.colourBy) {
    case "cluster": {
      const cid = state.clusterResult.nodeCluster[node.id];
      return state.clusterResult.clusters[cid].colour;
    }
    case "origin":
      return state.result.origins[node.originId].colour;
    case "indegree":
      return colourByInDegree(state.citationResult.inDeg, node.id);
    case "uniform":
    default:
      return "#cfd8e3";
  }
}

function colourForLink(link) {
  if (link.kind === "citation")      return state.view.citColour;
  if (link.kind === "base")          return state.view.baseColour;
  if (link.kind === "structure-edge") return "#5dd39e";   // cluster-debug
  return genColourForLink(link, state.result.origins);
}

// Per-link opacity. Base uses a power transform (mid-tones matter most when
// fading dense base edges); citations are direct linear opacity for precise
// brightness control.
function opacityForLink(link) {
  if (link.kind === "base") {
    const g = Math.max(0.05, state.view.baseGamma || 1);
    return Math.pow(0.5, 1 / g);
  }
  if (link.kind === "citation") {
    return Math.max(0.02, Math.min(1, state.view.citGamma ?? 1));
  }
  if (link.kind === "structure-edge") return 0.55;
  return 0.4;
}

function loadGraphData() {
  // Snapshot the previous graph's live positions so a rebuild (toggling a
  // debug overlay, changing citation rates, etc) doesn't reset nodes back
  // to basePos. After a regen, `state._liveById` is null so we fall back
  // to seeding from basePos.
  if (Graph) {
    const prev = Graph.graphData();
    if (prev && prev.nodes) {
      const m = new Map();
      for (const n of prev.nodes) {
        if (n.kind !== "node") continue;
        m.set(n.id, { x: n.x, y: n.y, z: n.z, vx: n.vx ?? 0, vy: n.vy ?? 0, vz: n.vz ?? 0 });
      }
      state._liveById = m;
    }
  }
  const data = buildDebugGraph(state.result, state._liveById);
  decorateClusterDebug(data, state.clusterResult);
  decorateCitations(data, state.citationResult);
  if (state.view.showBase) {
    for (const e of buildBaseEdges(state.result, state.view.baseDensity)) {
      data.links.push(e);
    }
  }
  const T = window.THREE;
  Graph
    .nodeColor(colourForNode)
    .nodeVal((n) => (n.kind === "origin" || n.kind === "centroid") ? 0.001 : 1)
    .nodeRelSize(2)
    .nodeThreeObject((n) => {
      if (n.kind === "origin") return buildOriginMarker(T, state.result.origins[n.originId]);
      if (n.kind === "centroid") return buildCentroidMarker(T, state.clusterResult.clusters[n.clusterId]);
      // Data nodes: only return a custom mesh when the noise-rings overlay
      // is on AND this node was flagged as noise by the algorithm. The
      // helper bundles a coloured sphere (replacement for the lib's
      // default) plus the ring so we can keep nodeThreeObjectExtend(false)
      // and stay consistent with origin / centroid markers.
      if (clusterDebugFlags.showNoiseRings) {
        const flags = state.clusterResult.noiseFlags;
        if (flags && flags[n.id] === 1) {
          return buildNoiseDecoratedNode(T, colourForNode(n));
        }
      }
      return null;
    })
    .nodeThreeObjectExtend(false)
    .nodeLabel((n) => {
      if (n.kind === "origin")   return `origin ${n.originId} (anchor)`;
      if (n.kind === "centroid") return `centroid · cluster ${n.clusterId}`;
      const cid = state.clusterResult.nodeCluster[n.id];
      return `#${n.id} · origin ${n.originId} · cluster ${cid} · t=${n.t.toFixed(2)}`;
    })
    .linkColor(colourForLink)
    .linkOpacity(0.9)              // overridden per-link via linkMaterial below
    .linkMaterial((l) => getLinkMaterial(l))
    .linkWidth((l) => {
      if (l.kind === "citation")    return 0.9;
      if (l.kind === "structure-edge") return 0.6;
      if (l.kind === "base")        return 0.3;
      return 0.3;
    })
    .linkDirectionalArrowLength((l) => (l.kind === "citation" && state.view.citArrows) ? 2.2 : 0)
    .linkDirectionalArrowRelPos(1)
    .graphData(data);

  ensureVolumeOutline();
  ensureDisplacementOverlay();
  installPerLinkOpacityHook();
}

/* per-link material ownership: 3d-force-graph caches LineBasicMaterials /
   MeshLambertMaterials internally, indexed by colour string — multiple
   links of the same colour share ONE material instance. That's fatal for
   per-link opacity (last writer wins) AND for live colour updates (lib
   doesn't re-evaluate the colour accessor every frame; tension changes
   every frame, so it would never propagate). We bypass the cache by
   handing the lib a fresh MeshLambertMaterial per link via the
   linkMaterial accessor. The lib uses our material as-is and never
   replaces it. We then own colour + opacity, updated every frame in the
   rAF tick below. WeakMap keyed on the link object means materials are
   GC'd when graphData() rebuilds links. */
const _linkMatCache = new WeakMap();
function getLinkMaterial(link) {
  let m = _linkMatCache.get(link);
  if (!m) {
    const T = window.THREE;
    m = new T.MeshLambertMaterial({ transparent: true, depthWrite: false });
    _linkMatCache.set(link, m);
  }
  return m;
}
function installPerLinkOpacityHook() {
  if (installPerLinkOpacityHook._installed) return;
  installPerLinkOpacityHook._installed = true;
  const tick = () => {
    if (Graph) {
      const data = Graph.graphData();
      const links = data.links;
      for (const l of links) {
        const m = _linkMatCache.get(l);
        if (!m) continue;
        m.opacity = opacityForLink(l);
        const c = colourForLink(l);
        if (m.__lastColour !== c) {
          m.color.set(c);
          m.__lastColour = c;
        }
      }
      if (physicsDebugFlags.showDisplacement && displacementObject && state.result) {
        updateDisplacementOverlay(
          displacementObject,
          data.nodes,
          (id) => state.result.nodes[id]?.basePos,
        );
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function ensureVolumeOutline() {
  if (!Graph) return;
  const T = window.THREE;
  if (!T) return;
  const scene = Graph.scene();
  if (volumeObject) {
    scene.remove(volumeObject);
    volumeObject.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    volumeObject = null;
  }
  if (debugFlags.showVolume) {
    volumeObject = buildVolumeOutline(T, state.result.R);
    scene.add(volumeObject);
  }
}

// Same lifecycle pattern as ensureVolumeOutline. Rebuilds when the data
// node count changes (so a regen with a different N gets a correctly-sized
// vertex buffer).
function ensureDisplacementOverlay() {
  if (!Graph) return;
  const T = window.THREE;
  if (!T || !state.result) return;
  const scene = Graph.scene();
  const wantN = state.result.nodes.length;
  const haveN = displacementObject
    ? displacementObject.geometry.attributes.position.array.length / 6
    : 0;
  const sizeMismatch = displacementObject && haveN !== wantN;
  if (displacementObject && (!physicsDebugFlags.showDisplacement || sizeMismatch)) {
    scene.remove(displacementObject);
    displacementObject.geometry.dispose();
    displacementObject.material.dispose();
    displacementObject = null;
  }
  if (physicsDebugFlags.showDisplacement && !displacementObject) {
    displacementObject = buildDisplacementOverlay(T, wantN);
    scene.add(displacementObject);
  }
}

/* ── cluster legend ─────────────────────────────────────────────────────── */

function rebuildClusterLegend() {
  const root = $("cluster-legend");
  root.innerHTML = "";
  for (const c of state.clusterResult.clusters) {
    const row = document.createElement("div");
    row.className = "cluster-row";
    // Stability is optional per the contract — only show it for
    // algorithms that compute it (HDBSCAN). NaN values are suppressed.
    const stabFrag = Number.isFinite(c.stability)
      ? ` · S=${c.stability.toFixed(1)}`
      : "";
    row.innerHTML = `
      <span class="swatch" style="background:${c.colour}"></span>
      <span>cluster ${c.id}</span>
      <span class="meta">n=${c.count} · σ=${c.spread.toFixed(1)}${stabFrag}</span>
    `;
    root.appendChild(row);
  }
}

/* ── dropdown menus ─────────────────────────────────────────────────────── */

function bindDropdowns() {
  const menus = document.querySelectorAll(".menu");
  for (const m of menus) {
    const trigger = m.querySelector(":scope > .tb-btn");
    if (!trigger) continue;
    trigger.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = m.classList.contains("open");
      for (const mm of menus) mm.classList.remove("open");
      if (!wasOpen) m.classList.add("open");
    };
  }
  document.addEventListener("click", () => {
    for (const m of menus) m.classList.remove("open");
  });
  for (const m of menus) {
    const list = m.querySelector(":scope > .menu-list");
    if (list) list.addEventListener("click", (e) => e.stopPropagation());
  }
}

/* ── debug overlay toggles ──────────────────────────────────────────────── */

function bindDebugToggles() {
  // Generation overlays.
  $("dbg-origins").checked      = debugFlags.showOrigins;
  $("dbg-origin-edges").checked = debugFlags.showOriginEdges;
  $("dbg-volume").checked       = debugFlags.showVolume;
  $("dbg-origins").onchange      = (e) => { debugFlags.showOrigins     = e.target.checked; loadGraphData(); };
  $("dbg-origin-edges").onchange = (e) => { debugFlags.showOriginEdges = e.target.checked; loadGraphData(); };
  $("dbg-volume").onchange       = (e) => { debugFlags.showVolume      = e.target.checked; ensureVolumeOutline(); };

  // Clustering overlays.
  $("dbg-centroids").checked     = clusterDebugFlags.showCentroids;
  $("dbg-structure-edges").checked  = clusterDebugFlags.showStructureEdges;
  $("dbg-noise-rings").checked   = clusterDebugFlags.showNoiseRings;
  $("dbg-centroids").onchange    = (e) => { clusterDebugFlags.showCentroids   = e.target.checked; loadGraphData(); };
  $("dbg-structure-edges").onchange = (e) => { clusterDebugFlags.showStructureEdges = e.target.checked; loadGraphData(); };
  $("dbg-noise-rings").onchange  = (e) => { clusterDebugFlags.showNoiseRings  = e.target.checked; loadGraphData(); };

  $("dbg-displacement").checked  = physicsDebugFlags.showDisplacement;
  $("dbg-displacement").onchange = (e) => { physicsDebugFlags.showDisplacement = e.target.checked; ensureDisplacementOverlay(); };
}

/* ── settings modal ─────────────────────────────────────────────────────── */

let pending = null;

function openSettings() {
  pending = { ...state.params };
  $("set-nodes").value         = pending.nodeCount;
  $("set-nodes-range").value   = pending.nodeCount;
  $("set-origins").value       = pending.pointsOfOrigin;
  $("set-origins-range").value = pending.pointsOfOrigin;
  $("set-spread-range").value  = pending.spreadScale;
  $("set-spread-val").textContent = (+pending.spreadScale).toFixed(2);
  $("settings-modal").classList.add("open");
}
function closeSettings() {
  $("settings-modal").classList.remove("open");
  pending = null;
}
function commitSettingsAndGenerate() {
  if (!pending) return;
  pending.nodeCount      = Math.max(1, Math.min(2000, pending.nodeCount | 0));
  pending.pointsOfOrigin = Math.max(1, Math.min(pending.nodeCount, pending.pointsOfOrigin | 0));
  pending.spreadScale    = Math.max(0, +pending.spreadScale || 1);
  state.params = { ...state.params, ...pending };
  closeSettings();
  regenerate();
}
function bindSettings() {
  $("btn-settings").onclick   = openSettings;
  $("settings-close").onclick = closeSettings;
  $("settings-x").onclick     = closeSettings;
  $("settings-generate").onclick = commitSettingsAndGenerate;
  $("settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("settings-modal").classList.contains("open")) closeSettings();
  });

  const syncNodes = (v) => {
    v = Math.max(1, Math.min(2000, parseInt(v, 10) || 1));
    $("set-nodes").value = v;
    $("set-nodes-range").value = v;
    if (pending) pending.nodeCount = v;
    if (pending && pending.pointsOfOrigin > v) {
      pending.pointsOfOrigin = v;
      $("set-origins").value = v;
      $("set-origins-range").value = v;
    }
  };
  $("set-nodes").oninput       = (e) => syncNodes(e.target.value);
  $("set-nodes-range").oninput = (e) => syncNodes(e.target.value);

  const syncOrigins = (v) => {
    const cap = pending ? pending.nodeCount : 2000;
    v = Math.max(1, Math.min(cap, parseInt(v, 10) || 1));
    $("set-origins").value = v;
    $("set-origins-range").value = v;
    if (pending) pending.pointsOfOrigin = v;
  };
  $("set-origins").oninput       = (e) => syncOrigins(e.target.value);
  $("set-origins-range").oninput = (e) => syncOrigins(e.target.value);

  $("set-spread-range").oninput = (e) => {
    const v = +e.target.value;
    $("set-spread-val").textContent = v.toFixed(2);
    if (pending) pending.spreadScale = v;
  };
}

/* ── topbar (Generate, seed, Freeze) ────────────────────────────────────── */

function bindTopbar() {
  $("seed-input").value = state.params.seed;
  $("seed-input").onchange = (e) => {
    state.params.seed = parseInt(e.target.value, 10) || 0;
    regenerate();
  };
  $("btn-generate").onclick = () => regenerate();
  $("btn-freeze").onclick = () => {
    state.frozen = !state.frozen;
    $("btn-freeze").classList.toggle("active", state.frozen);
    if (!Graph) return;
    if (state.frozen) Graph.pauseAnimation();
    else              Graph.resumeAnimation();
  };
}

/* ── topbar: Cluster ▾ menu + cluster settings modal ────────────────────── */
/* The menu is built from the registry (one item per algorithm). Picking
 * an item commits that method to state and opens the cluster-settings
 * modal preloaded with that algorithm's pending params. The modal body
 * is rendered from the algorithm's modalSchema, so adding an algorithm
 * needs no UI code here. */

let clusterPending = null;          // { method, params } staged for Apply

function bindClusterMenu() {
  const list = $("menu-cluster-list");
  list.innerHTML = "";
  for (const algo of listAlgorithms()) {
    const btn = document.createElement("button");
    btn.className = "menu-item";
    btn.textContent = algo.label;
    btn.onclick = () => {
      $("menu-cluster").classList.remove("open");
      openClusterModal(algo.id);
    };
    list.appendChild(btn);
  }
}

function bindClusterModal() {
  $("cluster-modal-cancel").onclick = closeClusterModal;
  $("cluster-modal-x").onclick      = closeClusterModal;
  $("cluster-modal-apply").onclick  = commitClusterModalAndApply;
  $("cluster-modal").addEventListener("click", (e) => {
    if (e.target.id === "cluster-modal") closeClusterModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("cluster-modal").classList.contains("open")) closeClusterModal();
  });
}

function openClusterModal(methodId) {
  const algo = getAlgorithm(methodId);
  // Stage pending params: shallow-copy whatever the user dialled in last
  // time for this algorithm. If the user has never touched it, byAlgo
  // already holds defaultParams() (set during initialClusterParams()).
  clusterPending = {
    method: algo.id,
    params: { ...state.clusterParams.byAlgo[algo.id] },
  };
  $("cluster-modal-title").textContent = algo.label + " — settings";
  renderClusterModalBody(algo, clusterPending.params);
  $("cluster-modal").classList.add("open");
}

function closeClusterModal() {
  $("cluster-modal").classList.remove("open");
  clusterPending = null;
}

function commitClusterModalAndApply() {
  if (!clusterPending) return;
  // Commit pending → state. The pending bag may include keys clamped /
  // typed by the schema renderer, so trust it as-is.
  state.clusterParams.byAlgo[clusterPending.method] = { ...clusterPending.params };
  state.clusterParams.method = clusterPending.method;
  closeClusterModal();
  recluster();
}

// Render one row per modalSchema entry. This is intentionally simple —
// just range / int sliders for now. If a future algorithm needs a
// different control type, extend this and add the kind to the schema.
function renderClusterModalBody(algo, params) {
  const body = $("cluster-modal-body");
  body.innerHTML = "";

  if (algo.description) {
    const note = document.createElement("div");
    note.style.cssText = "font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:12px;";
    note.textContent = algo.description;
    body.appendChild(note);
  }

  const cols = document.createElement("div");
  cols.className = "cluster-modal-cols";
  body.appendChild(cols);

  const left = document.createElement("div");
  left.className = "cluster-modal-settings";
  cols.appendChild(left);

  const right = document.createElement("div");
  right.className = "cluster-modal-eval";
  cols.appendChild(right);

  renderClusterSettings(left, algo, params, () => updateLiveAri(algo, params));
  renderClusterEval(right, algo, params);
}

function renderClusterSettings(container, algo, params, onChange) {
  container.innerHTML = "";
  for (const field of algo.modalSchema) {
    const row = document.createElement("div");
    row.className = "field";

    const label = document.createElement("label");
    label.textContent = field.label;
    row.appendChild(label);

    if (field.kind === "select") {
      const select = document.createElement("select");
      select.style.cssText = "grid-column: 2 / 4; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); padding: 4px 6px; border-radius: 3px; font-size: 12px;";
      for (const opt of field.options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        select.appendChild(o);
      }
      select.value = String(params[field.key]);
      select.onchange = (e) => { params[field.key] = e.target.value; onChange(); };
      row.appendChild(select);
    } else {
      const range = document.createElement("input");
      range.type = "range";
      range.min  = String(field.min);
      range.max  = String(field.max);
      range.step = String(field.step);
      range.value = String(params[field.key]);
      row.appendChild(range);

      const val = document.createElement("span");
      val.className = "val";
      val.textContent = field.format(params[field.key]);
      row.appendChild(val);

      range.oninput = (e) => {
        let v = +e.target.value;
        if (field.kind === "int") v = v | 0;
        params[field.key] = v;
        val.textContent = field.format(v);
        onChange();
      };
    }

    container.appendChild(row);

    if (field.hint) {
      const hint = document.createElement("div");
      hint.style.cssText = "grid-column: 1 / -1; font-size:10px;color:var(--muted);line-height:1.4;margin:-4px 0 6px;";
      hint.textContent = field.hint;
      container.appendChild(hint);
    }
  }
}

/* ── cluster eval column ────────────────────────────────────────────────── */
/* Live ARI vs the generator's originId labels, plus an on-demand grid sweep
 * to find the parameter combination that maximises ARI. The k-means(k=K)
 * baseline gives a "what's achievable if you knew the right K" reference;
 * density-based methods should approach it on well-separated mixtures and
 * fall short on overlapping ones. Cached per generation so re-opening the
 * modal doesn't re-run the baseline. */

let _kmeansCache = { genId: -1, ari: NaN, k: 0 };

function renderClusterEval(container, algo, params) {
  container.innerHTML = "";
  if (!state.result || !state.result.nodes || state.result.nodes.length === 0) {
    container.innerHTML = "<div class='eval-empty'>Generate first to enable evaluation.</div>";
    return;
  }

  const groundTruth = new Int32Array(state.result.nodes.map((n) => n.originId));
  const K = state.result.origins.length;

  const head = document.createElement("h3");
  head.textContent = "Evaluation";
  container.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "eval-meta";
  meta.innerHTML = `Ground truth: <code>originId</code> · ${K} components, ${groundTruth.length} nodes. ARI vs originId — 1.0 = perfect, 0.0 = chance.`;
  container.appendChild(meta);

  const liveRow = document.createElement("div");
  liveRow.className = "eval-row live";
  liveRow.innerHTML = `<span>current params</span><span class="ari" id="eval-live-ari">—</span>`;
  container.appendChild(liveRow);

  const kmRow = document.createElement("div");
  kmRow.className = "eval-row";
  kmRow.innerHTML = `<span>k-means(k=${K}) baseline</span><span class="ari" id="eval-kmeans-ari">computing…</span>`;
  container.appendChild(kmRow);

  const btn = document.createElement("button");
  btn.className = "tb-btn";
  btn.id = "eval-sweep-btn";
  btn.textContent = "Find best params";
  btn.style.cssText = "margin-top: 14px; width: 100%;";
  btn.onclick = () => runClusterSweep(algo, params, groundTruth, container);
  container.appendChild(btn);

  const status = document.createElement("div");
  status.className = "sweep-status";
  status.id = "eval-sweep-status";
  container.appendChild(status);

  const results = document.createElement("div");
  results.id = "eval-sweep-results";
  results.style.cssText = "margin-top: 8px;";
  container.appendChild(results);

  updateLiveAri(algo, params);
  updateKmeansBaseline(K);
}

function updateLiveAri(algo, params) {
  const el = document.getElementById("eval-live-ari");
  if (!el) return;
  if (!state.result || state.result.nodes.length === 0) { el.textContent = "—"; return; }
  const groundTruth = new Int32Array(state.result.nodes.map((n) => n.originId));
  try {
    const r = algo.infer(state.result, params);
    const ari = adjustedRandIndex(r.nodeCluster, groundTruth);
    el.textContent = formatAri(ari) + ` · ${r.clusters.length} clusters`;
  } catch (e) {
    el.textContent = "error";
    console.error("[eval] live ARI failed:", e);
  }
}

function updateKmeansBaseline(K) {
  const el = document.getElementById("eval-kmeans-ari");
  if (!el) return;
  // Cache by the generation result identity so repeated modal opens don't
  // recompute. state.result is replaced wholesale on regenerate(), so a
  // simple identity check is enough.
  const genId = state.result;
  if (_kmeansCache.genId === genId && _kmeansCache.k === K) {
    el.textContent = formatAri(_kmeansCache.ari);
    return;
  }
  // Yield to the renderer once so "computing…" is visible before we block.
  setTimeout(() => {
    const truth = new Int32Array(state.result.nodes.map((n) => n.originId));
    const points = state.result.nodes.map((n) => n.basePos);
    const { labels } = kmeans(points, K, { restarts: 5 });
    const ari = adjustedRandIndex(labels, truth);
    _kmeansCache = { genId, ari, k: K };
    if (el && el.isConnected) el.textContent = formatAri(ari);
  }, 0);
}

function runClusterSweep(algo, params, groundTruth, container) {
  const btn = document.getElementById("eval-sweep-btn");
  const status = document.getElementById("eval-sweep-status");
  const resultsBox = document.getElementById("eval-sweep-results");
  btn.disabled = true;
  btn.textContent = "Sweeping…";
  status.textContent = "running grid…";
  resultsBox.innerHTML = "";

  // Yield so the disabled state and "running" text actually paint before the
  // synchronous sweep blocks the main thread.
  setTimeout(() => {
    const t0 = performance.now();
    const { top, totalCombos } = sweepAlgorithm(algo, state.result, groundTruth, params, 5);
    const dt = performance.now() - t0;

    btn.disabled = false;
    btn.textContent = "Find best params";
    status.textContent = `${totalCombos} combos in ${dt.toFixed(0)}ms · top 5 by ARI:`;
    renderSweepResults(resultsBox, top, algo, params, container);
  }, 0);
}

function renderSweepResults(container, top, algo, params, evalContainer) {
  container.innerHTML = "";
  if (top.length === 0) {
    container.innerHTML = "<div class='eval-empty'>No results.</div>";
    return;
  }
  for (const row of top) {
    const div = document.createElement("div");
    div.className = "sweep-row";
    div.innerHTML = `
      <span class="ari">${formatAri(row.ari)}</span>
      <div>
        <div class="params">${formatParamsShort(algo, row.params)}</div>
        <div class="count">${row.numClusters} clusters${row.error ? " · error: " + row.error : ""}</div>
      </div>
    `;
    const apply = document.createElement("button");
    apply.className = "tb-btn";
    apply.textContent = "Apply";
    apply.title = "Stage these params into the sliders. Press Apply at the bottom to commit.";
    apply.onclick = () => applySweepRow(algo, params, row.params);
    div.appendChild(apply);
    container.appendChild(div);
  }
}

function applySweepRow(algo, params, newParams) {
  for (const k of Object.keys(newParams)) params[k] = newParams[k];
  // Re-render only the settings column so the eval column (sweep results)
  // stays put. Then refresh live ARI to reflect the new pending state.
  const left = document.querySelector(".cluster-modal-settings");
  if (left) renderClusterSettings(left, algo, params, () => updateLiveAri(algo, params));
  updateLiveAri(algo, params);
}

function formatAri(ari) {
  if (!Number.isFinite(ari)) return "—";
  return ari.toFixed(3);
}

// Compact one-liner of the params suitable for a sweep-row label. Uses the
// modal schema for ordering and (where present) the field's `format` to
// render the value.
function formatParamsShort(algo, params) {
  const parts = [];
  for (const field of algo.modalSchema) {
    const v = params[field.key];
    if (v === undefined) continue;
    const rendered = (typeof field.format === "function") ? field.format(v) : String(v);
    parts.push(`${field.label}=${rendered}`);
  }
  return parts.join(" · ");
}

/* ── topbar: Citation Layout ▾ menu + citation-layout settings modal ────── */
/* Mirrors the Cluster ▾ pattern. Menu is built from the citation-layout
 * registry — one item per algorithm. Picking one opens the settings modal
 * preloaded with that algorithm's pending params; the body is rendered
 * from modalSchema via renderClusterSettings (which is algorithm-generic
 * despite its name). */

let citationLayoutPending = null;        // { method, params } staged for Apply

function bindCitationLayoutMenu() {
  const list = $("menu-citlayout-list");
  list.innerHTML = "";
  for (const algo of listCitationLayoutAlgorithms()) {
    const btn = document.createElement("button");
    btn.className = "menu-item";
    btn.textContent = algo.label;
    btn.onclick = () => {
      $("menu-citlayout").classList.remove("open");
      openCitationLayoutModal(algo.id);
    };
    list.appendChild(btn);
  }
}

function bindCitationLayoutModal() {
  $("citlayout-modal-cancel").onclick = closeCitationLayoutModal;
  $("citlayout-modal-x").onclick      = closeCitationLayoutModal;
  $("citlayout-modal-apply").onclick  = commitCitationLayoutModalAndApply;
  $("citlayout-modal").addEventListener("click", (e) => {
    if (e.target.id === "citlayout-modal") closeCitationLayoutModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("citlayout-modal").classList.contains("open")) closeCitationLayoutModal();
  });
}

function openCitationLayoutModal(methodId) {
  const algo = getCitationLayoutAlgorithm(methodId);
  // If the user is opening a DIFFERENT algorithm than the active one,
  // load that algorithm's defaults — current params are for the old
  // algorithm and probably have keys that don't apply (and miss keys
  // that do). If they're opening the SAME algorithm, preserve their
  // current settings.
  const params = (methodId === state.citationLayoutParams.method)
    ? { ...state.citationLayoutParams.params }
    : algo.defaultParams();
  citationLayoutPending = { method: algo.id, params };
  $("citlayout-modal-title").textContent = algo.label + " — settings";
  renderCitationLayoutModalBody(algo, citationLayoutPending.params);
  $("citlayout-modal").classList.add("open");
}

function closeCitationLayoutModal() {
  $("citlayout-modal").classList.remove("open");
  citationLayoutPending = null;
}

function commitCitationLayoutModalAndApply() {
  if (!citationLayoutPending) return;
  state.citationLayoutParams.method = citationLayoutPending.method;
  state.citationLayoutParams.params = { ...citationLayoutPending.params };
  closeCitationLayoutModal();
  // Layout params changed → recompute citationLayout + alignedCitationLayout.
  // Don't re-roll citations; only the LAYOUT depends on these params.
  relayoutCitations();
  if (Graph && !state.frozen) {
    Graph.d3ReheatSimulation();
    Graph.resumeAnimation();
  }
}

function renderCitationLayoutModalBody(algo, params) {
  const body = $("citlayout-modal-body");
  body.innerHTML = "";
  if (algo.description) {
    const note = document.createElement("div");
    note.style.cssText = "font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:12px;";
    note.textContent = algo.description;
    body.appendChild(note);
  }
  // Settings fields. Reuse the cluster-modal field renderer (it's
  // algorithm-generic — iterates modalSchema, dispatches on field.kind).
  // onChange schedules a debounced live correlation update — recomputing
  // a layout per slider tick is ~50–100ms, too laggy without debouncing.
  const settings = document.createElement("div");
  body.appendChild(settings);
  renderClusterSettings(settings, algo, params, () => scheduleLiveCorrelation(algo, params));

  // Evaluation section. Mirrors the cluster modal's eval column but
  // simpler — there's no ground truth like originId for layout, so we
  // use the alignment correlation coefficient (0 = uncorrelated, 1 =
  // perfectly aligned to basePos) as the quality metric.
  renderCitationLayoutEval(body, algo, params);
}

/* ── citation layout eval ──────────────────────────────────────────────── */
/* Live alignment correlation for the pending params + a "Find best params"
 * sweep across BOTH layout algorithms × their sweepValues. Single ranking
 * metric (the correlation coefficient) so user can directly compare what
 * each (algorithm, params) combo produces against basePos's structure. */

let _layoutLiveTimer = null;

function renderCitationLayoutEval(container, algo, params) {
  const wrap = document.createElement("div");
  wrap.id = "citlayout-eval";
  wrap.style.cssText = "border-top: 1px solid var(--line); margin-top: 14px; padding-top: 12px;";
  container.appendChild(wrap);

  const head = document.createElement("h3");
  head.style.cssText = "font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px;";
  head.textContent = "Evaluation";
  wrap.appendChild(head);

  const meta = document.createElement("div");
  meta.style.cssText = "font-size: 10px; color: var(--muted); margin-bottom: 10px; line-height: 1.4;";
  meta.innerHTML = "Alignment correlation between this layout and basePos. 0 = uncorrelated random; 1 = perfectly aligned (i.e. basePos itself). Higher = layout reproduces more of basePos's structure.";
  wrap.appendChild(meta);

  const liveRow = document.createElement("div");
  liveRow.style.cssText = "display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0; border-bottom: 1px solid var(--line); margin-bottom: 8px;";
  liveRow.innerHTML = `<span>current params</span><span class="ari" id="citlayout-live-corr" style="font-variant-numeric: tabular-nums; font-weight: 600;">computing…</span>`;
  wrap.appendChild(liveRow);

  const btn = document.createElement("button");
  btn.className = "tb-btn";
  btn.id = "citlayout-sweep-btn";
  btn.textContent = "Find best params";
  btn.style.cssText = "margin-top: 6px; width: 100%;";
  btn.onclick = () => runLayoutSweep();
  wrap.appendChild(btn);

  const status = document.createElement("div");
  status.style.cssText = "font-size: 10px; color: var(--muted); margin-top: 6px;";
  status.id = "citlayout-sweep-status";
  wrap.appendChild(status);

  const results = document.createElement("div");
  results.id = "citlayout-sweep-results";
  results.style.cssText = "margin-top: 8px;";
  wrap.appendChild(results);

  // Initial live correlation: prefer the cached value (already
  // computed during the most recent relayoutCitations) so the modal
  // opens instantly without recomputing. Recompute only on param
  // change.
  if (algo.id === state.citationLayoutParams.method && Number.isFinite(state.alignmentCorrelation)) {
    document.getElementById("citlayout-live-corr").textContent = state.alignmentCorrelation.toFixed(3);
  } else {
    scheduleLiveCorrelation(algo, params);
  }
}

function scheduleLiveCorrelation(algo, params) {
  if (_layoutLiveTimer) clearTimeout(_layoutLiveTimer);
  const el = document.getElementById("citlayout-live-corr");
  if (el) el.textContent = "computing…";
  // Debounce: the layout compute is ~50–100 ms, too laggy to run on
  // every slider input event. 200 ms after the last change is enough
  // for the user to read but cheap enough to feel responsive.
  _layoutLiveTimer = setTimeout(() => {
    _layoutLiveTimer = null;
    updateLiveLayoutCorrelation(algo, params);
  }, 200);
}

function updateLiveLayoutCorrelation(algo, params) {
  const el = document.getElementById("citlayout-live-corr");
  if (!el) return;
  if (!state.result || !state.citationResult) { el.textContent = "—"; return; }
  const n = state.result.nodes.length;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = state.result.nodes[i].t;
  const edges = state.citationResult.citations.map((c) => [c.source, c.target]);
  try {
    const positions = algo.compute({ n, edges, t, seed: state.citationParams.samplingSeed, params });
    const r = alignByComponent({ basePos: state._basePos, citationPos: positions, edges, n });
    el.textContent = Number.isFinite(r.correlation) ? r.correlation.toFixed(3) : "—";
  } catch (e) {
    el.textContent = "error";
    console.error("[layout-eval] live correlation failed:", e);
  }
}

function runLayoutSweep() {
  const btn = document.getElementById("citlayout-sweep-btn");
  const status = document.getElementById("citlayout-sweep-status");
  const resultsBox = document.getElementById("citlayout-sweep-results");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Sweeping…";
  status.textContent = "running grid…";
  resultsBox.innerHTML = "";

  // Yield to the renderer once so the disabled state paints before
  // the synchronous sweep blocks the main thread.
  setTimeout(() => {
    if (!state.result || !state.citationResult) {
      btn.disabled = false;
      btn.textContent = "Find best params";
      status.textContent = "no data — generate first";
      return;
    }
    const n = state.result.nodes.length;
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = state.result.nodes[i].t;
    const edges = state.citationResult.citations.map((c) => [c.source, c.target]);

    const t0 = performance.now();
    const { top, totalCombos } = sweepLayouts({
      n, edges, t,
      basePos: state._basePos,
      baseSeed: state.citationParams.samplingSeed,
      topN: 6,
    });
    const dt = performance.now() - t0;

    btn.disabled = false;
    btn.textContent = "Find best params";
    status.textContent = `${totalCombos} combos in ${dt.toFixed(0)}ms · top ${top.length} by correlation:`;
    renderLayoutSweepResults(resultsBox, top);
  }, 0);
}

function renderLayoutSweepResults(container, top) {
  container.innerHTML = "";
  if (top.length === 0) {
    container.innerHTML = "<div style='color:var(--muted);font-style:italic;padding:6px 0;'>No results.</div>";
    return;
  }
  for (const row of top) {
    const div = document.createElement("div");
    div.style.cssText = "display: grid; grid-template-columns: 50px 1fr auto; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px dashed var(--line); font-size: 11px;";

    const corr = document.createElement("span");
    corr.style.cssText = "font-variant-numeric: tabular-nums; font-weight: 600;";
    corr.textContent = Number.isFinite(row.correlation) ? row.correlation.toFixed(3) : "—";
    div.appendChild(corr);

    const middle = document.createElement("div");
    const algoLabel = document.createElement("div");
    algoLabel.textContent = row.algoLabel;
    algoLabel.style.cssText = "color: var(--text); font-size: 11px;";
    middle.appendChild(algoLabel);
    const paramsLine = document.createElement("div");
    paramsLine.textContent = formatLayoutParams(row.method, row.params);
    paramsLine.style.cssText = "color: var(--muted); font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 10px; line-height: 1.4;";
    middle.appendChild(paramsLine);
    if (row.error) {
      const err = document.createElement("div");
      err.textContent = "error: " + row.error;
      err.style.cssText = "color: #e15759; font-size: 10px;";
      middle.appendChild(err);
    }
    div.appendChild(middle);

    const apply = document.createElement("button");
    apply.className = "tb-btn";
    apply.textContent = "Apply";
    apply.style.cssText = "padding: 2px 6px; font-size: 10px;";
    apply.title = "Switch to this (algorithm, params) combo and recompute the citation layout. Closes this modal.";
    apply.onclick = () => applyLayoutSweepRow(row);
    div.appendChild(apply);

    container.appendChild(div);
  }
}

function formatLayoutParams(method, params) {
  // Lookup the algorithm's modalSchema for nice label/format; fall
  // back to JSON-ish if the schema doesn't recognise a key.
  const algo = getCitationLayoutAlgorithm(method);
  const parts = [];
  for (const field of algo.modalSchema) {
    const v = params[field.key];
    if (v === undefined) continue;
    const rendered = (typeof field.format === "function") ? field.format(v) : String(v);
    parts.push(`${field.label}=${rendered}`);
  }
  return parts.join(" · ");
}

function applyLayoutSweepRow(row) {
  state.citationLayoutParams.method = row.method;
  state.citationLayoutParams.params = { ...row.params };
  closeCitationLayoutModal();
  relayoutCitations();
  if (Graph && !state.frozen) {
    Graph.d3ReheatSimulation();
    Graph.resumeAnimation();
  }
}

/* ── left panel: blend ──────────────────────────────────────────────────── */

function bindForceControls() {
  $("blend-input").value = state.blend;
  $("blend-val").textContent = state.blend.toFixed(2);
  // Slider drag: blend value is a pure deterministic mix between basePos
  // and alignedCitationPos. There's no constraint solver to settle, but
  // d3-force-3d's internal simAlpha decays over time and freezes ticks
  // when the network "looks settled" — which is instant under deterministic
  // blending. Reheat each drag so the lib keeps ticking and our blend
  // force hook keeps firing.
  $("blend-input").oninput = (e) => {
    state.blend = +e.target.value;
    $("blend-val").textContent = state.blend.toFixed(2);
    if (!Graph) return;
    if (state.frozen) return;
    Graph.d3ReheatSimulation();
    Graph.resumeAnimation();
  };
}

/* ── left panel: citations ──────────────────────────────────────────────── */

function bindCitationControls() {
  const p = state.citationParams;
  $("cit-density").value     = p.density;     $("cit-density-val").textContent = p.density.toFixed(2);
  $("cit-intra").value       = p.intraRate;   $("cit-intra-val").textContent   = p.intraRate.toFixed(2);
  $("cit-cross").value       = p.crossRate;   $("cit-cross-val").textContent   = p.crossRate.toFixed(2);
  $("cit-seed").value        = p.samplingSeed;

  $("cit-density").oninput = (e) => {
    p.density = +e.target.value;
    $("cit-density-val").textContent = p.density.toFixed(2);
    resample();
  };
  $("cit-intra").oninput = (e) => {
    p.intraRate = +e.target.value;
    $("cit-intra-val").textContent = p.intraRate.toFixed(2);
    resample();
  };
  $("cit-cross").oninput = (e) => {
    p.crossRate = +e.target.value;
    $("cit-cross-val").textContent = p.crossRate.toFixed(2);
    resample();
  };
  $("cit-seed").onchange = (e) => {
    p.samplingSeed = parseInt(e.target.value, 10) || 0;
    resample();
  };
  $("cit-randomize").onclick = () => {
    p.samplingSeed = Math.floor(Math.random() * 1e9);
    $("cit-seed").value = p.samplingSeed;
    resample();
  };
}

/* ── citation settings modal (apply-on-Apply) ──────────────────────────── */
// All the deeper citation knobs live here, including the Stage 1 / Stage 2
// + 3 / Stage 4 controls. Like the generation modal, a local buffer holds
// pending changes; Apply commits them and fires the right rerun lane.

let citPending = null;

function openCitationModal() {
  citPending = {
    neighbourK:    state.neighbourhoodParams.neighbourK,
    favouritesMean: state.tasteParams.favouritesMean,
    sharedTaste:    state.tasteParams.sharedTaste,
    tasteRange:     state.tasteParams.tasteRange,
    transitiveBoost:state.tasteParams.transitiveBoost,
    tasteSeed:      state.tasteParams.tasteSeed,
    density:        state.citationParams.density,
    intraRate:      state.citationParams.intraRate,
    crossRate:      state.citationParams.crossRate,
    epsilonIntra:   state.citationParams.epsilonIntra,
    epsilonCross:   state.citationParams.epsilonCross,
    samplingSeed:   state.citationParams.samplingSeed,
  };
  // hydrate inputs from pending
  hydrateCitModal();
  updateCitationModalStatus();
  $("cit-modal").classList.add("open");
}
function closeCitationModal() {
  $("cit-modal").classList.remove("open");
  citPending = null;
}
function commitCitationModalAndApply() {
  if (!citPending) return;

  // Detect which stage(s) changed so we can pick the cheapest rerun.
  const np = state.neighbourhoodParams;
  const tp = state.tasteParams;
  const cp = state.citationParams;

  const neighChanged =
    citPending.neighbourK !== np.neighbourK;
  const tasteChanged = neighChanged ||
    citPending.favouritesMean   !== tp.favouritesMean   ||
    citPending.sharedTaste      !== tp.sharedTaste      ||
    citPending.tasteRange       !== tp.tasteRange       ||
    citPending.transitiveBoost  !== tp.transitiveBoost  ||
    citPending.tasteSeed        !== tp.tasteSeed;
  // Sampling always re-runs at minimum (cheap, and the user clicked Apply).

  // Commit pending → state.
  np.neighbourK      = Math.max(1, citPending.neighbourK | 0);
  tp.favouritesMean  = Math.max(0.1, +citPending.favouritesMean);
  tp.sharedTaste     = Math.max(0,   +citPending.sharedTaste);
  tp.tasteRange      = Math.max(0.5, +citPending.tasteRange);
  tp.transitiveBoost = Math.max(0,   Math.min(1, +citPending.transitiveBoost));
  tp.tasteSeed       = citPending.tasteSeed | 0;
  cp.density         = Math.max(0, Math.min(1, +citPending.density));
  cp.intraRate       = Math.max(0, Math.min(1, +citPending.intraRate));
  cp.crossRate       = Math.max(0, Math.min(1, +citPending.crossRate));
  cp.epsilonIntra    = Math.max(0, +citPending.epsilonIntra);
  cp.epsilonCross    = Math.max(0, +citPending.epsilonCross);
  cp.samplingSeed    = citPending.samplingSeed | 0;

  // Sync the left-panel sliders so they reflect what we just committed.
  syncCitationLeftPanel();

  closeCitationModal();
  if (neighChanged)      reneighbour();
  else if (tasteChanged) retaste();
  else                   resample();
}

function hydrateCitModal() {
  const p = citPending;
  $("cm-density").value     = p.density;     $("cm-density-val").textContent     = p.density.toFixed(2);
  $("cm-intra").value       = p.intraRate;   $("cm-intra-val").textContent       = p.intraRate.toFixed(2);
  $("cm-cross").value       = p.crossRate;   $("cm-cross-val").textContent       = p.crossRate.toFixed(2);
  $("cm-eps-intra").value   = p.epsilonIntra;$("cm-eps-intra-val").textContent   = p.epsilonIntra.toFixed(3);
  $("cm-eps-cross").value   = p.epsilonCross;$("cm-eps-cross-val").textContent   = p.epsilonCross.toFixed(3);
  $("cm-sampling-seed").value = p.samplingSeed;
  $("cm-neighbourk").value  = p.neighbourK;  $("cm-neighbourk-val").textContent  = String(p.neighbourK);
  $("cm-fav-mean").value    = p.favouritesMean; $("cm-fav-mean-val").textContent  = (+p.favouritesMean).toFixed(1);
  $("cm-shared").value      = p.sharedTaste; $("cm-shared-val").textContent      = (+p.sharedTaste).toFixed(2);
  $("cm-taste-range").value = p.tasteRange;  $("cm-taste-range-val").textContent = (+p.tasteRange).toFixed(1);
  $("cm-trans").value       = p.transitiveBoost; $("cm-trans-val").textContent   = (+p.transitiveBoost).toFixed(2);
  $("cm-taste-seed").value  = p.tasteSeed;
}

function updateCitationModalStatus() {
  const p = state.citationResult.pools;
  $("cm-status").textContent =
    `intra ${p.intraPicked} / ${p.intraValid}    cross ${p.crossPicked} / ${p.crossValid}`;
}

function syncCitationLeftPanel() {
  const p = state.citationParams;
  $("cit-density").value = p.density;     $("cit-density-val").textContent = p.density.toFixed(2);
  $("cit-intra").value   = p.intraRate;   $("cit-intra-val").textContent   = p.intraRate.toFixed(2);
  $("cit-cross").value   = p.crossRate;   $("cit-cross-val").textContent   = p.crossRate.toFixed(2);
  $("cit-seed").value    = p.samplingSeed;
}

function bindCitationModal() {
  $("cit-settings-open").onclick = openCitationModal;
  $("cit-modal-cancel").onclick  = closeCitationModal;
  $("cit-modal-x").onclick       = closeCitationModal;
  $("cit-modal-apply").onclick   = commitCitationModalAndApply;
  $("cit-modal").addEventListener("click", (e) => {
    if (e.target.id === "cit-modal") closeCitationModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("cit-modal").classList.contains("open")) closeCitationModal();
  });

  // Each input mutates the pending buffer. No commit → no side effects.
  const bindRange = (id, valId, key, fmt) => {
    $(id).oninput = (e) => {
      const v = +e.target.value;
      if (citPending) citPending[key] = v;
      $(valId).textContent = fmt(v);
    };
  };
  bindRange("cm-density",   "cm-density-val",   "density",        v => v.toFixed(2));
  bindRange("cm-intra",     "cm-intra-val",     "intraRate",      v => v.toFixed(2));
  bindRange("cm-cross",     "cm-cross-val",     "crossRate",      v => v.toFixed(2));
  bindRange("cm-eps-intra", "cm-eps-intra-val", "epsilonIntra",   v => v.toFixed(3));
  bindRange("cm-eps-cross", "cm-eps-cross-val", "epsilonCross",   v => v.toFixed(3));
  bindRange("cm-fav-mean",  "cm-fav-mean-val",  "favouritesMean", v => v.toFixed(1));
  bindRange("cm-shared",    "cm-shared-val",    "sharedTaste",    v => v.toFixed(2));
  bindRange("cm-taste-range","cm-taste-range-val","tasteRange",   v => v.toFixed(1));
  bindRange("cm-trans",     "cm-trans-val",     "transitiveBoost",v => v.toFixed(2));

  $("cm-neighbourk").oninput = (e) => {
    const v = (+e.target.value) | 0;
    if (citPending) citPending.neighbourK = v;
    $("cm-neighbourk-val").textContent = String(v);
  };
  $("cm-sampling-seed").onchange = (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    if (citPending) citPending.samplingSeed = v;
  };
  $("cm-taste-seed").onchange = (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    if (citPending) citPending.tasteSeed = v;
  };
  $("cm-sampling-randomize").onclick = () => {
    const v = Math.floor(Math.random() * 1e9);
    $("cm-sampling-seed").value = v;
    if (citPending) citPending.samplingSeed = v;
  };
  $("cm-taste-randomize").onclick = () => {
    const v = Math.floor(Math.random() * 1e9);
    $("cm-taste-seed").value = v;
    if (citPending) citPending.tasteSeed = v;
  };
}

/* ── bottom bar: base / citation / nodes groups ─────────────────────────── */

function bindBottomBar() {
  const v = state.view;

  // BASE EDGES
  $("show-base").checked = v.showBase;
  $("base-density").value = v.baseDensity;
  $("base-density-val").textContent = v.baseDensity.toFixed(3);
  $("base-gamma").value = v.baseGamma;
  $("base-gamma-val").textContent = v.baseGamma.toFixed(2);
  $("base-colour").value = v.baseColour;

  $("show-base").onchange = (e) => {
    v.showBase = e.target.checked;
    loadGraphData();              // toggling visibility changes the link list
  };
  $("base-density").oninput = (e) => {
    v.baseDensity = +e.target.value;
    $("base-density-val").textContent = v.baseDensity.toFixed(3);
    if (v.showBase) loadGraphData();   // density only matters when shown
  };
  $("base-gamma").oninput = (e) => {
    v.baseGamma = +e.target.value;
    $("base-gamma-val").textContent = v.baseGamma.toFixed(2);
    // Gamma is render-only; the per-link opacity hook reads state.view
    // every frame, so no rebuild needed.
  };
  $("base-colour").oninput = (e) => {
    v.baseColour = e.target.value;
    if (Graph) Graph.linkColor(colourForLink);
  };

  // CITATION EDGES
  $("show-citations").checked = citationViewFlags.showCitations;
  $("cit-gamma").value = v.citGamma;
  $("cit-gamma-val").textContent = v.citGamma.toFixed(2);
  $("cit-colour").value = v.citColour;

  $("show-citations").onchange = (e) => {
    citationViewFlags.showCitations = e.target.checked;
    loadGraphData();
  };
  $("show-cit-arrows").checked = v.citArrows;
  $("show-cit-arrows").onchange = (e) => {
    v.citArrows = e.target.checked;
    if (Graph) {
      Graph.linkDirectionalArrowLength((l) => (l.kind === "citation" && v.citArrows) ? 2.2 : 0);
      Graph.refresh();
    }
  };
  $("cit-gamma").oninput = (e) => {
    v.citGamma = +e.target.value;
    $("cit-gamma-val").textContent = v.citGamma.toFixed(2);
  };
  $("cit-colour").oninput = (e) => {
    v.citColour = e.target.value;
    if (Graph) Graph.linkColor(colourForLink);
  };

  // NODES
  $("colour-by").value = state.colourBy;
  $("colour-by").onchange = (e) => {
    state.colourBy = e.target.value;
    if (Graph) {
      Graph.nodeColor(colourForNode);
      Graph.refresh();
    }
  };
}

/* ── 3D graph init ──────────────────────────────────────────────────────── */

function initGraph() {
  const el = $("graph");
  const rect = el.getBoundingClientRect();
  Graph = ForceGraph3D()(el)
    .width(rect.width)
    .height(rect.height)
    .backgroundColor("#06080c")
    .nodeRelSize(2)
    .nodeOpacity(1.0)
    // Run the simulation forever; pause via the Freeze button. Without
    // this, d3-force-3d cools down and stops applying forces — α changes
    // would then have no visible effect until you reheated.
    .cooldownTicks(Infinity)
    .warmupTicks(60);

  // Disable the library's default forces — the blend hook is the only
  // thing determining node positions. Charge / link / center would all
  // fight the deterministic blend each tick.
  const charge = Graph.d3Force("charge"); if (charge && charge.strength) charge.strength(0);
  const link   = Graph.d3Force("link");   if (link   && link.strength)   link.strength(0);
  const center = Graph.d3Force("center"); if (center && center.strength) center.strength(0);

  // Register the blend hook under d3-force-3d's "force" slot. Each
  // tick the hook reads the current blend value + cached basePos +
  // alignedCitationLayout (both Float32Array(n×3)) and writes
  //   live = (1−α)·basePos + α·alignedCitationPos
  // directly into node.x/y/z. No state, no momentum, no constraint
  // iterations — pure deterministic linear interpolation. The closure
  // reads everything through getters so citation reroll, blend slider
  // drag, etc. take effect on the next frame without re-registration.
  Graph.d3Force("blend", makeBlendForce({
    getBasePos:            () => state._basePos,
    getAlignedCitationPos: () => state.alignedCitationLayout,
    getBlend:              () => state.blend,
  }));

  // velocityDecay = 1 zeros velocities every tick. Any stray vx (drag
  // interactions, lib internals) dies before integration touches
  // position; the blend hook owns motion entirely.
  Graph.d3VelocityDecay(1.0);

  const ctrls = Graph.controls();
  if (ctrls) {
    ctrls.rotateSpeed = 2.2;
    ctrls.zoomSpeed   = 2.5;
    ctrls.panSpeed    = 1.6;
    ctrls.enableDamping = false;
  }

  new ResizeObserver((entries) => {
    if (!Graph) return;
    const r = entries[0].contentRect;
    Graph.width(r.width).height(r.height);
  }).observe(el);
}

/* ── boot ───────────────────────────────────────────────────────────────── */

export function boot() {
  bindDropdowns();
  bindDebugToggles();
  bindSettings();
  bindTopbar();
  bindClusterMenu();
  bindClusterModal();
  bindCitationLayoutMenu();
  bindCitationLayoutModal();
  bindForceControls();
  bindCitationControls();
  bindCitationModal();
  bindBottomBar();

  // Run the full pipeline once. Status / legend / graph data are populated
  // as side-effects of resample() at the bottom of the chain.
  state.result = generate(state.params);
  precomputeBasePos();
  {
    const algo = activeAlgorithm();
    state.clusterResult = algo.infer(state.result, activeAlgorithmParams());
    validateClusterResult(state.clusterResult, state.result.nodes.length, {
      allowNoise: !!algo.allowsNoise,
    });
  }
  rebuildClusterLegend();
  state.neighbourhoodResult = inferNeighbourhoods(state.result, state.clusterResult, state.neighbourhoodParams);
  state.tasteResult = buildCitationTaste(state.clusterResult, state.neighbourhoodResult, state.tasteParams);
  state.citationResult = generateCitations(
    state.result, state.clusterResult, state.neighbourhoodResult,
    state.tasteResult, state.citationParams,
  );
  relayoutCitations();           // FR layout + per-component alignment
  updateStatus();
  updateCitationStatus();

  requestAnimationFrame(() => {
    initGraph();
    loadGraphData();
    Graph.cameraPosition({ x: 0, y: 0, z: R_GLOBAL * 4 }, { x: 0, y: 0, z: 0 }, 0);
    // expose for debugging in DevTools console
    window.__nt = {
      Graph, state, physicsDebugFlags, citationViewFlags,
      colourForLink, opacityForLink,
      linkMatCache: _linkMatCache,
    };
  });
}
