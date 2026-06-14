// Panel: Optimise sweep results (live or saved).
//
// Two modes selected by `config.runId`:
//   - **Saved** (config.runId set): renders the matching entry from
//     state.validationRuns. Read-only — Apply on a row re-infers.
//   - **Live** (no runId): renders state.evalResults.optimise (the
//     latest sweep run from the Optimise tab). Auto-updates when a
//     new sweep completes. Apply on a row goes through the same
//     descriptor path the modal uses.
//
// One panel module, two modes; the picker picks the binding:
//   - Picked from *Panel types* → no config → live mode.
//   - Picked from *Validation runs* → config.runId → saved mode.
//
// If the bound run is deleted or the live slot is empty, the panel
// shows a small empty-state hint rather than crashing.

import { getState, subscribe }  from "../state.js";
import { getLayerDescriptor }    from "../modals/layer-descriptors.js";
import { renderResults }         from "../modals/clustering-tabs/optimise-results-renderer.js";

export const ID          = "validation-run-optimise";
export const LABEL       = "Optimise results";
export const DESCRIPTION = "Latest Optimise sweep results, or a saved run when picked from Validation runs. Per-row Apply lands the chosen config into the active clustering.";

export function mount(container, _state, config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-vr-optimise";
  container.appendChild(wrap);

  const runId = (config && config.runId) || null;
  const liveMode = !runId;
  // Sentinel: undefined means "not yet rendered". Using null here
  // would collide with findSource()'s "no result" return value, so
  // the initial empty-state render would get skipped.
  let lastSourceRef = undefined;

  // Source resolver — different by mode but produces the same
  // {label, timestamp, inputs?, results, runtimeSec?} shape so the
  // renderer below stays uniform.
  function findSource() {
    if (liveMode) {
      const opt = getState().evalResults && getState().evalResults.optimise;
      if (!opt || !opt.ranked || opt.ranked.length === 0) return null;
      return {
        live:      true,
        label:     "Latest sweep",
        timestamp: opt.timestamp,
        results:   opt,
        runtimeSec: opt.runtimeSec,
      };
    }
    const runs = getState().validationRuns || [];
    const run = runs.find(r => r.id === runId);
    return run || null;
  }

  function render() {
    const src = findSource();
    if (src === lastSourceRef) return;   // no change → skip rerender (avoids row-click churn)
    lastSourceRef = src;

    if (!src) {
      wrap.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "panel-vr-empty";
      empty.textContent = liveMode
        ? "No Optimise results yet. Open the Clustering modal → Optimise tab → Run sweep."
        : "This saved run no longer exists. Open the panel picker (+) to choose another.";
      wrap.appendChild(empty);
      return;
    }

    wrap.innerHTML = "";

    // Header — label, meta. Layout same for live + saved, just with
    // a "(live)" tag on the latter and a fixture/timestamp meta on
    // saved.
    const header = document.createElement("div");
    header.className = "panel-vr-header";
    const title = document.createElement("div");
    title.className = "panel-vr-title";
    title.textContent = src.live
      ? "Optimise — live results"
      : (src.label || "(unlabelled run)");
    header.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "panel-vr-meta";
    const dt = src.timestamp ? new Date(src.timestamp).toLocaleString() : "";
    if (src.live) {
      const opt = src.results;
      meta.textContent = `${opt.totalConfigs} configs · ranked by ${opt.scorerLabel || opt.scorerId}${dt ? " · run " + dt : ""}`;
    } else {
      const inputsDS  = src.inputs && src.inputs.dataSourceId;
      const inputsCfg = src.inputs && src.inputs.dataSourceConfig;
      const subset = inputsCfg && inputsCfg.subset ? ` · ${inputsCfg.subset}` : "";
      const fixtureTag = inputsDS ? `${inputsDS}${subset}` : "unknown source";
      meta.textContent = `${src.results.totalConfigs} configs · ranked by ${src.results.scorerLabel || src.results.scorerId} · ${fixtureTag} · saved ${dt}`;
    }
    header.appendChild(meta);

    // Fixture-mismatch warning (saved mode only): the saved run was
    // produced on a particular dataSource; if the current state has
    // a different dataSource, applying a row will re-infer against
    // the CURRENT data, which may not be what the user wants.
    if (!src.live) {
      const inputsDS = src.inputs && src.inputs.dataSourceId;
      const curMode = getState().dataSource && getState().dataSource.mode;
      if (inputsDS && curMode && inputsDS !== curMode) {
        const warn = document.createElement("div");
        warn.className = "panel-vr-warn";
        warn.textContent = `⚠ Saved on data source "${inputsDS}"; current is "${curMode}". Apply will re-infer against the current data.`;
        header.appendChild(warn);
      }
    }

    wrap.appendChild(header);

    // Body — the ranked table.
    const body = document.createElement("div");
    body.className = "panel-vr-body";
    wrap.appendChild(body);

    const outcome = {
      ranked:       src.results.ranked || [],
      totalConfigs: src.results.totalConfigs,
      completed:    src.results.completed,
    };
    const scorer = {
      id:    src.results.scorerId,
      label: src.results.scorerLabel || src.results.scorerId,
    };

    // Per-row Apply: same routing as the in-modal tab. We don't have
    // the modal's getLevels helper here, so pass null → renderer
    // falls back to a single "Apply" button per row (lands on L0).
    // _cr is absent in v1-persisted runs → precomputedCr = null.
    const onApplyRow = (row /*, levelIdx */) => {
      const desc = getLayerDescriptor("clustering");
      if (!desc) {
        console.warn("[optimise-results panel] no clustering descriptor; can't apply");
        return;
      }
      const active = desc.getActive();
      const newLvl = {
        uid:    Math.random().toString(36).slice(2, 10),
        params: { ...row.params },
        scope:  "global",
      };
      const levels = [newLvl, ...(active.levels || []).slice(1)];
      // Apply re-infers in v1: both setOptimiseResult (live slot) and
      // saveValidationRun (saved-run slot) strip `_cr` before
      // persisting, so the rows we render here never carry the §6.18.3
      // precomputedCr cache. Re-infer is fast (~one infer per row)
      // vs the original sweep cost (N × infer). The §6.19 follow-up
      // to persist `_cr` would make this instant.
      //
      // Phase 2 slice 2.9.c — descriptor.applyChange already enqueues a
      // step-bound job (slice 2.5); wrapping it in enqueueBusy nested
      // queues. Call directly + surface errors to the console.
      desc.applyChange(row.algoId, levels, { precomputedCr: null })
        .catch(e => console.error("[optimise-results panel] apply failed:", e));
    };

    renderResults(body, outcome, scorer, onApplyRow, null);
  }

  render();
  const unsub = subscribe(() => render());

  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}
