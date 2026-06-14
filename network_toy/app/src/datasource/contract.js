// Data-source output contract (Layer 1).
//
// Every data-source produces this shape. The engine validates it once
// on the way out so contract violations surface immediately when
// adding a new source.
//
// Shape:
//   {
//     nodes: [{
//       id:        int,                 // contiguous 0..n-1
//       t:         number ∈ [0, 1],      // timestamp / publication-year-normalised
//       originId?: int | null,            // toy ground-truth label; null for real
//       isGhost?:  boolean,               // structural ("ghost") node — a materialised
//                                         //   external citation endpoint with NO embedding
//                                         //   row (default false). See ghost-node spec §4.1.
//       basePos?:  [x, y, z],             // optional per-node viz position
//                                         //   (toy supplies it; real does not — Layer 1.5
//                                         //    viz sub-stage backfills it)
//     }],
//     origins?:   [{id, centre, spread, colour}, ...],
//                                         // toy ground-truth mixture components; null for real
//     embedding?: { d, data: Float32Array(m*d), m?, rowOf? },
//                                         // high-dim feature vectors for the EMBEDDED nodes
//                                         // (real ingest); absent for toy where basePos serves
//                                         // as the (3-d) embedding directly.
//                                         //   data: dense m×d block, m = count(!isGhost).
//                                         //   m:    embedded-node count (defaults to n when no
//                                         //         ghosts; equals n - #ghosts otherwise).
//                                         //   rowOf: Int32Array(n) mapping node index → embedding
//                                         //         row, or -1 for a ghost (no row). Optional —
//                                         //         when omitted, the ghost-mask invariant below
//                                         //         (ghosts are the last n-m indices) defines it.
//     basePos?:   Float32Array(n*3),       // optional flat viz buffer; either nodes carry
//                                         // basePos or this is supplied — engine packs whichever's present
//   }
//
// Ghost-node invariant (ghost-node spec §4.1):
//   * `isGhost` nodes carry NO embedding row. The embedding is a dense m×d
//     block over the m = count(!isGhost) embedded nodes ONLY.
//   * Ghosts MUST be the last n-m node indices (embedded first, rows 0..m-1;
//     ghosts last, m..n-1). This keeps `embedding.data` contiguous and lets a
//     consumer derive the node→row map without a sidecar: rowOf[i] = i < m ? i : -1.
//   * An optional explicit `embedding.rowOf` is honoured when present; it must
//     agree with the mask (row ≥ 0 ⇔ !isGhost) and be a valid permutation of
//     0..m-1 over the embedded nodes.
//
// Combinations a data-source may legally produce:
//   * toy:  nodes[i].basePos + origins              (no embedding; basePos role doubled as embedding for Layer 1.5 identity)
//   * real: embedding only                           (no basePos, no origins; viz sub-stage produces basePos)
//   * any source supplying basePos directly         (e.g. a future "load existing 3-d coords" source)
//
// Either embedding or basePos (or both) must be present, otherwise
// downstream layers have nothing to chew on.

export const DATASOURCE_CONTRACT_VERSION = 1;

export function validateDataSourceResult(result) {
  fail(result && typeof result === "object", "result must be an object");
  fail(Array.isArray(result.nodes), "result.nodes must be an array");
  const n = result.nodes.length;
  fail(n > 0, "result.nodes must be non-empty");

  // Count embedded (non-ghost) nodes and enforce the ghosts-last invariant
  // as we go: once a ghost is seen, every later node must also be a ghost.
  let m = 0;            // count(!isGhost)
  let seenGhost = false;
  for (let i = 0; i < n; i++) {
    const node = result.nodes[i];
    fail(node && typeof node === "object", `nodes[${i}] must be an object`);
    fail(node.id === i,                    `nodes[${i}].id must equal ${i} (got ${node.id})`);
    fail(Number.isFinite(node.t),           `nodes[${i}].t must be a finite number`);
    if (node.isGhost !== undefined && node.isGhost !== null) {
      fail(typeof node.isGhost === "boolean", `nodes[${i}].isGhost must be a boolean`);
    }
    const isGhost = node.isGhost === true;
    if (isGhost) {
      seenGhost = true;
    } else {
      fail(!seenGhost,
           `nodes[${i}] is embedded but follows a ghost — ghosts must be the last n-m indices`);
      m++;
    }
    if (node.basePos !== undefined && node.basePos !== null) {
      fail(Array.isArray(node.basePos) && node.basePos.length === 3 && node.basePos.every(Number.isFinite),
           `nodes[${i}].basePos must be a 3-vec of finite numbers`);
    }
  }

  if (result.embedding !== undefined && result.embedding !== null) {
    const e = result.embedding;
    fail(Number.isInteger(e.d) && e.d > 0,    "embedding.d must be a positive integer");
    fail(e.data instanceof Float32Array,       "embedding.data must be a Float32Array");
    // Embedding covers the m embedded nodes only — ghosts have no row. Strict
    // on the embedded block: m*d exactly, no slack.
    fail(e.data.length === m * e.d,
         `embedding.data.length must equal m*d (m=${m}, d=${e.d} → ${m * e.d}); got ${e.data.length}`);
    if (e.m !== undefined && e.m !== null) {
      fail(e.m === m,
           `embedding.m must equal count(!isGhost) (${m}); got ${e.m}`);
    }
    // Optional explicit node→row map. When present it must agree with the
    // mask: ghosts map to -1, embedded nodes form a permutation of 0..m-1.
    if (e.rowOf !== undefined && e.rowOf !== null) {
      fail(e.rowOf instanceof Int32Array,
           "embedding.rowOf must be an Int32Array");
      fail(e.rowOf.length === n,
           `embedding.rowOf.length must equal n (${n}); got ${e.rowOf.length}`);
      const seenRow = new Uint8Array(m);
      for (let i = 0; i < n; i++) {
        const isGhost = result.nodes[i].isGhost === true;
        const row = e.rowOf[i];
        if (isGhost) {
          fail(row === -1, `embedding.rowOf[${i}] must be -1 for a ghost; got ${row}`);
        } else {
          fail(Number.isInteger(row) && row >= 0 && row < m,
               `embedding.rowOf[${i}] must be in [0, m) for an embedded node; got ${row}`);
          fail(!seenRow[row], `embedding.rowOf maps two nodes to row ${row}`);
          seenRow[row] = 1;
        }
      }
    }
  }

  if (result.basePos !== undefined && result.basePos !== null) {
    fail(result.basePos instanceof Float32Array,
         "result.basePos must be a Float32Array");
    fail(result.basePos.length === n * 3,
         `result.basePos.length must equal n*3 (${n * 3}); got ${result.basePos.length}`);
  }

  // Per-node basePos OR top-level basePos OR embedding must be present —
  // otherwise Layer 1.5 has nothing to consume and the viewer can't
  // render. Embedding alone is a valid "real-data, viz-not-yet-fitted"
  // state.
  const hasNodeBasePos = result.nodes.every(n => Array.isArray(n.basePos) && n.basePos.length === 3);
  const hasFlatBasePos = result.basePos instanceof Float32Array;
  const hasEmbedding   = result.embedding && result.embedding.data;
  fail(hasNodeBasePos || hasFlatBasePos || hasEmbedding,
       "data source must supply at least one of: per-node basePos, top-level basePos, or embedding");
}

function fail(ok, msg) {
  if (!ok) throw new Error(`[datasource contract] ${msg}`);
}
