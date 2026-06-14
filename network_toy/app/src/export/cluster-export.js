// Cluster export — resolve a node selection from the scored clustering and
// emit it as a RIS file. Two selection modes:
//
//   by-score:  every node in a cluster at level L whose score ≥ threshold.
//              Scores are PER-LEVEL (a node is scored independently at each
//              level), so the export is always tied to one chosen level.
//   cluster:   every node in one chosen cluster at level L.
//
// The node→record lookup is injected (getRecord) so this stays pure +
// testable; production passes datasource/sqlite.js getNodeRecord.

import { formatRis } from "./ris.js";

// Node ids (0..n-1) for a selection. Returns { nodeIds, clusterIds } where
// clusterIds is the set of cluster ids that contributed (for provenance).
//
//   sel = { mode: "by-score", level, minScore }
//       | { mode: "cluster",  level, clusterId }
//
// levels  : clusterLevels[] ([{uid, clusterResult:{nodeCluster}}], coarse→fine)
// scores  : { [levelUid]: { [clusterId]: 1..5 } }
export function selectNodes(levels, scores, sel) {
  const out = { nodeIds: [], clusterIds: [] };
  if (!levels || !levels[sel.level]) return out;
  const level = levels[sel.level];
  const nodeCluster = level.clusterResult && level.clusterResult.nodeCluster;
  if (!nodeCluster) return out;

  let wanted;   // Set of cluster ids to include
  if (sel.mode === "cluster") {
    wanted = new Set([sel.clusterId]);
  } else {
    // by-score: clusters at this level scoring ≥ minScore.
    const levelScores = (scores && scores[level.uid]) || {};
    const min = Number.isFinite(sel.minScore) ? sel.minScore : 1;
    wanted = new Set(
      Object.keys(levelScores)
        .filter(cid => levelScores[cid] >= min)
        .map(cid => Number(cid)));
  }
  out.clusterIds = [...wanted];
  if (wanted.size === 0) return out;

  for (let i = 0; i < nodeCluster.length; i++) {
    if (wanted.has(nodeCluster[i])) out.nodeIds.push(i);
  }
  return out;
}

// Build the RIS text for a selection. getRecord(nodeId) → record | null.
// note(nodeId, clusterId, levelUid) is optional → per-record N1 provenance.
// Returns { ris, count, missing } (missing = nodes with no record).
export function buildRis(levels, scores, sel, getRecord, note) {
  const { nodeIds } = selectNodes(levels, scores, sel);
  const level = levels[sel.level];
  const nodeCluster = level.clusterResult.nodeCluster;
  const records = [];
  const notes = note ? [] : null;
  let missing = 0;
  for (const id of nodeIds) {
    const rec = getRecord(id);
    if (!rec) { missing++; continue; }
    records.push(rec);
    if (note) notes.push(note(id, nodeCluster[id], level.uid));
  }
  return { ris: formatRis(records, notes), count: records.length, missing };
}

// A descriptive filename for a selection.
export function exportFilename(sel) {
  if (sel.mode === "cluster") {
    return `cluster-L${sel.level}-c${sel.clusterId}.ris`;
  }
  return `cluster-L${sel.level}-score-ge-${sel.minScore}.ris`;
}

// Trigger a browser download of `text` as `filename` (text/plain RIS).
// Self-contained (mirrors topbar.js's triggerDownload) so the export module
// doesn't couple to the topbar.
export function downloadText(text, filename, mime = "application/x-research-info-systems") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
