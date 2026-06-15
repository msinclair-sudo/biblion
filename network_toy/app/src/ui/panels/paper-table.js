// Shared paper-row table helpers, used by the Cart panel and the Selected-papers
// panel. Both render a wide, joinable per-paper table (biblion metadata + citation
// in-degree + per-level cluster id + layout position), so the column catalogue,
// the per-node join, and the cell format/sort comparators live here once.
//
// Per-node data sources (joined by nodeId), same as the cart's original join:
//   state.genResult.nodes[i]                          → paperId, isGhost, year (toy)
//   getNodeRecord(i)                                  → title, venue, authors, doi, pubType, year
//   state.citationResult.inDeg[i]                     → citation in-degree
//   state.clusterLevels[L].clusterResult.nodeCluster[i] → cluster id at level L
//   state._basePos[3i..3i+2]                          → x / y / z

import { getNodeRecord } from "../../datasource/sqlite.js";

// Static column catalogue. `kind` drives formatting + sort comparator.
// Per-level cluster columns are appended dynamically by paperColumns().
export const BASE_COLUMNS = [
  { key: "source",  label: "source",  kind: "text"  },
  { key: "title",   label: "title",   kind: "text"  },
  { key: "year",    label: "year",    kind: "int"   },
  { key: "venue",   label: "venue",   kind: "text"  },
  { key: "authors", label: "authors", kind: "text"  },
  { key: "inDeg",   label: "in-deg",  kind: "int"   },
  { key: "isGhost", label: "ghost",   kind: "text"  },
  { key: "pubType", label: "type",    kind: "text"  },
  { key: "doi",     label: "doi",     kind: "text"  },
  { key: "paperId", label: "paperId", kind: "int"   },
  { key: "nodeId",  label: "nodeId",  kind: "int"   },
  { key: "x",       label: "x",       kind: "float" },
  { key: "y",       label: "y",       kind: "float" },
  { key: "z",       label: "z",       kind: "float" },
];

// Resolve the column catalogue for the current state: BASE_COLUMNS plus one
// per cluster level. Returns { columns, clusterKeys } so a panel can default
// the finest cluster column visible.
export function paperColumns(state) {
  const levels = state.clusterLevels || [];
  const dyn = levels.map((_, i) => ({
    key: `clusterL${i}`,
    label: levels.length > 1 ? `clust L${i}` : "cluster",
    kind: "int",
  }));
  return { columns: [...BASE_COLUMNS, ...dyn], clusterKeys: dyn.map(c => c.key) };
}

// Join all per-node data for one paper into a flat row. `nodeId` is the active
// node index; `opts.source` is the provenance string ("L2·c5", etc.); `opts.paperId`
// overrides the resolved id (the cart passes its stored paperId). paperId defaults
// to the node's own paperId — reload-safe, since getNodeRecord needs the live
// sqlite handle but the node carries paperId through a save/load.
export function joinPaperRow(nodeId, state, levels, opts = {}) {
  const rec = getNodeRecord(nodeId) || {};
  const nodes = (state.genResult && state.genResult.nodes) || [];
  const nd = nodes[nodeId] || {};
  const pos = state._basePos;
  const inDeg = (state.citationResult && state.citationResult.inDeg)
    ? state.citationResult.inDeg[nodeId] : null;
  const row = {
    paperId: opts.paperId != null ? opts.paperId : (nd.paperId != null ? nd.paperId : null),
    nodeId,
    source:  opts.source ?? null,
    title:   rec.title ?? null,
    year:    rec.year ?? (Number.isFinite(nd.year) ? nd.year : null),
    venue:   rec.venue ?? null,
    authors: (rec.authors && rec.authors.length) ? rec.authors.join("; ") : null,
    doi:     rec.doi ?? null,
    pubType: rec.pubType ?? null,
    isGhost: nd.isGhost ? "ghost" : "",
    inDeg:   inDeg == null ? null : inDeg,
    x: pos ? round3(pos[nodeId * 3])     : null,
    y: pos ? round3(pos[nodeId * 3 + 1]) : null,
    z: pos ? round3(pos[nodeId * 3 + 2]) : null,
  };
  for (let i = 0; i < levels.length; i++) {
    const cr = levels[i].clusterResult;
    row[`clusterL${i}`] = (cr && cr.nodeCluster) ? cr.nodeCluster[nodeId] : null;
  }
  return row;
}

export function round3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

export function formatCell(value, kind) {
  if (value == null || value === "") return value === "" ? "" : "—";
  if (kind === "float") return Number.isFinite(value) ? String(value) : "—";
  if (kind === "int")   return Number.isFinite(value) ? String(value) : "—";
  return String(value);
}

export function compareBy(a, b, key, dir, col) {
  const sign = dir === "asc" ? 1 : -1;
  let av = a[key], bv = b[key];
  const numeric = col && (col.kind === "int" || col.kind === "float");
  if (numeric) {
    const an = Number.isFinite(av) ? av : (dir === "asc" ? Infinity : -Infinity);
    const bn = Number.isFinite(bv) ? bv : (dir === "asc" ? Infinity : -Infinity);
    return (an - bn) * sign;
  }
  // Text: nulls/empties last regardless of dir.
  av = av == null ? "" : String(av).toLowerCase();
  bv = bv == null ? "" : String(bv).toLowerCase();
  if (av === "" && bv !== "") return 1;
  if (bv === "" && av !== "") return -1;
  return av < bv ? -1 * sign : av > bv ? 1 * sign : 0;
}
