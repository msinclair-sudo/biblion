"""
import_ris — ingest papers from a RIS (.ris) reference file.

A RIS file is a line-oriented text format used by Zotero, EndNote, Mendeley,
Web of Science, Scopus, and most library catalogues. Each record is a block
of `TAG  - value` lines terminated by `ER  -`. biblion parses these into
PaperRecord objects and pushes them through the cache like any other
producer.

Records with a DOI are pushed directly. Records without any identifier are
resolved against OpenAlex by title (top-3 search, ≥0.85 similarity to
accept). Unresolvable records are skipped with a warning.

After the cache drains, records that arrived through this importer are
flagged with `is_seed = 1` so later hops and queries can pick them out.
"""
from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterator, Optional

from ..cache.records import PaperRecord
from ..clients.openalex import OpenAlexClient
from ..framework.module import Module, ModuleResult, ValidationResult


# ---------------------------------------------------------------------------
# RIS parser
# ---------------------------------------------------------------------------

# A RIS line is exactly `TAG  - value` (two spaces, dash, space). Some
# exports use one-space padding; we accept either by tolerating any
# whitespace between tag and dash.
_LINE_RE = re.compile(r'^([A-Z][A-Z0-9])\s+-\s?(.*)$')

# Reference-type code → biblion's canonical pub_type. Anything not in this
# map is passed through lowercased.
_TY_MAP = {
    'JOUR': 'article',
    'JFULL': 'article',
    'CHAP': 'book-chapter',
    'BOOK': 'book',
    'CONF': 'conference',
    'CPAPER': 'conference',
    'THES': 'thesis',
    'RPRT': 'report',
    'GEN':  'other',
}

# Tags whose first occurrence we keep as a scalar.
_SCALAR_TAGS = {
    'TY', 'TI', 'T1', 'PY', 'Y1', 'T2', 'JF', 'JO', 'J2', 'JA',
    'VL', 'IS', 'SP', 'EP', 'DO', 'PB', 'CY', 'SN', 'M3', 'LA',
    'AB', 'N2', 'ET', 'T3', 'DA',
}

# Tags that may repeat; collected as lists.
_LIST_TAGS = {
    'AU', 'A1', 'A2', 'A3', 'A4', 'AD', 'KW', 'N1', 'UR', 'L1', 'L2',
    'C1', 'C2', 'C3', 'ID',
}


@dataclass
class RisRecord:
    """One RIS record, with scalar fields collapsed and lists preserved."""
    tags:    dict[str, str] = field(default_factory=dict)
    lists:   dict[str, list[str]] = field(default_factory=dict)

    def get(self, *names: str) -> Optional[str]:
        """Return the first non-empty scalar value from the given tag names."""
        for n in names:
            v = self.tags.get(n)
            if v:
                return v
        return None

    def all(self, name: str) -> list[str]:
        return list(self.lists.get(name, []))


def parse_ris(text: str) -> Iterator[RisRecord]:
    """Parse a RIS file. Yields one RisRecord per `TY...ER` block."""
    current = RisRecord()
    in_record = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            continue
        m = _LINE_RE.match(line)
        if not m:
            # Continuation of the previous value (RIS allows wrapped lines).
            continue
        tag, value = m.group(1), m.group(2).strip()

        if tag == 'TY':
            current = RisRecord()
            current.tags['TY'] = value
            in_record = True
            continue
        if tag == 'ER':
            if in_record and (current.tags or current.lists):
                yield current
            current = RisRecord()
            in_record = False
            continue
        if not in_record:
            continue

        if tag in _LIST_TAGS:
            current.lists.setdefault(tag, []).append(value)
        elif tag in _SCALAR_TAGS:
            # First-write-wins among scalars (e.g., prefer T2 over later JF).
            current.tags.setdefault(tag, value)
        else:
            # Unknown tag — keep as scalar for forensics.
            current.tags.setdefault(tag, value)


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------

_DOI_PREFIXES = ('https://doi.org/', 'http://doi.org/', 'doi:', 'DOI:')
_BARE_DOI = re.compile(r'\b(10\.\d{4,9}/[^\s"<>]+)', re.IGNORECASE)


def _normalize_doi(s: Optional[str]) -> Optional[str]:
    """Strip URL/scheme prefixes and lowercase. Returns None if no DOI present."""
    if not s:
        return None
    s = s.strip()
    for p in _DOI_PREFIXES:
        if s.lower().startswith(p.lower()):
            s = s[len(p):]
            break
    m = _BARE_DOI.search(s)
    return m.group(1).lower() if m else None


def _extract_doi(rec: RisRecord) -> Optional[str]:
    """DO is the canonical place. Fall back to anything DOI-shaped in UR."""
    doi = _normalize_doi(rec.get('DO'))
    if doi:
        return doi
    for url in rec.all('UR'):
        d = _normalize_doi(url)
        if d:
            return d
    return None


def _extract_year(rec: RisRecord) -> Optional[int]:
    raw = rec.get('PY', 'Y1')
    if not raw:
        return None
    m = re.search(r'\b(\d{4})\b', raw)
    return int(m.group(1)) if m else None


def _extract_venue(rec: RisRecord) -> Optional[str]:
    # T2 (secondary title) is the journal/container; JF/JO are journal-full
    # and abbreviated, both used in the wild. Fall back through them.
    return rec.get('T2', 'JF', 'JO', 'J2', 'JA')


def _extract_authors(rec: RisRecord) -> Optional[str]:
    names: list[str] = []
    for tag in ('AU', 'A1', 'A2', 'A3', 'A4'):
        for raw in rec.all(tag):
            n = raw.strip()
            if n and n not in names:
                names.append(n)
    return json.dumps(names) if names else None


def _extract_abstract(rec: RisRecord) -> Optional[str]:
    # AB is the formal abstract; N2 is the informal one. Either works.
    return rec.get('AB', 'N2')


def _extract_pub_type(rec: RisRecord) -> Optional[str]:
    ty = (rec.get('TY') or '').upper().strip()
    if not ty:
        return None
    return _TY_MAP.get(ty, ty.lower())


def _extract_editors(rec: RisRecord) -> Optional[str]:
    """RIS A2 is the secondary/editor author tag."""
    names = [n.strip() for n in rec.all('A2') if n.strip()]
    return json.dumps(names) if names else None


def _extract_month(rec: RisRecord) -> Optional[str]:
    """RIS DA is 'YYYY/MM/DD' (parts optional). Pull the month component."""
    da = rec.get('DA')
    if not da:
        return None
    parts = da.split('/')
    if len(parts) >= 2 and parts[1].strip():
        return parts[1].strip()
    return None


def _extract_identifiers(rec: RisRecord, pub_type: Optional[str]) -> dict:
    """RIS overloads SN for both ISSN (serials) and ISBN (books). Route by
    publication type."""
    sn = rec.get('SN')
    if not sn:
        return {}
    scheme = 'isbn' if pub_type in ('book', 'book-chapter') else 'issn'
    return {scheme: [sn]}


def ris_record_to_paper(rec: RisRecord, source: str) -> Optional[PaperRecord]:
    """Build a PaperRecord. Returns None if no identifier could be derived."""
    doi = _extract_doi(rec)
    pub_type = _extract_pub_type(rec)
    pr = PaperRecord(
        source           = source,
        doi              = doi,
        title            = rec.get('TI', 'T1'),
        year             = _extract_year(rec),
        venue            = _extract_venue(rec),
        authors_json     = _extract_authors(rec),
        abstract         = _extract_abstract(rec),
        pub_type         = pub_type,
        editors_json     = _extract_editors(rec),
        volume           = rec.get('VL'),
        issue            = rec.get('IS'),
        first_page       = rec.get('SP'),
        last_page        = rec.get('EP'),
        publisher        = rec.get('PB'),
        series           = rec.get('T3'),
        edition          = rec.get('ET'),
        language         = rec.get('LA'),
        month            = _extract_month(rec),
        extra_identifiers = _extract_identifiers(rec, pub_type),
        raw              = json.dumps({'tags': rec.tags, 'lists': rec.lists},
                                       separators=(',', ':')),
    )
    return pr


# ---------------------------------------------------------------------------
# OpenAlex title-search fallback for records missing identifiers
# ---------------------------------------------------------------------------

_TITLE_MATCH_THRESHOLD = 0.85    # SequenceMatcher ratio to accept


def _normalize_title(s: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace — for comparison only."""
    return re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', ' ', s.lower())).strip()


def resolve_via_title(client: OpenAlexClient, title: str,
                       year: Optional[int] = None) -> Optional[dict]:
    """Search OpenAlex by title; return the top result if it's a confident
    match. Returns None on no result, low confidence, or ambiguity."""
    if not title or len(title) < 10:
        return None
    hits = client.search_by_title(title=title, year=year, top_k=3)
    if not hits:
        return None
    target = _normalize_title(title)
    best, best_score = None, 0.0
    for h in hits:
        ht = _normalize_title(h.get('title') or h.get('display_name') or '')
        if not ht:
            continue
        s = SequenceMatcher(None, target, ht).ratio()
        if s > best_score:
            best, best_score = h, s
    if best is None or best_score < _TITLE_MATCH_THRESHOLD:
        return None
    return best


# ---------------------------------------------------------------------------
# Module
# ---------------------------------------------------------------------------

class ImportRis(Module):
    name        = 'import_ris'
    description = (
        'Ingest a RIS reference file. Records with DOIs are pushed directly; '
        'records without identifiers are resolved via OpenAlex title search. '
        'Imported papers are flagged is_seed=1 after the cache drains.'
    )

    requires    = set()
    produces    = {'cache:papers'}
    eventually  = {'papers.doi', 'papers.title', 'papers.year',
                   'papers.authors', 'papers.venue', 'papers.is_seed'}
    resources   = {'openalex_api'}    # only when title-search fallback fires

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        ris_file = ctx.config.get('ris_file')
        if not ris_file:
            return ValidationResult(
                ok=False, missing=['ris_file'],
                message='Pass a RIS file path via the import subcommand',
            )
        if not Path(ris_file).exists():
            return ValidationResult(
                ok=False, missing=['ris_file'],
                message=f'RIS file not found: {ris_file}',
            )
        return ValidationResult(ok=True)

    def run(self, ctx) -> ModuleResult:
        ris_file   = Path(ctx.config['ris_file'])
        no_resolve = bool(ctx.config.get('no_resolve', False))
        verbose    = bool(ctx.config.get('verbose', False))
        source     = f'ris:{ris_file.name}'

        text = ris_file.read_text(encoding='utf-8', errors='replace')
        records = list(parse_ris(text))

        stats = {
            'records':           len(records),
            'pushed_with_doi':   0,
            'resolved_via_oa':   0,
            'skipped_no_id':     0,
            'unresolvable':      0,
            'pushed':            0,
        }

        print(f"  import_ris: file={ris_file.name} records={len(records)} "
              f"no_resolve={no_resolve}")

        oa_client: Optional[OpenAlexClient] = None
        batch: list[PaperRecord] = []
        # Track every identifier we push so the CLI can mark them is_seed=1
        # after the cache drains.
        pushed_ids: dict[str, list[str]] = {'doi': [], 's2_id': [], 'oa_id': []}

        for i, rec in enumerate(records, 1):
            if ctx.shutdown.requested:
                print("  [shutdown] aborting")
                break

            pr = ris_record_to_paper(rec, source=source)
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
                hit = resolve_via_title(oa_client, pr.title or '',
                                         year=pr.year)
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

            batch.append(pr)
            if len(batch) >= 100:
                ctx.cache.push_papers(batch)
                stats['pushed'] += len(batch)
                batch = []

        if batch:
            ctx.cache.push_papers(batch)
            stats['pushed'] += len(batch)

        # CLI wrapper reads this after the cache drains to flag is_seed=1.
        stats['_seed_ids'] = pushed_ids
        return ModuleResult(status='success', stats=stats)


def mark_seeds(db_path: Path, pushed_ids: dict[str, list[str]]) -> int:
    """Set is_seed=1 on rows matching any of the supplied identifiers.
    Returns the total number of rows updated."""
    conn = sqlite3.connect(str(db_path))
    try:
        touched = 0
        for col, vals in pushed_ids.items():
            if not vals:
                continue
            for i in range(0, len(vals), 500):
                chunk = vals[i:i + 500]
                placeholders = ','.join('?' * len(chunk))
                cur = conn.execute(
                    f"UPDATE papers "
                    f"SET is_seed = 1, updated_at = datetime('now') "
                    f"WHERE {col} IN ({placeholders}) AND is_seed = 0",
                    chunk,
                )
                touched += cur.rowcount
        conn.commit()
        return touched
    finally:
        conn.close()
