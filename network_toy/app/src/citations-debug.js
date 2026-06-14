// Citation debug / render helpers.
//
// Citation edges are not really "debug" — they're the layer's primary
// product. But they're still optional from the renderer's POV (toggleable
// in the bottom bar like base edges in the old version). Keeping the helpers
// here keeps citations.js itself a pure data producer.

export const citationViewFlags = {
  showCitations: true,    // bottom-bar toggle
};

// Inject citation links into a graph-data object. Caller decides where in
// the rendering pipeline to do this (in main.js, between cluster-debug and
// the final graphData() call).
export function decorateGraphData(graphData, citationResult) {
  if (!citationResult) return graphData;
  if (!citationViewFlags.showCitations) return graphData;
  for (const c of citationResult.citations) {
    graphData.links.push({
      source: c.source,
      target: c.target,
      kind: "citation",
    });
  }
  return graphData;
}

// In-degree colouring (viridis on log1p of in-degree, normalised to the
// observed maximum). Returns null if there's no signal yet.
const VIRIDIS_STOPS = ["#440154","#414487","#2a788e","#22a884","#7ad151","#fde725"];
export function colourByInDegree(inDeg, nodeId) {
  let max = 1;
  for (let i = 0; i < inDeg.length; i++) if (inDeg[i] > max) max = inDeg[i];
  const t = Math.log1p(inDeg[nodeId]) / Math.log1p(max);
  return viridis(t);
}
function viridis(t) {
  t = Math.max(0, Math.min(1, t));
  const i = t * (VIRIDIS_STOPS.length - 1);
  const a = Math.floor(i), b = Math.min(VIRIDIS_STOPS.length - 1, a + 1);
  const f = i - a;
  return mixHex(VIRIDIS_STOPS[a], VIRIDIS_STOPS[b], f);
}
function mixHex(h1, h2, f) {
  const r1=parseInt(h1.slice(1,3),16), g1=parseInt(h1.slice(3,5),16), b1=parseInt(h1.slice(5,7),16);
  const r2=parseInt(h2.slice(1,3),16), g2=parseInt(h2.slice(3,5),16), b2=parseInt(h2.slice(5,7),16);
  const r = Math.round(r1+(r2-r1)*f), g = Math.round(g1+(g2-g1)*f), b = Math.round(b1+(b2-b1)*f);
  return "#" + r.toString(16).padStart(2,"0") + g.toString(16).padStart(2,"0") + b.toString(16).padStart(2,"0");
}
