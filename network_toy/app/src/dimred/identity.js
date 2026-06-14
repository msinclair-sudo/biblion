// Identity dim-reduction — pass-through, used as the "skip this stage"
// option in either the noise-reduction or compression slot of Layer 1.5.
//
// Input is a generic DimredInput ({n, d, data: Float32Array(n*d)}); the
// engine packs basePos into one for the first stage, and stage 2's input
// is stage 1's output. Identity emits its input verbatim wrapped with
// DimredResult metadata. Cheap; the contract validator is what actually
// touches the buffer.

export const defaultIdentityParams = () => ({});

export function computeIdentity(input, _params = {}) {
  return {
    method: "identity",
    params: {},
    n: input.n,
    d: input.d,
    data: input.data,
  };
}
