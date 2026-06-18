// BibTeX bibliographic export — pure formatter (no DOM, no deps).
//
// Turns the full per-node records from datasource/sqlite.js (getNodeFullRecord)
// into a .bib file: one @entry per paper, suitable for biblatex / Zotero /
// EndNote and round-tripping back through `biblion advanced export`. The field
// shape + entry-type mapping mirror biblion/modules/export.py (paper_to_bibtex)
// so a cart .bib matches what biblion itself emits.
//
//   record = { paperId, citekey, title, year, venue, doi, pubType, abstract,
//              authors:[], editors:[], volume, issue, firstPage, lastPage,
//              publisher, booktitle, series, edition, language, month,
//              editorialStatus, pubmedId, identifiers:{isbn:[],issn:[],arxiv:[]},
//              keywords:[] }   // user tags, emitted as the BibTeX keywords field

// biblion pub_type -> BibTeX entry type. Real snapshots carry OpenAlex / S2 type
// strings (journalarticle, proceedingsarticle, postedcontent, …), not biblion's
// own canonical set, so the table is wider than export.py's; unknown -> misc.
const BIBTYPE_BY_PUBTYPE = {
  article:            "article",
  journalarticle:     "article",
  review:             "article",
  erratum:            "article",
  retraction:         "article",
  editorial:          "article",
  letter:             "article",
  lettersandcomments: "article",
  preprint:           "article",   // biblatex has no preprint; @article is usual
  postedcontent:      "article",
  conference:         "inproceedings",
  conferencepaper:    "inproceedings",
  proceedings:        "inproceedings",
  proceedingsarticle: "inproceedings",
  bookchapter:        "incollection",
  chapter:            "incollection",
  referenceentry:     "incollection",
  book:               "book",
  thesis:             "phdthesis",
  dissertation:       "phdthesis",
  report:             "techreport",
  dataset:            "misc",
};

// Match biblion's pub_type canonicalization (lowercase, strip non-alphanumerics)
// so the inverse map keys regardless of source punctuation/casing.
function canonType(pubType) {
  return String(pubType || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function bibtexTypeFor(pubType) {
  return BIBTYPE_BY_PUBTYPE[canonType(pubType)] || "misc";
}

// BibTeX special characters that must be backslash-escaped inside {field}.
const ESCAPE = { "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_" };

export function escapeBibtex(value) {
  return String(value).replace(/[&%$#_]/g, (ch) => ESCAPE[ch]);
}

// Field values are single-line: collapse embedded newlines (abstracts carry
// hard breaks) then escape.
function clean(value) {
  return escapeBibtex(String(value).replace(/\s*\r?\n\s*/g, " ").trim());
}

function pagesOf(rec) {
  if (rec.firstPage && rec.lastPage) return `${rec.firstPage}--${rec.lastPage}`;
  return rec.firstPage || null;
}

// Name list -> BibTeX ' and '-joined string (null when empty).
function namesOf(list) {
  if (!Array.isArray(list)) return null;
  const ns = list.map((n) => String(n).trim()).filter(Boolean);
  return ns.length ? ns.join(" and ") : null;
}

const KEY_SANITIZE = /[^A-Za-z0-9]+/g;

// Append a/b/c… to `base` until it is unused — mirrors biblion's suffix scheme.
function dedupeKey(base, used) {
  let key = base;
  let n = 1;
  while (used.has(key)) {
    n += 1;
    key = `${base}${String.fromCharCode(97 + n - 2)}`;   // base, basea, baseb…
  }
  used.add(key);
  return key;
}

// Synthesize {surname}{year}{titleword} for a paper with no stored citekey,
// deduped against `used`. Mirrors biblion export._synth_citekey.
export function synthCitekey(rec, used) {
  let surname = "anon";
  const first = (rec.authors && rec.authors[0]) || "";
  if (first) {
    surname = first.includes(",")
      ? first.split(",")[0].trim()
      : first.trim().split(/\s+/).pop();
  }
  surname = String(surname).replace(KEY_SANITIZE, "").toLowerCase() || "anon";
  const year = Number.isFinite(rec.year) ? String(rec.year) : "nd";
  let word = "";
  if (rec.title) {
    const toks = rec.title.replace(KEY_SANITIZE, " ").split(/\s+/).filter(Boolean);
    word = toks.length ? toks[0].toLowerCase() : "";
  }
  return dedupeKey(`${surname}${year}${word}` || "ref", used);
}

/**
 * Format one record as a BibTeX entry. `note` (optional) is merged into the
 * entry's `note` field (used to carry the cart's `source` provenance).
 *
 * @param {object} rec   getNodeFullRecord() shape.
 * @param {string} key   the (already unique) citation key.
 * @param {string} [note]
 * @returns {string}     the `@type{key, …}` entry, trailing newline included.
 */
export function formatBibtexRecord(rec, key, note) {
  if (!rec) return "";
  const btype = bibtexTypeFor(rec.pubType);
  const fields = [];
  const put = (name, value) => { if (value) fields.push([name, clean(value)]); };

  put("title", rec.title);
  put("author", namesOf(rec.authors));
  put("editor", namesOf(rec.editors));
  // Container: booktitle for collected works, journaltitle for serials.
  if (btype === "incollection" || btype === "inproceedings") {
    put("booktitle", rec.booktitle || rec.venue);
  } else {
    put("journaltitle", rec.venue);
    put("booktitle", rec.booktitle);
  }
  put("series", rec.series);
  put("volume", rec.volume);
  put("number", rec.issue);
  put("pages", pagesOf(rec));
  put("publisher", rec.publisher);
  put("edition", rec.edition);
  put("date", Number.isFinite(rec.year) ? rec.year : null);
  put("month", rec.month);
  put("language", rec.language);
  put("doi", rec.doi);
  const ids = rec.identifiers || {};
  if (ids.isbn && ids.isbn[0]) put("isbn", ids.isbn[0]);
  if (ids.issn && ids.issn[0]) put("issn", ids.issn[0]);
  if (ids.arxiv && ids.arxiv[0]) {
    put("eprint", ids.arxiv[0]);
    put("eprinttype", "arxiv");
  }
  put("pmid", rec.pubmedId);
  // User tags as the native BibTeX keywords field (comma-joined); round-trips
  // through biblion import_bib (which parses keywords) and biblion export.
  if (Array.isArray(rec.keywords) && rec.keywords.length) {
    put("keywords", rec.keywords.map((k) => String(k).trim()).filter(Boolean).join(", "));
  }
  put("abstract", rec.abstract);
  // Editorial notice + provenance ride in `note` so they stay attached in any
  // reader (mirrors export.py, which folds editorial_status into note).
  const noteParts = [];
  if (rec.editorialStatus) noteParts.push(String(rec.editorialStatus).toUpperCase());
  if (note) noteParts.push(note);
  if (noteParts.length) put("note", noteParts.join("; "));

  const body = fields.map(([name, val]) => `  ${name.padEnd(11)} = {${val}}`).join(",\n");
  return `@${btype}{${key},\n${body}\n}\n`;
}

/**
 * Join many records into one .bib string. Keys come from each record's stored
 * citekey when present (deduped within the file), else a synthesized key.
 * `notes` (optional) is a parallel array of per-record provenance notes.
 * Null/undefined records are skipped.
 *
 * @param {object[]} records
 * @param {string[]} [notes]
 * @returns {string}
 */
export function formatBibtex(records, notes) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const stored = rec.citekey && String(rec.citekey).trim();
    const key = stored ? dedupeKey(stored, used) : synthCitekey(rec, used);
    out.push(formatBibtexRecord(rec, key, notes && notes[i]));
  }
  // Blank line between entries; trailing newline already on the last entry.
  return out.length ? out.join("\n") : "";
}
