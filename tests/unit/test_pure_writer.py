"""
Phase 6 pure-writer: the apply-only path (hand-built jobs), the compute stage,
and the DB-equivalence gate (legacy writer vs compute -> pure writer).
"""
from dataclasses import asdict

import pytest

from biblion import db as _db
from biblion.cache.records import (
    PaperRecord, CitationRecord, WritePaperJob, WriteEdgeJob, WritePendingEdgeJob,
)
from biblion.merge.writer import MergeWriter
from biblion.enrich.compute import Compute
from biblion.enrich.dedup import plan_merge
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


# ---------------------------------------------------------------------------
# Apply-only path
# ---------------------------------------------------------------------------

class TestApplyOnly:
    @pytest.fixture
    def pure(self, monkeypatch):
        monkeypatch.setenv('BIBLION_PURE_WRITER', '1')

    def test_insert_job(self, pure, tmp_db_path, claims_db_path, cache,
                        count_rows, db_conn):
        cache.push_write_jobs([WritePaperJob(
            None, PaperRecord(source='t', doi='10.1/a', title='A').to_json())])
        w = MergeWriter(tmp_db_path, cache, batch_size=50, served_modules=[])
        w.run_cycle(); w.close()
        assert count_rows('papers') == 1
        assert w.stats.new_papers == 1

    def test_update_job(self, pure, tmp_db_path, claims_db_path, cache,
                        insert_paper, db_conn):
        pid = insert_paper(doi='10.1/a', title='Old')
        cache.push_write_jobs([WritePaperJob(
            pid, PaperRecord(source='oa', doi='10.1/a', year=2021).to_json())])
        w = MergeWriter(tmp_db_path, cache, batch_size=50, served_modules=[])
        w.run_cycle(); w.close()
        row = db_conn.execute("SELECT year FROM papers WHERE id=?", (pid,)).fetchone()
        assert row['year'] == 2021

    def test_edge_job(self, pure, tmp_db_path, claims_db_path, cache,
                      insert_paper, count_rows):
        a = insert_paper(doi='10.1/a'); b = insert_paper(doi='10.1/b')
        cache.push_write_jobs([WriteEdgeJob(a, b, 'oa')])
        w = MergeWriter(tmp_db_path, cache, batch_size=50, served_modules=[])
        w.run_cycle(); w.close()
        assert count_rows('citations') == 1

    def test_pending_edge_job(self, pure, tmp_db_path, claims_db_path, cache,
                              count_rows):
        cache.push_write_jobs([WritePendingEdgeJob(
            '10.1/a', None, None, '10.1/missing', None, None, 'oa')])
        w = MergeWriter(tmp_db_path, cache, batch_size=50, served_modules=[])
        w.run_cycle(); w.close()
        assert count_rows('pending_citations') == 1

    def test_in_batch_dedup_two_new_same_id(self, pure, tmp_db_path,
                                            claims_db_path, cache, count_rows):
        # Two insert jobs for the same DOI -> writer inserts once, updates once.
        cache.push_write_jobs([
            WritePaperJob(None, PaperRecord(source='t', doi='10.1/a', title='A').to_json()),
            WritePaperJob(None, PaperRecord(source='t', doi='10.1/a', year=2020).to_json()),
        ])
        w = MergeWriter(tmp_db_path, cache, batch_size=50, served_modules=[])
        w.run_cycle(); w.close()
        assert count_rows('papers') == 1

    def test_stale_single_hit_collision_merges(self, pure, tmp_db_path,
                                               claims_db_path, cache,
                                               insert_paper, db_conn, count_rows):
        # Stale-snapshot collision: compute classified the record as a single-hit
        # UPDATE onto B (matched by oa_id), but between scan and apply the record's
        # s2_id now lives on a DIFFERENT paper A. Applying it to B would
        # UPDATE B.s2_id=S1 -> UNIQUE clash with A. The writer must escalate to a
        # merge of A+B (not crash-loop), then land the record on the winner.
        a = insert_paper(doi='10.1/a', s2_id='S1', title='A', year=2020, venue='V')
        b = insert_paper(oa_id='OA1')
        cache.push_write_jobs([WritePaperJob(
            b, PaperRecord(source='x', s2_id='S1', oa_id='OA1').to_json())])
        w = MergeWriter(tmp_db_path, cache, batch_size=50, served_modules=[])
        w.run_cycle(); w.close()
        assert w.stats.merged_papers == 1
        assert count_rows('papers', 'tombstone=0') == 1      # A+B collapsed to one
        survivor = db_conn.execute(
            "SELECT s2_id, oa_id FROM papers WHERE tombstone=0").fetchone()
        assert survivor['s2_id'] == 'S1' and survivor['oa_id'] == 'OA1'

    def test_merge_plan_job(self, pure, tmp_db_path, claims_db_path, cache,
                            insert_paper, db_conn, count_rows):
        a = insert_paper(doi='10.1/a', title='A', year=2020, venue='V')
        b = insert_paper(s2_id='S1')
        rows = db_conn.execute(
            "SELECT id, doi, s2_id, oa_id, title, year, venue, authors, abstract, "
            "pub_type FROM papers WHERE id IN (?, ?)", (a, b)).fetchall()
        plan = plan_merge(rows)
        cache.push_write_jobs([WritePaperJob(
            plan.winner_id, PaperRecord(source='x', doi='10.1/a', s2_id='S1').to_json(),
            plan=asdict(plan))])
        w = MergeWriter(tmp_db_path, cache, batch_size=50, served_modules=[])
        w.run_cycle(); w.close()
        assert count_rows('papers') == 2                 # loser tombstoned
        winner = db_conn.execute(
            "SELECT doi, s2_id FROM papers WHERE id=? AND tombstone=0",
            (plan.winner_id,)).fetchone()
        assert winner['doi'] == '10.1/a' and winner['s2_id'] == 'S1'


# ---------------------------------------------------------------------------
# Compute stage
# ---------------------------------------------------------------------------

class TestCompute:
    def test_classifies_new_single_edge(self, tmp_db_path, claims_db_path,
                                        cache, insert_paper):
        insert_paper(doi='10.1/exist', title='E')
        insert_paper(doi='10.1/a'); insert_paper(doi='10.1/b')
        cache.push_paper(PaperRecord(source='t', doi='10.1/new', title='New'))
        cache.push_paper(PaperRecord(source='oa', doi='10.1/exist', year=2020))
        cache.push_citation(CitationRecord(source='oa', citing_doi='10.1/a',
                                           cited_doi='10.1/b'))
        comp = Compute(cache, tmp_db_path, batch_size=50)
        try:
            comp.run_pass()
        finally:
            comp.close()
        jobs = cache.pop_write_job_batch(100)
        papers = [j for j in jobs if isinstance(j, WritePaperJob)]
        edges = [j for j in jobs if isinstance(j, WriteEdgeJob)]
        assert any(j.target_id is None for j in papers)      # the new one
        assert any(j.target_id is not None for j in papers)  # the update
        assert len(edges) == 1


# ---------------------------------------------------------------------------
# DB-equivalence gate
# ---------------------------------------------------------------------------

def _snapshot(conn):
    """Live papers keyed by identifiers + the canonical edge set, for comparison
    independent of autoincrement id assignment."""
    papers = {}
    for r in conn.execute(
        "SELECT doi, s2_id, oa_id, title, year, venue, authors, abstract, "
        "pub_type FROM papers WHERE tombstone = 0"
    ):
        key = (r['doi'], r['s2_id'], r['oa_id'])
        papers[key] = tuple(r[c] for c in
                            ('title', 'year', 'venue', 'authors', 'abstract', 'pub_type'))
    edges = set()
    for r in conn.execute(
        "SELECT c.citing_id, c.cited_id FROM citations c"
    ):
        cp = conn.execute("SELECT doi FROM papers WHERE id=?", (r['citing_id'],)).fetchone()
        dp = conn.execute("SELECT doi FROM papers WHERE id=?", (r['cited_id'],)).fetchone()
        edges.add((cp['doi'] if cp else None, dp['doi'] if dp else None))
    return papers, edges


def _seed(path):
    conn = _db.get_connection(path)
    _db.init_db(conn)
    now = "2026-01-01T00:00:00Z"
    for doi, title in (('10.1/x', 'X old'), ('10.1/a', None), ('10.1/b', None)):
        conn.execute("INSERT INTO papers (doi, title, created_at) VALUES (?, ?, ?)",
                     (doi, title, now))
    conn.commit(); conn.close()


_RECORDS = [
    PaperRecord(source='oa', doi='10.1/x', year=2020, abstract='abs', venue='V'),
    PaperRecord(source='t', doi='10.1/new', title='New', year=2019),
]
_CITATIONS = [
    CitationRecord(source='oa', citing_doi='10.1/a', cited_doi='10.1/b'),
]


def test_legacy_vs_pure_equivalence(tmp_path, cache, monkeypatch):
    # --- legacy path ---
    legacy = tmp_path / 'legacy.db'
    _seed(legacy)
    _db.ensure_claims_db(legacy.with_name('legacy_claims.db'))
    cache.flush_all()
    for r in _RECORDS:
        cache.push_paper(r)
    monkeypatch.setenv('BIBLION_PURE_WRITER', '0')
    w = MergeWriter(legacy, cache, batch_size=50, served_modules=[])
    w.run_cycle()                                   # papers first (same cycle)
    for c in _CITATIONS:
        cache.push_citation(c)
    w.run_cycle()
    w.close()
    legacy_conn = _db.get_connection(legacy)
    legacy_state = _snapshot(legacy_conn)
    legacy_conn.close()

    # --- compute -> pure writer path ---
    pure = tmp_path / 'pure.db'
    _seed(pure)
    _db.ensure_claims_db(pure.with_name('pure_claims.db'))
    cache.flush_all()
    for r in _RECORDS:
        cache.push_paper(r)
    comp = Compute(cache, pure, batch_size=50)
    comp.run_pass()                                 # papers -> jobs
    comp.close()
    monkeypatch.setenv('BIBLION_PURE_WRITER', '1')
    w2 = MergeWriter(pure, cache, batch_size=50, served_modules=[])
    w2.run_cycle()                                  # apply paper jobs (inserts)
    # citations now that endpoints exist, so they resolve directly (not pending)
    for c in _CITATIONS:
        cache.push_citation(c)
    comp2 = Compute(cache, pure, batch_size=50)
    comp2.run_pass()
    comp2.close()
    w2.run_cycle()                                  # apply edge jobs
    w2.close()
    pure_conn = _db.get_connection(pure)
    pure_state = _snapshot(pure_conn)
    pure_conn.close()

    assert pure_state == legacy_state
