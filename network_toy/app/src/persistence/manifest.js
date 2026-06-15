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
// SCHEMA_VERSION 4: persists state.workflow (the canonical card tree) +
//   state.view alongside the flat projection slots. v3 files have no
//   workflow, so strict-refusal rejects them (acceptable per the rule).
export const SCHEMA_VERSION = 4;

// Build the manifest header written into the zip. Caller fills in
// the contents list (paths inside the archive) since it has the
// inventory after serialisation.
export function buildManifest({ projectName, contents, fixtureStamp }) {
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    appName:       "network-toy",
    appVersion:    "v3-dev",
    savedAt:       new Date().toISOString(),
    projectName:   projectName || null,
    contents,                                 // [string] — relative paths in the zip
  };
  // Fixture provenance — ONLY present in generated test fixtures (written by
  // scripts/make-fixtures.mjs), never in ordinary user saves. Records the
  // generator version + the pipeline params that produced the fixture so the
  // freshness/determinism guards can detect a committed fixture that has
  // drifted from its generator. See network_toy/tests/test_fixture_*.py.
  if (fixtureStamp) manifest.fixtureStamp = fixtureStamp;
  return manifest;
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
