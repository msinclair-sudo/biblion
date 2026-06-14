// RIS bibliographic export — pure formatter (no DOM, no deps).
//
// Turns the per-node records from datasource/sqlite.js (getNodeRecord) into a
// RIS file: one tagged record per paper, suitable for import into Zotero /
// EndNote / Mendeley. RIS is line-oriented `TAG  - value`; every record ends
// with `ER  -`. We emit a full record: type, authors, title, year, journal,
// DOI, abstract.
//
//   record = { paperId, title, year, venue, doi, pubType, abstract, authors:[] }
//
// Reference: RIS tags — TY (type), AU (author, repeatable), TI (title),
// PY (year), JO (journal/venue), DO (doi), AB (abstract), ER (end).

// biblion pub_type is canonicalized (lowercase, no punctuation). Map the
// common ones to RIS type codes; anything unknown falls back to GEN (generic).
const TY_BY_PUBTYPE = {
  journalarticle: "JOUR",
  article:        "JOUR",
  preprint:       "JOUR",   // RIS has no dedicated preprint; JOUR is the usual choice
  conferencepaper:"CONF",
  proceedings:    "CONF",
  book:           "BOOK",
  bookchapter:    "CHAP",
  chapter:        "CHAP",
  review:         "JOUR",
  dataset:        "DATA",
  report:         "RPRT",
  thesis:         "THES",
  dissertation:   "THES",
  patent:         "PAT",
};

export function risTypeFor(pubType) {
  if (!pubType) return "GEN";
  return TY_BY_PUBTYPE[String(pubType).toLowerCase()] || "GEN";
}

// One `TAG  - value` line. RIS uses exactly two spaces, a hyphen, a space.
// Values are single-line — collapse any embedded newlines so the record
// structure stays intact (abstracts often contain hard breaks).
function line(tag, value) {
  const v = String(value).replace(/\s*\r?\n\s*/g, " ").trim();
  return `${tag}  - ${v}`;
}

/**
 * Format one node record as a RIS entry (array of lines, no trailing blank).
 * Skips empty fields. `note` (optional) is emitted as an N1 line — used to
 * carry export provenance (cluster / score / level) when the caller wants it.
 *
 * @param {object} rec   getNodeRecord() shape.
 * @param {string} [note]
 * @returns {string}     the record's RIS text (TY … ER).
 */
export function formatRisRecord(rec, note) {
  if (!rec) return "";
  const lines = [];
  lines.push(line("TY", risTypeFor(rec.pubType)));
  for (const a of rec.authors || []) {
    if (a && String(a).trim()) lines.push(line("AU", a));
  }
  if (rec.title)    lines.push(line("TI", rec.title));
  if (Number.isFinite(rec.year)) lines.push(line("PY", rec.year));
  if (rec.venue)    lines.push(line("JO", rec.venue));
  if (rec.doi)      lines.push(line("DO", rec.doi));
  if (rec.abstract) lines.push(line("AB", rec.abstract));
  if (note)         lines.push(line("N1", note));
  lines.push("ER  - ");
  return lines.join("\n");
}

/**
 * Join many records into a single .ris string. `notes` (optional) is a
 * parallel array of per-record provenance notes (notes[i] for records[i]).
 * Records that are null/undefined are skipped.
 *
 * @param {object[]} records
 * @param {string[]} [notes]
 * @returns {string}
 */
export function formatRis(records, notes) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    out.push(formatRisRecord(r, notes && notes[i]));
  }
  // Trailing newline — many importers expect the file to end with one.
  return out.length ? out.join("\n\n") + "\n" : "";
}
