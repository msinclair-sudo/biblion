// Persistence schema version + manifest helpers.
//
// SCHEMA_VERSION bumps when the on-disk shape changes incompatibly.
// Loader refuses files with a different version (per the user's
// "strict refusal" choice). When the shape changes, increment this
// constant in the same commit; old files become unloadable until a
// migration is added.

// SCHEMA_VERSION 2: adds state._basePos2d (2D viewer input) +
//   layerParams.dimred.viz2d sub-stage. Files saved under v1 don't
//   carry these fields, so loader refuses (per strict-refusal rule).
// SCHEMA_VERSION 3: adds state.cart (cluster→cart→biblion-subset round-trip).
export const SCHEMA_VERSION = 3;

// Build the manifest header written into the zip. Caller fills in
// the contents list (paths inside the archive) since it has the
// inventory after serialisation.
export function buildManifest({ projectName, contents }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    appName:       "network-toy",
    appVersion:    "v3-dev",
    savedAt:       new Date().toISOString(),
    projectName:   projectName || null,
    contents,                                 // [string] — relative paths in the zip
  };
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("[persistence] manifest is missing or not an object");
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `[persistence] schema version mismatch — file is v${manifest.schemaVersion}, ` +
      `app expects v${SCHEMA_VERSION}. Refusing to load.`
    );
  }
  if (manifest.appName !== "network-toy") {
    throw new Error(`[persistence] not a network-toy file (appName=${JSON.stringify(manifest.appName)})`);
  }
}
