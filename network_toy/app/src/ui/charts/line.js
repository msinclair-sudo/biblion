// SVG line / scatter chart renderer.
//
// Companion to charts/bars.js + charts/heatmap.js (same chart-* classes,
// same margin idiom). Built for the multi-layer stability-vs-count curve
// (panels/multilayer-curve.js) but generic over a list of {x, y} points:
// draws a connecting polyline + a marker per point, an optional horizontal
// reference line (e.g. the reproducibility floor), and supports a log x
// axis (cluster counts span a wide range). Markers can be flagged
// `selected` (the chosen shelves) and carry an optional `size` weight.

/**
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {Array<{x:number, y:number|null, selected?:boolean, highlighted?:boolean, size?:number, label?:string}>} opts.points
 *   `selected` = committed pick (filled larger dot). `highlighted` = transient
 *   hover/cross-binding (outline stroke); orthogonal to `selected`.
 * @param {number} [opts.yMin=0]
 * @param {number} [opts.yMax=1]
 * @param {boolean} [opts.xLog=true]      log-scale the x axis.
 * @param {number} [opts.hline]           y of a horizontal reference line.
 * @param {string} [opts.hlineLabel]
 * @param {string} [opts.title]
 * @param {string} [opts.xLabel]
 * @param {string} [opts.yLabel]
 * @param {number} [opts.chartW=320]
 * @param {number} [opts.chartH=180]
 * @param {(v:number)=>string} [opts.formatX]
 * @param {(v:number)=>string} [opts.formatY]
 * @param {(p:object)=>void} [opts.onPointClick]
 */
export function renderLine(host, opts = {}) {
  host.innerHTML = "";
  const {
    points = [],
    yMin = 0, yMax = 1,
    xLog = true,
    hline, hlineLabel,
    title, xLabel, yLabel,
    chartW = 320, chartH = 180,
    formatX = (v) => String(v),
    formatY = (v) => v.toFixed(2),
    onPointClick = null,
  } = opts;

  const SVG_NS = "http://www.w3.org/2000/svg";
  if (!Array.isArray(points) || points.length === 0) {
    host.textContent = "(no data)";
    return;
  }

  const M_LEFT = 40, M_RIGHT = 14, M_TOP = title ? 26 : 12, M_BOTTOM = 34;
  const gridW = chartW, gridH = chartH;
  const svgW = M_LEFT + gridW + M_RIGHT;
  const svgH = M_TOP + gridH + M_BOTTOM;

  // x domain (log or linear) from the point x's.
  const xs = points.map(p => p.x);
  let xLo = Math.min(...xs), xHi = Math.max(...xs);
  if (xHi === xLo) { xHi = xLo + 1; }
  const tx = (x) => xLog
    ? (Math.log(Math.max(1e-9, x)) - Math.log(Math.max(1e-9, xLo))) /
      (Math.log(Math.max(1e-9, xHi)) - Math.log(Math.max(1e-9, xLo)))
    : (x - xLo) / (xHi - xLo);
  const xScale = (x) => M_LEFT + tx(x) * gridW;
  const yScale = (y) => M_TOP + gridH - ((y - yMin) / (yMax - yMin)) * gridH;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "chart-line");
  svg.setAttribute("viewBox", `0 0 ${svgW} ${svgH}`);
  svg.setAttribute("width", String(svgW));
  svg.setAttribute("height", String(svgH));

  const el = (tag, attrs, cls) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    if (cls) e.setAttribute("class", cls);
    return e;
  };

  if (title) {
    const t = el("text", { x: M_LEFT, y: 13 }, "chart-title");
    t.textContent = title;
    svg.appendChild(t);
  }

  // Y grid + ticks.
  for (const v of [yMin, (yMin + yMax) / 2, yMax]) {
    const y = yScale(v);
    svg.appendChild(el("line", { x1: M_LEFT, x2: M_LEFT + gridW, y1: y, y2: y }, "chart-grid-line"));
    const tk = el("text", { x: M_LEFT - 6, y: y + 4, "text-anchor": "end" }, "chart-axis-label");
    tk.textContent = formatY(v);
    svg.appendChild(tk);
  }
  if (yLabel) {
    const t = el("text", { x: M_LEFT, y: M_TOP - 3 }, "chart-axis-label");
    t.textContent = yLabel;
    svg.appendChild(t);
  }

  // Horizontal reference line (floor).
  if (Number.isFinite(hline)) {
    const y = yScale(hline);
    svg.appendChild(el("line", { x1: M_LEFT, x2: M_LEFT + gridW, y1: y, y2: y }, "chart-line-hline"));
    if (hlineLabel) {
      const t = el("text", { x: M_LEFT + gridW, y: y - 3, "text-anchor": "end" }, "chart-line-hline-label");
      t.textContent = hlineLabel;
      svg.appendChild(t);
    }
  }

  // Connect the points (in x order) that have a finite y.
  const ordered = points.slice().sort((a, b) => a.x - b.x);
  const drawn = ordered.filter(p => Number.isFinite(p.y));
  if (drawn.length >= 2) {
    const d = drawn.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.x).toFixed(1)} ${yScale(p.y).toFixed(1)}`).join(" ");
    svg.appendChild(el("path", { d }, "chart-line-path"));
  }

  // X ticks/labels at each point's x (counts are discrete + few).
  for (const p of ordered) {
    const x = xScale(p.x);
    const xl = el("text", { x, y: M_TOP + gridH + 16, "text-anchor": "middle" }, "chart-axis-label");
    xl.textContent = formatX(p.x);
    svg.appendChild(xl);
  }
  if (xLabel) {
    const t = el("text", { x: M_LEFT + gridW / 2, y: M_TOP + gridH + 30, "text-anchor": "middle" }, "chart-axis-label");
    t.textContent = xLabel;
    svg.appendChild(t);
  }

  // Markers.
  for (const p of ordered) {
    const x = xScale(p.x);
    const finite = Number.isFinite(p.y);
    const y = finite ? yScale(p.y) : (M_TOP + gridH);   // park nulls on the axis
    const r = p.selected ? 5 : (p.highlighted ? 4.2 : 3.2);
    const cls = "chart-line-dot"
      + (p.selected ? " selected" : "")
      + (p.highlighted ? " highlighted" : "")
      + (finite ? "" : " null");
    const g = el("g", { class: "chart-line-marker" });
    const dot = el("circle", { cx: x, cy: y, r }, cls);
    const title = `${p.label || ("count " + p.x)}${finite ? " · stability " + p.y.toFixed(2) : " · (no score)"}`;
    const tEl = document.createElementNS(SVG_NS, "title");
    tEl.textContent = title;
    dot.appendChild(tEl);
    if (onPointClick) {
      dot.style.cursor = "pointer";
      dot.addEventListener("click", () => onPointClick(p));
    }
    g.appendChild(dot);
    svg.appendChild(g);
  }

  host.appendChild(svg);
}
