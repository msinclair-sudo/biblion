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

import { getState, subscribe, setTabConfig } from "../state.js";
import { getStep, getSelectedStep, getStepDescendants, getStepAncestors,
         findClusterLevels, setCardScore } from "../workflow.js";
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

export function mount(container, _state, config = {}, tabContext = null) {
  const fixedStepId = (config && config.stepId) || null;
  // Per-layer parent-score threshold (panel-local; survives re-renders).
  let thresholds = {};
  // Which labelling method to display (persisted on the tab). Defaults to the
  // combined pick; the header dropdown lets the user switch to any one method.
  let labelMethod = (config && config.labelMethod) || COMBINED;
  // Per-cluster "show all band terms" expansion (panel-local; keyed levelUid:clusterId).
  const expanded = new Set();

  function persistMethod(id) {
    labelMethod = id;
    if (tabContext) setTabConfig(tabContext.slot, tabContext.tabId, { labelMethod: id });
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
    return head;
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
      for (const cl of cr.clusters) {
        body.appendChild(clusterBlock(card, levelUid, cl, labels, levelScores, null, true));
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
      for (const it of arr) {
        body.appendChild(clusterBlock(card, levelUid, it.cl, labels, levelScores, it.metric, it.eligible));
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

  // One cluster block: swatch + id/count, label bullets, 1–5 (if eligible),
  // and a metrics slot.
  function clusterBlock(card, levelUid, cl, labels, levelScores, metric, eligible) {
    const block = document.createElement("div");
    block.className = "scoring-cluster" + (eligible ? "" : " ineligible");

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
    const count = (cl.members && cl.members.length) || cl.count || 0;
    idLab.textContent = `Cluster ${cl.id} · ${count}`;
    headRow.appendChild(idLab);
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
    const expandKey = `${levelUid}:${cl.id}`;

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
      // banded (stratified) labels render one band per line for readability,
      // behind a per-cluster show-more so they don't dominate the column.
      if (v && v.bands) {
        const wrap = document.createElement("div");
        wrap.className = "scoring-label-bullet stratified";
        const head = document.createElement("div");
        head.className = "scoring-label-method";
        head.textContent = `• ${name}:`;
        wrap.appendChild(head);
        const isOpen = expanded.has(expandKey);
        if (isOpen) {
          for (const b of ["anchor", "broad", "mid", "specific", "signature"]) {
            const arr = v.bands[b];
            if (!arr || !arr.length) continue;
            const line = document.createElement("div");
            line.className = "scoring-label-band";
            // full per-band terms (up to STRAT_PER_BAND, already computed).
            line.textContent = `${b}: ${arr.slice(0, STRAT_PER_BAND).map(t => t.term).join(", ")}`;
            wrap.appendChild(line);
          }
        } else {
          // collapsed: the compact combined one-liner across the gradient.
          const line = document.createElement("div");
          line.className = "scoring-label-collapsed";
          line.textContent = (info && info.combined) || (v.terms || []).slice(0, 3).join(" · ");
          wrap.appendChild(line);
        }
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "scoring-label-showmore";
        toggle.textContent = isOpen ? "show less" : "show more";
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          if (isOpen) expanded.delete(expandKey); else expanded.add(expandKey);
          render();
        });
        wrap.appendChild(toggle);
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
