// Workflow chart — tree-aware SVG renderer.
//
// Phase 2 slice 2.3 of the workflow-tree-redesign. Reads from
// state.workflow (the typed branching DAG that lives in workflow.js)
// instead of the hand-positioned 7-node list this file used to ship.
//
// Self-contained module: defined inputs + outputs.
//   - Inputs: state.workflow (via workflow.js's read API) + state
//     subscriptions for re-render.
//   - Side effects: mounts an SVG under #workflow-chart; calls
//     selectStep(id) on click; opens the relevant modal for spine
//     step types via getLayerDescriptor (slice 2.5 will move this
//     into modal-as-step-creator).
//   - Auto-migration: when state.workflow is empty but the legacy
//     state slots are populated, calls migrateLegacyToWorkflowIfNeeded
//     to bootstrap a baseline linear tree before rendering. Idempotent.
//
// Layout (slice 2.3 first cut): the tree is rendered as a vertical
// spine, with non-spine children (e.g. saved ValidationRun cards
// attached to a clustering step) floated to the right at their
// parent's depth. Real branching layout (multiple siblings on the
// spine) lands in slice 2.8.

import { getState, subscribe }            from "./state.js";
import {
  getRootStep, getStep, getSelectedStep, isStepStale,
  selectStep, deleteStep, getStepDescendants, STEP_STATUS,
  findClusterLevels,
} from "./workflow.js";
import { scoreColour }                     from "./gradients.js";
import { openModal }                       from "./modals/modal.js";
import { migrateLegacyToWorkflowIfNeeded } from "./workflow-migration.js";
import { projectStepIntoLegacyState }      from "./workflow-projection.js";
import { getLayerDescriptor, rerunStep }   from "./modals/layer-descriptors.js";
import { openAddStepModal }                from "./modals/add-step-modal.js";
import { addStepRulesFor }                 from "./next-steps-rules.js";

// Map step.type → existing layer-descriptor id (the chart's click
// handler opens that descriptor's modal during the transition;
// slice 2.5 replaces this with "create a new step" semantics).
const DESCRIPTOR_BY_TYPE = {
  "data":               "data",
  "dimred":             "dimred",
  "clustering":         "clustering",
  "citationLayout":     "layout",
  "dimSweep":           "dimSweep",
  "fusionComparison":   "fusionComparison",
  "multiLevel":         "multiLevel",
  "labelling":          "labelling",
};

// Layout constants. Cards are smaller than slice 2.3 since branching
// trees can fan out wide; smaller cards keep ~4-5 siblings visible
// in a standard left rail. Long labels truncate.
const NODE_W       = 120;
const NODE_H       = 36;
const HORIZ_GAP    = 12;         // horizontal gap between sibling subtrees
const VERTICAL_GAP = 56;         // vertical distance between depth levels
const TOP_PAD      = 10;
const BOTTOM_PAD   = 12;
const LEFT_PAD     = 8;
const RIGHT_PAD    = 8;

const SVG_NS = "http://www.w3.org/2000/svg";


export function mountWorkflowChart() {
  const root = document.getElementById("workflow-chart");
  if (!root) return;
  // One-shot migration on mount: bootstrap the tree from legacy slots
  // if the workflow is empty. Idempotent. Subsequent state changes
  // re-render but do NOT re-migrate — that would clobber tests + any
  // workflow mutations performed by other modules.
  migrateLegacyToWorkflowIfNeeded();
  // Subscribe with a debounced one-shot retry: when state.genResult
  // first becomes populated after boot (toy boot is fast but real-mode
  // ingest takes ~30 s), the workflow is still empty. We re-attempt
  // migration once per render until the root appears, then stop trying.
  let migrationDone = !!getRootStep();
  render(root);
  subscribe(() => {
    if (!migrationDone) {
      const ran = migrateLegacyToWorkflowIfNeeded();
      if (ran || getRootStep()) migrationDone = true;
    }
    render(root);
  });
}

function render(root) {
  const rootStep = getRootStep();

  // Empty-state: no tree yet. Could happen on a degenerate boot
  // (no genResult). Render an empty hint rather than a blank rail.
  if (!rootStep) {
    renderEmptyHint(root);
    return;
  }

  // Compute layout: walk the spine top-down + lay out side-branches
  // to the right at each spine node's row.
  const layout = computeLayout(rootStep);
  renderSvg(root, layout);
}

// ── layout ───────────────────────────────────────────────────────────

/**
 * Compute SVG-local positions for every step using a Reingold-Tilford-
 * ish recursive tree layout. Phase 2 slice 2.8 — replaces the linear
 * spine + side-branch layout from slice 2.3 since slice 2.5 lets the
 * user create multiple siblings per layer.
 *
 * Algorithm:
 *   Pass 1 — compute subtree width per node (in card-slots):
 *     leaf:     width = 1
 *     internal: width = max(1, sum of children widths)
 *   Pass 2 — pre-order traversal:
 *     each node gets centred over its allotted subtree-width.
 *     Children laid out left-to-right; sibling subtrees butt up
 *     against each other (HORIZ_GAP between cards).
 *     y = depth × VERTICAL_GAP + TOP_PAD.
 *
 * Returns:
 *   {
 *     positions: [{ step, x, y }],
 *     edges:     [{ fromX, fromY, toX, toY }],
 *     viewboxW, viewboxH,
 *   }
 */
function computeLayout(rootStep) {
  const slotWidth = NODE_W + HORIZ_GAP;     // total slot pitch per card

  // Pass 1: width-in-slots per node.
  const widthOf = new Map();
  function computeWidth(stepId) {
    const step = stepId && getStepInTree(stepId);
    if (!step) return 0;
    if (step.childIds.length === 0) {
      widthOf.set(stepId, 1);
      return 1;
    }
    let total = 0;
    for (const cid of step.childIds) total += computeWidth(cid);
    const w = Math.max(1, total);
    widthOf.set(stepId, w);
    return w;
  }
  computeWidth(rootStep.id);

  // Pass 2: place each node. (x, y) is the top-left of the card; we
  // compute the centre internally and translate.
  const positions = [];
  const edges = [];
  function place(stepId, xLeftSlot, y) {
    const step = getStepInTree(stepId);
    if (!step) return;
    const w = widthOf.get(stepId);
    // Card centre = midpoint of allotted slot range.
    const xCentre = xLeftSlot + (w * slotWidth) / 2 - HORIZ_GAP / 2;
    const xCard   = xCentre - NODE_W / 2;
    positions.push({ step, x: xCard, y });

    let childXLeft = xLeftSlot;
    for (const cid of step.childIds) {
      const cWidth   = widthOf.get(cid);
      const childCentre = childXLeft + (cWidth * slotWidth) / 2 - HORIZ_GAP / 2;
      const childY      = y + VERTICAL_GAP;
      edges.push({
        fromX: xCentre,
        fromY: y + NODE_H,
        toX:   childCentre,
        toY:   childY,
      });
      place(cid, childXLeft, childY);
      childXLeft += cWidth * slotWidth;
    }
  }
  place(rootStep.id, LEFT_PAD, TOP_PAD);

  // Ref (cross-DAG) edges — slice 2.10, §10.D4. parentId is the primary
  // solid edge; refIds are drawn as dashed cross-edges from each source
  // card to the referencing card (e.g. a fusionComparison card's two
  // source clusterings). Computed after placement since a refId can
  // point anywhere in the already-laid-out tree.
  //
  // Exception (J15): nodeDisplacement branches off BOTH fusion branches, so its
  // ref-edge (the pre branch — the post branch is the parentId) is PROMOTED to a
  // primary, solid lineage edge. It draws from the source card's bottom into the
  // ND card's top so it reads like the parentId edge, giving two solid incoming
  // edges rather than one solid + one dashed.
  const posById = new Map(positions.map(p => [p.step.id, p]));
  const refEdges = [];
  for (const p of positions) {
    const refIds = p.step.refIds || [];
    const primary = p.step.type === "nodeDisplacement";
    for (const rid of refIds) {
      const src = posById.get(rid);
      if (!src) continue;
      if (primary) {
        refEdges.push({
          fromX: src.x + NODE_W / 2,
          fromY: src.y + NODE_H,
          toX:   p.x + NODE_W / 2,
          toY:   p.y,
        });
      } else {
        refEdges.push({
          fromX:  src.x + NODE_W / 2,
          fromY:  src.y + NODE_H / 2,
          toX:    p.x + NODE_W / 2,
          toY:    p.y + NODE_H / 2,
          dashed: true,
        });
      }
    }
  }

  // Compute viewport from the placed positions.
  const maxX = positions.length > 0
    ? Math.max(...positions.map(p => p.x + NODE_W)) + RIGHT_PAD
    : LEFT_PAD + NODE_W + RIGHT_PAD;
  const maxY = positions.length > 0
    ? Math.max(...positions.map(p => p.y + NODE_H)) + BOTTOM_PAD
    : TOP_PAD + NODE_H + BOTTOM_PAD;

  return { positions, edges, refEdges, viewboxW: maxX, viewboxH: maxY };
}

// Wraps getStep with a null-safe lookup; used during the recursive
// layout so a missing step (shouldn't happen if invariants hold)
// doesn't throw.
function getStepInTree(stepId) {
  try { return getStep(stepId); }
  catch (_) { return null; }
}

// ── render ───────────────────────────────────────────────────────────

function renderEmptyHint(root) {
  root.innerHTML = "";
  const div = document.createElement("div");
  div.className = "wf-empty-hint";

  const msg = document.createElement("div");
  msg.className = "wf-empty-msg";
  msg.textContent = "Empty workflow.";
  div.appendChild(msg);

  // UI #2: the tree starts empty (no boot auto-run). The user begins by
  // adding a data source; everything else grows from the per-card +.
  const btn = document.createElement("button");
  btn.className = "wf-add-data-btn";
  btn.type = "button";
  btn.textContent = "+ Add data source";
  btn.addEventListener("click", () => {
    const desc = getLayerDescriptor("data");
    if (desc && desc.openModal) desc.openModal();
  });
  div.appendChild(btn);

  root.appendChild(div);
}

function renderSvg(root, layout) {
  root.innerHTML = "";

  // Render at the tree's NATURAL pixel size (width/height = viewBox
  // dims) so cards are a constant ~120px regardless of how few there
  // are. CSS caps width at 100% (scale DOWN to fit a wide tree) but
  // never scales UP — a 1-2 card tree no longer balloons to fill the
  // rail (which was magnifying the running spinner; UI fix).
  const svg = svgEl("svg", {
    viewBox: `0 0 ${layout.viewboxW} ${layout.viewboxH}`,
    width:  layout.viewboxW,
    height: layout.viewboxH,
    preserveAspectRatio: "xMidYMin meet",
  });

  const defs = svgEl("defs");
  const marker = svgEl("marker", {
    id: "wf-arrowhead",
    viewBox: "0 0 10 10",
    refX: "9", refY: "5",
    markerWidth: "6", markerHeight: "6",
    orient: "auto-start-reverse",
  });
  marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#4a5260" }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Dashed ref cross-edges first (drawn behind solid edges + cards).
  for (const e of (layout.refEdges || [])) {
    svg.appendChild(renderEdge(e));
  }
  // Solid parentId edges next (so cards draw on top).
  for (const e of layout.edges) {
    svg.appendChild(renderEdge(e));
  }

  // Build a stepId → queue-position map for the spinner / badge
  // overlays (Phase 2 slice 2.4). Walk state.jobs.order; running +
  // pending jobs each carry an in-flight position counted from 0.
  const positionByStep = buildQueuePositionMap();
  const selectedId = (getSelectedStep() && getSelectedStep().id) || null;

  // All cards (uniform size now — slice 2.8 dropped the spine/side
  // distinction in favour of pure tree layout).
  for (const { step, x, y } of layout.positions) {
    svg.appendChild(renderCard(step, x, y, NODE_W, NODE_H, selectedId, positionByStep));
  }

  root.appendChild(svg);
}

/**
 * Walk state.jobs.order, count in-flight (pending + running) jobs,
 * and emit a Map(stepId → 0-based position) for every job that has
 * a bound stepId. Position 0 = currently running; 1 = next pending;
 * etc.
 *
 * @returns {Map<string, number>}
 */
function buildQueuePositionMap() {
  const out = new Map();
  const state = getState();
  const jobs  = state.jobs;
  if (!jobs || !jobs.order) return out;
  let pos = 0;
  for (const jid of jobs.order) {
    const j = jobs.byId[jid];
    if (!j) continue;
    if (j.status !== "pending" && j.status !== "running") continue;
    if (j.stepId) out.set(j.stepId, pos);
    pos++;
  }
  return out;
}

function renderEdge(e) {
  // Ref cross-edges (slice 2.10): a gentle quadratic curve between two
  // arbitrary cards, drawn dashed so it reads as a non-spine link.
  if (e.dashed) {
    const mx = (e.fromX + e.toX) / 2;
    const my = (e.fromY + e.toY) / 2 - 18;   // bow upward for legibility
    const d = `M ${e.fromX} ${e.fromY} Q ${mx} ${my} ${e.toX} ${e.toY}`;
    return svgEl("path", { d, class: "wf-arrow wf-arrow-ref" });
  }
  // Spine edges have fromX === toX (vertical); side edges go diagonal.
  let d;
  if (Math.abs(e.fromX - e.toX) < 1) {
    d = `M ${e.fromX} ${e.fromY} L ${e.toX} ${e.toY - 2}`;
  } else {
    // Right-angle bend so the side-edge reads cleanly against the
    // vertical spine.
    const mx = (e.fromX + e.toX) / 2;
    d = `M ${e.fromX} ${e.fromY} L ${mx} ${e.fromY} L ${mx} ${e.toY} L ${e.toX - 2} ${e.toY}`;
  }
  return svgEl("path", { d, class: "wf-arrow" });
}

function renderCard(step, x, y, w, h, selectedId, positionByStep) {
  const g = svgEl("g", { transform: `translate(${x}, ${y})` });

  const cls = ["wf-node-rect"];
  if (step.id === selectedId)   cls.push("selected");
  if (isStepStale(step.id))     cls.push("stale");
  const rect = svgEl("rect", { width: w, height: h, class: cls.join(" ") });
  rect.addEventListener("click", () => onCardClick(step));
  g.appendChild(rect);

  // Status indicator: spinning ring when running, static dot otherwise.
  // The spinner is a partial-arc circle that rotates via CSS animation;
  // sits at the same location as the static dot.
  if (step.status === STEP_STATUS.RUNNING) {
    const spinnerG = svgEl("g", {
      class: "wf-spinner",
      transform: `translate(10, ${h / 2})`,
    });
    spinnerG.appendChild(svgEl("circle", {
      cx: 0, cy: 0, r: 5,
      class: "wf-spinner-track",
    }));
    spinnerG.appendChild(svgEl("circle", {
      cx: 0, cy: 0, r: 5,
      class: "wf-spinner-arc",
    }));
    g.appendChild(spinnerG);
  } else {
    const dot = svgEl("circle", {
      cx: 10,
      cy: h / 2,
      r: 4,
      class: `wf-state-dot ${statusClass(step.status)}`,
    });
    g.appendChild(dot);
  }

  // Queue-position badge for PENDING steps that are bound to a job.
  // Sits in the top-right corner. Position 0 = currently running (not
  // shown — handled by the spinner above); 1 = next pending, etc.
  const queuePos = positionByStep && positionByStep.get(step.id);
  if (step.status === STEP_STATUS.PENDING && queuePos != null && queuePos > 0) {
    const badgeR = 7;
    const badge = svgEl("g", { class: "wf-queue-badge",
                               transform: `translate(${w - badgeR - 4}, ${badgeR + 4})` });
    badge.appendChild(svgEl("circle", { cx: 0, cy: 0, r: badgeR }));
    const t = svgEl("text", { x: 0, y: 0 });
    t.textContent = String(queuePos);
    badge.appendChild(t);
    g.appendChild(badge);
  }

  // J17: node-weighted score distribution as a thin stacked bar down the
  // right edge of a scoring card. One vertical bar; each segment's height
  // = fraction of NODES whose cluster carries that score, coloured by the
  // 1–5 score ramp. Starts below the top-right badge zone so it never
  // collides with the queue badge / re-run button.
  if (step.type === "scoring") {
    const dist = scoreDistributionFor(step);
    if (dist && dist.total > 0) {
      const barW   = 4;
      const barX   = w - barW;          // flush right edge
      const barTop = 20;                // clear the top-right badge zone
      const barH   = h - barTop - 4;
      const barG   = svgEl("g", { class: "wf-score-bar" });
      let yCursor = barTop;
      // Draw high → low so stronger scores stack at the top of the bar.
      for (let s = 5; s >= 1; s--) {
        const frac = (dist.byScore[s] || 0) / dist.total;
        if (frac <= 0) continue;
        const segH = frac * barH;
        barG.appendChild(svgEl("rect", {
          x: barX, y: yCursor, width: barW, height: segH,
          fill: scoreColour(s),
        }));
        yCursor += segH;
      }
      g.appendChild(barG);
    }
  }

  // Slice 2.6: re-run affordance on stale cards. Clickable ↻ glyph in
  // the top-right corner (offset left when a queue badge is also there).
  // Click → forkStep via rerunStep — creates a new sibling under the
  // canonical (current) parent with the stale card's params.
  if (isStepStale(step.id)) {
    const btnR = 8;
    const btnX = (queuePos != null && queuePos > 0) ? w - btnR - 22 : w - btnR - 4;
    const btn = svgEl("g", {
      class: "wf-rerun-btn",
      transform: `translate(${btnX}, ${btnR + 4})`,
    });
    btn.appendChild(svgEl("circle", { cx: 0, cy: 0, r: btnR }));
    // Refresh glyph — a partial-arc path + arrowhead.
    btn.appendChild(svgEl("path", {
      d: "M -3.5 -1.5 A 3.5 3.5 0 1 0 -2 -3.5 L -2 -1 L -4 -1",
      class: "wf-rerun-glyph",
    }));
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      rerunStep(step.id).catch(e =>
        console.error("[workflow-chart] rerunStep failed:", e)
      );
    });
    g.appendChild(btn);
  }

  // Main label + small sub-label below (algorithm summary).
  // Card is small (120×36); both lines truncate to ~15-18 chars.
  const sub = subLabelFor(step);
  const labelY = sub ? h / 2 - 5 : h / 2;
  const label = svgEl("text", {
    x: w / 2 + 4,
    y: labelY,
    class: "wf-node-label",
  });
  label.textContent = truncate(step.label, 16);
  g.appendChild(label);

  if (sub) {
    const algoText = svgEl("text", {
      x: w / 2 + 4,
      y: h / 2 + 7,
      class: "wf-node-algo",
    });
    algoText.textContent = truncate(sub, 16);
    g.appendChild(algoText);
  }

  // Gear icon — opens the card's config modal (UI change: clicking the
  // card body only selects; editing is explicit via the gear). Only on
  // cards whose type maps to a layer descriptor. Bottom-right corner so
  // it clears the top-right queue badge / re-run button.
  if (DESCRIPTOR_BY_TYPE[step.type]) {
    const gear = svgEl("g", {
      class: "wf-gear-btn",
      transform: `translate(${w - 11}, ${h - 10})`,
    });
    // Transparent hit area for an easier click target than the glyph.
    gear.appendChild(svgEl("circle", { cx: 0, cy: 1, r: 8, class: "wf-gear-hit" }));
    const glyph = svgEl("text", { x: 0, y: 0, class: "wf-gear-glyph" });
    glyph.textContent = "⚙";   // ⚙
    gear.appendChild(glyph);
    gear.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openStepModal(step);
    });
    g.appendChild(gear);
  }

  // "✕" delete button — top-left corner, clear of the gear (bottom-right),
  // queue badge / re-run (top-right) and the "+" (bottom-centre). Confirms
  // before cascading the delete.
  {
    const del = svgEl("g", {
      class: "wf-delete-btn",
      transform: `translate(10, 10)`,
    });
    del.appendChild(svgEl("circle", { cx: 0, cy: 0, r: 7, class: "wf-delete-hit" }));
    del.appendChild(svgEl("path", {
      d: "M -3 -3 L 3 3 M 3 -3 L -3 3",
      class: "wf-delete-glyph",
    }));
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      confirmDeleteCard(step);
    });
    g.appendChild(del);
  }

  // "+" add-step button at the base of the card (UI #2). Opens a menu of
  // valid downstream steps; picking one forks a new child card. Only on
  // cards that have at least one downstream option.
  if (addStepRulesFor(step.type).length > 0) {
    const plus = svgEl("g", {
      class: "wf-add-btn",
      transform: `translate(${w / 2}, ${h + 1})`,
    });
    plus.appendChild(svgEl("circle", { cx: 0, cy: 0, r: 7, class: "wf-add-circle" }));
    plus.appendChild(svgEl("path", {
      d: "M -3 0 L 3 0 M 0 -3 L 0 3",
      class: "wf-add-glyph",
    }));
    plus.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // Anchor the addition on THIS card. Selection-driven descriptors
      // (multiLevel / dimSweep / bootstrap) resolve their parent from the
      // selected card's lineage — without this, clicking "+" on a dimred
      // card while some other card is selected makes them report "no
      // dim-reduction card" even though one is right here.
      selectStep(step.id);
      projectStepIntoLegacyState(step.id);
      openAddStepModal(step);
    });
    g.appendChild(plus);
  }

  return g;
}

// ── interactions ─────────────────────────────────────────────────────

function onCardClick(step) {
  selectStep(step.id);
  // Slice 2.7: swap the legacy state slots (state.dimredResult /
  // clusterLevels / basePos / etc.) to this card's snapshot, so the
  // viewer + every panel re-paints to the selected card's data.
  // Cheap (refs only, no recompute). Clicking the card body ONLY
  // selects + projects — opening the config modal is the gear icon's
  // job now (UI change: click ≠ edit).
  projectStepIntoLegacyState(step.id);
}

// Open the config modal for a card (the gear-icon action). The gear EDITS
// THIS card in place — Apply overwrites the same card (id / parent /
// children kept) and re-runs it; descendants go stale. Branching is the
// "+" button's job, not the gear's. (Data is the exception: switching
// data source rebuilds the whole tree.)
function openStepModal(step) {
  const descriptorId = DESCRIPTOR_BY_TYPE[step.type];
  if (!descriptorId) return;
  const editStepId = step.type === "data" ? null : step.id;
  const desc = getLayerDescriptor(descriptorId, editStepId);
  if (desc && desc.openModal) desc.openModal();
}

// Delete a card (and its descendants) with a confirm. Wired to the per-
// card ✕ button. deleteStep cascades + rebinds selection/root internally.
function confirmDeleteCard(step) {
  const nDesc = getStepDescendants(step.id).length;
  const body = document.createElement("div");
  body.className = "delete-card-confirm";
  body.textContent = nDesc > 0
    ? `Delete “${step.label}” and its ${nDesc} downstream card${nDesc > 1 ? "s" : ""}? This can't be undone.`
    : `Delete “${step.label}”? This can't be undone.`;
  openModal({
    title: "Delete card",
    body,
    actions: [
      { label: "Cancel" },
      { label: "Delete", primary: true, onClick: () => { deleteStep(step.id); } },
    ],
  });
}

// ── helpers ──────────────────────────────────────────────────────────

// J17: node-weighted 1–5 score distribution for a scoring card's mini bar.
//
// Returns { byScore: {1..5: nodeCount}, total } over the SELECTED level
// (resolved from state.colourMode, falling back to the finest level) —
// consistent with how the card's other readouts project a single level.
// DECISION (flagged for confirmation): selected level, not pooled across
// all scored levels.
//
// Node-weighted: each cluster contributes its node COUNT to the score it
// carries, so a score backed by a big cluster dominates the bar.
function scoreDistributionFor(step) {
  const scores = step.result && step.result.scores;
  if (!scores) return null;
  const { levels } = findClusterLevels(step.id);
  if (!levels.length) return null;

  // Selected level from the viewer colour mode ("cluster:N" / "cluster:finest").
  const mode = getState().colourMode || "";
  let idx = levels.length - 1;          // default: finest
  if (mode.startsWith("cluster:")) {
    const n = parseInt(mode.slice(8), 10);
    if (Number.isFinite(n) && n >= 0 && n < levels.length) idx = n;
  }
  const lvl = levels[idx];
  if (!lvl || !lvl.clusterResult) return null;

  const levelScores = scores[lvl.uid] || {};
  const byScore = {};
  let total = 0;
  for (const cl of lvl.clusterResult.clusters) {
    const sc = levelScores[cl.id];
    if (sc == null) continue;
    const count = (cl.members && cl.members.length) || cl.count || 0;
    if (count <= 0) continue;
    byScore[sc] = (byScore[sc] || 0) + count;
    total += count;
  }
  return { byScore, total };
}

function statusClass(status) {
  switch (status) {
    case STEP_STATUS.DONE:      return "fresh";
    case STEP_STATUS.RUNNING:   return "running";
    case STEP_STATUS.FAILED:    return "error";
    case STEP_STATUS.CANCELLED: return "cancelled";
    case STEP_STATUS.PENDING:   return "pending";
    default:                    return "not-run";
  }
}

function subLabelFor(step) {
  // Provide a small algorithm-summary line for spine cards. Defaults
  // to the step's params method when present.
  const p = step.params || {};
  if (step.type === "data") {
    return p.mode || (getState().dataSource && getState().dataSource.mode) || null;
  }
  if (step.type === "dimred") {
    const cs = p.compression && p.compression.method;
    const vs = p.viz         && p.viz.method;
    if (cs === "identity" && vs === "identity") return "—";
    return `cluster: ${cs || "?"} · viz: ${vs || "?"}`;
  }
  if (step.type === "clustering") {
    const lvls = (p.levels || []).length;
    return lvls > 1 ? `${p.method || "?"} · ${lvls} levels` : (p.method || null);
  }
  if (step.type === "citations") {
    const r = step.result && step.result.citationResult;
    const n = r && r.citations ? r.citations.length : 0;
    return n > 0 ? `${n} edges` : null;
  }
  if (step.type === "citationLayout") return p.method || null;
  if (step.type === "alignment")      return "match-RMS";
  if (step.type === "bootstrapStability") {
    if (p.B != null) return `B=${p.B}`;
    return "bootstrap";
  }
  if (step.type === "dimSweep") {
    const dims  = (p.dims  || []).length;
    const seeds = (p.seeds || []).length;
    if (dims && seeds) return `${dims}d × ${seeds}s`;
    return "dimsweep";
  }
  if (step.type === "fusionComparison") {
    const r = step.result;
    if (r && r.comparison && r.comparison.perLevel && r.comparison.perLevel[0]) {
      const ari = r.comparison.perLevel[0].aggregate.ari;
      return Number.isFinite(ari) ? `ARI ${ari.toFixed(2)}` : "compare";
    }
    return "compare";
  }
  if (step.type === "save" || step.type === "load") {
    return truncate(p.filename || "", 18) || step.type;
  }
  return null;
}

function truncate(s, max) {
  if (!s) return "";
  s = String(s);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) el.setAttribute(k, v);
  }
  return el;
}
