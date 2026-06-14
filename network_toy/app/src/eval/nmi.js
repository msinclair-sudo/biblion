// Normalised Mutual Information between two label arrays.
//
//   I(A; B)   = Σ p(a, b) · log(p(a, b) / (p(a) · p(b)))    natural log
//   H(A)      = -Σ p(a) · log p(a)
//   NMI_arith = 2·I / (H(A) + H(B))    — most common in the clustering literature
//   NMI_geom  = I / √(H(A) · H(B))     — slightly stricter; reported alongside
//
// Permutation-invariant (label "0" in A doesn't have to mean the same
// thing as label "0" in B) and well-defined when the two clusterings
// have different cluster counts. Returns 1.0 for identical partitions
// (modulo relabelling), 0.0 when A and B are independent. Both inputs
// must be the same length.
//
// Adjusted MI (AMI) corrects NMI for chance agreement under the
// permutation model — random clusterings give NMI > 0 systematically
// at small n / many clusters, but AMI ≈ 0. We compute AMI under the
// Vinh-Epps-Bailey 2009 form using the hypergeometric expected MI.
// Heavy on log-gamma evaluations but tractable at any clustering
// scale (linear in the contingency-table size); not worth deferring
// to a worker.
//
// Reference: Vinh, N. X., Epps, J., & Bailey, J. (2009). Information
// theoretic measures for clusterings comparison.

export function normalisedMutualInformation(a, b) {
  const n = a.length;
  if (n !== b.length) throw new Error("NMI: length mismatch");
  if (n === 0) return { nmi_arith: NaN, nmi_geom: NaN, mi: NaN, hA: NaN, hB: NaN };

  // Contingency table.
  const ct = new Map();           // a_label → Map(b_label → count)
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

  // I(A; B) = Σ p(a,b) · log[p(a,b) / (p(a)·p(b))]
  //        = Σ (n_ab/n) · log[n · n_ab / (n_a · n_b)]
  let mi = 0;
  for (const [ai, row] of ct) {
    const nA = aTotals.get(ai);
    for (const [bi, nAB] of row) {
      const nB = bTotals.get(bi);
      mi += (nAB / n) * Math.log((n * nAB) / (nA * nB));
    }
  }

  let hA = 0;
  for (const nA of aTotals.values()) {
    const p = nA / n;
    hA -= p * Math.log(p);
  }
  let hB = 0;
  for (const nB of bTotals.values()) {
    const p = nB / n;
    hB -= p * Math.log(p);
  }

  const denomArith = hA + hB;
  const denomGeom  = Math.sqrt(hA * hB);
  return {
    mi,
    hA, hB,
    nmi_arith: denomArith > 0 ? (2 * mi) / denomArith : (hA === 0 && hB === 0 ? 1.0 : 0.0),
    nmi_geom:  denomGeom  > 0 ? mi / denomGeom         : (hA === 0 && hB === 0 ? 1.0 : 0.0),
  };
}

/**
 * Adjusted Mutual Information (Vinh-Epps-Bailey form).
 *
 * AMI = (MI − E[MI]) / (max(H(A), H(B)) − E[MI])
 *
 * E[MI] computed exactly from cluster size totals (no sampling). At
 * very small contingency tables AMI can go slightly negative; clamp
 * for display but return the raw value here.
 *
 * Returns { ami, expectedMi } alongside the raw NMI fields.
 */
export function adjustedMutualInformation(a, b) {
  const nmi = normalisedMutualInformation(a, b);
  const { mi, hA, hB } = nmi;
  const n = a.length;
  if (n === 0) return { ...nmi, ami: NaN, expectedMi: NaN };

  // E[MI] under the hypergeometric model:
  //   E[MI] = Σ_i Σ_j  Σ_{nij = max(0, ai+bj-n)}^{min(ai, bj)}
  //               (nij/n) · log(n·nij / (ai·bj)) ·
  //               (ai! · bj! · (n-ai)! · (n-bj)!) /
  //               (n! · nij! · (ai-nij)! · (bj-nij)! · (n-ai-bj+nij)!)
  //
  // Computed in log-space via lgamma so the factorials stay tractable
  // at n=5000.
  const aTotals = countMap(a);
  const bTotals = countMap(b);
  const aSizes = [...aTotals.values()];
  const bSizes = [...bTotals.values()];

  let eMi = 0;
  const lgN = lgamma(n + 1);
  for (const ai of aSizes) {
    for (const bj of bSizes) {
      const start = Math.max(1, ai + bj - n);
      const end   = Math.min(ai, bj);
      for (let nij = start; nij <= end; nij++) {
        const term = (nij / n) * Math.log((n * nij) / (ai * bj));
        // log P(nij) = log(ai!) + log(bj!) + log((n-ai)!) + log((n-bj)!)
        //            − log(n!) − log(nij!) − log((ai-nij)!) − log((bj-nij)!) − log((n-ai-bj+nij)!)
        const logP = lgamma(ai + 1) + lgamma(bj + 1) + lgamma(n - ai + 1) + lgamma(n - bj + 1)
                   - lgN - lgamma(nij + 1) - lgamma(ai - nij + 1) - lgamma(bj - nij + 1) - lgamma(n - ai - bj + nij + 1);
        eMi += term * Math.exp(logP);
      }
    }
  }

  const maxH = Math.max(hA, hB);
  const denom = maxH - eMi;
  const ami = Math.abs(denom) < 1e-12 ? (Math.abs(mi - eMi) < 1e-12 ? 1.0 : 0.0)
                                       : (mi - eMi) / denom;
  return { ...nmi, ami, expectedMi: eMi };
}

function countMap(labels) {
  const m = new Map();
  for (const l of labels) m.set(l, (m.get(l) || 0) + 1);
  return m;
}

// Lanczos approximation of log Γ(x). Accurate to ~1e-14 for x > 0;
// good enough for the contingency-table sums above.
function lgamma(x) {
  if (x < 0.5) {
    // Reflection: Γ(x) Γ(1-x) = π / sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  const g = 7;
  const C = [
    0.99999999999980993,
    676.5203681218851,
   -1259.1392167224028,
    771.32342877765313,
   -176.61502916214059,
    12.507343278686905,
   -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  let s = C[0];
  for (let i = 1; i < g + 2; i++) s += C[i] / (x + i);
  const t = x + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}
