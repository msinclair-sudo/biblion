// Real-data data source — loads SPECTER2 embedding subsets from
// literture-network/artifacts/.
//
// Produces a DataSourceResult with nodes (id + t) and a high-dim
// embedding ({d:768, data:Float32Array(n*d)}). NO basePos: the viewer
// stays empty until the user opts into a viz reduction in Layer 1.5
// (UMAP-3 over the embedding). Per spec — large datasets shouldn't
// auto-render.
//
// The actual fetch happens through the static http server, which is
// expected to serve the repo root (so /literture-network/artifacts/...
// resolves alongside /app/). For now there's exactly one subset shipped
// (dev_subset_1000); add new entries to SUBSETS as more are carved.

const SUBSETS = {
  // id → {label, embeddingsPath, indexPath, yearsPath, edgesPath};
  // paths are absolute fetch URLs (the static server is rooted at
  // the repo root). yearsPath / edgesPath are optional — older
  // subsets carved without these files load gracefully (years → t=0
  // default; edges → no fusion possible).
  "dev_subset_1000": {
    label:          "dev_subset (1000 papers, random seed=42)",
    embeddingsPath: "/literture-network/artifacts/dev_subset/expanded_embeddings.npy",
    indexPath:      "/literture-network/artifacts/dev_subset/expanded_embeddings_paper_index.json",
    yearsPath:      "/literture-network/artifacts/dev_subset/paper_years.json",
    edgesPath:      "/literture-network/artifacts/dev_subset/citation_edges.json",
  },
  "dev_subset_bfs_5000": {
    label:          "dev_subset_bfs (5000 papers, BFS from 5 high-degree seeds)",
    embeddingsPath: "/literture-network/artifacts/dev_subset_bfs/expanded_embeddings.npy",
    indexPath:      "/literture-network/artifacts/dev_subset_bfs/expanded_embeddings_paper_index.json",
    yearsPath:      "/literture-network/artifacts/dev_subset_bfs/paper_years.json",
    edgesPath:      "/literture-network/artifacts/dev_subset_bfs/citation_edges.json",
  },
};

export const SUBSET_IDS    = Object.keys(SUBSETS);
export const SUBSET_LABELS = Object.fromEntries(
  Object.entries(SUBSETS).map(([id, s]) => [id, s.label])
);

export const defaultRealParams = () => ({
  subset: "dev_subset_1000",
});

export async function produceReal(params = {}) {
  const subsetId = params.subset || "dev_subset_1000";
  const subset   = SUBSETS[subsetId];
  if (!subset) throw new Error(`[datasource:real] unknown subset "${subsetId}"`);

  // Optional auxiliary files. 404 → null (older subsets carved before
  // these were emitted still load). Any other fetch error surfaces.
  const optionalJson = (url) =>
    url
      ? fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null);

  const [ab, paperIndex, paperYears, citationDoc] = await Promise.all([
    fetch(subset.embeddingsPath).then(r => r.arrayBuffer()),
    fetch(subset.indexPath).then(r => r.json()),
    optionalJson(subset.yearsPath),
    optionalJson(subset.edgesPath),
  ]);

  const { shape, data } = parseNpy(ab);
  const [m, d] = shape;   // m = EMBEDDED rows in the .npy (ghosts have no row)

  // Structural ("ghost") nodes: a paper_index entry may be a bare id (legacy)
  // or {id, structural}. Embedded rows 0..m-1 are aligned to the .npy and are
  // never structural; any further index entries marked structural are appended
  // as ghosts (last n-m indices, NO embedding row). On a legacy subset the
  // index has exactly m bare-id entries and no ghosts appear. See spec §4.1.
  const idOf      = (entry) => (entry && typeof entry === "object") ? entry.id : entry;
  const isStruct  = (entry) => !!(entry && typeof entry === "object" && entry.structural);
  const ghostIdxs = [];
  for (const key of Object.keys(paperIndex)) {
    const i = +key;
    if (Number.isInteger(i) && i >= m && isStruct(paperIndex[key])) ghostIdxs.push(i);
  }
  ghostIdxs.sort((a, b) => a - b);
  const n = m + ghostIdxs.length;

  // Per-node t ∈ [0, 1] normalised across the subset's year range.
  // Newest paper → t = 1, oldest → t = 0. This is the contract FR's
  // time anchor expects (`ka = max(0.2, 1 − t) · tBias` — older = more
  // central pull). Papers without a known year default to t = 0 so they
  // behave like the pre-years carves did; a separate flag could later
  // mark "unknown" if FR wants to skip the anchor for those.
  let yrMin = +Infinity, yrMax = -Infinity, nWithYear = 0;
  if (paperYears) {
    for (const yStr of Object.values(paperYears)) {
      const y = +yStr;
      if (!Number.isFinite(y)) continue;
      if (y < yrMin) yrMin = y;
      if (y > yrMax) yrMax = y;
      nWithYear++;
    }
  }
  const yrRange = (nWithYear > 0 && yrMax > yrMin) ? (yrMax - yrMin) : 0;

  // remap: on-disk file index → contiguous toy node index. Embedded rows keep
  // their index (0..m-1); ghosts (file index ≥ m, flagged structural) are
  // packed into the contiguous tail m..n-1. Identity for legacy (no-ghost)
  // subsets. Used both to place ghost nodes and to remap edge endpoints.
  const remap = new Int32Array(
    Math.max(m, ghostIdxs.length ? ghostIdxs[ghostIdxs.length - 1] + 1 : 0)
  );
  for (let i = 0; i < m; i++) remap[i] = i;
  for (let g = 0; g < ghostIdxs.length; g++) remap[ghostIdxs[g]] = m + g;

  const nodes = new Array(n);
  const mkNode = (toyIdx, fileIdx, isGhost) => {
    let t = 0, year = null;
    if (paperYears) {
      const y = +paperYears[String(fileIdx)];
      if (Number.isFinite(y)) {
        year = y;
        t = yrRange > 0 ? (y - yrMin) / yrRange : 0;
      }
    }
    nodes[toyIdx] = {
      id:      toyIdx,
      t,
      year,
      paperId: idOf(paperIndex[String(fileIdx)]) || null,
      isGhost,
    };
  };
  for (let i = 0; i < m; i++) mkNode(i, i, false);
  for (let g = 0; g < ghostIdxs.length; g++) mkNode(m + g, ghostIdxs[g], true);

  // Node index → embedding row, -1 for ghosts. Identity on [0,m) by construction.
  const rowOf = new Int32Array(n);
  for (let i = 0; i < n; i++) rowOf[i] = nodes[i].isGhost ? -1 : i;

  // Flatten citation edges into the [src, dst, src, dst, …] form the
  // engine + fusion stage consume. The on-disk schema is documented
  // in literture-network/scripts/make_subset_citation_edges.py:
  // `{ edges: [[src, dst], ...], meta }`. Direction in the file is
  // citgraphv2's "source is cited by target" convention; the toy
  // contract is the reverse ("source cites target"), and Layer 3's
  // imported-edges algorithm flips on materialisation. For fusion's
  // *symmetric* diffusion the direction doesn't matter, so we pass
  // the as-stored edges through here; consumers that care about
  // direction flip themselves. Endpoints are remapped to contiguous toy
  // indices; ghost endpoints are KEPT (they carry the A→ghost→B bridge),
  // edges to nodes outside both sets are dropped.
  let citationEdges = null;
  if (citationDoc && Array.isArray(citationDoc.edges)) {
    const raw = citationDoc.edges;
    const flat = [];
    const inRange = (x) => x >= 0 && x < remap.length;
    for (let k = 0; k < raw.length; k++) {
      const sf = raw[k][0] | 0, tf = raw[k][1] | 0;
      if (!inRange(sf) || !inRange(tf)) continue;
      flat.push(remap[sf], remap[tf]);
    }
    citationEdges = flat;
  }

  return {
    method:    "real",
    params:    { subset: subsetId, yearRange: nWithYear > 0 ? [yrMin, yrMax] : null,
                 nEmbedded: m, nGhost: n - m },
    nodes,
    // Embedding covers the m embedded nodes only; ghosts have no row.
    embedding: { d, data, m, rowOf },
    citationEdges,
    // No basePos — Layer 1.5's viz sub-stage will populate _basePos when
    // the user picks a real algorithm there.
  };
}

// Minimal NPY v1/v2 reader. Parses the magic + header, returns the raw
// Float32Array payload along with shape. Only supports '<f4' dtype,
// which is what step02_embeddings.py writes; we'll grow this if/when
// other dtypes show up.
function parseNpy(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  if (u8[0] !== 0x93 ||
      u8[1] !== 0x4e || u8[2] !== 0x55 || u8[3] !== 0x4d ||
      u8[4] !== 0x50 || u8[5] !== 0x59) {
    throw new Error("[datasource:real] not an .npy file (bad magic)");
  }
  const major = u8[6];
  let headerLen, headerStart;
  if (major === 1) {
    headerLen = u8[8] | (u8[9] << 8);
    headerStart = 10;
  } else {
    const dv = new DataView(arrayBuffer);
    headerLen = dv.getUint32(8, true);
    headerStart = 12;
  }
  const header = new TextDecoder("ascii").decode(u8.slice(headerStart, headerStart + headerLen));

  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(header);
  if (!shapeMatch) throw new Error(`[datasource:real] no shape in npy header: ${header}`);
  const shape = shapeMatch[1].split(",").map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);

  const descrMatch = /'descr':\s*'([^']+)'/.exec(header);
  if (!descrMatch || descrMatch[1] !== "<f4") {
    throw new Error(`[datasource:real] expected dtype '<f4'; got ${descrMatch && descrMatch[1]}`);
  }

  const dataStart = headerStart + headerLen;
  const data = new Float32Array(arrayBuffer.slice(dataStart));
  if (shape.length !== 2 || data.length !== shape[0] * shape[1]) {
    throw new Error(`[datasource:real] shape ${shape} does not match data length ${data.length}`);
  }
  return { shape, data };
}
