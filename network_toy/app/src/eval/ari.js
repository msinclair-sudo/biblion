// Adjusted Rand Index between two label arrays.
//
// ARI(A, B) = (RI − E[RI]) / (max(RI) − E[RI])
//
// computed via pair-counting on the contingency table. Permutation-
// invariant (label "0" in A doesn't have to mean the same thing as
// label "0" in B) and well-defined when the two clusterings have
// different cluster counts. Returns:
//   1.0  → identical partition (modulo label permutation)
//   0.0  → no better than chance
//   < 0  → worse than chance (rare)
//
// References: Hubert & Arabie 1985.
//
// Both inputs must be the same length. Labels can be any integers
// (or strings). NaN if either input is empty.

export function adjustedRandIndex(a, b) {
  const n = a.length;
  if (n !== b.length) throw new Error("ARI: length mismatch");
  if (n === 0) return NaN;

  // Contingency table as nested Maps: ct[a_label][b_label] = count.
  const ct = new Map();
  const aTotals = new Map();
  const bTotals = new Map();
  for (let i = 0; i < n; i++) {
    const ai = a[i], bi = b[i];
    let row = ct.get(ai);
    if (!row) { row = new Map(); ct.set(ai, row); }
    row.set(bi, (row.get(bi) || 0) + 1);
    aTotals.set(ai, (aTotals.get(ai) || 0) + 1);
    bTotals.set(bi, (bTotals.get(bi) || 0) + 1);
  }

  const c2 = (k) => k * (k - 1) / 2;

  let sumNij2 = 0;
  for (const row of ct.values()) for (const v of row.values()) sumNij2 += c2(v);
  let sumAi2 = 0;
  for (const v of aTotals.values()) sumAi2 += c2(v);
  let sumBj2 = 0;
  for (const v of bTotals.values()) sumBj2 += c2(v);

  const cn2 = c2(n);
  if (cn2 === 0) return 1.0;

  const expected = (sumAi2 * sumBj2) / cn2;
  const max      = 0.5 * (sumAi2 + sumBj2);
  if (max === expected) return 1.0;          // both clusterings trivial
  return (sumNij2 - expected) / (max - expected);
}
