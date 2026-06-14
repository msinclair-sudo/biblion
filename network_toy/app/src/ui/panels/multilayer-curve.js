// Panel: multi-layer LAYER PICKER (§9 producer/picker split, 2026-06-01;
// heatmap + live readout added 2026-06-02, Pass 1b).
//
// Two-column body:
//   LEFT  — reproducibility (stability) curve. One point per candidate
//           granularity the sweep tried. Click points to toggle picks.
//   RIGHT — bridge heatmap. One cell per (child > parent) pair across the
//           sweep candidates. Cell = bridge count (raw in tile, normalised
//           colour). Click a cell to highlight both layers on the curve;
//           click a curve point to shade the matching heatmap row/column.
//
// Bottom — live readout: lists the picked layers (coarse → fine) with their
//          cluster counts, and the bridge counts between adjacent picks.
//          Updates instantly (filters from pre-computed bridgesPerPair).
//
// Reads the producer card's sweep through the multiLevelPicker descriptor's
// getActive() (so each picker shows its own producer's curve + its committed
// picks); falls back to state.multiLevelSweep when shown standalone.

import { getState, subscribe } from "../state.js";
import { renderLine }          from "../charts/line.js";
import { renderHeatmap }       from "../charts/heatmap.js";
import { getLayerDescriptor }  from "../modals/layer-descriptors.js";

export const ID          = "multilayer-curve";
export const LABEL       = "Pick layers";
export const DESCRIPTION = "Reproducibility vs. cluster count + bridge heatmap for an Optimise-multi-layer run. Click points / cells to choose your coarse→fine layers, then Apply.";
export const SINGLETON   = true;

export function mount(container, _state, _config = {}) {
  // Local picked-set, seeded from the picker card's committed picks each time
  // a different sweep/card comes into view (tracked by uidPrefix).
  let picked = new Set();
  let seededFor = null;

  // Transient cross-binding highlight — { childIdx, parentIdx } when a
  // heatmap cell is hovered/clicked; null otherwise. Highlights both layers
  // on the curve and the matching row/col on the heatmap.
  let highlightedPair = null;

  function readActive() {
    // Prefer the picker descriptor's view (knows the parent producer + the
    // card's committed picks). Fall back to the bare sweep slot.
    try {
      const a = getLayerDescriptor("multiLevelPicker").getActive();
      if (a && a.sweep) return a;
    } catch (_) { /* no picker selected — fall through */ }
    const sweep = getState().multiLevelSweep;
    return sweep
      ? { sweep, curve: sweep.curve, floor: sweep.floor, prevPicks: [], stepId: null }
      : null;
  }

  function render() {
    container.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "multilayer-curve-panel";

    const title = document.createElement("div");
    title.className = "multilayer-curve-title";
    title.textContent = "Pick layers";
    wrap.appendChild(title);

    const active = readActive();
    const curve = active && Array.isArray(active.curve) ? active.curve : null;

    if (!curve || curve.length === 0) {
      const empty = document.createElement("div");
      empty.className = "multilayer-curve-empty";
      empty.textContent =
        "No multi-layer sweep yet — run an Optimise multi-layer clustering " +
        "(the + under a dim-reduction card); a picker opens when it finishes.";
      wrap.appendChild(empty);
      container.appendChild(wrap);
      return;
    }

    // Seed the picked-set from the card's committed picks the first time this
    // sweep is shown (keyed by uidPrefix so switching cards re-seeds).
    const key = (active.sweep && active.sweep.uidPrefix) || "ML";
    if (seededFor !== key) {
      picked = new Set(active.prevPicks || []);
      seededFor = key;
      highlightedPair = null;
    }
    // Drop picks that aren't valid candidate counts (defensive).
    const validCounts = new Set(curve.map(c => c.count));
    for (const c of [...picked]) if (!validCounts.has(c)) picked.delete(c);

    const summary = document.createElement("div");
    summary.className = "multilayer-curve-summary";
    summary.textContent =
      `${curve.length} candidate granularit${curve.length === 1 ? "y" : "ies"} · ` +
      `${picked.size} picked` +
      (picked.size ? ` (${[...picked].sort((a, b) => a - b).join(", ")} clusters)` : " — click points to choose");
    wrap.appendChild(summary);

    // ── Two-column body: stability curve | bridge heatmap ─────────────────
    const body = document.createElement("div");
    body.className = "multilayer-curve-body";
    wrap.appendChild(body);

    const chartHost = document.createElement("div");
    chartHost.className = "multilayer-curve-chart";
    body.appendChild(chartHost);

    const heatHost = document.createElement("div");
    heatHost.className = "multilayer-curve-chart";
    body.appendChild(heatHost);

    // Sweep candidates in coarse → fine order. The heatmap indices match
    // candidate array indices; the curve x-axis is cluster count.
    const sweep      = active.sweep || {};
    const candidates = Array.isArray(sweep.candidates) ? sweep.candidates : [];
    const bpp        = sweep.bridgesPerPair || null;

    // Build curve points. Pre-compute the heatmap-highlighted counts so the
    // matching curve dots flag with `highlighted`.
    const highlightedCounts = new Set();
    if (highlightedPair && candidates[highlightedPair.childIdx] && candidates[highlightedPair.parentIdx]) {
      highlightedCounts.add(candidates[highlightedPair.childIdx].count);
      highlightedCounts.add(candidates[highlightedPair.parentIdx].count);
    }

    const floor = Number.isFinite(active.floor) ? active.floor : 0.6;
    renderLine(chartHost, {
      points: curve.map(c => ({
        x:           c.count,
        y:           Number.isFinite(c.stability) ? c.stability : null,
        selected:    picked.has(c.count),
        highlighted: highlightedCounts.has(c.count),
        size:        c.plateauWidth,
        label:       `${c.count} clusters (mcs ${c.size})`,
      })),
      yMin: 0, yMax: 1, xLog: true,
      hline: floor,
      hlineLabel: `floor ${floor.toFixed(2)}`,
      xLabel: "cluster count", yLabel: "reproducibility",
      formatX: (v) => String(v),
      formatY: (v) => v.toFixed(2),
      chartW: Math.max(220, ((container.clientWidth || 720) - 60) / 2 - 20),
      chartH: 200,
      onPointClick: (p) => {
        // Cmd/Ctrl/Alt-click toggles a heatmap-side highlight without
        // committing the pick (so the user can probe the heatmap from the
        // curve). Plain click keeps the existing pick-toggle behaviour.
        const ev = window.event;
        if (ev && (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey)) {
          // Highlight the curve point's matching heatmap row/col by finding
          // the candidate with that count and setting both ends.
          const idx = candidates.findIndex(c => c.count === p.x);
          if (idx >= 0) {
            // No pair to pick yet — just flag the single layer; the heatmap
            // highlight set treats this as "row or col matches idx".
            highlightedPair = { childIdx: idx, parentIdx: idx };
          }
        } else {
          if (picked.has(p.x)) picked.delete(p.x);
          else picked.add(p.x);
          highlightedPair = null;
        }
        render();
      },
    });

    // ── Bridge heatmap ────────────────────────────────────────────────────
    if (!bpp || bpp.n < 2 || !candidates.length) {
      const empty = document.createElement("div");
      empty.className = "multilayer-curve-bridge-empty";
      empty.textContent = bpp ? "Bridge heatmap unavailable — need ≥ 2 candidates."
                              : "Bridge counts not computed for this sweep — re-run to populate.";
      heatHost.appendChild(empty);
    } else {
      // Compose the heatmap matrix: row = child idx (finer), col = parent idx
      // (coarser). Only the strict upper triangle (child > parent) is live.
      const n = bpp.n;
      const counts = bpp.counts;
      let vmax = 0;
      for (let r = 1; r < n; r++) {
        for (let c = 0; c < r; c++) {
          const v = counts[r * n + c];
          if (v > vmax) vmax = v;
        }
      }
      if (vmax === 0) vmax = 1;
      const matrix = [];
      for (let r = 0; r < n; r++) {
        const row = new Array(n);
        for (let c = 0; c < n; c++) row[c] = counts[r * n + c];
        matrix.push(row);
      }
      const labels = candidates.map(c => String(c.count));
      // Compact cells so the heatmap fits beside the curve at typical widths.
      const cellSize = Math.max(20, Math.min(38, Math.floor(((container.clientWidth || 720) / 2 - 60) / n)));
      // Cross-binding: outline rows/cols matching the highlighted pair.
      const hiRows = new Set(), hiCols = new Set();
      if (highlightedPair) {
        if (highlightedPair.childIdx  >= 0) hiRows.add(highlightedPair.childIdx);
        if (highlightedPair.parentIdx >= 0) hiCols.add(highlightedPair.parentIdx);
      }
      renderHeatmap(heatHost, {
        matrix,
        rowLabels: labels,
        colLabels: labels,
        vmin: 0, vmax,
        cellSize,
        palette: "ari",
        legendLabel: "bridges",
        formatCell: (v) => v > 0 ? String(v) : "",
        cellEnabled: (r, c) => r > c,
        cellTitle: (rowL, colL, v) =>
          `child ${rowL} clusters · parent ${colL} clusters · ${v} bridges`,
        highlightedRows: hiRows,
        highlightedCols: hiCols,
        onCellClick: (rowIdx, colIdx) => {
          // child > parent; the off-triangle is inactive so this fires only
          // on live cells. Highlight both layers on the curve.
          highlightedPair = { childIdx: rowIdx, parentIdx: colIdx };
          render();
        },
      });
    }

    // ── Live readout: picks + adjacent-pair bridges ────────────────────────
    const readout = renderReadout(picked, candidates, bpp);
    if (readout) wrap.appendChild(readout);

    // ── Apply / clear controls ────────────────────────────────────────────
    const controls = document.createElement("div");
    controls.className = "multilayer-curve-controls";

    const applyBtn = document.createElement("button");
    applyBtn.className = "multilayer-curve-apply";
    applyBtn.textContent = picked.size
      ? `Apply ${picked.size} layer${picked.size === 1 ? "" : "s"}`
      : "Apply (pick at least one)";
    applyBtn.disabled = picked.size === 0 || !active.stepId;
    applyBtn.addEventListener("click", () => {
      applyBtn.disabled = true;
      applyBtn.textContent = "Committing…";
      getLayerDescriptor("multiLevelPicker")
        .applyChange({ pickedCounts: [...picked] })
        .catch(e => console.error("[multilayer-picker] apply failed:", e));
    });
    controls.appendChild(applyBtn);

    if (picked.size) {
      const clearBtn = document.createElement("button");
      clearBtn.className = "multilayer-curve-clear";
      clearBtn.textContent = "Clear";
      clearBtn.addEventListener("click", () => {
        picked.clear();
        highlightedPair = null;
        render();
      });
      controls.appendChild(clearBtn);
    }
    if (highlightedPair) {
      const unhighlightBtn = document.createElement("button");
      unhighlightBtn.className = "multilayer-curve-clear";
      unhighlightBtn.textContent = "Unpin highlight";
      unhighlightBtn.addEventListener("click", () => {
        highlightedPair = null;
        render();
      });
      controls.appendChild(unhighlightBtn);
    }

    wrap.appendChild(controls);
    container.appendChild(wrap);
  }

  render();
  const unsub = subscribe(() => render());
  return {
    update() { render(); },
    destroy() { unsub(); container.innerHTML = ""; },
  };
}

// ── Live readout ──────────────────────────────────────────────────────────
// Shows the picked layers in coarse→fine order with cluster counts, and the
// bridge count between each adjacent pair (filters from bridgesPerPair, no
// recompute). Returns null when nothing is picked.
function renderReadout(picked, candidates, bpp) {
  if (!picked || !picked.size || !candidates.length) return null;
  // Sort picks ascending = coarse → fine, since cluster count grows with
  // granularity.
  const sortedPicks = [...picked].sort((a, b) => a - b);
  // Resolve each pick to its candidate index so we can index into
  // bridgesPerPair (child > parent).
  const pickedIdx = sortedPicks
    .map(cnt => candidates.findIndex(c => c.count === cnt))
    .filter(i => i >= 0);

  const root = document.createElement("div");
  root.className = "multilayer-curve-readout";

  // Layers line — picks in coarse → fine order.
  const layersLine = document.createElement("div");
  layersLine.className = "multilayer-curve-readout-line";
  const layersLabel = document.createElement("span");
  layersLabel.className = "multilayer-curve-readout-label";
  layersLabel.textContent = "Layers:";
  layersLine.appendChild(layersLabel);
  layersLine.appendChild(document.createTextNode(
    sortedPicks.map((cnt, i) => `L${i}: ${cnt}`).join("  →  ")
  ));
  root.appendChild(layersLine);

  // Bridges line — adjacent pairs only (per P3 option A).
  if (bpp && pickedIdx.length >= 2) {
    const n = bpp.n;
    const counts = bpp.counts;
    const parts = [];
    for (let i = 1; i < pickedIdx.length; i++) {
      const parent = pickedIdx[i - 1];   // coarser
      const child  = pickedIdx[i];       // finer
      const v = counts[child * n + parent];
      parts.push(`L${i} vs L${i - 1}: ${v}`);
    }
    const bridgesLine = document.createElement("div");
    bridgesLine.className = "multilayer-curve-readout-line";
    const bridgesLabel = document.createElement("span");
    bridgesLabel.className = "multilayer-curve-readout-label";
    bridgesLabel.textContent = "Bridges (adjacent):";
    bridgesLine.appendChild(bridgesLabel);
    bridgesLine.appendChild(document.createTextNode(parts.join("   ")));
    root.appendChild(bridgesLine);
  }

  return root;
}
