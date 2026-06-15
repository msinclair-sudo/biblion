// Panel: Export (RIS). Pick a selection from the scored clustering and
// download it as a RIS file for a reference manager.
//
// Two modes:
//   by-score:  a level + "score ≥ N" → every node in a cluster scoring at
//              least N at that level. Scores are PER-LEVEL, so the level is
//              always part of the selection.
//   cluster:   a level + a single cluster → that cluster's nodes.
//
// Binds to the selected `export` card; reads the level ladder from the
// nearest clustering ancestor and the 1–5 scores from the nearest scoring
// ancestor. Records come live from the sqlite corpus (getNodeRecord); the
// panel disables export + explains when no corpus is loaded.

import { getState, subscribe } from "../state.js";
import { getStep, getSelectedStep, getStepAncestors,
         findClusterLevels } from "../workflow.js";
import { getNodeRecord, hasSqliteText } from "../../datasource/sqlite.js";
import { selectNodes, buildRis, exportFilename, downloadText } from "../../export/cluster-export.js";
import { select as kitSelect, numberInput as kitNumberInput } from "../widgets.js";

export const ID          = "export-ris";
export const LABEL       = "Export (RIS)";
export const DESCRIPTION = "Export clusters or high-scoring nodes to a RIS file. Pick a level + score threshold, or a single cluster, then download.";
export const SINGLETON   = true;

export function mount(container, _state, config = {}) {
  const fixedStepId = (config && config.stepId) || null;
  // Panel-local selection state (survives re-renders).
  let ui = { mode: "by-score", level: 0, minScore: 3, clusterId: 0 };
  let seededFor = null;

  function resolveCard() {
    if (fixedStepId) return getStep(fixedStepId);
    const sel = getSelectedStep();
    if (!sel) return null;
    if (sel.type === "export") return sel;
    // An export card anywhere in the selected lineage.
    const anc = getStepAncestors(sel.id).filter(s => s.type === "export");
    return anc.length ? anc[anc.length - 1] : null;
  }

  // Scores from the nearest scoring ancestor (card.result.scores).
  function resolveScores(card) {
    const anc = getStepAncestors(card.id);
    for (let i = anc.length - 1; i >= 0; i--) {
      if (anc[i].type === "scoring" && anc[i].result && anc[i].result.scores) {
        return anc[i].result.scores;
      }
    }
    return {};
  }

  function render() {
    container.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "export-panel";

    const title = document.createElement("div");
    title.className = "export-title";
    title.textContent = "Export (RIS)";
    wrap.appendChild(title);

    const card = resolveCard();
    if (!card) {
      wrap.appendChild(empty("No export card on this branch — add one from a scoring card's “+”."));
      container.appendChild(wrap);
      return;
    }

    const { levels } = findClusterLevels(card.id);
    if (levels.length === 0) {
      wrap.appendChild(empty("No clustering levels above this card to export."));
      container.appendChild(wrap);
      return;
    }
    const scores = resolveScores(card);

    // Clamp ui.level to range and (re)seed once per card/levels shape.
    const key = card.id + ":" + levels.length;
    if (seededFor !== key) { ui.level = 0; ui.clusterId = 0; seededFor = key; }
    if (ui.level >= levels.length) ui.level = levels.length - 1;

    // ── mode toggle ──
    const modeRow = row("Export");
    modeRow.appendChild(toggle(
      [{ v: "by-score", label: "By score" }, { v: "cluster", label: "Single cluster" }],
      ui.mode, (v) => { ui.mode = v; render(); }));
    wrap.appendChild(modeRow);

    // ── level select ──
    const lvlRow = row("Level");
    lvlRow.appendChild(select(
      levels.map((l, i) => ({ value: i, label: `L${i} · ${l.clusterResult.clusters.length} clusters` })),
      ui.level, (v) => { ui.level = v; ui.clusterId = 0; render(); }));
    wrap.appendChild(lvlRow);

    if (ui.mode === "by-score") {
      const scRow = row("Score ≥");
      scRow.appendChild(numberInput(1, 5, 1, ui.minScore, (v) => { ui.minScore = v; render(); }));
      wrap.appendChild(scRow);
    } else {
      const clRow = row("Cluster");
      const clusters = levels[ui.level].clusterResult.clusters;
      clRow.appendChild(select(
        clusters.map(c => ({ value: c.id, label: `#${c.id} · ${c.count || (c.members && c.members.length) || 0} nodes` })),
        ui.clusterId, (v) => { ui.clusterId = v; render(); }));
      wrap.appendChild(clRow);
    }

    // ── live count ──
    const sel = ui.mode === "by-score"
      ? { mode: "by-score", level: ui.level, minScore: ui.minScore }
      : { mode: "cluster", level: ui.level, clusterId: ui.clusterId };
    const picked = selectNodes(levels, scores, sel);
    const count = document.createElement("div");
    count.className = "export-count";
    count.textContent = ui.mode === "by-score"
      ? `${picked.nodeIds.length} nodes in ${picked.clusterIds.length} cluster${picked.clusterIds.length === 1 ? "" : "s"} scoring ≥ ${ui.minScore} at L${ui.level}`
      : `${picked.nodeIds.length} nodes in cluster #${ui.clusterId} at L${ui.level}`;
    wrap.appendChild(count);

    // ── download ──
    const hasCorpus = hasSqliteText();
    const btn = document.createElement("button");
    btn.className = "export-download";
    btn.textContent = "Download RIS";
    btn.disabled = !hasCorpus || picked.nodeIds.length === 0;
    btn.addEventListener("click", () => {
      const note = (nodeId, cid, uid) => `network_toy export · level ${ui.level} (${uid}) · cluster ${cid}`;
      const { ris, count: n, missing } = buildRis(levels, scores, sel, getNodeRecord, note);
      if (n === 0) return;
      downloadText(ris, exportFilename(sel));
      const msg = document.createElement("div");
      msg.className = "export-result";
      msg.textContent = `Exported ${n} record${n === 1 ? "" : "s"}` +
        (missing ? ` (${missing} node${missing === 1 ? "" : "s"} had no bibliographic record)` : "") + ".";
      wrap.appendChild(msg);
    });
    wrap.appendChild(btn);

    if (!hasCorpus) {
      wrap.appendChild(empty("RIS export needs the biblion corpus loaded (it supplies titles / authors / DOIs)."));
    }

    container.appendChild(wrap);
  }

  render();
  const unsub = subscribe(() => render());
  return { update() { render(); }, destroy() { unsub(); container.innerHTML = ""; } };
}

/* ── tiny DOM helpers ─────────────────────────────────────────────────── */
function empty(text) {
  const e = document.createElement("div");
  e.className = "export-empty";
  e.textContent = text;
  return e;
}
function row(labelText) {
  const r = document.createElement("div");
  r.className = "export-row";
  const l = document.createElement("label");
  l.className = "export-row-label";
  l.textContent = labelText;
  r.appendChild(l);
  return r;
}
// Thin wrappers over the kit (widgets.js) that keep this panel's numeric
// coercion + clamping and its `export-*` class names — same DOM/wiring as
// the previous hand-rolled controls. Option values are numbers here, so
// match against String(value) and coerce the change back with Number().
function select(options, value, onChange) {
  return kitSelect(
    options.map(o => ({ value: String(o.value), label: o.label })),
    {
      value: String(value),
      className: "export-select",
      onChange: (v) => onChange(Number(v)),
    },
  );
}
function numberInput(min, max, step, value, onChange) {
  const i = kitNumberInput({
    min, max, step, value, className: "export-number",
    onChange: () => {
      let v = parseInt(i.value, 10);
      if (!Number.isFinite(v)) v = min;
      v = Math.max(min, Math.min(max, v));
      onChange(v);
    },
  });
  return i;
}
function toggle(options, value, onChange) {
  const t = document.createElement("div");
  t.className = "export-toggle";
  for (const o of options) {
    const b = document.createElement("button");
    b.className = "export-toggle-btn" + (o.v === value ? " active" : "");
    b.textContent = o.label;
    b.addEventListener("click", () => onChange(o.v));
    t.appendChild(b);
  }
  return t;
}
