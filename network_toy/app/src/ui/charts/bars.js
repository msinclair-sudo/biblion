// SVG bar chart renderer.
//
// Companion to charts/heatmap.js. Used by the dim-sweep panel to show
// cluster counts per dim; reusable for any sequence of named scalars
// (e.g. swept-score distributions, per-cluster sizes if a histogram
// panel materialises later).
//
// Each bar can optionally carry an error-bar (mean ± SD). Bars are
// uniform-coloured by default; pass `palette` + `vmin/vmax` to colour
// by value.

import { heatmapCell } from "../gradients.js";

/**
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {number[]} opts.values       Bar heights.
 * @param {string[]} opts.labels       X-axis labels per bar.
 * @param {number[]} [opts.errors]     Symmetric error per bar (drawn as whiskers).
 * @param {number} [opts.ymin=0]
 * @param {number} [opts.ymax]         Defaults to 1.1 × max(values + errors).
 * @param {string|number[][]} [opts.palette]   If set, colour each bar by value.
 * @param {number} [opts.cellSize=56]  Bar width.
 * @param {number} [opts.chartH=160]   Drawing area height (px).
 * @param {string} [opts.title]
 * @param {string} [opts.yLabel]
 * @param {function} [opts.formatBar=v => v.toFixed(1)]
 */
export function renderBars(host, opts = {}) {
  host.innerHTML = "";

  const {
    values,
    labels = [],
    errors = null,
    ymin = 0,
    palette,
    cellSize = 56,
    chartH = 160,
    title,
    yLabel,
    formatBar = (v) => Number.isFinite(v) ? v.toFixed(1) : "—",
  } = opts;

  if (!Array.isArray(values) || values.length === 0) {
    host.textContent = "(no bars)";
    return;
  }

  let { ymax } = opts;
  if (!Number.isFinite(ymax)) {
    let m = 0;
    for (let i = 0; i < values.length; i++) {
      const eMag = errors ? Math.abs(errors[i] || 0) : 0;
      m = Math.max(m, (values[i] || 0) + eMag);
    }
    ymax = m === 0 ? 1 : m * 1.1;
  }

  const N = values.length;
  const M_LEFT   = 44;            // y-axis space
  const M_RIGHT  = 16;
  const M_TOP    = title ? 28 : 14;
  const M_BOTTOM = 32;            // x-labels
  const gridW = N * cellSize;
  const gridH = chartH;
  const svgW = M_LEFT + gridW + M_RIGHT;
  const svgH = M_TOP + gridH + M_BOTTOM;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "chart-bars");
  svg.setAttribute("viewBox", `0 0 ${svgW} ${svgH}`);
  svg.setAttribute("width",  String(svgW));
  svg.setAttribute("height", String(svgH));

  if (title) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(M_LEFT));
    t.setAttribute("y", "14");
    t.setAttribute("class", "chart-title");
    t.textContent = title;
    svg.appendChild(t);
  }

  // Y axis: ticks at min, mid, max.
  const yScale = (v) => M_TOP + gridH - ((v - ymin) / (ymax - ymin)) * gridH;
  const yTicks = [ymin, (ymin + ymax) / 2, ymax];
  for (const v of yTicks) {
    const y = yScale(v);
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(M_LEFT));
    line.setAttribute("x2", String(M_LEFT + gridW));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "chart-grid-line");
    svg.appendChild(line);

    const tk = document.createElementNS(SVG_NS, "text");
    tk.setAttribute("x", String(M_LEFT - 6));
    tk.setAttribute("y", String(y + 4));
    tk.setAttribute("text-anchor", "end");
    tk.setAttribute("class", "chart-axis-label");
    tk.textContent = formatTick(v);
    svg.appendChild(tk);
  }
  if (yLabel) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(M_LEFT));
    t.setAttribute("y", String(M_TOP - 4));
    t.setAttribute("class", "chart-axis-label");
    t.textContent = yLabel;
    svg.appendChild(t);
  }

  // Bars.
  const barInset = 6;             // padding inside cell
  for (let i = 0; i < N; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const t = palette ? clamp01((v - ymin) / (ymax - ymin)) : 0;
    const fill = palette ? heatmapCell(t, palette) : "rgb(120, 140, 180)";

    const x0 = M_LEFT + i * cellSize + barInset;
    const w  = cellSize - 2 * barInset;
    const y0 = yScale(v);
    const h  = M_TOP + gridH - y0;

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x0));
    rect.setAttribute("y", String(y0));
    rect.setAttribute("width",  String(w));
    rect.setAttribute("height", String(Math.max(0, h)));
    rect.setAttribute("fill", fill);
    rect.setAttribute("class", "chart-bars-rect");
    svg.appendChild(rect);

    // Value label above the bar.
    const lbl = document.createElementNS(SVG_NS, "text");
    lbl.setAttribute("x", String(x0 + w / 2));
    lbl.setAttribute("y", String(Math.max(M_TOP + 10, y0 - 4)));
    lbl.setAttribute("text-anchor", "middle");
    lbl.setAttribute("class", "chart-bars-value");
    lbl.textContent = formatBar(v);
    svg.appendChild(lbl);

    // Error bar.
    if (errors && Number.isFinite(errors[i]) && errors[i] !== 0) {
      const eHi = yScale(v + errors[i]);
      const eLo = yScale(v - errors[i]);
      const xMid = x0 + w / 2;
      const whisker = document.createElementNS(SVG_NS, "g");
      whisker.setAttribute("class", "chart-bars-whisker");
      whisker.innerHTML =
        `<line x1="${xMid}" x2="${xMid}" y1="${eHi}" y2="${eLo}"/>` +
        `<line x1="${xMid - 4}" x2="${xMid + 4}" y1="${eHi}" y2="${eHi}"/>` +
        `<line x1="${xMid - 4}" x2="${xMid + 4}" y1="${eLo}" y2="${eLo}"/>`;
      svg.appendChild(whisker);
    }

    // X-axis label below the bar.
    const xl = document.createElementNS(SVG_NS, "text");
    xl.setAttribute("x", String(x0 + w / 2));
    xl.setAttribute("y", String(M_TOP + gridH + 18));
    xl.setAttribute("text-anchor", "middle");
    xl.setAttribute("class", "chart-axis-label");
    xl.textContent = String(labels[i] ?? "");
    svg.appendChild(xl);
  }

  host.appendChild(svg);
}

function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
function formatTick(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100)   return v.toFixed(0);
  if (Math.abs(v) >= 10)    return v.toFixed(1);
  return v.toFixed(2);
}
