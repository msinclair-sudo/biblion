// Zip blob → state patch.
//
// Reverse of serialise.js: unzips, validates schemaVersion (refuses
// on mismatch), parses state.json, walks every {__binary, type, length}
// descriptor and replaces it with a TypedArray view onto the matching
// arrays/* entry.
//
// Returns a state patch suitable for `update(patch)`. Caller is
// responsible for clearing engineRevision / refreshing UI / etc.

import { unzipSync, strFromU8 } from "fflate";
import { validateManifest } from "./manifest.js";

const TYPED_ARRAY_CTORS = {
  Float32Array,
  Int32Array,
  Uint8Array,
  Float64Array,
};

export async function deserialiseFile(file) {
  const ab = await file.arrayBuffer();
  const entries = unzipSync(new Uint8Array(ab));

  if (!entries["manifest.json"]) {
    throw new Error("[persistence] no manifest.json — not a project file");
  }
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  validateManifest(manifest);   // throws on schema mismatch

  if (!entries["state.json"]) {
    throw new Error("[persistence] no state.json in archive");
  }
  const raw = JSON.parse(strFromU8(entries["state.json"]));
  // (Back-compat shim entry point — additive normalisation of `raw` for
  //  older schema versions goes here, before reviveBinaries.)
  normaliseLegacyToy(raw);
  const patch = reviveBinaries(raw, entries);

  // reviveBinaries handles nested descriptors recursively, including
  // multiple descriptors that point at one shared arrays/ entry (the
  // serialiser's buffer-identity dedup emits these): each descriptor
  // gets its own copied buffer, so the revived views are independent
  // and usable even when they share a source path.
  return { patch, manifest };
}

// Back-compat: the synthetic toy data path was retired. Old project
// archives can still name registry entries that no longer exist —
// rewrite them to their real-data equivalents in place so the rest of
// the load (and engine boot) doesn't reference a missing registry key.
//   citations.method "taste-network"        -> "imported-edges"
//   evalResults.optimise scorer "ari"/"auto" -> "richness"
function normaliseLegacyToy(raw) {
  if (!raw || typeof raw !== "object") return;

  if (raw.citations && raw.citations.method === "taste-network") {
    raw.citations.method = "imported-edges";
  }

  const opt = raw.evalResults && raw.evalResults.optimise;
  if (opt) {
    const sid = opt.scorerId || opt.scorer;
    if (sid === "ari" || sid === "auto") {
      if ("scorerId" in opt) opt.scorerId = "richness";
      if ("scorer" in opt) opt.scorer = "richness";
    }
  }
}

// Recursively walk a JSON-deserialised object; whenever we see a
// {__binary, type, length} descriptor, replace it with the matching
// TypedArray reconstructed from the zip entry.
function reviveBinaries(node, entries) {
  if (node == null) return node;
  if (typeof node !== "object") return node;

  // Binary descriptor sentinel.
  if (typeof node.__binary === "string" && node.type) {
    const bytes = entries[node.__binary];
    if (!bytes) {
      throw new Error(`[persistence] missing array entry: ${node.__binary}`);
    }
    const Ctor = TYPED_ARRAY_CTORS[node.type];
    if (!Ctor) {
      throw new Error(`[persistence] unknown TypedArray type: ${node.type}`);
    }
    // unzipSync returns a Uint8Array view onto the file's bytes;
    // wrap it as the requested TypedArray. Use slice() to copy
    // because the underlying buffer's alignment isn't guaranteed
    // for f32/i32 views.
    const copied = new Uint8Array(bytes);
    return new Ctor(copied.buffer, copied.byteOffset, node.length);
  }

  if (Array.isArray(node)) {
    return node.map(child => reviveBinaries(child, entries));
  }

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = reviveBinaries(v, entries);
  }
  return out;
}
