// Citation layout — public output contract.
//
// Every layout algorithm in the registry must return a flat
// Float32Array of length n×3, indexed by data-node id:
//
//   positions[i*3]   = x for node i
//   positions[i*3+1] = y for node i
//   positions[i*3+2] = z for node i
//
// All values must be finite. Layouts produced from disconnected
// citation graphs must still cover every node — no NaN / Infinity
// for islands. The layout is in its own coordinate frame; orientation
// and centroid are arbitrary (the blend module's per-component Kabsch
// alignment handles bringing it into basePos's frame).

export function validateCitationLayout(positions, n) {
  const errors = [];
  if (!(positions instanceof Float32Array)) {
    return ["CitationLayout: must be a Float32Array"];
  }
  if (positions.length !== n * 3) {
    errors.push(`CitationLayout: length ${positions.length} ≠ n×3 (${n*3})`);
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      const node = (i / 3) | 0;
      const axis = "xyz"[i % 3];
      errors.push(`CitationLayout: node ${node}.${axis} is non-finite (${positions[i]})`);
      break;
    }
  }
  return errors;
}

export function assertCitationLayout(positions, n) {
  const errors = validateCitationLayout(positions, n);
  if (errors.length) {
    throw new Error("CitationLayout contract violations:\n  - " + errors.join("\n  - "));
  }
}
