"""
import_bib — ingest papers from a BibTeX / BibLaTeX (.bib) reference file.

A .bib file is the citation format produced by Zotero (BibLaTeX export),
JabRef, and used directly by pandoc (`[@citekey]`). Each entry looks like:

    @article{smith2024thing,
      author      = {Smith, Jane and Doe, Alan},
      title       = {On a Thing},
      journaltitle = {Journal of Things},
      date        = {2024},
      doi         = {10.1234/abcd},
    }

This module is the .bib sibling of import_ris: it reads .bib fields
*natively* (no conversion to RIS) and emits the same PaperRecord objects,
which flow through the identical backend — Redis cache, merge writer,
resolver, dedup, field_observations. The only thing new is the pandoc
citation key (`smith2024thing` above), captured onto PaperRecord.citekey
and persisted to papers.citekey.

DOI handling, OpenAlex title-fallback, and is_seed flagging are reused
verbatim from import_ris.

Two persistence promises beyond the mapped columns:
  - The full entry is JSON-serialised into PaperRecord.raw (forensics).
  - After the cache drains, EVERY bib field (including ones with no papers
    column — publisher, editor, booktitle, isbn, ...) is written as its own
    named row in field_observations via record_bib_fields(), so nothing the
    .bib carried is dropped.
"""
from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

from ..cache.records import PaperRecord
from ..clients.openalex import OpenAlexClient
from ..framework.module import Module, ModuleResult, ValidationResult
# Reused directly — see TODO.md: no premature _import_common.py.
from .import_ris import _normalize_doi, mark_seeds, resolve_via_title


# ---------------------------------------------------------------------------
# BibTeX parser
# ---------------------------------------------------------------------------

# Entry header: `@type{citekey,`. Whitespace tolerant. The citekey runs up to
# the first comma; entry-type is lowercased downstream.
_ENTRY_START = re.compile(r'@(\w+)\s*\{\s*', re.IGNORECASE)

# @string / @preamble / @comment carry no paper records — skip them.
_NON_ENTRY_TYPES = {'string', 'preamble', 'comment'}

# entry_type → biblion canonical pub_type. Anything unmapped passes through
# lowercased (mirrors import_ris._TY_MAP behaviour).
_TYPE_MAP = {
    'article':       'article',
    'inproceedings': 'conference',
    'conference':    'conference',
    'proceedings':   'conference',
    'incollection':  'book-chapter',
    'inbook':        'book-chapter',
    'book':          'book',
    'phdthesis':     'thesis',
    'mastersthesis': 'thesis',
    'thesis':        'thesis',
    'techreport':    'report',
    'report':        'report',
    'misc':          'other',
    'unpublished':   'other',
}


@dataclass
class BibEntry:
    """One parsed @entry: its type, pandoc citekey, and verbatim fields."""
    entry_type: str
    citekey:    str
    fields:     dict[str, str] = field(default_factory=dict)

    def get(self, *names: str) -> Optional[str]:
        """First non-empty field value among the given (lowercased) names."""
        for n in names:
            v = self.fields.get(n)
            if v:
                return v
        return None


# Common LaTeX accent commands → unicode. Pragmatic, not exhaustive — Zotero
# output is mostly clean; this covers the frequent ones so display names read
# correctly. Applied after brace stripping.
_ACCENTS = {
    r"\'a": 'á', r"\'e": 'é', r"\'i": 'í', r"\'o": 'ó', r"\'u": 'ú',
    r"\'A": 'Á', r"\'E": 'É', r"\'I": 'Í', r"\'O": 'Ó', r"\'U": 'Ú',
    r"\'n": 'ń', r"\'c": 'ć', r"\'y": 'ý',
    r'\"a': 'ä', r'\"e': 'ë', r'\"i': 'ï', r'\"o': 'ö', r'\"u': 'ü',
    r'\"A': 'Ä', r'\"O': 'Ö', r'\"U': 'Ü',
    r'\`a': 'à', r'\`e': 'è', r'\`i': 'ì', r'\`o': 'ò', r'\`u': 'ù',
    r'\^a': 'â', r'\^e': 'ê', r'\^i': 'î', r'\^o': 'ô', r'\^u': 'û',
    r'\~n': 'ñ', r'\~a': 'ã', r'\~o': 'õ',
    r'\c c': 'ç', r'\c{c}': 'ç', r'\cc': 'ç',
    r'\ss': 'ß', r'\o': 'ø', r'\O': 'Ø', r'\ae': 'æ', r'\AE': 'Æ',
    r'\&': '&', r'\%': '%', r'\_': '_', r'\$': '$', r'\#': '#',
}


def _clean_value(s: str) -> str:
    """Normalise a raw bib field value: collapse accent commands, strip the
    {grouping} braces LaTeX uses for case/accents, fix en/em dashes, and
    squeeze whitespace. Leaves the textual content otherwise intact."""
    if not s:
        return ''
    # Accent forms appear both as `{\'{e}}` and `\'e`; collapse the
    # inner-brace variant (`\'{e}` -> `\'e`) first so the table below matches.
    s = re.sub(r"\\(['\"`^~])\{(\w)\}", r"\\\1\2", s)
    for tex, uni in _ACCENTS.items():
        s = s.replace(tex, uni)
    # Drop remaining grouping braces (case-protection like {DNA}); they carry
    # no value once we're storing plain text.
    s = s.replace('{', '').replace('}', '')
    s = s.replace('--', '–').replace('---', '—')
    return re.sub(r'\s+', ' ', s).strip()


def _read_field_value(text: str, i: int) -> tuple[str, int]:
    """Read a field value starting at index i (first non-space char after '=').

    Handles the three BibTeX value forms:
      - {...}  brace-delimited, nested braces balanced
      - "..."  quote-delimited (braces inside still balanced)
      - bare   number or @string macro name, up to ',' or '}'

    Returns (raw_value, index_just_past_value).
    """
    n = len(text)
    while i < n and text[i].isspace():
        i += 1
    if i >= n:
        return '', i

    ch = text[i]
    if ch == '{':
        depth, j = 0, i
        while j < n:
            if text[j] == '{':
                depth += 1
            elif text[j] == '}':
                depth -= 1
                if depth == 0:
                    return text[i + 1:j], j + 1
            j += 1
        return text[i + 1:], n          # unbalanced; take the rest
    if ch == '"':
        depth, j = 0, i + 1
        while j < n:
            if text[j] == '{':
                depth += 1
            elif text[j] == '}':
                depth -= 1
            elif text[j] == '"' and depth == 0:
                return text[i + 1:j], j + 1
            j += 1
        return text[i + 1:], n
    # Bare value: number or macro name.
    j = i
    while j < n and text[j] not in ',}':
        j += 1
    return text[i:j].strip(), j


def parse_bib(text: str) -> Iterator[BibEntry]:
    """Parse a .bib file. Yields one BibEntry per @entry (skipping
    @string/@preamble/@comment). First-write-wins per field name."""
    n = len(text)
    pos = 0
    while True:
        m = _ENTRY_START.search(text, pos)
        if not m:
            return
        entry_type = m.group(1).lower()
        i = m.end()

        if entry_type in _NON_ENTRY_TYPES:
            # Skip the whole {...} body so a @string's `=` isn't misread as a
            # field of the next entry.
            _, pos = _read_brace_block(text, m.end() - 1)
            continue

        # citekey: from here to the first comma (or closing brace for a
        # field-less entry).
        j = i
        while j < n and text[j] not in ',}':
            j += 1
        citekey = text[i:j].strip()
        entry = BibEntry(entry_type=entry_type, citekey=citekey)

        # Parse `field = value` pairs until the entry's closing brace.
        k = j
        depth = 1                       # we're inside the entry's opening '{'
        while k < n and depth >= 1:
            c = text[k]
            if c == '}':
                depth -= 1
                k += 1
                if depth == 0:
                    break
                continue
            if c == '{':
                depth += 1
                k += 1
                continue
            if c == ',' or c.isspace():
                k += 1
                continue
            # Field name up to '='.
            fstart = k
            while k < n and text[k] not in '=,}':
                k += 1
            fname = text[fstart:k].strip().lower()
            if k < n and text[k] == '=':
                raw, k = _read_field_value(text, k + 1)
                if fname and fname not in entry.fields:
                    entry.fields[fname] = _clean_value(raw)
            else:
                # No '=' — stray token; skip it.
                k += 1

        pos = k
        yield entry


def _read_brace_block(text: str, i: int) -> tuple[str, int]:
    """From the '{' at index i, return (inner, index_past_close)."""
    n = len(text)
    while i < n and text[i] != '{':
        i += 1
    depth, j = 0, i
    while j < n:
        if text[j] == '{':
            depth += 1
        elif text[j] == '}':
            depth -= 1
            if depth == 0:
                return text[i + 1:j], j + 1
        j += 1
    return text[i + 1:] if i < n else '', n


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------

def _extract_doi(entry: BibEntry) -> Optional[str]:
    """`doi` is canonical; fall back to anything DOI-shaped in `url`."""
    doi = _normalize_doi(entry.get('doi'))
    if doi:
        return doi
    return _normalize_doi(entry.get('url'))


def _extract_year(entry: BibEntry) -> Optional[int]:
    # BibLaTeX uses `date` (often 'YYYY-MM-DD'); BibTeX uses `year`.
    raw = entry.get('date', 'year')
    if not raw:
        return None
    m = re.search(r'\b(\d{4})\b', raw)
    return int(m.group(1)) if m else None


def _extract_venue(entry: BibEntry) -> Optional[str]:
    # venue is the serial/journal container for articles only. booktitle and
    # series now have their own columns (see _extract_booktitle/_extract_series)
    # so they're no longer collapsed in here — that conflated a chapter's
    # containing book with a journal name.
    return entry.get('journaltitle', 'journal')


def _split_names(raw: Optional[str]) -> Optional[str]:
    """Split a BibTeX `and`-delimited name list, keep `Last, First` form, and
    JSON-encode — the shape authors_json/editors_json expect."""
    if not raw:
        return None
    parts = re.split(r'\s+and\s+', raw)
    names = [p.strip() for p in parts if p.strip()]
    return json.dumps(names) if names else None


def _extract_authors(entry: BibEntry) -> Optional[str]:
    """The chapter/article authors. Unlike before, this no longer falls back to
    `editor` — editors get their own field so an edited volume's editors don't
    masquerade as authors."""
    return _split_names(entry.get('author'))


def _extract_editors(entry: BibEntry) -> Optional[str]:
    return _split_names(entry.get('editor'))


def _extract_pages(entry: BibEntry) -> tuple[Optional[str], Optional[str]]:
    """Decompose `pages` into (first, last). _clean_value already folded '--'
    to an en-dash; accept any dash variant. A single page returns (page, None)."""
    raw = entry.get('pages')
    if not raw:
        return None, None
    parts = re.split(r'\s*[–—-]+\s*', raw.strip(), maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return parts[0].strip(), parts[1].strip()
    return raw.strip(), None


def _extract_identifiers(entry: BibEntry) -> dict:
    """Scheme-keyed secondary identifiers for the identifiers table. ISBN/ISSN
    map straight through; an `eprint` is treated as arXiv only when the entry's
    eprinttype/archiveprefix says so."""
    out: dict[str, list[str]] = {}
    for scheme, fname in (('isbn', 'isbn'), ('issn', 'issn')):
        v = entry.get(fname)
        if v:
            out[scheme] = [v]
    eprint = entry.get('eprint')
    eprint_type = (entry.get('eprinttype', 'archiveprefix') or '').lower()
    if eprint and 'arxiv' in eprint_type:
        out['arxiv'] = [eprint]
    return out


def _extract_pub_type(entry: BibEntry) -> Optional[str]:
    t = (entry.entry_type or '').lower().strip()
    if not t:
        return None
    return _TYPE_MAP.get(t, t)


def bib_entry_to_paper(entry: BibEntry, source: str) -> Optional[PaperRecord]:
    """Build a PaperRecord from a BibEntry. Returns None for entries with no
    usable content. The full entry is preserved in `raw` for forensics."""
    first_page, last_page = _extract_pages(entry)
    return PaperRecord(
        source       = source,
        doi          = _extract_doi(entry),
        title        = entry.get('title'),
        year         = _extract_year(entry),
        venue        = _extract_venue(entry),
        authors_json = _extract_authors(entry),
        abstract     = entry.get('abstract'),
        pub_type     = _extract_pub_type(entry),
        citekey      = entry.citekey or None,
        # Extended bibliographic fields.
        editors_json = _extract_editors(entry),
        volume       = entry.get('volume'),
        issue        = entry.get('number', 'issue'),
        first_page   = first_page,
        last_page    = last_page,
        publisher    = entry.get('publisher'),
        booktitle    = entry.get('booktitle'),
        series       = entry.get('series'),
        edition      = entry.get('edition'),
        language     = entry.get('language', 'langid'),
        month        = entry.get('month'),
        extra_identifiers = _extract_identifiers(entry),
        raw          = json.dumps(
            {'entry_type': entry.entry_type, 'citekey': entry.citekey,
             'fields': entry.fields},
            separators=(',', ':'),
        ),
    )


# ---------------------------------------------------------------------------
# Module
# ---------------------------------------------------------------------------

class ImportBib(Module):
    name        = 'import_bib'
    description = (
        'Ingest a BibTeX / BibLaTeX (.bib) reference file natively. Records '
        'with DOIs are pushed directly; records without identifiers are '
        'resolved via OpenAlex title search. The pandoc citation key is kept '
        'on papers.citekey. Imported papers are flagged is_seed=1 after the '
        'cache drains; every bib field is recorded in field_observations.'
    )

    requires    = set()
    produces    = {'cache:papers'}
    eventually  = {'papers.doi', 'papers.title', 'papers.year',
                   'papers.authors', 'papers.venue', 'papers.is_seed',
                   'papers.citekey'}
    resources   = {'openalex_api'}    # only when title-search fallback fires

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        bib_file = ctx.config.get('bib_file')
        if not bib_file:
            return ValidationResult(
                ok=False, missing=['bib_file'],
                message='Pass a .bib file path via the import subcommand',
            )
        if not Path(bib_file).exists():
            return ValidationResult(
                ok=False, missing=['bib_file'],
                message=f'.bib file not found: {bib_file}',
            )
        return ValidationResult(ok=True)

    def run(self, ctx) -> ModuleResult:
        bib_file   = Path(ctx.config['bib_file'])
        no_resolve = bool(ctx.config.get('no_resolve', False))
        verbose    = bool(ctx.config.get('verbose', False))
        source     = f'bib:{bib_file.name}'

        text = bib_file.read_text(encoding='utf-8', errors='replace')
        entries = list(parse_bib(text))

        stats = {
            'records':         len(entries),
            'pushed_with_doi': 0,
            'resolved_via_oa': 0,
            'skipped_no_id':   0,
            'unresolvable':    0,
            'pushed':          0,
        }

        print(f"  import_bib: file={bib_file.name} records={len(entries)} "
              f"no_resolve={no_resolve}")

        oa_client: Optional[OpenAlexClient] = None
        batch: list[PaperRecord] = []
        pushed_ids: dict[str, list[str]] = {'doi': [], 's2_id': [], 'oa_id': []}
        # (citekey, identifier-key, identifier-value, fields-dict) per pushed
        # entry, so record_bib_fields can re-home every field after the drain.
        pushed_entries: list[dict] = []

        for i, entry in enumerate(entries, 1):
            if ctx.shutdown.requested:
                print("  [shutdown] aborting")
                break

            pr = bib_entry_to_paper(entry, source=source)
            if pr is None:
                stats['skipped_no_id'] += 1
                continue

            if not pr.has_identifier():
                if no_resolve:
                    stats['skipped_no_id'] += 1
                    if verbose:
                        print(f"    [{i}] no identifier, no-resolve set; "
                              f"skipped: {(pr.title or '')[:80]!r}")
                    continue
                if oa_client is None:
                    oa_client = OpenAlexClient()
                hit = resolve_via_title(oa_client, pr.title or '', year=pr.year)
                if hit is None:
                    stats['unresolvable'] += 1
                    if verbose:
                        print(f"    [{i}] no confident OA match for: "
                              f"{(pr.title or '')[:80]!r}")
                    continue
                pr.doi   = _normalize_doi(hit.get('doi')) or pr.doi
                pr.oa_id = hit.get('id') or pr.oa_id
                stats['resolved_via_oa'] += 1
                if verbose:
                    print(f"    [{i}] resolved via OA title search → "
                          f"{pr.doi or pr.oa_id}")
            else:
                stats['pushed_with_doi'] += 1

            for k in ('doi', 's2_id', 'oa_id'):
                v = getattr(pr, k, None)
                if v:
                    pushed_ids[k].append(v)

            ident = pr.identifiers()
            pushed_entries.append({
                'citekey':    pr.citekey,
                'ident':      ident,           # {'doi': ...} etc., for re-homing
                'fields':     entry.fields,
                'entry_type': entry.entry_type,
            })

            batch.append(pr)
            if len(batch) >= 100:
                ctx.cache.push_papers(batch)
                stats['pushed'] += len(batch)
                batch = []

        if batch:
            ctx.cache.push_papers(batch)
            stats['pushed'] += len(batch)

        # CLI wrapper reads these after the cache drains: _seed_ids flags
        # is_seed=1; _bib_entries records the full per-field provenance.
        stats['_seed_ids'] = pushed_ids
        stats['_bib_entries'] = pushed_entries
        stats['_source'] = source
        return ModuleResult(status='success', stats=stats)


# Bib fields already mapped to first-class papers columns / their own resolved
# observations by the merge writer — don't duplicate them as extra rows. The
# long tail (note, keywords, annotation, address, institution, ...) still lands
# in field_observations so nothing the .bib carried is dropped.
_MAPPED_BIB_FIELDS = {
    'doi', 'title', 'abstract', 'author',
    'journaltitle', 'journal', 'booktitle', 'series',
    'date', 'year', 'url',
    # Promoted to first-class columns / the identifiers table.
    'editor', 'volume', 'number', 'issue', 'pages',
    'publisher', 'edition', 'language', 'langid', 'month',
    'isbn', 'issn', 'eprint', 'eprinttype', 'archiveprefix',
}


def record_bib_fields(db_path: Path, entries: list[dict], source: str) -> int:
    """Persist every *unmapped* bib field as its own named field_observations
    row, so nothing the .bib carried is dropped. Each (paper, field) gets one
    row keyed by the bib field name (publisher, editor, isbn, note, ...) with
    value/raw_value = the verbatim bib value.

    Entries are re-homed to papers.id via their identifier (doi/oa_id/s2_id);
    falling back to citekey when the writer landed it but no identifier
    matched. Returns the number of observation rows written."""
    ts = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(str(db_path))
    try:
        written = 0
        for e in entries:
            paper_id = _resolve_paper_id(conn, e)
            if paper_id is None:
                continue
            for fname, fval in e['fields'].items():
                if not fval or fname in _MAPPED_BIB_FIELDS:
                    continue
                conn.execute("""
                    INSERT INTO field_observations
                        (paper_id, field, value, raw_value, source,
                         pub_type_hint, observed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(paper_id, field, source) DO UPDATE SET
                        value = excluded.value,
                        raw_value = excluded.raw_value,
                        observed_at = excluded.observed_at
                """, (paper_id, fname, fval, fval, source, None, ts))
                written += 1
        conn.commit()
        return written
    finally:
        conn.close()


def _resolve_paper_id(conn: sqlite3.Connection, entry: dict) -> Optional[int]:
    """Map a pushed bib entry back to its merged papers.id. Try each
    identifier the entry carried, then the citekey the writer stored."""
    for col, val in entry.get('ident', {}).items():
        row = conn.execute(
            f"SELECT id FROM papers WHERE {col} = ?", (val,)
        ).fetchone()
        if row:
            return row[0]
    ck = entry.get('citekey')
    if ck:
        row = conn.execute(
            "SELECT id FROM papers WHERE citekey = ?", (ck,)
        ).fetchone()
        if row:
            return row[0]
    return None
