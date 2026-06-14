// SVG heatmap renderer.
//
// First chart helper for the dim-sweep panel (§6.19 step 4); generic
// enough to reuse for any future pairwise matrix (e.g. cross-algorithm
// ARI). Tiny SVG-from-scratch per the plan's "strategy not library"
// call — ~120 LoC for one chart type vs ~200 KB of d3 / Plotly.
//
// Renders:
//   - matrix of coloured cells with value labels overlaid
//   - row + column axis labels
//   - colour-scale legend bar with min / mid / max ticks
//   - optional title above the chart
//
// All sizing is in pixels; the SVG viewport adapts to the cell grid.
// Caller controls dimensions via opts.cellSize. No interactivity yet —
// hover tooltips are a follow-up if a use case appears.

import { heatmapCell } from "../gradients.js";

/**
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {number[][]} opts.matrix    Row-major: matrix[rowIdx][colIdx].
 * @param {string[]} opts.rowLabels   Length = matrix.length.
 * @param {string[]} opts.colLabels   Length = matrix[0].length.
 * @param {string|number[][]} [opts.palette="ari"]  Named or explicit stops.
 * @param {number} [opts.vmin=0]      Value mapped to gradient t=0.
 * @param {number} [opts.vmax=1]      Value mapped to gradient t=1.
 * @param {number} [opts.cellSize=48]
 * @param {string} [opts.title]
 * @param {string} [opts.legendLabel="value"]
 * @param {function} [opts.formatCell=v => v.toFixed(2)]
 *                                    How to render each cell's overlay text.
 *                                    Set to null to suppress overlays.
 * @param {(rowLabel, colLabel, value) => string} [opts.cellTitle]
 *                                    SVG `<title>` element per cell for
 *                                    native browser tooltip on hover.
 * @param {(rowIdx, colIdx, value) => void} [opts.onCellClick]
 *                                    Click handler per cell.
 * @param {Set<number>|null} [opts.highlightedRows]
 *                                    Row indices to outline (cross-binding).
 * @param {Set<number>|null} [opts.highlightedCols]
 *                                    Col indices to outline (cross-binding).
 * @param {(rowIdx, colIdx) => boolean} [opts.cellEnabled]
 *                                    Return false to render a cell as
 *                                    inactive (no fill, no overlay text).
 *                                    Useful for triangular matrices.
 */
export function renderHeatmap(host, opts = {}) {
  host.innerHTML = "";

  const {
    matrix,
    rowLabels = [],
    colLabels = [],
    palette = "ari",
    vmin = 0,
    vmax = 1,
    cellSize = 48,
    title,
    legendLabel = "value",
    formatCell = (v) => v.toFixed(2),
    cellTitle,
    onCellClick = null,
    highlightedRows = null,
    highlightedCols = null,
    cellEnabled = null,
  } = opts;

  if (!Array.isArray(matrix) || matrix.length === 0) {
    host.textContent = "(empty matrix)";
    return;
  }
  const nRows = matrix.length;
  const nCols = matrix[0].length;

  // Margins around the grid for axis labels.
  const M_LEFT   = Math.max(40, longestLabelPx(rowLabels));
  const M_TOP    = Math.max(28, longestLabelPx(colLabels));
  const M_RIGHT  = 16;
  const M_BOTTOM = 64;             // grid bottom → legend bar lives here

  const gridW = nCols * cellSize;
  const gridH = nRows * cellSize;
  const svgW = M_LEFT + gridW + M_RIGHT;
  const svgH = M_TOP + gridH + M_BOTTOM;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "chart-heatmap");
  svg.setAttribute("viewBox", `0 0 ${svgW} ${svgH}`);
  svg.setAttribute("width",  String(svgW));
  svg.setAttribute("height", String(svgH));

  // Title.
  if (title) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(M_LEFT));
    t.setAttribute("y", "14");
    t.setAttribute("class", "chart-title");
    t.textContent = title;
    svg.appendChild(t);
  }

  // Column labels (above the grid).
  for (let c = 0; c < nCols; c++) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(M_LEFT + c * cellSize + cellSize / 2));
    t.setAttribute("y", String(M_TOP - 6));
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("class", "chart-axis-label");
    t.textContent = String(colLabels[c] ?? "");
    svg.appendChild(t);
  }
  // Row labels (left of the grid).
  for (let r = 0; r < nRows; r++) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(M_LEFT - 6));
    t.setAttribute("y", String(M_TOP + r * cellSize + cellSize / 2 + 4));
    t.setAttribute("text-anchor", "end");
    t.setAttribute("class", "chart-axis-label");
    t.textContent = String(rowLabels[r] ?? "");
    svg.appendChild(t);
  }

  // Cells.
  const range = (vmax - vmin) || 1;
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const enabled = cellEnabled ? cellEnabled(r, c) : true;
      const v = matrix[r][c];
      const t = clamp01((v - vmin) / range);

      const cell = document.createElementNS(SVG_NS, "rect");
      cell.setAttribute("x", String(M_LEFT + c * cellSize));
      cell.setAttribute("y", String(M_TOP  + r * cellSize));
      cell.setAttribute("width",  String(cellSize - 1));
      cell.setAttribute("height", String(cellSize - 1));
      const fill = !enabled
        ? "rgb(28,28,28)"
        : (Number.isFinite(v) ? heatmapCell(t, palette) : "rgb(50,50,50)");
      cell.setAttribute("fill", fill);
      cell.setAttribute("class", "chart-heatmap-cell" + (enabled ? "" : " inactive"));
      if (typeof cellTitle === "function") {
        const titleEl = document.createElementNS(SVG_NS, "title");
        titleEl.textContent = cellTitle(rowLabels[r], colLabels[c], v);
        cell.appendChild(titleEl);
      }
      if (enabled && typeof onCellClick === "function") {
        cell.style.cursor = "pointer";
        const rr = r, cc = c, vv = v;
        cell.addEventListener("click", () => onCellClick(rr, cc, vv));
      }
      svg.appendChild(cell);

      if (enabled && formatCell && Number.isFinite(v)) {
        const txt = document.createElementNS(SVG_NS, "text");
        txt.setAttribute("x", String(M_LEFT + c * cellSize + cellSize / 2));
        txt.setAttribute("y", String(M_TOP  + r * cellSize + cellSize / 2 + 4));
        txt.setAttribute("text-anchor", "middle");
        txt.setAttribute("class", "chart-heatmap-overlay");
        // Click-through: the overlay text shouldn't intercept the cell click.
        if (typeof onCellClick === "function") txt.setAttribute("pointer-events", "none");
        // Pick black or white for legibility based on cell luminance.
        txt.setAttribute("fill", luminanceContrast(heatmapCell(t, palette)));
        txt.textContent = formatCell(v);
        svg.appendChild(txt);
      }
    }
  }

  // Cross-binding highlight: outline highlighted rows / columns over the grid.
  const hiRows = highlightedRows instanceof Set ? highlightedRows : null;
  const hiCols = highlightedCols instanceof Set ? highlightedCols : null;
  if (hiRows && hiRows.size) {
    for (const r of hiRows) {
      if (r < 0 || r >= nRows) continue;
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(M_LEFT));
      rect.setAttribute("y", String(M_TOP + r * cellSize));
      rect.setAttribute("width",  String(gridW));
      rect.setAttribute("height", String(cellSize - 1));
      rect.setAttribute("class", "chart-heatmap-highlight-row");
      rect.setAttribute("fill", "none");
      rect.setAttribute("pointer-events", "none");
      svg.appendChild(rect);
    }
  }
  if (hiCols && hiCols.size) {
    for (const c of hiCols) {
      if (c < 0 || c >= nCols) continue;
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(M_LEFT + c * cellSize));
      rect.setAttribute("y", String(M_TOP));
      rect.setAttribute("width",  String(cellSize - 1));
      rect.setAttribute("height", String(gridH));
      rect.setAttribute("class", "chart-heatmap-highlight-col");
      rect.setAttribute("fill", "none");
      rect.setAttribute("pointer-events", "none");
      svg.appendChild(rect);
    }
  }

  // Colour legend (horizontal bar under the grid).
  const legendY = M_TOP + gridH + 18;
  const legendH = 10;
  const legendW = Math.min(gridW, 240);
  const legendX = M_LEFT;

  // Gradient stops painted as a horizontal sequence of rects.
  const N_STOPS = 40;
  const stopW = legendW / N_STOPS;
  for (let i = 0; i < N_STOPS; i++) {
    const t = i / (N_STOPS - 1);
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("x", String(legendX + i * stopW));
    r.setAttribute("y", String(legendY));
    r.setAttribute("width", String(stopW + 0.5));
    r.setAttribute("height", String(legendH));
    r.setAttribute("fill", heatmapCell(t, palette));
    svg.appendChild(r);
  }
  // Min / mid / max tick labels.
  const ticks = [
    { v: vmin,            x: legendX },
    { v: (vmin+vmax)/2,   x: legendX + legendW / 2 },
    { v: vmax,            x: legendX + legendW },
  ];
  for (const tk of ticks) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(tk.x));
    t.setAttribute("y", String(legendY + legendH + 14));
    t.setAttribute("text-anchor", tk.x === legendX ? "start" : tk.x === legendX + legendW ? "end" : "middle");
    t.setAttribute("class", "chart-axis-label");
    t.textContent = formatTick(tk.v);
    svg.appendChild(t);
  }
  if (legendLabel) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(legendX + legendW + 12));
    t.setAttribute("y", String(legendY + legendH - 1));
    t.setAttribute("class", "chart-axis-label");
    t.textContent = legendLabel;
    svg.appendChild(t);
  }

  host.appendChild(svg);
}

function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

function longestLabelPx(labels) {
  let m = 0;
  for (const l of labels) m = Math.max(m, String(l ?? "").length);
  return m * 7 + 12;          // ~7 px per char at the default font size
}

function formatTick(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100)   return v.toFixed(0);
  if (Math.abs(v) >= 10)    return v.toFixed(1);
  return v.toFixed(2);
}

// Parse an "rgb(r, g, b)" string and pick black or white text colour
// for legibility against it. Uses relative luminance per WCAG; threshold
// 0.5 in normalised luminance space gives clean transitions across our
// gradient palettes.
function luminanceContrast(rgbStr) {
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(rgbStr || "");
  if (!m) return "rgb(0,0,0)";
  const r = (+m[1]) / 255, g = (+m[2]) / 255, b = (+m[3]) / 255;
  // Rec.709 luma approximation; cheaper than full sRGB → linear → Y.
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 0.55 ? "rgb(20,20,20)" : "rgb(245,245,245)";
}
