// Cluster labelling — its own multi-method module (MLC §7).
//
// Computes a label for every cluster by SEVERAL methods at once and
// returns them side-by-side (+ a combined pick), so the scoring surface
// can show one or compare many. Real-data only: the toy's synthetic nodes
// have no text/paper identity.
//
// Methods (a small registry — add one entry to add a method):
//   representative  embedding centroid → nearest member's paperId. Works
//                   from the SPECTER2 embedding alone; always available on
//                   real data.
//   year            median + range of member publication years. Cheap
//                   descriptive tag; available when nodes carry `year`.
//   cTfidf          class-based TF-IDF (BERTopic-style): each cluster is
//                   one document; top terms vs the other clusters.
//   tfidf           plain TF-IDF over member texts vs the whole corpus.
//
// The text methods (cTfidf / tfidf / a future KeyBERT) need a per-node
// text accessor `ctx.getText(nodeId) → string|null`. The toy doesn't
// materialise titles/abstracts today (only paperId + embedding are
// loaded), so on real data they report { available:false, reason } until a
// titles source is wired into ctx.getText — but the maths is here and
// unit-tested via an injected accessor.
//
// ctx: {
//   embedding: { d, data:Float32Array(n*d) } | null,
//   nodes:     [{ id, paperId?, year? }],
//   getText?:  (nodeId) => string | null,
// }

const STOPWORDS = new Set((
  "the a an and or of to in for on with by from as at is are be this that " +
  "we our using use based via into over under between within across new " +
  "approach method methods model models results result study analysis " +
  "paper which can may not but its their these those also more most such " +
  "than then they them was were has have had been being it he she his her"
).split(/\s+/));

const TOP_TERMS = 4;

/* ── method registry ────────────────────────────────────────────────── */

const METHODS = {
  representative: {
    id: "representative",
    label: "Representative paper",
    available: (ctx) => !!(ctx.embedding && ctx.embedding.data),
    run: runRepresentative,
  },
  year: {
    id: "year",
    label: "Year span",
    available: (ctx) => Array.isArray(ctx.nodes) && ctx.nodes.some(nd => Number.isFinite(nd && nd.year)),
    run: runYear,
  },
  cTfidf: {
    id: "cTfidf",
    label: "c-TF-IDF",
    available: hasText,
    run: (cr, ctx) => runTfidf(cr, ctx, /* classBased */ true),
  },
  tfidf: {
    id: "tfidf",
    label: "TF-IDF",
    available: hasText,
    run: (cr, ctx) => runTfidf(cr, ctx, /* classBased */ false),
  },
  keybert: {
    id: "keybert",
    label: "KeyBERT",
    available: hasText,
    run: runKeyBERT,
  },
  // Stratified (banded) variants — same scoring as the flat method above, but
  // the terms are sampled across df-specificity bands (anchor → signature)
  // instead of taken from one slice. One per base scorer, since which relevance
  // the bands are built from matters (KeyBERT's MMR diversity ≠ plain TF-IDF).
  cTfidfStratified: {
    id: "cTfidfStratified",
    label: "c-TF-IDF (banded)",
    available: hasText,
    run: (cr, ctx, members) =>
      stratifiedLabels(cr, ctx, members, { ngramMax: 1, lenBoost: false, mmr: false }),
  },
  tfidfStratified: {
    id: "tfidfStratified",
    label: "TF-IDF (banded)",
    available: hasText,
    run: (cr, ctx, members) =>
      stratifiedLabels(cr, ctx, members, { ngramMax: 1, lenBoost: false, mmr: false }),
  },
  keybertStratified: {
    id: "keybertStratified",
    label: "KeyBERT (banded)",
    available: hasText,
    run: (cr, ctx, members) =>
      stratifiedLabels(cr, ctx, members, { ngramMax: 2, lenBoost: true, mmr: true }),
  },
};

// List the label methods. Pass a ctx ({embedding, nodes, getText?}) to also
// report per-method availability + a reason when unavailable (used by the
// labelling card's modal to disable methods that can't run on this data).
export function listLabelMethods(ctx = null) {
  return Object.values(METHODS).map(m => {
    const out = { id: m.id, label: m.label };
    if (ctx) {
      out.available = m.available(ctx);
      if (!out.available) out.reason = reasonFor(m.id, ctx);
    }
    return out;
  });
}

/**
 * Label every cluster of `clusterResult` by every requested method.
 *
 * @param {object} clusterResult  a ClusterResult (nodeCluster + clusters).
 * @param {object} ctx            { embedding, nodes, getText? }.
 * @param {object} [opts]         { methods?: string[] } — defaults to all.
 * @returns {{
 *   methods: Array<{id, label, available, reason?}>,
 *   perCluster: Array<{ clusterId, byMethod: {[id]: any}, combined: string }>,
 * }}
 */
export function labelClusters(clusterResult, ctx, opts = {}) {
  const wanted = opts.methods || Object.keys(METHODS);
  const nClusters = clusterResult.clusters.length;

  // Member ids per cluster (one pass).
  const members = Array.from({ length: nClusters }, () => []);
  const nc = clusterResult.nodeCluster;
  for (let i = 0; i < nc.length; i++) {
    const c = nc[i];
    if (c >= 0 && c < nClusters) members[c].push(i);
  }

  const methodInfo = [];
  const results = {};   // id → perCluster array (or null)
  for (const id of wanted) {
    const m = METHODS[id];
    if (!m) continue;
    const avail = m.available(ctx);
    methodInfo.push({
      id: m.id, label: m.label, available: avail,
      reason: avail ? undefined : reasonFor(id, ctx),
    });
    results[id] = avail ? m.run(clusterResult, ctx, members) : null;
  }

  const perCluster = [];
  for (let c = 0; c < nClusters; c++) {
    const byMethod = {};
    for (const id of wanted) {
      if (results[id]) byMethod[id] = results[id][c];
    }
    perCluster.push({ clusterId: c, byMethod, combined: combine(byMethod) });
  }

  return { methods: methodInfo, perCluster };
}

/* ── methods ─────────────────────────────────────────────────────────── */

function runRepresentative(cr, ctx, members) {
  const { d, data } = ctx.embedding;
  const out = new Array(cr.clusters.length);
  for (let c = 0; c < cr.clusters.length; c++) {
    const ids = members[c];
    if (ids.length === 0) { out[c] = { nodeId: -1, paperId: null }; continue; }
    // centroid in embedding space
    const cen = new Float64Array(d);
    for (const i of ids) { const off = i * d; for (let k = 0; k < d; k++) cen[k] += data[off + k]; }
    for (let k = 0; k < d; k++) cen[k] /= ids.length;
    // nearest member by cosine similarity to the centroid
    let best = ids[0], bestSim = -Infinity;
    let cenNorm = 0; for (let k = 0; k < d; k++) cenNorm += cen[k] * cen[k];
    cenNorm = Math.sqrt(cenNorm) || 1;
    for (const i of ids) {
      const off = i * d;
      let dot = 0, nn = 0;
      for (let k = 0; k < d; k++) { const v = data[off + k]; dot += v * cen[k]; nn += v * v; }
      const sim = dot / ((Math.sqrt(nn) || 1) * cenNorm);
      if (sim > bestSim) { bestSim = sim; best = i; }
    }
    const node = ctx.nodes[best];
    out[c] = {
      nodeId:  best,
      paperId: (node && node.paperId) || null,
      similarity: bestSim,
    };
  }
  return out;
}

function runYear(cr, ctx, members) {
  const out = new Array(cr.clusters.length);
  for (let c = 0; c < cr.clusters.length; c++) {
    const years = [];
    for (const i of members[c]) {
      const y = ctx.nodes[i] && ctx.nodes[i].year;
      if (Number.isFinite(y)) years.push(y);
    }
    if (years.length === 0) { out[c] = { median: null, min: null, max: null }; continue; }
    years.sort((a, b) => a - b);
    out[c] = {
      median: years[Math.floor(years.length / 2)],
      min:    years[0],
      max:    years[years.length - 1],
      n:      years.length,
    };
  }
  return out;
}

// Plain (classBased=false) or class-based (true) TF-IDF over member texts.
function runTfidf(cr, ctx, classBased, membersArg) {
  const members = membersArg || membersOf(cr);
  const nClusters = cr.clusters.length;

  // Tokenise each cluster's bag of member texts → term-frequency map.
  const tf = new Array(nClusters);
  for (let c = 0; c < nClusters; c++) {
    const counts = new Map();
    let total = 0;
    for (const i of members[c]) {
      const text = ctx.getText(ctx.nodes[i] ? ctx.nodes[i].id : i);
      if (!text) continue;
      for (const tok of tokenize(text)) {
        counts.set(tok, (counts.get(tok) || 0) + 1);
        total++;
      }
    }
    tf[c] = { counts, total: total || 1 };
  }

  // Document frequency across clusters (class-based) — how many clusters
  // contain each term. For plain TF-IDF we'd use per-node df, but at the
  // cluster-labelling granularity the class-based df is the meaningful one;
  // the `classBased` flag tunes the idf base only.
  const df = new Map();
  for (let c = 0; c < nClusters; c++) {
    for (const term of tf[c].counts.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const N = classBased ? nClusters : nClusters;

  const out = new Array(nClusters);
  for (let c = 0; c < nClusters; c++) {
    const scored = [];
    for (const [term, count] of tf[c].counts) {
      const tfv = count / tf[c].total;
      const idf = Math.log(1 + N / (1 + (df.get(term) || 0)));
      scored.push({ term, score: tfv * idf, count });
    }
    scored.sort((a, b) => b.score - a.score);
    out[c] = { terms: scored.slice(0, TOP_TERMS).map(s => s.term), detail: scored.slice(0, TOP_TERMS) };
  }
  return out;
}

// KeyBERT-STYLE keyphrase labels, adapted to a no-transformer environment.
//
// Real KeyBERT embeds candidate phrases with the same sentence-transformer as
// the document and ranks them by cosine similarity, then MMR-diversifies. The
// static in-browser toy has no phrase encoder, so we keep KeyBERT's two
// defining moves — (1) candidate n-gram generation, (2) MMR diversification —
// and substitute a class-based TF-IDF *relevance* for the (unavailable)
// phrase↔document cosine. The result is a small set of DIVERSE, cluster-
// distinctive 1–2-grams: closer to KeyBERT's output than plain TF-IDF (which
// has no diversity step and emits unigrams only). The approximation is
// documented so we don't overclaim it's the real model.
//
// relevance(phrase, cluster) = classTfidf over the phrase's frequency in the
//   cluster's bag vs. how many clusters contain it.
// MMR: pick the top phrase, then iteratively pick the phrase maximising
//   λ·relevance − (1−λ)·maxTokenOverlapWithAlreadyPicked, so near-duplicate
//   phrases ("soil microbial", "microbial community", "soil microbial
//   community") don't all win.
const KEYBERT_NGRAM_MAX = 2;   // unigrams + bigrams
const KEYBERT_MMR_LAMBDA = 0.6;
const KEYBERT_CANDIDATES = 30; // top-by-relevance pool MMR diversifies over

function runKeyBERT(cr, ctx, membersArg) {
  const members = membersArg || membersOf(cr);
  const nClusters = cr.clusters.length;

  // Per-cluster phrase frequencies (1..KEYBERT_NGRAM_MAX grams).
  const tf = new Array(nClusters);
  for (let c = 0; c < nClusters; c++) {
    const counts = new Map();
    for (const i of members[c]) {
      const text = ctx.getText(ctx.nodes[i] ? ctx.nodes[i].id : i);
      if (!text) continue;
      for (const ph of ngrams(tokenize(text), KEYBERT_NGRAM_MAX)) {
        counts.set(ph, (counts.get(ph) || 0) + 1);
      }
    }
    tf[c] = counts;
  }

  // Class document frequency: how many clusters contain each phrase.
  const df = new Map();
  for (let c = 0; c < nClusters; c++) {
    for (const ph of tf[c].keys()) df.set(ph, (df.get(ph) || 0) + 1);
  }

  const out = new Array(nClusters);
  for (let c = 0; c < nClusters; c++) {
    let total = 0;
    for (const v of tf[c].values()) total += v;
    total = total || 1;
    // Relevance = class TF-IDF; a longer phrase gets a mild length boost so
    // informative bigrams aren't always beaten by their component unigrams.
    const scored = [];
    for (const [ph, count] of tf[c]) {
      const tfv = count / total;
      const idf = Math.log(1 + nClusters / (1 + (df.get(ph) || 0)));
      const lenBoost = 1 + 0.15 * (ph.split(" ").length - 1);
      scored.push({ term: ph, score: tfv * idf * lenBoost, count });
    }
    scored.sort((a, b) => b.score - a.score);
    const pool = scored.slice(0, KEYBERT_CANDIDATES);
    const diverse = mmrSelect(pool, TOP_TERMS);
    out[c] = { terms: diverse.map(s => s.term), detail: diverse };
  }
  return out;
}

// STRATIFIED labels — describe a cluster at several specificity altitudes at
// once instead of taking the top-N from one slice. The banding "grain" is a
// term's PAPER document-frequency (how many papers in the whole corpus contain
// it), NOT its cluster-df: cluster-df only ranges over the handful of clusters,
// so "mid"/"specific" collapsed onto near-unique terms and read as too specific.
// Paper-df spreads terms over the real corpus distribution, so a corpus-common
// word lands in a general band and a rare word in a specific one. We bucket
// candidate terms into five bands from general ("anchor", in many papers —
// places the cluster in the corpus) down to "signature" (paper-df==1, in a
// single paper — what it actually holds), and take the top STRAT_PER_BAND of
// each by the same c-TF-IDF relevance the other text methods use (relevance
// ranking — which terms enter the bands — is unchanged; only the banding axis
// moved from cluster-df to paper-df).
//
// The band edges are NOT fixed thresholds — they're read off this dataset's own
// paper-df distribution so the slices transfer across corpora. df is heavy-
// tailed (most terms sit in very few papers), so the informative distinctions
// live in the sparse upper tail and that axis is logarithmic: we log-space the
// four non-signature bands over [2 .. maxDf]. See scratch/label_overlap/ for the
// analysis that motivated this (quantiles collapse, flat ratios don't transfer).
export const STRAT_PER_BAND = 6;
const STRAT_BANDS = ["anchor", "broad", "mid", "specific", "signature"];

// Common non-English (Romance) function words that survive the English-only
// STOPWORDS list and otherwise pollute the df==1 signature band in multilingual
// corpora (e.g. fallworm's Portuguese abstracts → "para", "foram", "uma").
const STRAT_MULTI_STOP = new Set((
  "para com que uma foram dos das por foi mas como este esta sao ser son del " +
  "las los una con fue por sus est une des pour avec sur dans nel della delle"
).split(/\s+/));

// Banding core, shared by every "(banded)" method. `opts` selects the base
// scorer: ngramMax (1 = TF-IDF unigrams, 2 = KeyBERT 1–2-grams), lenBoost (give
// longer phrases a mild edge, KeyBERT-style), and mmr (diversify within each
// band with maximal-marginal-relevance, KeyBERT-style — otherwise take the top
// per band by score with light unigram-in-phrase dedup).
function stratifiedLabels(cr, ctx, membersArg, opts) {
  const { ngramMax = 2, lenBoost = true, mmr = false } = opts || {};
  const members = membersArg || membersOf(cr);
  const nClusters = cr.clusters.length;

  // Per-cluster phrase frequencies (1..ngramMax grams) for relevance, AND a
  // corpus-wide paper-df pass: how many distinct PAPERS contain each phrase.
  // Paper-df is the banding axis; cluster-df is no longer computed.
  const tf = new Array(nClusters);
  const paperDf = new Map();
  let nPapers = 0;
  for (let c = 0; c < nClusters; c++) {
    const counts = new Map();
    for (const i of members[c]) {
      const text = ctx.getText(ctx.nodes[i] ? ctx.nodes[i].id : i);
      if (!text) continue;
      nPapers++;
      const seen = new Set();   // de-dup within a paper so df counts papers, not hits
      for (const ph of ngrams(tokenize(text), ngramMax)) {
        counts.set(ph, (counts.get(ph) || 0) + 1);
        if (!seen.has(ph)) { seen.add(ph); paperDf.set(ph, (paperDf.get(ph) || 0) + 1); }
      }
    }
    tf[c] = counts;
  }

  // Modest minimum-support floor: drop terms that appear in too few papers to
  // be worth banding. Frequency-1 terms in a tiny corpus stay (a unique
  // signature is the point), but as the corpus grows we require a term to show
  // up in at least ~0.5% of papers (min 1) before it can enter a band. Junk is
  // still caught by looksJunk in the signature tail; this is the support gate.
  const supportFloor = Math.max(1, Math.ceil(nPapers * 0.005));

  // Dataset-adaptive band edges from the paper-df distribution (above-floor).
  const bandDf = new Map();
  for (const [ph, c] of paperDf) if (c >= supportFloor) bandDf.set(ph, c);
  const edges = bandEdges(bandDf);

  const out = new Array(nClusters);
  for (let c = 0; c < nClusters; c++) {
    let total = 0;
    for (const v of tf[c].values()) total += v;
    total = total || 1;

    // Score every above-floor candidate (c-TF-IDF relevance, cluster-based idf),
    // then split into bands by its corpus paper-df.
    const perBand = { anchor: [], broad: [], mid: [], specific: [], signature: [] };
    const scored = [];
    for (const [ph, count] of tf[c]) {
      const pdf = paperDf.get(ph) || 1;
      if (pdf < supportFloor) continue;   // below support floor — drop before banding
      const tfv = count / total;
      const idf = Math.log(1 + nClusters / (1 + pdf));
      const boost = lenBoost ? 1 + 0.15 * (ph.split(" ").length - 1) : 1;
      scored.push({ term: ph, score: tfv * idf * boost, df: pdf });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const cand of scored) perBand[bandOf(cand.df, edges)].push(cand);

    const bands = {};
    for (const band of STRAT_BANDS) {
      // clean only the noisy df==1 signature tail; keep gene/strain codes.
      let pool = band === "signature" ? perBand[band].filter(c => !looksJunk(c.term))
                                      : perBand[band];
      let picks;
      if (mmr) {
        picks = mmrSelect(pool, STRAT_PER_BAND);
      } else {
        picks = [];
        for (const cand of pool) {
          if (picks.length >= STRAT_PER_BAND) break;
          const words = cand.term.split(" ");
          // within a band, skip a unigram already covered by a chosen phrase.
          if (words.length === 1 &&
              picks.some(t => t.term.split(" ").includes(words[0]))) continue;
          picks.push(cand);
        }
      }
      bands[band] = picks.map(c => ({ term: c.term, df: c.df, score: c.score }));
    }

    // Flat band-ordered term list (general → specific) for combine()/consumers.
    const terms = [];
    for (const band of STRAT_BANDS) for (const t of bands[band]) terms.push(t.term);
    out[c] = { bands, terms, edges };
  }
  return out;
}

// Three paper-df cut points (tops of specific|mid|broad; anchor is everything
// above), log-spaced over [2 .. maxDf]. signature (paper-df==1) is handled
// separately. `df` here is the paper-df map (terms → #papers containing them).
function bandEdges(df) {
  let maxdf = 2;
  for (const v of df.values()) if (v > maxdf) maxdf = v;
  const raw = [Math.pow(maxdf, 1 / 4), Math.pow(maxdf, 2 / 4), Math.pow(maxdf, 3 / 4)];
  const edges = [];
  let prev = 1;
  for (const x of raw) {
    const v = Math.max(Math.round(x), prev + 1, 2);   // strictly increasing, >= 2
    edges.push(v);
    prev = v;
  }
  return edges;
}

function bandOf(dfv, edges) {
  if (dfv === 1) return "signature";
  if (dfv <= edges[0]) return "specific";
  if (dfv <= edges[1]) return "mid";
  if (dfv <= edges[2]) return "broad";
  return "anchor";
}

// Cheap signature-tail cleaner. Conservative on purpose: drops pure numbers and
// foreign function words, but KEEPS code-like tokens (pgr5, ndh, faw) because in
// this domain those are often the real distinguishing gene/strain names.
function looksJunk(term) {
  for (const w of term.split(" ")) {
    if (/^\d+$/.test(w)) return true;            // pure number / year
    if (STRAT_MULTI_STOP.has(w)) return true;    // non-English function word
  }
  return false;
}

// Maximal-marginal-relevance pick from a relevance-sorted candidate pool.
// Diversity penalty = max Jaccard token-overlap with an already-picked phrase.
function mmrSelect(pool, k) {
  if (pool.length === 0) return [];
  const picked = [pool[0]];
  const rest = pool.slice(1);
  const toks = (p) => new Set(p.term.split(" "));
  const overlap = (a, b) => {
    const A = toks(a), B = toks(b);
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const uni = A.size + B.size - inter;
    return uni ? inter / uni : 0;
  };
  while (picked.length < k && rest.length) {
    let bestIdx = 0, bestVal = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      let maxOv = 0;
      for (const p of picked) { const o = overlap(rest[i], p); if (o > maxOv) maxOv = o; }
      const mmr = KEYBERT_MMR_LAMBDA * rest[i].score - (1 - KEYBERT_MMR_LAMBDA) * maxOv;
      if (mmr > bestVal) { bestVal = mmr; bestIdx = i; }
    }
    picked.push(rest.splice(bestIdx, 1)[0]);
  }
  return picked;
}

// Contiguous n-grams (1..maxN) over an already-tokenised, stopword-filtered
// word list. Bigrams are only formed from adjacent surviving tokens, so they
// read as real phrases rather than spanning removed stopwords.
function ngrams(tokens, maxN) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 1; n <= maxN && i + n <= tokens.length; n++) {
      out.push(tokens.slice(i, i + n).join(" "));
    }
  }
  return out;
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function hasText(ctx) {
  if (typeof ctx.getText !== "function" || !Array.isArray(ctx.nodes)) return false;
  // probe a few nodes for any non-empty text
  const probe = Math.min(ctx.nodes.length, 20);
  for (let i = 0; i < probe; i++) {
    const t = ctx.getText(ctx.nodes[i].id);
    if (t && String(t).trim()) return true;
  }
  return false;
}

function reasonFor(id, ctx) {
  if (id === "representative") return "needs an embedding";
  if (id === "year")          return "no node has a year";
  // everything else is a text method (flat or banded TF-IDF / c-TF-IDF / KeyBERT)
  return typeof ctx.getText !== "function"
    ? "needs per-node text — titles/abstracts are not materialised in this dataset"
    : "no member text found";
}

function membersOf(cr) {
  const out = Array.from({ length: cr.clusters.length }, () => []);
  for (let i = 0; i < cr.nodeCluster.length; i++) {
    const c = cr.nodeCluster[i];
    if (c >= 0 && c < out.length) out[c].push(i);
  }
  return out;
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// Pick the most legible single label from whatever methods ran.
function combine(byMethod) {
  // KeyBERT first — diverse keyphrases read as the most informative label.
  if (byMethod.keybert && byMethod.keybert.terms && byMethod.keybert.terms.length) {
    return byMethod.keybert.terms.join(" · ");
  }
  // Any banded method: a compact one-liner spanning the gradient — top anchor
  // (the grouping) + top signature/specific (what's inside).
  for (const id of ["keybertStratified", "cTfidfStratified", "tfidfStratified"]) {
    const m = byMethod[id];
    if (!m || !m.bands) continue;
    const b = m.bands;
    const head = ((b.anchor[0] || b.broad[0]) || {}).term;
    const tail = ((b.signature[0] || b.specific[0] || b.mid[0]) || {}).term;
    const combo = [head, tail].filter(Boolean).join(" · ");
    if (combo) return combo;
    if (m.terms.length) return m.terms.slice(0, 3).join(" · ");
  }
  if (byMethod.cTfidf && byMethod.cTfidf.terms && byMethod.cTfidf.terms.length) {
    return byMethod.cTfidf.terms.join(" · ");
  }
  if (byMethod.tfidf && byMethod.tfidf.terms && byMethod.tfidf.terms.length) {
    return byMethod.tfidf.terms.join(" · ");
  }
  if (byMethod.representative && byMethod.representative.paperId) {
    const yr = byMethod.year && byMethod.year.median ? ` (${byMethod.year.median})` : "";
    return `${byMethod.representative.paperId}${yr}`;
  }
  if (byMethod.year && byMethod.year.median) {
    return `${byMethod.year.min}–${byMethod.year.max}`;
  }
  return "(unlabelled)";
}
