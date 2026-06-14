// Citation generation — public output contract.
//
// Every algorithm in the citation-generation registry must return a
// CitationResult satisfying this shape. Downstream consumers (Layer 4
// citation-layout, Layer 5 blend, render-time decoration) are written
// against this contract and against this contract only — they MUST
// NOT reach into any algorithm-specific internals (taste sets,
// neighbourhood ids, intermediate stages).
//
// Shape:
//   {
//     method:    string         id of the registry entry that produced this
//     params:    object         echo of the params actually used (post-clamp)
//     hasCit:    Uint8Array(n²) symmetric flag, 1 ⇔ pair (i, j) cited
//     inDeg:     Int32Array(n)  incoming-citation count per node
//     citations: [{ source, target }, …]   every citation as (newer→older)
//     edges:     [[i, j], …]    same set as citations, normalised i < j
//     pools:     object         per-algorithm diagnostic counters; opaque
//   }
//
// The validator below is enforced once per resample so contract drift
// shows up at the moment a new algorithm is registered, not three
// layers downstream when something breaks silently.

export function validateCitationResult(result, n) {
  const errors = [];
  if (!result || typeof result !== "object") {
    return ["CitationResult: not an object"];
  }
  if (typeof result.method !== "string" || !result.method) {
    errors.push("CitationResult.method must be a non-empty string");
  }
  if (!result.params || typeof result.params !== "object") {
    errors.push("CitationResult.params must be an object");
  }
  if (!(result.hasCit instanceof Uint8Array)) {
    errors.push("CitationResult.hasCit must be a Uint8Array");
  } else if (result.hasCit.length !== n * n) {
    errors.push(`CitationResult.hasCit length ${result.hasCit.length} ≠ n² (${n*n})`);
  }
  if (!(result.inDeg instanceof Int32Array)) {
    errors.push("CitationResult.inDeg must be an Int32Array");
  } else if (result.inDeg.length !== n) {
    errors.push(`CitationResult.inDeg length ${result.inDeg.length} ≠ n (${n})`);
  }
  if (!Array.isArray(result.citations)) {
    errors.push("CitationResult.citations must be an array");
  }
  if (!Array.isArray(result.edges)) {
    errors.push("CitationResult.edges must be an array");
  }
  // Symmetry of hasCit is a structural property the layout / blend
  // layers rely on; check a sampled subset cheaply rather than all
  // n² pairs every regen.
  if (result.hasCit instanceof Uint8Array && result.hasCit.length === n * n) {
    const step = Math.max(1, Math.floor(n / 16));
    for (let i = 0; i < n; i += step) {
      for (let j = 0; j < n; j += step) {
        if (result.hasCit[i*n+j] !== result.hasCit[j*n+i]) {
          errors.push(`CitationResult.hasCit asymmetry at (${i},${j})`);
          break;
        }
      }
      if (errors.length) break;
    }
  }
  return errors;
}

export function assertCitationResult(result, n) {
  const errors = validateCitationResult(result, n);
  if (errors.length) {
    throw new Error("CitationResult contract violations:\n  - " + errors.join("\n  - "));
  }
}
