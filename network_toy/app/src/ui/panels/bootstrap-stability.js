// Panel: bootstrap stability — renders the sidecar result of the live
// clustering OR a legacy validationRun.
//
// cards.md Pass 2b (2026-06-03): bootstrap is no longer a standalone card.
// It runs as a sidecar to clustering — knobs in the clustering modal's
// Configure tab — and lands on state.bootstrapStability. The panel
// auto-binds to that slot. Two legacy paths are kept for older saves:
//   - **Step-bound** (config.stepId): renders a bootstrapStability card's
//     result on a pre-Pass-2b workflow.
//   - **Run-bound** (config.runId): renders a saved validationRuns entry.

import {
  getState, subscribe, setSelection,
} from "../state.js";
import { getStep }                              from "../workflow.js";
import { SCORE_VERSION, DEFAULT_MIN_MEMBERS,
         HENNIG_STABLE, HENNIG_DOUBTFUL }       from "../../eval/bootstrap.js";

export const ID          = "bootstrap-stability";
export const LABEL       = "Bootstrap stability";
export const DESCRIPTION = "Per-cluster bootstrap-Jaccard stability for the live clustering (run it from the Clustering modal's Stability section) or a legacy saved validationRun.";
export const SINGLETON   = true;

export function mount(container, _state, config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-bs";
  container.appendChild(wrap);

  const stepId = (config && config.stepId) || null;
  const runId  = (config && config.runId)  || null;

  // Auto-bind: prefer the live state.bootstrapStability (the sidecar from
  // the most recent clustering); fall back to legacy card / validationRun
  // shapes for older saves.
  function resolveBinding() {
    if (stepId) {
      const s = getStep(stepId);
      if (s && s.type === "bootstrapStability" && s.result) {
        return { kind: "step", id: stepId, source: stepResultToSource(s) };
      }
      return { kind: "missing", id: stepId };
    }
    if (runId) {
      const r = (getState().validationRuns || []).find(x => x.id === runId);
      if (r) return { kind: "run", id: runId, source: runToSource(r) };
      return { kind: "missing", id: runId };
    }
    // Auto-pick: live state slot wins (clustering sidecar, cards.md Pass 2b);
    // then legacy bootstrap card if one survives an old save; then validationRun.
    const live = getState().bootstrapStability;
    if (live && live.bootstrapResult) {
      return { kind: "live", id: "live", source: liveStateToSource(live) };
    }
    const w = getState().workflow;
    if (w && w.steps) {
      const cards = Object.values(w.steps)
        .filter(s => s.type === "bootstrapStability" && s.status === "done" && s.result);
      if (cards.length > 0) {
        const latest = cards[cards.length - 1];
        return { kind: "step", id: latest.id, source: stepResultToSource(latest) };
      }
    }
    const runs = (getState().validationRuns || []).filter(r => r.type === "bootstrapStability");
    if (runs.length > 0) {
      const latest = runs[runs.length - 1];
      return { kind: "run", id: latest.id, source: runToSource(latest) };
    }
    return { kind: "empty" };
  }

  // Re-render only when the bound source reference changes (otherwise
  // every state tick clobbers the DOM unnecessarily). Sentinel:
  // undefined means "not yet rendered" so the first render fires.
  let lastSourceRef = undefined;

  function render() {
    const binding = resolveBinding();
    const sourceRef = binding.source || null;
    if (sourceRef === lastSourceRef && binding.kind !== "missing" && binding.kind !== "empty") {
      // No change — but if previously empty/missing and still so, the
      // initial empty-state has already rendered.
      if (lastSourceRef !== undefined) return;
    }
    lastSourceRef = sourceRef;

    wrap.innerHTML = "";

    const header = document.createElement("div");
    header.className = "panel-bs-header";
    const title = document.createElement("div");
    title.className = "panel-bs-title";
    const sub = document.createElement("div");
    sub.className = "panel-bs-meta";
    header.appendChild(title);
    header.appendChild(sub);
    wrap.appendChild(header);

    if (binding.kind === "empty") {
      title.textContent = "Bootstrap stability";
      const empty = document.createElement("div");
      empty.className = "panel-bs-empty";
      empty.textContent = "No bootstrap runs yet. Open the Clustering modal → Stability section, make sure 'Run bootstrap stability' is on, and Apply.";
      wrap.appendChild(empty);
      return;
    }
    if (binding.kind === "missing") {
      title.textContent = "Bootstrap stability";
      const empty = document.createElement("div");
      empty.className = "panel-bs-empty";
      empty.textContent = `Bound run "${binding.id}" no longer exists. Open the panel picker (+) to choose another.`;
      wrap.appendChild(empty);
      return;
    }

    const src = binding.source;
    title.textContent = src.label || "(unlabelled bootstrap run)";
    sub.textContent = formatMeta(src);
    renderResultBody(wrap, src.bootstrapResult, src.cluster || {}, src.runtimeSec);
  }

  render();
  const unsub = subscribe(() => render());

  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}

// ── source extractors ──────────────────────────────────────────────

// A "source" is the normalised shape the renderer consumes:
//   { label, bootstrapResult, cluster: {label, nClusters}, settings,
//     runtimeSec, savedAt, dataSourceMode, dataSourceConfig }
// step-bound and run-bound bindings both flatten to this.

// Live state slot — populated by engine.recluster's bootstrap sidecar
// (cards.md Pass 2b). Same renderer shape; no validationRun id.
function liveStateToSource(slot) {
  return {
    label:           slot.label || "bootstrap (live)",
    bootstrapResult: slot.bootstrapResult,
    cluster:         slot.cluster || {},
    settings:        slot.settings || {},
    runtimeSec:      slot.runtimeSec || 0,
    savedAt:         slot.capturedAt || null,
    dataSourceMode:  liveDataSourceMode(),
    dataSourceConfig: {},
  };
}

function stepResultToSource(step) {
  const r = step.result || {};
  return {
    label:           step.label || r.label || "bootstrap",
    bootstrapResult: r.bootstrapResult,
    cluster:         r.cluster || {},
    settings:        r.settings || {},
    runtimeSec:      r.runtimeSec || 0,
    savedAt:         r.ranAt || step.endedAt || null,
    // The card doesn't store full data-source config; pull descriptors
    // off the validationRun if there's a linked one (auto-saved by the
    // runner). Otherwise fall back to live state's data-source mode.
    dataSourceMode:  liveDataSourceMode(),
    dataSourceConfig: {},
  };
}

function runToSource(run) {
  const inputs = run.inputs || {};
  return {
    label:           run.label,
    bootstrapResult: (run.results || {}).bootstrapResult,
    cluster:         (run.results || {}).cluster || {},
    settings:        run.settings || {},
    runtimeSec:      run.runtimeSec || 0,
    savedAt:         run.timestamp || null,
    dataSourceMode:  inputs.dataSourceId,
    dataSourceConfig: inputs.dataSourceConfig || {},
  };
}

function liveDataSourceMode() {
  const ds = getState().dataSource;
  return ds && ds.mode;
}

// ── renderer (unchanged from pre-2.9.a saved-mode body) ───────────

function renderResultBody(host, br, curSummary, runtimeSec) {
  if (!br) {
    const empty = document.createElement("div");
    empty.className = "panel-bs-empty";
    empty.textContent = "(no result on this binding)";
    host.appendChild(empty);
    return;
  }
  const agg = br.aggregate;
  if (!agg || !Array.isArray(br.perCluster)) {
    const empty = document.createElement("div");
    empty.className = "panel-bs-empty";
    empty.textContent = "(empty result)";
    host.appendChild(empty);
    return;
  }

  // Aggregate strip.
  const aggRow = document.createElement("div");
  aggRow.className = "panel-bs-agg";
  aggRow.innerHTML = `
    <span><b>macro</b> ${fmtScalar(agg.meanJaccard_macro)}</span>
    <span><b>per-cluster</b> ${fmtScalar(agg.meanJaccard_unweighted)}</span>
    <span><b>nClusters</b> ${agg.nClusters}</span>
    <span><b>noise frac</b> ${fmtScalar(agg.noiseFraction)}</span>
    <span><b>protocol</b> ${agg.noiseHandling || "exclude"}</span>
  `;
  host.appendChild(aggRow);

  // Hennig breakdown bar.
  const total = agg.nStable + agg.nDoubtful + agg.nUnstable;
  if (total > 0) {
    const bar = document.createElement("div");
    bar.className = "panel-bs-breakdown";
    const s = (agg.nStable   / total) * 100;
    const d = (agg.nDoubtful / total) * 100;
    const u = (agg.nUnstable / total) * 100;
    bar.innerHTML = `
      <span class="cm-hennig-bar" title="${agg.nStable} stable · ${agg.nDoubtful} doubtful · ${agg.nUnstable} unstable (Hennig: stable ≥ ${HENNIG_STABLE}, doubtful ${HENNIG_DOUBTFUL}–${HENNIG_STABLE}, unstable < ${HENNIG_DOUBTFUL})">
        <span class="cm-hennig-seg cm-hennig-stable"   style="width:${s.toFixed(2)}%"></span>
        <span class="cm-hennig-seg cm-hennig-doubtful" style="width:${d.toFixed(2)}%"></span>
        <span class="cm-hennig-seg cm-hennig-unstable" style="width:${u.toFixed(2)}%"></span>
      </span>
      <span class="panel-bs-breakdown-counts">
        ${agg.nStable} stable · ${agg.nDoubtful} doubtful · ${agg.nUnstable} unstable
      </span>
    `;
    host.appendChild(bar);
  }

  // Per-cluster table.
  const table = document.createElement("table");
  table.className = "panel-bs-table";
  host.appendChild(table);

  let sortKey = "meanJaccard";
  let sortDir = "asc";
  const cols = [
    { key: "id",          label: "id",           align: "right", value: r => r.clusterId },
    { key: "count",       label: "count",        align: "right", value: r => r.memberCount },
    { key: "meanJaccard", label: "mean Jaccard", align: "right", value: r => r.meanJaccard },
    { key: "class",       label: "class",        align: "left",  value: r => r.classification },
  ];

  function rebuild() {
    table.innerHTML = "";
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    for (const col of cols) {
      const th = document.createElement("th");
      th.textContent = col.label;
      th.style.textAlign = col.align;
      th.classList.add("sortable");
      if (col.key === sortKey) th.classList.add("sorted-" + sortDir);
      th.addEventListener("click", () => {
        if (sortKey === col.key) sortDir = sortDir === "asc" ? "desc" : "asc";
        else { sortKey = col.key; sortDir = "asc"; }
        rebuild();
      });
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    const sorted = br.perCluster.slice().sort((a, b) => {
      const col = cols.find(c => c.key === sortKey);
      const av = col.value(a), bv = col.value(b);
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * (sortDir === "asc" ? 1 : -1);
    });

    const sel = getState().selection || {};
    const lvl = (getState().clusterLevels || []).length - 1;
    const isSel = (r) => sel.type === "cluster" && sel.level === lvl && sel.id === r.clusterId;

    const tbody = document.createElement("tbody");
    for (const r of sorted) {
      const tr = document.createElement("tr");
      tr.className = `panel-bs-row class-${r.classification}`;
      if (isSel(r)) tr.classList.add("selected");
      for (const col of cols) {
        const td = document.createElement("td");
        td.style.textAlign = col.align;
        if (col.key === "meanJaccard") td.textContent = fmtScalar(r.meanJaccard);
        else                            td.textContent = String(col.value(r));
        tr.appendChild(td);
      }
      tr.addEventListener("click", () => {
        if (isSel(r)) setSelection({ type: null, id: null });
        else          setSelection({ type: "cluster", level: lvl, id: r.clusterId });
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }
  rebuild();

  // Footer — protocol + runtime.
  const footer = document.createElement("div");
  footer.className = "panel-bs-footer";
  const s = curSummary || {};
  const settingsLine = s.label && agg
    ? `${s.label} · ${s.nClusters || agg.nClusters} clusters · scoreVersion ${SCORE_VERSION}`
    : `scoreVersion ${SCORE_VERSION}`;
  footer.textContent = (runtimeSec ? `${settingsLine} · ${runtimeSec.toFixed(1)}s` : settingsLine);
  host.appendChild(footer);
}

// ── helpers ──

function formatMeta(src) {
  const dt = src.savedAt ? new Date(src.savedAt).toLocaleString() : "";
  const subset = src.dataSourceConfig && src.dataSourceConfig.subset
    ? ` · ${src.dataSourceConfig.subset}`
    : "";
  const fixtureTag = src.dataSourceMode ? `${src.dataSourceMode}${subset}` : "unknown source";
  const settings = src.settings || {};
  const protoTag = settings.B != null
    ? `B=${settings.B} · frac=${settings.subsampleFrac} · minMembers=${settings.minMembers ?? DEFAULT_MIN_MEMBERS} · noise=${settings.noiseHandling}`
    : "(settings unknown)";
  return dt ? `${fixtureTag} · ${protoTag} · saved ${dt}` : `${fixtureTag} · ${protoTag}`;
}

function fmtScalar(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(2);
  return v.toFixed(3);
}
