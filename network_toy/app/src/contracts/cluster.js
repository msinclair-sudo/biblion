// Cluster-output contract validator.
//
// Source of truth: doc/clustering.md §1.
//
// Every clustering algorithm runs through this on the way out. Cheap to
// run (~50 µs at n=100) so we ship it in production: a contract violation
// is the first thing to catch when adding a new algorithm.
//
// Usage:
//   import { validateClusterResult, CLUSTER_CONTRACT_VERSION } from "./contracts/cluster.js";
//   validateClusterResult(result, n, { allowNoise: false });
//
// Throws on failure with a descriptive message; returns nothing on success.

export const CLUSTER_CONTRACT_VERSION = 1;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function validateClusterResult(result, n, opts = {}) {
  const allowNoise = !!opts.allowNoise;

  // Top-level shape.
  fail(result && typeof result === "object", "result must be an object");
  fail(typeof result.method === "string", "result.method must be a string");
  fail(result.params && typeof result.params === "object",
       "result.params must be an object");
  fail(Array.isArray(result.clusters), "result.clusters must be an array");
  fail(result.nodeCluster instanceof Int32Array,
       "result.nodeCluster must be an Int32Array");
  fail(result.nodeCluster.length === n,
       `result.nodeCluster.length must equal n (${n}), got ${result.nodeCluster.length}`);
  fail(Array.isArray(result.structureEdges),
       "result.structureEdges must be an array");

  // Determine the set of distinct cluster ids actually used.
  const idsSeen = new Map();    // id -> count
  let hasNoise = false;
  let maxNormalId = -1;
  for (let i = 0; i < n; i++) {
    const c = result.nodeCluster[i];
    fail(Number.isInteger(c),
         `nodeCluster[${i}] must be an integer, got ${c}`);
    if (c === -1) {
      fail(allowNoise,
           `nodeCluster[${i}] is -1 (noise) but allowNoise is false`);
      hasNoise = true;
    } else {
      fail(c >= 0,
           `nodeCluster[${i}] = ${c}: ids must be ≥ 0 (or -1 for noise)`);
      if (c > maxNormalId) maxNormalId = c;
    }
    idsSeen.set(c, (idsSeen.get(c) || 0) + 1);
  }
  const numNormalClusters = maxNormalId + 1;
  // Must be contiguous: every id in [0, numNormalClusters) appears at least once.
  for (let c = 0; c < numNormalClusters; c++) {
    fail(idsSeen.has(c),
         `cluster id ${c} is missing — ids must be contiguous from 0 to ${numNormalClusters - 1}`);
  }

  // clusters[] length: numNormalClusters + (1 if noise).
  const expectedLen = numNormalClusters + (hasNoise ? 1 : 0);
  fail(result.clusters.length === expectedLen,
       `clusters.length must be ${expectedLen} (numNormalClusters + noise), got ${result.clusters.length}`);

  // Per-cluster shape and consistency.
  for (let idx = 0; idx < result.clusters.length; idx++) {
    const cl = result.clusters[idx];
    const isNoise = idx === numNormalClusters;
    fail(cl && typeof cl === "object",
         `clusters[${idx}] must be an object`);
    if (isNoise) {
      fail(cl.id === -1,
           `clusters[${idx}] is the noise entry; id must be -1, got ${cl.id}`);
    } else {
      fail(cl.id === idx,
           `clusters[${idx}].id must equal ${idx}, got ${cl.id}`);
    }
    fail(Array.isArray(cl.centre) && cl.centre.length === 3,
         `clusters[${idx}].centre must be a 3-tuple`);
    for (let k = 0; k < 3; k++) {
      fail(Number.isFinite(cl.centre[k]),
           `clusters[${idx}].centre[${k}] must be finite, got ${cl.centre[k]}`);
    }
    fail(typeof cl.spread === "number" && Number.isFinite(cl.spread),
         `clusters[${idx}].spread must be a finite number`);
    fail(Number.isInteger(cl.count) && cl.count >= 0,
         `clusters[${idx}].count must be a non-negative integer`);
    fail(typeof cl.colour === "string" && HEX_RE.test(cl.colour),
         `clusters[${idx}].colour must be #RRGGBB hex, got ${cl.colour}`);
    fail("stability" in cl,
         `clusters[${idx}].stability must be present (use NaN if not computed)`);
    fail(typeof cl.stability === "number",
         `clusters[${idx}].stability must be a number (NaN allowed)`);
    // Count consistency with nodeCluster.
    const observed = idsSeen.get(cl.id) || 0;
    fail(cl.count === observed,
         `clusters[${idx}].count (${cl.count}) doesn't match the ${observed} nodes with id ${cl.id}`);
  }

  // structureEdges shape.
  for (let k = 0; k < result.structureEdges.length; k++) {
    const e = result.structureEdges[k];
    fail(Array.isArray(e) && e.length === 2,
         `structureEdges[${k}] must be a 2-element array`);
    const [i, j] = e;
    fail(Number.isInteger(i) && Number.isInteger(j),
         `structureEdges[${k}] entries must be integers, got [${i}, ${j}]`);
    fail(0 <= i && i < j && j < n,
         `structureEdges[${k}]: must satisfy 0 ≤ i < j < n (n=${n}), got [${i}, ${j}]`);
  }

  // Optional noiseFlags: present only if the algorithm has a noise
  // concept. Independent of nodeCluster[i] — a point may be flagged
  // noise AND have a non-noise cluster id (soft absorption case).
  if (result.noiseFlags !== undefined) {
    fail(result.noiseFlags instanceof Uint8Array,
         "noiseFlags must be a Uint8Array if present");
    fail(result.noiseFlags.length === n,
         `noiseFlags.length must equal n (${n}), got ${result.noiseFlags.length}`);
    for (let i = 0; i < n; i++) {
      const v = result.noiseFlags[i];
      fail(v === 0 || v === 1,
           `noiseFlags[${i}] must be 0 or 1, got ${v}`);
    }
  }

  // Optional condensedTree: surfaced by HDBSCAN (MLC-0) for multi-level
  // extraction. Present only on algorithms that build a stability tree.
  // Compact projection — node-parallel typed arrays + per-leaf home.
  if (result.condensedTree !== undefined) {
    validateCondensedTree(result.condensedTree, n);
  }
}

// Validate the compact condensed-tree projection (doc/clustering.md §4.2,
// serialised in clustering-hdbscan.js). Cheap structural checks only —
// the heavy correctness invariant (deepest-selected-ancestor reproduces
// the flat labels) lives in the pytest suite, not the hot path.
function validateCondensedTree(t, n) {
  fail(t && typeof t === "object", "condensedTree must be an object");
  const m = t.numNodes;
  fail(Number.isInteger(m) && m >= 0,
       `condensedTree.numNodes must be a non-negative integer, got ${m}`);
  fail(t.n === n, `condensedTree.n must equal n (${n}), got ${t.n}`);
  fail(t.root === (m > 0 ? 0 : -1),
       `condensedTree.root must be ${m > 0 ? 0 : -1} for ${m} nodes, got ${t.root}`);

  const nodeArrays = [
    ["parent",        Int32Array],
    ["birthLambda",   Float64Array],
    ["stability",     Float64Array],
    ["size",          Int32Array],
    ["selectedLabel", Int32Array],
  ];
  for (const [key, Ctor] of nodeArrays) {
    fail(t[key] instanceof Ctor,
         `condensedTree.${key} must be a ${Ctor.name}`);
    fail(t[key].length === m,
         `condensedTree.${key}.length must equal numNodes (${m}), got ${t[key].length}`);
  }
  for (let i = 0; i < m; i++) {
    const p = t.parent[i];
    fail(p === -1 || (p >= 0 && p < m && p < i),
         `condensedTree.parent[${i}] = ${p}: must be -1 or an ancestor id in [0, ${i})`);
  }
  fail(m === 0 || t.parent[0] === -1,
       "condensedTree.parent[root] must be -1");

  const leafArrays = [
    ["leafHome",   Int32Array],
    ["leafLambda", Float64Array],
  ];
  for (const [key, Ctor] of leafArrays) {
    fail(t[key] instanceof Ctor,
         `condensedTree.${key} must be a ${Ctor.name}`);
    fail(t[key].length === n,
         `condensedTree.${key}.length must equal n (${n}), got ${t[key].length}`);
  }
  for (let p = 0; p < n; p++) {
    const home = t.leafHome[p];
    fail(m === 0 || (home >= 0 && home < m),
         `condensedTree.leafHome[${p}] = ${home}: must be a valid node id in [0, ${m})`);
  }
}

function fail(cond, msg) {
  if (!cond) {
    throw new Error("[ClusterContract] " + msg);
  }
}
