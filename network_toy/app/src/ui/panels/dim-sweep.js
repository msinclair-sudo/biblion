// Panel: dim-sweep — saved-mode renderer for a card or a legacy
// validationRun.
//
// Phase 2 slice 2.9.b removed the panel's live tab. Dim-sweep is now
// kicked off from the workflow chart (Dim sweep card → modal → Apply).
// The panel renders results only.
//
// Two binding modes, picked by config:
//   - **Step-bound** (config.stepId): renders the matching
//     state.workflow.steps[stepId].result.
//   - **Legacy run-bound** (config.runId): renders the matching
//     state.validationRuns entry. Kept so saved projects from before
//     2.9.b continue to render their dim-sweep runs.

import { getState, subscribe }              from "../state.js";
import { getStep }                          from "../workflow.js";
import { dimSweepVerdict }                  from "../../eval/dim-sweep.js";
import { renderHeatmap }                    from "../charts/heatmap.js";
import { renderBars }                       from "../charts/bars.js";

export const ID          = "dim-sweep";
export const LABEL       = "Dim sweep";
export const DESCRIPTION = "ARI dim-sweep validation (§6.9) — heatmap + cluster-count bars + verdict for a dimSweep card or legacy saved validationRun. Run a new sweep from the workflow chart's Dim sweep card.";
export const SINGLETON   = true;

const DEFAULT_THRESHOLD = 0.9;

export function mount(container, _state, config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-ds";
  container.appendChild(wrap);

  const stepId = (config && config.stepId) || null;
  const runId  = (config && config.runId)  || null;

  function resolveBinding() {
    if (stepId) {
      const s = getStep(stepId);
      if (s && s.type === "dimSweep" && s.result) {
        return { kind: "step", id: stepId, source: stepResultToSource(s) };
      }
      return { kind: "missing", id: stepId };
    }
    if (runId) {
      const r = (getState().validationRuns || []).find(x => x.id === runId);
      if (r) return { kind: "run", id: runId, source: runToSource(r) };
      return { kind: "missing", id: runId };
    }
    // Auto-pick: latest done dimSweep card, else latest saved run.
    const w = getState().workflow;
    if (w && w.steps) {
      const cards = Object.values(w.steps)
        .filter(s => s.type === "dimSweep" && s.status === "done" && s.result);
      if (cards.length > 0) {
        const latest = cards[cards.length - 1];
        return { kind: "step", id: latest.id, source: stepResultToSource(latest) };
      }
    }
    const runs = (getState().validationRuns || []).filter(r => r.type === "dimSweep");
    if (runs.length > 0) {
      const latest = runs[runs.length - 1];
      return { kind: "run", id: latest.id, source: runToSource(latest) };
    }
    return { kind: "empty" };
  }

  let lastSourceRef = undefined;

  function render() {
    const binding = resolveBinding();
    const sourceRef = binding.source || null;
    if (sourceRef === lastSourceRef && binding.kind !== "missing" && binding.kind !== "empty") {
      if (lastSourceRef !== undefined) return;
    }
    lastSourceRef = sourceRef;

    wrap.innerHTML = "";

    const header = document.createElement("div");
    header.className = "panel-ds-header";
    const title = document.createElement("div");
    title.className = "panel-ds-title";
    const sub   = document.createElement("div");
    sub.className = "panel-ds-meta";
    header.appendChild(title);
    header.appendChild(sub);
    wrap.appendChild(header);

    if (binding.kind === "empty") {
      title.textContent = "Dim sweep";
      const empty = document.createElement("div");
      empty.className = "panel-ds-empty";
      empty.textContent = "No dim-sweep runs yet. Open the Dim sweep card on the workflow chart and click Apply to run one.";
      wrap.appendChild(empty);
      return;
    }
    if (binding.kind === "missing") {
      title.textContent = "Dim sweep";
      const empty = document.createElement("div");
      empty.className = "panel-ds-empty";
      empty.textContent = `Bound run "${binding.id}" no longer exists. Open the panel picker (+) to choose another.`;
      wrap.appendChild(empty);
      return;
    }

    const src = binding.source;
    title.textContent = src.label || "(unlabelled dim-sweep run)";
    sub.textContent = formatMeta(src);
    renderResultBody(wrap, src.sweep, src.verdictPair, src.verdictThreshold, src.runtimeSec);
  }

  render();
  const unsub = subscribe(() => render());

  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}

// ── source extractors ──────────────────────────────────────────────

function stepResultToSource(step) {
  const r = step.result || {};
  const dims = (r.sweep && r.sweep.dims) || [];
  const settings = r.settings || {};
  const defaultPair = dims.length >= 2
    ? [dims[dims.length - 2], dims[dims.length - 1]]
    : [dims[0], dims[0]];
  return {
    label:            step.label || r.label,
    sweep:            r.sweep,
    verdictPair:      settings.verdictPair || defaultPair,
    verdictThreshold: Number.isFinite(settings.verdictThreshold) ? settings.verdictThreshold : DEFAULT_THRESHOLD,
    runtimeSec:       r.runtimeSec || 0,
    savedAt:          r.ranAt || step.endedAt || null,
    dataSourceMode:   getState().dataSource && getState().dataSource.mode,
    dataSourceConfig: {},
    settings,
  };
}

function runToSource(run) {
  const inputs = run.inputs || {};
  const settings = run.settings || {};
  const sweep = (run.results || {}).sweep;
  const dims = (sweep && sweep.dims) || [];
  const defaultPair = dims.length >= 2
    ? [dims[dims.length - 2], dims[dims.length - 1]]
    : [dims[0], dims[0]];
  return {
    label:            run.label,
    sweep,
    verdictPair:      settings.verdictPair || defaultPair,
    verdictThreshold: Number.isFinite(settings.verdictThreshold) ? settings.verdictThreshold : DEFAULT_THRESHOLD,
    runtimeSec:       run.runtimeSec || 0,
    savedAt:          run.timestamp || null,
    dataSourceMode:   inputs.dataSourceId,
    dataSourceConfig: inputs.dataSourceConfig || {},
    settings,
  };
}

// ── renderer (saved-mode body — verdict picker is now read-only since
//    every render is from a frozen card/run snapshot) ────────────────

function renderResultBody(host, sweep, pair, threshold, runtimeSec) {
  if (!sweep) {
    const empty = document.createElement("div");
    empty.className = "panel-ds-empty";
    empty.textContent = "(saved run carries no sweep result — likely a schema mismatch)";
    host.appendChild(empty);
    return;
  }
  const { dims, ariMatrix, clusterCounts } = sweep;
  const verdict = dimSweepVerdict(sweep, pair[0], pair[1], threshold);

  // Verdict pair row (read-only).
  const verdictRow = document.createElement("div");
  verdictRow.className = "panel-ds-verdict-row";
  verdictRow.innerHTML =
    `<span class="panel-ds-verdict-pickerlabel">Verdict pair:</span>` +
    `<span>d=${pair[0]}</span><span style="opacity:0.6;">vs</span><span>d=${pair[1]}</span>` +
    `<span class="panel-ds-verdict-thlabel">threshold</span>` +
    `<span>${threshold.toFixed(2)}</span>`;
  host.appendChild(verdictRow);

  // Verdict banner.
  const banner = document.createElement("div");
  banner.className = "panel-ds-verdict-banner";
  banner.dataset.defensible = String(verdict.defensible);
  if (verdict.mean === null) {
    banner.textContent = `ARI(${pair[0]}, ${pair[1]}) — no data`;
  } else {
    const tag = verdict.defensible ? "PASS" : "FAIL";
    banner.innerHTML =
      `<b>${tag}</b> · mean ARI(${pair[0]}, ${pair[1]}) = <b>${verdict.mean.toFixed(3)}</b>` +
      ` ± ${verdict.sd.toFixed(3)}` +
      ` · threshold ${threshold.toFixed(2)}` +
      ` · ${verdict.defensible
            ? `${pair[0]}-d preserves partition structure at this threshold`
            : `${pair[0]}-d differs meaningfully from ${pair[1]}-d — consider bumping the compression default`}`;
  }
  host.appendChild(banner);

  // ARI heatmap.
  const heatmapTitle = document.createElement("div");
  heatmapTitle.className = "panel-ds-chart-title";
  heatmapTitle.textContent = "Mean pairwise ARI across seeds";
  host.appendChild(heatmapTitle);

  const heatmapHost = document.createElement("div");
  heatmapHost.className = "panel-ds-chart-host";
  host.appendChild(heatmapHost);
  const matrix = dims.map(d1 => dims.map(d2 => ariMatrix[d1][d2].mean));
  renderHeatmap(heatmapHost, {
    matrix,
    rowLabels:   dims.map(d => `d=${d}`),
    colLabels:   dims.map(d => `d=${d}`),
    palette:     "ari",
    vmin:        0,
    vmax:        1,
    cellSize:    52,
    legendLabel: "ARI",
    formatCell:  (v) => v.toFixed(3),
    cellTitle:   (rL, cL) => {
      const d1n = parseInt(String(rL).replace("d=", ""), 10);
      const d2n = parseInt(String(cL).replace("d=", ""), 10);
      const cell = ariMatrix[d1n] && ariMatrix[d1n][d2n];
      return cell
        ? `ARI(${d1n}, ${d2n}) = ${cell.mean.toFixed(3)} ± ${cell.sd.toFixed(3)} · per seed: ${cell.perSeed.map(x => x.toFixed(3)).join(", ")}`
        : "—";
    },
  });

  // Cluster-count bars.
  const barsTitle = document.createElement("div");
  barsTitle.className = "panel-ds-chart-title";
  barsTitle.textContent = "Cluster counts (mean ± SD across seeds)";
  host.appendChild(barsTitle);

  const barsHost = document.createElement("div");
  barsHost.className = "panel-ds-chart-host";
  host.appendChild(barsHost);
  renderBars(barsHost, {
    values: dims.map(d => clusterCounts[d].mean),
    errors: dims.map(d => clusterCounts[d].sd),
    labels: dims.map(d => `d=${d}`),
    cellSize: 64,
    chartH: 140,
    yLabel: "n clusters",
    formatBar: (v) => v.toFixed(1),
  });

  // Footer — runtime.
  const footer = document.createElement("div");
  footer.className = "panel-ds-footer";
  footer.textContent = runtimeSec ? `${runtimeSec.toFixed(1)}s` : "";
  host.appendChild(footer);
}

function formatMeta(src) {
  const dt = src.savedAt ? new Date(src.savedAt).toLocaleString() : "";
  const subset = src.dataSourceConfig && src.dataSourceConfig.subset
    ? ` · ${src.dataSourceConfig.subset}`
    : "";
  const fixtureTag = src.dataSourceMode ? `${src.dataSourceMode}${subset}` : "unknown source";
  const dims = (src.sweep && src.sweep.dims) || [];
  const seeds = (src.sweep && src.sweep.seeds) || [];
  return dt
    ? `${dims.length} dims × ${seeds.length} seeds · ${fixtureTag} · saved ${dt}`
    : `${dims.length} dims × ${seeds.length} seeds · ${fixtureTag}`;
}
