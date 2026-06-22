"""
DB-to-DB merge: replay one biblion database into another.

`biblion merge <src>` reads the source DB and re-emits its papers and citation
edges as cache records, pushing them through the SAME producer->writer pipeline
`biblion import` uses. That reuses all the hard parts — identifier dedup
(doi/s2_id/oa_id), field resolution, the alias/tombstone substrate, and
pending-citation promotion — instead of re-implementing them here.

This module holds the pure, testable halves:
  * row -> PaperRecord / CitationRecord converters (no Redis, no I/O), and
  * copy_sidecar_tables(), the post-drain SQL pass for the data a PaperRecord
    can't carry (is_seed/is_rejected flags, paper_tags, citation_counts), keyed
    by identifier off the papers the writer just deduped.

`__main__.cmd_merge` orchestrates: backup, push, drain, then the sidecar copy.
"""
from pathlib import Path
from typing import Iterator, Optional
import sqlite3

from ..cache.records import PaperRecord, CitationRecord


# Papers columns we read and how they map onto PaperRecord. Most pass straight
# through; `authors`/`editors` (TEXT JSON columns) map onto the *_json fields.
# is_stub is deliberately NOT carried: the writer re-derives it (_insert_new:
# stub iff no title/abstract/year), so a source stub stays a stub and an
# enriched source paper does not.
_PAPER_COLUMNS = (
    'id', 'doi', 's2_id', 'oa_id',
    'title', 'year', 'venue', 'authors', 'abstract', 'pub_type',
    'publication_date', 'is_open_access', 'influential_cit_count',
    's2_fields_of_study', 'pubmed_id', 'pubmed_central_id', 'citekey',
    'editors', 'volume', 'issue', 'first_page', 'last_page', 'publisher',
    'booktitle', 'series', 'edition', 'language', 'month', 'editorial_status',
)


def paper_record_from_row(row: sqlite3.Row, source: str,
                          extra_ids: Optional[dict] = None) -> PaperRecord:
    """Map a source `papers` row to a PaperRecord tagged with `source`.

    `extra_ids` is the {scheme: [values]} dict gathered from the source
    `identifiers` table for this paper; routed to the identifiers table by the
    writer via PaperRecord.extra_identifiers.
    """
    is_oa = row['is_open_access']
    return PaperRecord(
        source=source,
        doi=row['doi'], s2_id=row['s2_id'], oa_id=row['oa_id'],
        title=row['title'], year=row['year'], venue=row['venue'],
        authors_json=row['authors'], abstract=row['abstract'],
        pub_type=row['pub_type'], publication_date=row['publication_date'],
        is_open_access=(bool(is_oa) if is_oa is not None else None),
        influential_cit_count=row['influential_cit_count'],
        s2_fields_of_study=row['s2_fields_of_study'],
        pubmed_id=row['pubmed_id'], pubmed_central_id=row['pubmed_central_id'],
        citekey=row['citekey'],
        editors_json=row['editors'], volume=row['volume'], issue=row['issue'],
        first_page=row['first_page'], last_page=row['last_page'],
        publisher=row['publisher'], booktitle=row['booktitle'],
        series=row['series'], edition=row['edition'], language=row['language'],
        month=row['month'], editorial_status=row['editorial_status'],
        extra_identifiers=(extra_ids or {}),
    )


def _load_extra_identifiers(conn: sqlite3.Connection) -> dict:
    """Preload the source `identifiers` table into {paper_id: {scheme: [vals]}}.

    One pass instead of an N+1 per-paper query; biblion DBs being merged are
    modest enough to hold this in RAM.
    """
    out: dict[int, dict] = {}
    for r in conn.execute(
            "SELECT paper_id, scheme, value FROM identifiers"):
        out.setdefault(r['paper_id'], {}).setdefault(r['scheme'], []).append(
            r['value'])
    return out


def iter_paper_records(conn: sqlite3.Connection, source: str,
                       batch: int = 500) -> Iterator[list[PaperRecord]]:
    """Yield batches of PaperRecords for every live (non-tombstoned) source
    paper. Tombstoned losers are skipped — their winner already carries the
    resolved values, and their identifiers were NULLed at merge time."""
    extra = _load_extra_identifiers(conn)
    cols = ', '.join(_PAPER_COLUMNS)
    cur = conn.execute(
        f"SELECT {cols} FROM papers WHERE tombstone = 0 ORDER BY id")
    out: list[PaperRecord] = []
    for row in cur:
        out.append(paper_record_from_row(row, source, extra.get(row['id'])))
        if len(out) >= batch:
            yield out
            out = []
    if out:
        yield out


def iter_citation_records(conn: sqlite3.Connection, source: str,
                          batch: int = 500) -> Iterator[list[CitationRecord]]:
    """Yield batches of CitationRecords for the source citation graph.

    Drives off `citations_canonical` (resolves source-side aliases one level)
    joined to papers twice for each endpoint's identifiers, then replays
    `pending_citations` rows (which already carry both endpoints' identifiers)
    so edges still pending in the source get another chance to resolve in the
    combined DB. Endpoints with no identifier are dropped by the cache client.
    """
    out: list[CitationRecord] = []

    cur = conn.execute("""
        SELECT cc.provenance AS provenance,
               pc.doi AS citing_doi, pc.s2_id AS citing_s2_id,
               pc.oa_id AS citing_oa_id,
               pd.doi AS cited_doi, pd.s2_id AS cited_s2_id,
               pd.oa_id AS cited_oa_id
        FROM citations_canonical cc
        JOIN papers pc ON pc.id = cc.citing_id
        JOIN papers pd ON pd.id = cc.cited_id
    """)
    for r in cur:
        out.append(CitationRecord(
            source=source, citing_doi=r['citing_doi'],
            citing_s2_id=r['citing_s2_id'], citing_oa_id=r['citing_oa_id'],
            cited_doi=r['cited_doi'], cited_s2_id=r['cited_s2_id'],
            cited_oa_id=r['cited_oa_id']))
        if len(out) >= batch:
            yield out
            out = []

    for r in conn.execute("""
        SELECT provenance, citing_doi, citing_s2_id, citing_oa_id,
               cited_doi, cited_s2_id, cited_oa_id
        FROM pending_citations
    """):
        out.append(CitationRecord(
            source=source, citing_doi=r['citing_doi'],
            citing_s2_id=r['citing_s2_id'], citing_oa_id=r['citing_oa_id'],
            cited_doi=r['cited_doi'], cited_s2_id=r['cited_s2_id'],
            cited_oa_id=r['cited_oa_id']))
        if len(out) >= batch:
            yield out
            out = []

    if out:
        yield out


def copy_sidecar_tables(conn: sqlite3.Connection, src_db_path: Path) -> dict:
    """Post-drain pass: copy the data a PaperRecord can't carry, keyed by the
    identifiers the writer just deduped on.

    `conn` is a writable connection to the TARGET DB. The source is ATTACHed
    as `src` (read-only in practice — we only SELECT from it). A temp `idmap`
    matches each live source paper to its
    (now-deduped) target paper by doi, else s2_id, else oa_id. All writes are
    INSERT OR IGNORE / guarded UPDATE, so re-running is a no-op.

    Returns per-target row counts for the summary.
    """
    counts: dict[str, int] = {}
    conn.execute("ATTACH DATABASE ? AS src", (str(src_db_path),))
    try:
        conn.execute("DROP TABLE IF EXISTS temp.idmap")
        # Match by doi, then s2_id, then oa_id. Tombstoned target losers have
        # NULL identifiers (NULLed at merge time), so they never match here.
        conn.execute("""
            CREATE TEMP TABLE idmap AS
            SELECT sp.id AS src_id,
                   COALESCE(tdoi.id, ts2.id, toa.id) AS tgt_id,
                   sp.is_seed     AS src_is_seed,
                   sp.is_rejected AS src_is_rejected
            FROM src.papers sp
            LEFT JOIN papers tdoi ON sp.doi   IS NOT NULL AND tdoi.doi   = sp.doi
            LEFT JOIN papers ts2  ON sp.s2_id IS NOT NULL AND ts2.s2_id  = sp.s2_id
            LEFT JOIN papers toa  ON sp.oa_id IS NOT NULL AND toa.oa_id  = sp.oa_id
            WHERE sp.tombstone = 0
        """)
        conn.execute("DELETE FROM idmap WHERE tgt_id IS NULL")
        conn.execute(
            "CREATE INDEX temp.idmap_src ON idmap(src_id)")

        counts['matched'] = conn.execute(
            "SELECT COUNT(*) FROM idmap").fetchone()[0]

        counts['is_seed'] = conn.execute("""
            UPDATE papers SET is_seed = 1
            WHERE is_seed = 0
              AND id IN (SELECT tgt_id FROM idmap WHERE src_is_seed = 1)
        """).rowcount

        counts['is_rejected'] = conn.execute("""
            UPDATE papers SET is_rejected = 1
            WHERE is_rejected = 0
              AND id IN (SELECT tgt_id FROM idmap WHERE src_is_rejected = 1)
        """).rowcount

        counts['paper_tags'] = conn.execute("""
            INSERT OR IGNORE INTO paper_tags
                (paper_id, tag, added_at, added_by, category)
            SELECT m.tgt_id, t.tag, t.added_at, t.added_by, t.category
            FROM src.paper_tags t JOIN idmap m ON m.src_id = t.paper_id
        """).rowcount

        counts['citation_counts'] = conn.execute("""
            INSERT OR IGNORE INTO citation_counts
                (paper_id, source, cit_count, ref_count, fetched_at)
            SELECT m.tgt_id, c.source, c.cit_count, c.ref_count, c.fetched_at
            FROM src.citation_counts c JOIN idmap m ON m.src_id = c.paper_id
        """).rowcount

        conn.execute("DROP TABLE IF EXISTS temp.idmap")
        conn.commit()
    finally:
        conn.execute("DETACH DATABASE src")
    return counts
