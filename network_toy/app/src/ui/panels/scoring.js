// Scoring panel (MLC §5).
//
// A horizontally-scrolling board: ONE COLUMN PER LAYER (coarse → fine).
// Each column lists its clusters as blocks — swatch + id + count, the
// method labels as bullets, a 1–5 score control, and a metrics slot. From
// the second layer on, clusters split into a regular section and a
// "Bridge Clusters" section (fine clusters straddling ≥2 coarse parents).
// Each column header carries a parent-score threshold: a cluster only
// becomes scoreable once its parent (previous layer) cleared that bar —
// so scoring flows coarse → fine.
//
// Binding follows the SELECTED card (different work-tree branches each have
// their own scoring card); scores live ON the scoring card
// (result.scores[levelUid][clusterId]) and travel with its branch.

import { getState, subscribe, setTabConfig, addHighlight, addToCart } from "../state.js";
import { getStep, getSelectedStep, getStepDescendants, getStepAncestors,
         findClusterLevels, setCardScore } from "../workflow.js";
import { getIdByRow } from "../../datasource/sqlite.js";
import { computeBridgeAnalysis } from "../bridge-analysis.js";
import { listLabelMethods, STRAT_PER_BAND } from "../../labelling/cluster-labels.js";

export const ID          = "scoring";
export const LABEL       = "Scoring";
export const DESCRIPTION = "Score clusters 1–5 layer by layer, using an upstream labelling card. Scores live on the scoring card.";
export const SINGLETON   = true;

const TAU = 0.8;   // dominance cutoff: encapsulated vs bridge

// Human label per method id (for the bullet prefixes).
const METHOD_LABEL = Object.fromEntries(listLabelMethods().map(m => [m.id, m.label]));

// Sentinel method id for the combined one-liner pick (combine()'s output),
// shown by default instead of stacking every method per cluster.
const COMBINED = "__combined__";

// Board-wide sort for the cluster blocks WITHIN each column. "default" keeps the
// existing eligibility/bridge ordering; the others re-order by the manual 1–5
// score (result.scores[levelUid][clusterId]). "unscored" floats the not-yet-
// scored blocks to the top so they're easy to find and clear.
const SORT_OPTIONS = [
  { id: "default",  label: "Default" },
  { id: "scoreDesc", label: "Score desc" },
  { id: "scoreAsc",  label: "Score asc" },
  { id: "unscored",  label: "Un-scored first" },
];

export function mount(container, _state, config = {}, tabContext = null) {
  const fixedStepId = (config && config.stepId) || null;
  // Per-layer parent-score threshold (panel-local; survives re-renders).
  let thresholds = {};
  // Which labelling method to display (persisted on the tab). Defaults to the
  // combined pick; the header dropdown lets the user switch to any one method.
  let labelMethod = (config && config.labelMethod) || COMBINED;
  // Board-wide cluster-block sort (persisted on the tab). Defaults to the
  // existing eligibility/bridge order.
  let sortMode = (config && config.sortMode) || "default";

  function persistMethod(id) {
    labelMethod = id;
    if (tabContext) setTabConfig(tabContext.slot, tabContext.tabId, { labelMethod: id });
    render();
  }

  function persistSort(id) {
    sortMode = id;
    if (tabContext) setTabConfig(tabContext.slot, tabContext.tabId, { sortMode: id });
    render();
  }

  function resolveCard() {
    if (fixedStepId) return getStep(fixedStepId);
    const sel = getSelectedStep();
    if (!sel) return null;
    if (sel.type === "scoring") return sel;
    const inBranch = (steps) => {
      const scoring = steps.filter(s => s.type === "scoring");
      if (!scoring.length) return null;
      const done = scoring.filter(s => s.status === "done" && s.result);
      return (done.length ? done : scoring).slice(-1)[0];
    };
    return inBranch(getStepDescendants(sel.id))
        || inBranch(getStepAncestors(sel.id))
        || null;
  }

  // Resolve everything the board needs from the bound card's branch:
  // the level ladder (clustering ancestor), labels (labelling parent),
  // and the scores (on the card).
  function resolveData(card) {
    // Labels come from the labelling card (the direct parent); the level
    // ladder comes from the nearest clustering-like ANCESTOR — which may be
    // further up than the grandparent now that a bridge card can sit in the
    // chain (picker → bridge → labelling → scoring).
    const labelling = card.parentId ? getStep(card.parentId) : null;
    const { levels } = findClusterLevels(card.id);
    const labelsByLevel = (labelling && labelling.result && labelling.result.byLevel) || {};
    const scores = (card.result && card.result.scores) || {};
    return { levels, labelsByLevel, scores };
  }

  function render() {
    container.innerHTML = "";
    const card = resolveCard();
    const root = document.createElement("div");
    root.className = "scoring-board";

    if (!card) {
      root.classList.add("empty");
      root.textContent = "No scoring card on this branch — add one from a labelling card's “+”.";
      container.appendChild(root);
      return;
    }

    const { levels, labelsByLevel, scores } = resolveData(card);
    if (levels.length === 0) {
      root.classList.add("empty");
      root.textContent = "Scoring card has no levels yet — re-prepare it (upstream may still be running).";
      container.appendChild(root);
      return;
    }

    // Panel header: pick which labelling method to display (combined by default).
    container.appendChild(methodHeader(labelsByLevel));

    for (let i = 0; i < levels.length; i++) {
      root.appendChild(renderColumn(card, levels, labelsByLevel, scores, i));
    }
    container.appendChild(root);
  }

  // The labelling methods actually present in this card's stored labels, in
  // registry order. Built from labels.methods (level-invariant), unioned across
  // levels in case a level gated a method off.
  function availableMethods(labelsByLevel) {
    const seen = new Map();   // id → label
    for (const lvl of Object.values(labelsByLevel)) {
      for (const m of (lvl && lvl.methods) || []) {
        if (m.available && !seen.has(m.id)) seen.set(m.id, m.label);
      }
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }

  function methodHeader(labelsByLevel) {
    const methods = availableMethods(labelsByLevel);
    // If the persisted choice no longer exists, fall back to the combined pick.
    if (labelMethod !== COMBINED && !methods.some(m => m.id === labelMethod)) {
      labelMethod = COMBINED;
    }
    const head = document.createElement("div");
    head.className = "scoring-board-head";
    const lab = document.createElement("label");
    lab.className = "scoring-method-label";
    lab.textContent = "label method:";
    head.appendChild(lab);
    const sel = document.createElement("select");
    sel.className = "scoring-method-select";
    const opt = (value, text) => {
      const o = document.createElement("option");
      o.value = value; o.textContent = text;
      if (value === labelMethod) o.selected = true;
      sel.appendChild(o);
    };
    opt(COMBINED, "Combined (preferred)");
    for (const m of methods) opt(m.id, m.label);
    sel.addEventListener("change", () => persistMethod(sel.value));
    head.appendChild(sel);

    // Board-wide sort control: re-orders cluster blocks within every column.
    const sortLab = document.createElement("label");
    sortLab.className = "scoring-method-label";
    sortLab.textContent = "sort by:";
    head.appendChild(sortLab);
    const sortSel = document.createElement("select");
    sortSel.className = "scoring-method-select";
    for (const o of SORT_OPTIONS) {
      const el = document.createElement("option");
      el.value = o.id; el.textContent = o.label;
      if (o.id === sortMode) el.selected = true;
      sortSel.appendChild(el);
    }
    sortSel.addEventListener("change", () => persistSort(sortSel.value));
    head.appendChild(sortSel);
    return head;
  }

  // Order a list of {cl, metric, eligible} blocks by the active sort mode.
  // "default" preserves the incoming (eligibility/bridge) order. The score-based
  // modes read the manual 1–5 from levelScores; un-scored clusters are treated
  // as the lowest for desc (so they sink) and surfaced first for "unscored".
  function sortBlocks(arr, levelScores) {
    if (sortMode === "default") return arr;
    const scoreOf = (it) => {
      const v = levelScores[it.cl.id];
      return Number.isFinite(v) ? v : null;
    };
    // Stable sort: decorate with the original index so equal keys keep order.
    const decorated = arr.map((it, idx) => ({ it, idx, score: scoreOf(it) }));
    decorated.sort((a, b) => {
      if (sortMode === "unscored") {
        const au = a.score == null ? 0 : 1;
        const bu = b.score == null ? 0 : 1;
        if (au !== bu) return au - bu;
        return a.idx - b.idx;
      }
      const av = a.score == null ? -Infinity : a.score;
      const bv = b.score == null ? -Infinity : b.score;
      if (av !== bv) return sortMode === "scoreAsc" ? av - bv : bv - av;
      return a.idx - b.idx;
    });
    return decorated.map(d => d.it);
  }

  function renderColumn(card, levels, labelsByLevel, scores, i) {
    const lvl = levels[i];
    const cr = lvl.clusterResult;
    const levelUid = lvl.uid;
    const labels = labelsByLevel[levelUid] || { perCluster: [] };
    const levelScores = scores[levelUid] || {};

    const col = document.createElement("div");
    col.className = "scoring-col";

    // ── header: layer + (for i>0) parent-score threshold ──
    const head = document.createElement("div");
    head.className = "scoring-col-head";
    const h = document.createElement("div");
    h.className = "scoring-col-title";
    h.textContent = `Layer ${i}`;
    head.appendChild(h);
    const sub = document.createElement("div");
    sub.className = "scoring-col-sub";
    sub.textContent = `${cr.clusters.length} clusters · ${Object.keys(levelScores).length} scored`;
    head.appendChild(sub);
    if (i > 0) head.appendChild(thresholdControl(i));
    col.appendChild(head);

    const body = document.createElement("div");
    body.className = "scoring-col-body";
    col.appendChild(body);

    if (i === 0) {
      // Top layer — every cluster scoreable, no parent gate, no bridge split.
      const blocks = cr.clusters.map(cl => ({ cl, metric: null, eligible: true }));
      for (const it of sortBlocks(blocks, levelScores)) {
        body.appendChild(clusterBlock(card, i, levelUid, cr, it.cl, labels, levelScores, it.metric, it.eligible));
      }
      return col;
    }

    // Below top — bridge split + parent-score gating.
    const threshold = thresholds[i] != null ? thresholds[i] : 3;
    const ba = computeBridgeAnalysis(levels, { fineLevel: i, coarseLevel: i - 1 });
    const byFine = new Map(ba.perCluster.map(p => [p.fineId, p]));
    const parentUid = levels[i - 1].uid;
    const parentScores = scores[parentUid] || {};

    // Four ordered buckets: eligible first (core → bridge), then the
    // below-threshold ones sink to the bottom greyed out (core → bridge),
    // rather than just dimming in place.
    const coreElig = [], bridgeElig = [], coreInel = [], bridgeInel = [];
    for (const cl of cr.clusters) {
      const p = byFine.get(cl.id);
      const at = p && p.byLevel[i - 1];
      const shares = at ? at.shares : [];
      const dom = at ? at.dominantFraction : 1;
      const span = at ? at.spanCount : 1;
      const isBridge = span >= 2 && dom < TAU;
      const parentScoreOf = (pid) => parentScores[pid];
      const dominantScore = shares.length ? parentScoreOf(shares[0].id) : undefined;
      const eligible = isBridge
        ? shares.some(sh => (parentScoreOf(sh.id) || 0) >= threshold)
        : (dominantScore || 0) >= threshold;
      const metric = { dom, span, isBridge, shares };
      const bucket = isBridge
        ? (eligible ? bridgeElig : bridgeInel)
        : (eligible ? coreElig  : coreInel);
      bucket.push({ cl, metric, eligible });
    }

    const addBlocks = (arr) => {
      // Sort within each section (core/bridge, eligible/below-threshold) so the
      // bridge/threshold grouping is preserved while blocks reorder inside it.
      for (const it of sortBlocks(arr, levelScores)) {
        body.appendChild(clusterBlock(card, i, levelUid, cr, it.cl, labels, levelScores, it.metric, it.eligible));
      }
    };
    const divider = (text, muted) => {
      const d = document.createElement("div");
      d.className = "scoring-bridge-divider" + (muted ? " muted" : "");
      d.textContent = text;
      body.appendChild(d);
    };

    addBlocks(coreElig);
    if (bridgeElig.length) { divider(`Bridge clusters — ${bridgeElig.length}`); addBlocks(bridgeElig); }
    if (coreInel.length || bridgeInel.length) {
      divider(`Below parent ≥ ${threshold} — ${coreInel.length + bridgeInel.length}`, true);
      addBlocks(coreInel);
      if (bridgeInel.length) { divider(`Bridge clusters — ${bridgeInel.length}`, true); addBlocks(bridgeInel); }
    }
    return col;
  }

  function thresholdControl(i) {
    const wrap = document.createElement("div");
    wrap.className = "scoring-threshold";
    const lab = document.createElement("label");
    lab.textContent = "parent ≥";
    lab.title = "Only score clusters whose parent (previous layer) scored at least this.";
    wrap.appendChild(lab);
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "1"; inp.max = "5"; inp.step = "1";
    inp.value = String(thresholds[i] != null ? thresholds[i] : 3);
    inp.addEventListener("change", () => {
      let v = parseInt(inp.value, 10);
      if (!Number.isFinite(v)) v = 3;
      v = Math.max(1, Math.min(5, v));
      thresholds[i] = v;
      render();
    });
    wrap.appendChild(inp);
    return wrap;
  }

  // Collect the active-dataset nodeIds belonging to cluster `cl` in this level.
  // nodeCluster is indexed by node id (same convention the viewers use:
  // cr.nodeCluster[node.id]), so the index IS the node id.
  function nodeIdsForCluster(cr, cl) {
    const ids = [];
    const nc = cr && cr.nodeCluster;
    if (!nc) return ids;
    for (let id = 0; id < nc.length; id++) if (nc[id] === cl.id) ids.push(id);
    return ids;
  }

  // Is this cluster currently selected? Mirrors the viewer: a cluster reads as
  // selected when ALL of its nodes sit within the active node-selection (the
  // J25 highlight channel, any source) — so a selection made by clicking this
  // block, or from the viewer / another card, lights up the owning block.
  // "All" (not "any") is deliberate: a bridge cluster straddling two coarse
  // parents shouldn't highlight when only one parent is selected.
  function isClusterSelected(cr, cl) {
    const sources = getState().highlights && getState().highlights.bySource;
    if (!sources) return false;
    const ids = nodeIdsForCluster(cr, cl);
    if (ids.length === 0) return false;
    const inAny = (id) => {
      for (const k in sources) {
        const g = sources[k];
        if (g && g.ids && g.ids.has(id)) return true;
      }
      return false;
    };
    return ids.every(inAny);
  }

  // Gather a cluster's REAL (non-ghost) papers for the cart. Cluster membership
  // is the authoritative node-index → cluster-id map (cr.nodeCluster); ghosts
  // carry citation edges but no paper we'd put in a subset, so they're skipped.
  // Each item matches the cart's { paperId, nodeId, source } shape.
  function clusterCartItems(cr, layerIdx, clusterId) {
    const nodes = (getState().genResult && getState().genResult.nodes) || [];
    const nc = cr.nodeCluster;
    // Provenance string mirrors the node-table's cart convention ("L2·c5").
    const source = `L${layerIdx}·c${clusterId}`;
    const items = [];
    if (!nc) return items;
    for (let nodeId = 0; nodeId < nc.length; nodeId++) {
      if (nc[nodeId] !== clusterId) continue;
      if (nodes[nodeId] && nodes[nodeId].isGhost) continue;
      const paperId = getIdByRow(nodeId);
      if (paperId != null) items.push({ paperId, nodeId, source });
    }
    return items;
  }

  // One cluster block: swatch + id/count, label bullets, 1–5 (if eligible),
  // and a metrics slot. Clicking the block highlights its nodes in both viewers
  // via the general highlight channel (J25); Ctrl/Cmd+click adds to the current
  // "scoring" group instead of replacing it (multi-select).
  function clusterBlock(card, layerIdx, levelUid, cr, cl, labels, levelScores, metric, eligible) {
    const block = document.createElement("div");
    block.className = "scoring-cluster" + (eligible ? "" : " ineligible")
      + (isClusterSelected(cr, cl) ? " selected" : "");
    block.addEventListener("click", (e) => {
      // Score buttons stopPropagation, so a block click here is a genuine
      // "select this cluster" gesture. Glow in the cluster's own colour.
      const additive = e.ctrlKey || e.metaKey;
      addHighlight("scoring", nodeIdsForCluster(cr, cl), cl.colour || "#ffd23f", additive);
    });

    const left = document.createElement("div");
    left.className = "scoring-cluster-main";

    const headRow = document.createElement("div");
    headRow.className = "scoring-cluster-head";
    const sw = document.createElement("span");
    sw.className = "scoring-swatch";
    sw.style.background = cl.colour || "#888";
    headRow.appendChild(sw);
    const idLab = document.createElement("span");
    idLab.className = "scoring-cluster-id";
    // Two counts can differ: cl.count/members is total membership (incl. ghost
    // nodes that carry citation edges but no real paper); the cart only takes
    // real papers. We show the real-paper count — it's what "Add to cart" pushes
    // and is the more meaningful figure for scoring. Falls back to total when no
    // corpus is loaded (cartItems empty → 0).
    const cartItems = clusterCartItems(cr, layerIdx, cl.id);
    const totalCount = (cl.members && cl.members.length) || cl.count || 0;
    const papers = cartItems.length;
    // No corpus loaded → getIdByRow yields nothing for every node; fall back to
    // the total membership rather than a misleading "0 papers / N".
    const noCorpus = papers === 0 && totalCount > 0;
    idLab.textContent = (noCorpus || papers === totalCount)
      ? `Cluster ${cl.id} · ${totalCount}`
      : `Cluster ${cl.id} · ${papers} papers / ${totalCount}`;
    headRow.appendChild(idLab);

    // Add-to-cart: push this cluster's real papers (no ghosts) via the shared
    // cart helper, which dedupes by paperId across clusters.
    const cartBtn = document.createElement("button");
    cartBtn.type = "button";
    cartBtn.className = "scoring-cart-add";
    cartBtn.textContent = "+ cart";
    cartBtn.title = `Add ${papers} paper${papers === 1 ? "" : "s"} from this cluster to the cart`;
    cartBtn.disabled = papers === 0;
    cartBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addToCart(cartItems);
    });
    headRow.appendChild(cartBtn);
    left.appendChild(headRow);

    // label bullets — only the SELECTED method (combined by default), not every
    // method stacked. The header dropdown switches which one shows here.
    const info = labels.perCluster && labels.perCluster[cl.id];
    const labWrap = document.createElement("div");
    labWrap.className = "scoring-cluster-labels";
    const labHead = document.createElement("div");
    labHead.className = "scoring-cluster-label-head";
    labHead.textContent = "label:";
    labWrap.appendChild(labHead);
    const byMethod = (info && info.byMethod) || {};

    if (labelMethod === COMBINED) {
      const li = document.createElement("div");
      li.className = "scoring-label-bullet" + (info && info.combined ? "" : " none");
      li.textContent = `• ${(info && info.combined) || "(unlabelled)"}`;
      labWrap.appendChild(li);
    } else if (!byMethod[labelMethod]) {
      const li = document.createElement("div");
      li.className = "scoring-label-bullet none";
      li.textContent = "• (no label for this method)";
      labWrap.appendChild(li);
    } else {
      const v = byMethod[labelMethod];
      const name = METHOD_LABEL[labelMethod] || labelMethod;
      // banded (stratified) labels render one band per line for readability.
      if (v && v.bands) {
        const wrap = document.createElement("div");
        wrap.className = "scoring-label-bullet stratified";
        const head = document.createElement("div");
        head.className = "scoring-label-method";
        head.textContent = `• ${name}:`;
        wrap.appendChild(head);
        for (const b of ["anchor", "broad", "mid", "specific", "signature"]) {
          const arr = v.bands[b];
          if (!arr || !arr.length) continue;
          const line = document.createElement("div");
          line.className = "scoring-label-band";
          // full per-band terms (up to STRAT_PER_BAND, already computed).
          line.textContent = `${b}: ${arr.slice(0, STRAT_PER_BAND).map(t => t.term).join(", ")}`;
          wrap.appendChild(line);
        }
        labWrap.appendChild(wrap);
      } else {
        const li = document.createElement("div");
        li.className = "scoring-label-bullet";
        li.textContent = `• ${name}: ${formatLabel(v)}`;
        labWrap.appendChild(li);
      }
    }
    left.appendChild(labWrap);

    // 1–5 control (only when eligible).
    if (eligible) {
      const stars = document.createElement("div");
      stars.className = "scoring-stars";
      const current = levelScores[cl.id];
      for (let v = 1; v <= 5; v++) {
        const b = document.createElement("button");
        b.className = "scoring-star" + (current === v ? " active" : "");
        b.textContent = String(v);
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          setCardScore(card.id, levelUid, cl.id, current === v ? null : v);
        });
        stars.appendChild(b);
      }
      left.appendChild(stars);
    }
    block.appendChild(left);

    // metrics slot (right). Straddle metric from bridge analysis, surfaced
    // next to the score so the manual 1–5 is made with the geometry in view.
    // dominantFraction = how much of the cluster sits in its single biggest
    // parent; straddle = 1 − that. Bridges (span ≥ 2 under τ) are flagged.
    const metrics = document.createElement("div");
    metrics.className = "scoring-metrics"
      + (metric && metric.isBridge ? " is-bridge" : "");
    if (metric && Number.isFinite(metric.dom)) {
      const straddlePct = Math.round((1 - metric.dom) * 100);
      metrics.textContent = metric.isBridge
        ? `bridge · straddles ${straddlePct}% across ${metric.span}`
        : `clean · ${Math.round(metric.dom * 100)}% in parent`;
      metrics.title = "From bridge analysis: dominant-parent share vs straddle. "
        + "Lower dominance / higher span = more of a bridge.";
    } else {
      metrics.textContent = "—";
    }
    block.appendChild(metrics);

    return block;
  }

  render();
  const unsub = subscribe(() => render());
  return {
    update() { render(); },
    destroy() { unsub(); container.innerHTML = ""; },
  };
}

// Format a method's raw label value for a bullet.
function formatLabel(v) {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.slice(0, 5).join(", ");
  if (typeof v === "object") {
    if (Number.isFinite(v.min) && Number.isFinite(v.max)) {
      return v.min === v.max ? `${v.min}` : `${v.min}–${v.max}`;
    }
    if (v.paperId) return String(v.paperId);
    // stratified: render each populated band as "band: t1, t2, t3".
    if (v.bands) {
      return ["anchor", "broad", "mid", "specific", "signature"]
        .map(b => (v.bands[b] && v.bands[b].length)
          ? `${b}: ${v.bands[b].map(t => t.term).join(", ")}` : null)
        .filter(Boolean)
        .join("  ·  ");
    }
    if (v.term || v.terms) return String(v.term || (v.terms || []).join(", "));
  }
  return String(v);
}
