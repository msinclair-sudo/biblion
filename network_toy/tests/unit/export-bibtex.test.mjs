// Node-native unit tests for app/src/export/bibtex.js (BibTeX formatter).
//
// The module is dependency-free pure functions (the live DB read lives in
// datasource/sqlite.js getNodeFullRecord), so it runs under `node --test`.
//
//   node --test tests/unit/export-bibtex.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as bib from "../../app/src/export/bibtex.js";

const REC = {
  paperId: 1,
  citekey: null,
  title: "Soil microbial communities & you",
  year: 2021,
  venue: "Soil Biology",
  doi: "10.1/abc",
  pubType: "journalarticle",
  abstract: "We study\nsoil microbes.",
  authors: ["Smith, Jane", "Doe, A."],
  editors: [],
  volume: "12",
  issue: "3",
  firstPage: "100",
  lastPage: "120",
  publisher: "Springer",
  booktitle: null,
  series: null,
  edition: null,
  language: null,
  month: null,
  editorialStatus: null,
  pubmedId: null,
  identifiers: { issn: ["1234-5678"], arxiv: ["2101.00001"] },
};

test("bibtexTypeFor maps real pub_type strings; unknown -> misc", () => {
  assert.equal(bib.bibtexTypeFor("journalarticle"), "article");
  assert.equal(bib.bibtexTypeFor("article"), "article");
  assert.equal(bib.bibtexTypeFor("proceedingsarticle"), "inproceedings");
  assert.equal(bib.bibtexTypeFor("book-chapter"), "incollection");   // punctuation canonicalized
  assert.equal(bib.bibtexTypeFor("dissertation"), "phdthesis");
  assert.equal(bib.bibtexTypeFor("weirdtype"), "misc");
  assert.equal(bib.bibtexTypeFor(null), "misc");
});

test("keywords field carries tags (and is omitted when none)", () => {
  const withKw = bib.formatBibtexRecord({ ...REC, keywords: ["methods", "to-read"] }, "k");
  assert.ok(withKw.includes("keywords    = {methods, to-read}"));
  const noKw = bib.formatBibtexRecord({ ...REC, keywords: [] }, "k");
  assert.ok(!noKw.includes("keywords"));
  const undef = bib.formatBibtexRecord(REC, "k");   // REC has no keywords key
  assert.ok(!undef.includes("keywords"));
});

test("formatBibtexRecord emits a valid @article entry with biblatex fields", () => {
  const out = bib.formatBibtexRecord(REC, "smith2021soil");
  assert.ok(out.startsWith("@article{smith2021soil,\n"));
  assert.ok(out.trimEnd().endsWith("}"));
  assert.ok(out.includes("author      = {Smith, Jane and Doe, A.}"));   // " and "-joined
  assert.ok(out.includes("journaltitle = {Soil Biology}"));
  assert.ok(out.includes("date        = {2021}"));
  assert.ok(out.includes("number      = {3}"));
  assert.ok(out.includes("pages       = {100--120}"));                  // en-dash range
  assert.ok(out.includes("doi         = {10.1/abc}"));
  assert.ok(out.includes("issn        = {1234-5678}"));
  assert.ok(out.includes("eprint      = {2101.00001}"));
  assert.ok(out.includes("eprinttype  = {arxiv}"));
  assert.ok(out.includes("title       = {Soil microbial communities \\& you}"));  // & escaped
  assert.ok(!/abstract    = \{We study\n/.test(out));                   // newline collapsed
});

test("incollection/inproceedings use booktitle, not journaltitle", () => {
  const chap = bib.formatBibtexRecord(
    { ...REC, pubType: "bookchapter", booktitle: "Handbook of Soil" }, "k");
  assert.ok(chap.startsWith("@incollection{"));
  assert.ok(chap.includes("booktitle   = {Handbook of Soil}"));
  assert.ok(!chap.includes("journaltitle"));
});

test("note merges editorial status and the provenance note", () => {
  const out = bib.formatBibtexRecord(
    { ...REC, editorialStatus: "retracted" }, "k", "L2·c5");
  assert.ok(out.includes("note        = {RETRACTED; L2·c5}"));
});

test("synthCitekey builds {surname}{year}{word} and dedupes with a/b suffixes", () => {
  const used = new Set();
  assert.equal(bib.synthCitekey(REC, used), "smith2021soil");
  assert.equal(bib.synthCitekey(REC, used), "smith2021soila");   // first dup -> a
  assert.equal(bib.synthCitekey(REC, used), "smith2021soilb");
  assert.equal(bib.synthCitekey({ authors: [], title: null, year: null }, used), "anonnd");
});

test("formatBibtex keeps stored citekeys (deduped) and synthesizes the rest", () => {
  const a = { ...REC, citekey: "MyKey2020" };
  const b = { ...REC, citekey: "MyKey2020" };   // collides with a -> suffixed
  const c = { ...REC, citekey: null };          // synthesized
  const out = bib.formatBibtex([a, b, c], ["src-a", null, "src-c"]);
  assert.ok(out.includes("@article{MyKey2020,\n"));
  assert.ok(out.includes("@article{MyKey2020a,\n"));
  assert.ok(out.includes("@article{smith2021soil,\n"));
  assert.equal((out.match(/^@article\{/gm) || []).length, 3);
  assert.ok(out.includes("note        = {src-a}"));     // provenance carried through
});

test("formatBibtex skips null records and returns '' when empty", () => {
  assert.equal(bib.formatBibtex([null, undefined]), "");
  assert.equal(bib.formatBibtex([]), "");
});
