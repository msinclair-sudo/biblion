"""
Unit tests for the DB-to-DB merge converters and sidecar copy
(biblion/merge/combine.py). No Redis: these exercise the pure row->record
mapping and the post-drain SQL pass directly against temp SQLite DBs.
"""
from pathlib import Path

import pytest

from biblion.db import get_connection, init_db
from biblion.merge.combine import (
    paper_record_from_row, iter_paper_records, iter_citation_records,
    copy_sidecar_tables,
)
from biblion.merge.writer import MergeWriter
from tests.conftest import needs_redis

pytestmark = pytest.mark.unit


def _fresh_db(path: Path):
    conn = get_connection(path)
    init_db(conn)
    conn.commit()
    return conn


def _insert_paper(conn, **cols):
    cols.setdefault('created_at', '2026-01-01T00:00:00+00:00')
    keys = ', '.join(cols)
    qs = ', '.join('?' for _ in cols)
    cur = conn.execute(
        f"INSERT INTO papers ({keys}) VALUES ({qs})", tuple(cols.values()))
    return cur.lastrowid


def test_paper_record_from_row_maps_columns(tmp_path):
    conn = _fresh_db(tmp_path / 'src.db')
    pid = _insert_paper(
        conn, doi='10.1/a', s2_id='s2a', title='A title', year=2020,
        venue='J', authors='["Ada","Bob"]', editors='["Ed"]', abstract='abs',
        pub_type='article', volume='12A', is_open_access=1)
    conn.execute(
        "INSERT INTO identifiers (paper_id, scheme, value) VALUES (?,?,?)",
        (pid, 'issn', '1234-5678'))
    conn.commit()
    row = conn.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone()

    rec = paper_record_from_row(row, 'merge:src', {'issn': ['1234-5678']})
    assert rec.source == 'merge:src'
    assert rec.doi == '10.1/a' and rec.s2_id == 's2a'
    assert rec.authors_json == '["Ada","Bob"]'      # authors -> authors_json
    assert rec.editors_json == '["Ed"]'             # editors -> editors_json
    assert rec.volume == '12A'
    assert rec.is_open_access is True               # 1 -> bool
    assert rec.extra_identifiers == {'issn': ['1234-5678']}
    # is_stub is not a PaperRecord field at all — the writer re-derives it.
    assert not hasattr(rec, 'is_stub')
    conn.close()


def test_iter_paper_records_skips_tombstones(tmp_path):
    conn = _fresh_db(tmp_path / 'src.db')
    _insert_paper(conn, doi='10.1/live', title='Live')
    _insert_paper(conn, doi='10.1/dead', title='Dead', tombstone=1)
    conn.commit()

    recs = [r for chunk in iter_paper_records(conn, 'merge:src') for r in chunk]
    dois = {r.doi for r in recs}
    assert dois == {'10.1/live'}
    conn.close()


def test_iter_citation_records_edges_and_pending(tmp_path):
    conn = _fresh_db(tmp_path / 'src.db')
    a = _insert_paper(conn, doi='10.1/citing', title='Citing')
    b = _insert_paper(conn, doi='10.1/cited', s2_id='s2cited', title='Cited')
    conn.execute(
        "INSERT INTO citations (citing_id, cited_id, provenance) VALUES (?,?,?)",
        (a, b, 's2_references'))
    conn.execute(
        "INSERT INTO pending_citations "
        "(citing_doi, cited_doi, provenance, discovered_at) VALUES (?,?,?,?)",
        ('10.1/p_citing', '10.1/p_cited', 'oa_references', '2026-01-01'))
    conn.commit()

    recs = [r for chunk in iter_citation_records(conn, 'merge:src')
            for r in chunk]
    pairs = {(r.citing_doi, r.cited_doi) for r in recs}
    assert ('10.1/citing', '10.1/cited') in pairs
    assert ('10.1/p_citing', '10.1/p_cited') in pairs
    # the resolved edge carried the cited paper's s2_id endpoint too
    edge = next(r for r in recs if r.citing_doi == '10.1/citing')
    assert edge.cited_s2_id == 's2cited'
    conn.close()


def test_copy_sidecar_tables_flags_tags_counts(tmp_path):
    src_path = tmp_path / 'src.db'
    sconn = _fresh_db(src_path)
    sp = _insert_paper(sconn, doi='10.1/shared', title='Shared',
                       is_seed=1, is_rejected=1)
    sconn.execute(
        "INSERT INTO paper_tags (paper_id, tag, added_at, added_by, category) "
        "VALUES (?,?,?,?,?)", (sp, 'algae', '2026-01-01', 'cli', 'theme'))
    sconn.execute(
        "INSERT INTO citation_counts (paper_id, source, cit_count, ref_count) "
        "VALUES (?,?,?,?)", (sp, 'openalex', 42, 7))
    sconn.commit()
    sconn.close()

    tgt_path = tmp_path / 'tgt.db'
    tconn = _fresh_db(tgt_path)
    tp = _insert_paper(tconn, doi='10.1/shared', title='Shared', is_seed=0)
    tconn.commit()

    counts = copy_sidecar_tables(tconn, src_path)
    assert counts['matched'] == 1
    assert counts['is_seed'] == 1
    assert counts['is_rejected'] == 1
    assert counts['paper_tags'] == 1
    assert counts['citation_counts'] == 1

    row = tconn.execute(
        "SELECT is_seed, is_rejected FROM papers WHERE id=?", (tp,)).fetchone()
    assert row['is_seed'] == 1 and row['is_rejected'] == 1
    assert tconn.execute(
        "SELECT tag FROM paper_tags WHERE paper_id=?", (tp,)).fetchone()['tag'] \
        == 'algae'
    assert tconn.execute(
        "SELECT cit_count FROM citation_counts WHERE paper_id=? AND source=?",
        (tp, 'openalex')).fetchone()['cit_count'] == 42

    # Idempotent: a second run copies nothing new.
    again = copy_sidecar_tables(tconn, src_path)
    assert again['is_seed'] == 0
    assert again['paper_tags'] == 0
    assert again['citation_counts'] == 0
    tconn.close()


def test_copy_sidecar_unmatched_paper_ignored(tmp_path):
    """A source paper with no identifier match in the target is simply skipped
    (it should have been inserted during the cache drain; if it wasn't, we
    don't invent a mapping)."""
    src_path = tmp_path / 'src.db'
    sconn = _fresh_db(src_path)
    _insert_paper(sconn, doi='10.1/only-in-src', title='Orphan', is_seed=1)
    sconn.commit()
    sconn.close()

    tconn = _fresh_db(tmp_path / 'tgt.db')
    _insert_paper(tconn, doi='10.1/different', title='Other')
    tconn.commit()

    counts = copy_sidecar_tables(tconn, src_path)
    assert counts['matched'] == 0
    assert counts['is_seed'] == 0
    tconn.close()


@needs_redis
def test_end_to_end_merge_dedups_and_resolves_edges(
        tmp_path, tmp_db_path, claims_db_path, cache, db_conn):
    """Push a source DB through the converters + real MergeWriter (as cmd_merge
    does): the overlapping paper dedups, the disjoint papers land, the source
    edge resolves into a real citation, and the sidecar copy lands tags."""
    # Source: two papers + an edge between them; one shares the target's DOI.
    src_path = tmp_path / 'src.db'
    sconn = _fresh_db(src_path)
    a = _insert_paper(sconn, doi='10.1/shared', title='Shared', is_seed=1)
    b = _insert_paper(sconn, doi='10.1/onlysrc', title='Only in source')
    sconn.execute(
        "INSERT INTO citations (citing_id, cited_id, provenance) VALUES (?,?,?)",
        (a, b, 's2_references'))
    sconn.execute(
        "INSERT INTO paper_tags (paper_id, tag, added_at) VALUES (?,?,?)",
        (a, 'algae', '2026-01-01'))
    sconn.commit()

    # Target already has the shared paper (so it should dedup, not duplicate).
    db_conn.execute(
        "INSERT INTO papers (doi, title, created_at) VALUES (?,?,?)",
        ('10.1/shared', 'Shared', '2026-01-01T00:00:00+00:00'))
    db_conn.commit()

    w = MergeWriter(tmp_db_path, cache, batch_size=100, served_modules=[])
    try:
        for chunk in iter_paper_records(sconn, 'merge:src'):
            cache.push_papers(chunk)
        for _ in range(10):
            if w.run_cycle() == 0:
                break
        for chunk in iter_citation_records(sconn, 'merge:src'):
            cache.push_citations(chunk)
        for _ in range(10):
            if w.run_cycle() == 0:
                break
    finally:
        w.close()
    sconn.close()

    # 2 distinct papers (shared deduped), 1 resolved edge.
    assert db_conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 2
    assert db_conn.execute("SELECT COUNT(*) FROM citations").fetchone()[0] == 1

    side = copy_sidecar_tables(db_conn, src_path)
    assert side['matched'] == 2
    assert side['is_seed'] == 1                      # source's shared seed
    assert db_conn.execute(
        "SELECT COUNT(*) FROM paper_tags").fetchone()[0] == 1
