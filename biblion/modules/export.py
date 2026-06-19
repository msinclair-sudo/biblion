"""
export — serialise biblion's papers back out to BibTeX (.bib) or RIS (.ris).

The inverse of import_bib / import_ris. Read-only: opens the DB, assembles a
canonical record per paper from the first-class columns + the identifiers table
+ the long-tail field_observations (note/keywords/...), and writes one entry
per paper.

Round-trip fidelity: each entry's key is papers.citekey when present (so a
.bib that came in via import_bib comes back out with the same @key); papers
discovered through enrichment get a synthesized {author}{year}{word} key.

This is a plain function library driven by cmd_export in __main__.py — no
Module/cache/daemon machinery, since export touches neither Redis nor the
writer.
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Optional


# papers columns we read for export (order irrelevant; selected by name).
_PAPER_COLUMNS = (
    'id', 'citekey', 'doi', 'title', 'year', 'venue', 'authors', 'abstract',
    'pub_type', 'publication_date', 'pubmed_id', 'pubmed_central_id',
    'editors', 'volume', 'issue', 'first_page', 'last_page', 'publisher',
    'booktitle', 'series', 'edition', 'language', 'month', 'editorial_status',
)

# biblion pub_type -> BibTeX entry type (inverse of import_bib._TYPE_MAP).
# Keys are the *canonicalized* pub_type the writer stores (lowercase, no
# punctuation), e.g. 'book-chapter' is stored as 'bookchapter'.
_PUBTYPE_TO_BIBTYPE = {
    'article':      'article',
    'conference':   'inproceedings',
    'bookchapter':  'incollection',
    'book':         'book',
    'thesis':       'phdthesis',
    'report':       'techreport',
    'other':        'misc',
}

# biblion pub_type -> RIS reference type (inverse of import_ris._TY_MAP).
_PUBTYPE_TO_RISTYPE = {
    'article':      'JOUR',
    'conference':   'CONF',
    'bookchapter':  'CHAP',
    'book':         'BOOK',
    'thesis':       'THES',
    'report':       'RPRT',
    'other':        'GEN',
}


def _canon_type(pub_type: Optional[str]) -> str:
    """Match the writer's pub_type canonicalization (lowercase, strip
    punctuation) so the inverse maps key correctly regardless of source form."""
    return re.sub(r'[^a-z0-9]', '', (pub_type or '').lower())

# Long-tail field_observations we re-emit (everything else is provenance noise
# / already a column). Keyed by observation field name -> bib field name.
_EAV_BIB_FIELDS = {
    'keywords': 'keywords',
    'note':     'note',
    'annotation': 'annotation',
    'address':  'address',
    'institution': 'institution',
    'school':   'school',
    'organization': 'organization',
    'chapter':  'chapter',
}


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _load_rows(conn: sqlite3.Connection, where: str, params: tuple) -> list:
    cols = ', '.join(_PAPER_COLUMNS)
    sql = f"SELECT {cols} FROM papers WHERE {where} ORDER BY id"
    return conn.execute(sql, params).fetchall()


def _load_aux(conn: sqlite3.Connection, paper_ids: list[int]) -> tuple[dict, dict, dict, dict]:
    """Return ({paper_id: {field: value}} of long-tail observations,
    {paper_id: {scheme: [values]}} of identifiers,
    {paper_id: [tag, ...]} of user tags,
    {tag: category} of tag categories — a tag's category is a label property,
    so this is global, not per-paper) for the given papers."""
    eav: dict[int, dict] = {}
    ids: dict[int, dict] = {}
    tags: dict[int, list] = {}
    tag_cats: dict[str, str] = {}
    if not paper_ids:
        return eav, ids, tags, tag_cats
    for i in range(0, len(paper_ids), 500):
        chunk = paper_ids[i:i + 500]
        ph = ','.join('?' * len(chunk))
        for r in conn.execute(
            f"SELECT paper_id, field, raw_value, value FROM field_observations "
            f"WHERE paper_id IN ({ph})", chunk,
        ):
            if r['field'] not in _EAV_BIB_FIELDS:
                continue
            val = r['raw_value'] if r['raw_value'] is not None else r['value']
            if val:
                # First non-empty wins; observations are latest-per-source.
                eav.setdefault(r['paper_id'], {}).setdefault(r['field'], val)
        for r in conn.execute(
            f"SELECT paper_id, scheme, value FROM identifiers "
            f"WHERE paper_id IN ({ph})", chunk,
        ):
            ids.setdefault(r['paper_id'], {}).setdefault(
                r['scheme'], []).append(r['value'])
        # paper_tags is a recent table; tolerate its absence in an old DB.
        # The category column is newer still — fall back to a category-less
        # query if it's missing so old DBs still export their tags.
        try:
            for r in conn.execute(
                f"SELECT paper_id, tag, category FROM paper_tags "
                f"WHERE paper_id IN ({ph}) ORDER BY tag", chunk,
            ):
                tags.setdefault(r['paper_id'], []).append(r['tag'])
                if r['category']:
                    tag_cats[r['tag']] = r['category']
        except sqlite3.OperationalError:
            try:
                for r in conn.execute(
                    f"SELECT paper_id, tag FROM paper_tags "
                    f"WHERE paper_id IN ({ph}) ORDER BY tag", chunk,
                ):
                    tags.setdefault(r['paper_id'], []).append(r['tag'])
            except sqlite3.OperationalError:
                pass
    return eav, ids, tags, tag_cats


def _pages(row) -> Optional[str]:
    fp, lp = row['first_page'], row['last_page']
    if fp and lp:
        return f"{fp}--{lp}"
    return fp or None


def _names(json_str: Optional[str]) -> Optional[str]:
    """JSON name list -> BibTeX ' and '-joined string."""
    if not json_str:
        return None
    try:
        names = json.loads(json_str)
    except (ValueError, TypeError):
        return None
    names = [str(n).strip() for n in names if str(n).strip()]
    return ' and '.join(names) if names else None


# ---------------------------------------------------------------------------
# Citekey synthesis
# ---------------------------------------------------------------------------

_CITEKEY_SANITIZE = re.compile(r'[^A-Za-z0-9]+')


def _synth_citekey(row, used: set) -> str:
    """Synthesize {surname}{year}{titleword} for papers with no stored key.
    Deduped against `used` with a numeric suffix."""
    surname = 'anon'
    if row['authors']:
        try:
            first = json.loads(row['authors'])[0]
            # "Last, First" -> Last; "First Last" -> Last.
            surname = first.split(',')[0].strip() if ',' in first \
                else first.split()[-1]
        except (ValueError, TypeError, IndexError):
            pass
    surname = _CITEKEY_SANITIZE.sub('', surname).lower() or 'anon'
    year = str(row['year']) if row['year'] else 'nd'
    word = ''
    if row['title']:
        toks = _CITEKEY_SANITIZE.sub(' ', row['title']).split()
        word = toks[0].lower() if toks else ''
    base = f"{surname}{year}{word}" or 'ref'
    key = base
    n = 1
    while key in used:
        n += 1
        key = f"{base}{chr(ord('a') + n - 2)}"   # base, basea? -> use suffix
    used.add(key)
    return key


# ---------------------------------------------------------------------------
# BibTeX emission
# ---------------------------------------------------------------------------

_BIB_ESCAPE = {'&': r'\&', '%': r'\%', '$': r'\$', '#': r'\#', '_': r'\_'}


def _esc(v) -> str:
    s = str(v)
    for ch, rep in _BIB_ESCAPE.items():
        s = s.replace(ch, rep)
    return s


def _kw(tag: str, tag_cats: dict, category_tags: bool) -> str:
    """A tag rendered for a keywords field: 'category:tag' when category_tags is
    on and the tag carries one, else the bare tag. Tags reject ',' and ';' at
    write time, so a 'category:value' prefix round-trips on .bib/.ris re-import."""
    if category_tags:
        cat = tag_cats.get(tag)
        if cat:
            return f"{cat}:{tag}"
    return tag


def paper_to_bibtex(row, eav: dict, ids: dict, key: str, tags: dict | None = None,
                    tag_cats: dict | None = None, category_tags: bool = False) -> str:
    btype = _PUBTYPE_TO_BIBTYPE.get(_canon_type(row['pub_type']), 'misc')
    tags = tags or {}
    tag_cats = tag_cats or {}
    fields: list[tuple[str, str]] = []

    def put(name, value):
        if value:
            fields.append((name, _esc(value)))

    put('title', row['title'])
    put('author', _names(row['authors']))
    put('editor', _names(row['editors']))
    # Container: journaltitle for serials, booktitle for collected works.
    if btype in ('incollection', 'inproceedings'):
        put('booktitle', row['booktitle'] or row['venue'])
    else:
        put('journaltitle', row['venue'])
        put('booktitle', row['booktitle'])
    put('series', row['series'])
    put('volume', row['volume'])
    put('number', row['issue'])
    put('pages', _pages(row))
    put('publisher', row['publisher'])
    put('edition', row['edition'])
    put('date', row['year'])
    put('month', row['month'])
    put('language', row['language'])
    put('doi', row['doi'])
    for scheme, bibname in (('isbn', 'isbn'), ('issn', 'issn')):
        vals = ids.get(row['id'], {}).get(scheme)
        if vals:
            put(bibname, vals[0])
    arxiv = ids.get(row['id'], {}).get('arxiv')
    if arxiv:
        put('eprint', arxiv[0])
        fields.append(('eprinttype', 'arxiv'))
    put('pmid', row['pubmed_id'])
    put('abstract', row['abstract'])
    # Editorial notice travels in `note` so it stays attached to the reference
    # in any reader. Combine with any long-tail note from field_observations.
    note_parts = []
    if row['editorial_status']:
        note_parts.append(str(row['editorial_status']).upper())
    eav_note = eav.get(row['id'], {}).get('note')
    if eav_note:
        note_parts.append(eav_note)
    if note_parts:
        put('note', '; '.join(note_parts))
    # keywords: union of any long-tail keywords observation and user tags
    # (paper_tags). Emitted here so the EAV loop below can skip 'keywords'.
    kw_parts: list[str] = []
    eav_kw = eav.get(row['id'], {}).get('keywords')
    if eav_kw:
        kw_parts += [k.strip() for k in re.split(r'[;,]', eav_kw) if k.strip()]
    for t in tags.get(row['id'], []):
        kw = _kw(t, tag_cats, category_tags)
        if kw not in kw_parts:
            kw_parts.append(kw)
    if kw_parts:
        put('keywords', ', '.join(kw_parts))
    for obs_field, bibname in _EAV_BIB_FIELDS.items():
        if obs_field in ('note', 'keywords'):
            continue                 # handled above
        put(bibname, eav.get(row['id'], {}).get(obs_field))

    body = ',\n'.join(f"  {name:<11} = {{{val}}}" for name, val in fields)
    return f"@{btype}{{{key},\n{body}\n}}\n"


# ---------------------------------------------------------------------------
# RIS emission
# ---------------------------------------------------------------------------

def paper_to_ris(row, eav: dict, ids: dict, tags: dict | None = None,
                 tag_cats: dict | None = None, category_tags: bool = False) -> str:
    ty = _PUBTYPE_TO_RISTYPE.get(_canon_type(row['pub_type']), 'GEN')
    tags = tags or {}
    tag_cats = tag_cats or {}
    lines: list[str] = [f"TY  - {ty}"]

    def put(tag, value):
        if value:
            lines.append(f"{tag}  - {value}")

    put('TI', row['title'])
    for name in (json.loads(row['authors']) if row['authors'] else []):
        put('AU', name)
    for name in (json.loads(row['editors']) if row['editors'] else []):
        put('A2', name)
    put('PY', row['year'])
    # T2 is the container title (journal or book).
    put('T2', row['venue'] or row['booktitle'])
    put('T3', row['series'])
    put('VL', row['volume'])
    put('IS', row['issue'])
    put('SP', row['first_page'])
    put('EP', row['last_page'])
    put('PB', row['publisher'])
    put('ET', row['edition'])
    put('LA', row['language'])
    put('DO', row['doi'])
    for scheme in ('issn', 'isbn'):
        vals = ids.get(row['id'], {}).get(scheme)
        if vals:
            put('SN', vals[0])
    put('AB', row['abstract'])
    kw = eav.get(row['id'], {}).get('keywords')
    kw_seen = set()
    if kw:
        for k in re.split(r'[;,]', kw):
            k = k.strip()
            if k and k not in kw_seen:
                kw_seen.add(k)
                put('KW', k)
    for t in tags.get(row['id'], []):       # user tags as extra KW lines
        kw = _kw(t, tag_cats, category_tags)
        if kw not in kw_seen:
            kw_seen.add(kw)
            put('KW', kw)
    note_parts = []
    if row['editorial_status']:
        note_parts.append(str(row['editorial_status']).upper())
    eav_note = eav.get(row['id'], {}).get('note')
    if eav_note:
        note_parts.append(eav_note)
    put('N1', '; '.join(note_parts))
    lines.append('ER  - ')
    return '\n'.join(lines) + '\n\n'


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

# Editorial statuses treated as "redacted" — works pulled from the record.
# Excluded from exports by default (you don't want a retracted paper in a
# reference list). 'corrected'/'concern' are NOT here: those papers still
# stand and are merely annotated via the `note` field.
_REDACTED_STATUSES = ('retracted', 'withdrawn')


def export(conn: sqlite3.Connection, out_path: Path, fmt: str,
           where: str, params: tuple, include_redacted: bool = False,
           category_tags: bool = False) -> int:
    """Write all papers matching `where` to out_path in `fmt` ('bib'|'ris').
    Redacted (retracted/withdrawn) papers are excluded unless include_redacted
    is True. When category_tags is True, user tags carrying a category are
    emitted as 'category:tag' keywords. Returns the number of entries written."""
    if not include_redacted:
        ph = ','.join('?' * len(_REDACTED_STATUSES))
        where = (f"({where}) AND (editorial_status IS NULL "
                 f"OR editorial_status NOT IN ({ph}))")
        params = tuple(params) + _REDACTED_STATUSES
    rows = _load_rows(conn, where, params)
    paper_ids = [r['id'] for r in rows]
    eav, ids, tags, tag_cats = _load_aux(conn, paper_ids)

    used_keys: set = set()
    # Pre-seed used keys with the stored citekeys so synthesized ones can't
    # collide with them.
    for r in rows:
        if r['citekey']:
            used_keys.add(r['citekey'])

    chunks: list[str] = []
    for r in rows:
        if fmt == 'ris':
            chunks.append(paper_to_ris(r, eav, ids, tags, tag_cats, category_tags))
        else:
            key = r['citekey'] or _synth_citekey(r, used_keys)
            chunks.append(paper_to_bibtex(r, eav, ids, key, tags, tag_cats, category_tags))

    out_path.write_text(''.join(chunks), encoding='utf-8')
    return len(rows)
