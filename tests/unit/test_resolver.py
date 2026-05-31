"""
Tests for the multi-hit Resolver (the dedupe worker, not the
pending_resolver).

The resolver picks up records the writer parked because they matched
multiple existing papers (e.g. one row matched by doi, another by
oa_id), picks a winner, migrates citations, and pushes the survivor
back to the merge writer.
"""
import pytest

from biblion.cache.records import PaperRecord
from biblion.merge.resolver import Resolver, _pick_winner, _populated_count
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


# ---------------------------------------------------------------------------
# Winner-selection helpers
# ---------------------------------------------------------------------------

class TestWinnerSelection:
    def test_populated_count(self, insert_paper, db_conn):
        insert_paper(doi='10.1/x', title='X', year=2020)
        row = db_conn.execute("SELECT * FROM papers WHERE id = 1").fetchone()
        assert _populated_count(row) == 3   # doi, title, year

    def test_pick_winner_most_populated(self):
        class FakeRow(dict):
            def __getitem__(self, k):
                return super().get(k)

        more = FakeRow(id=2, doi='10.1/x', s2_id='abc', title='X', year=2020,
                       venue='V')
        less = FakeRow(id=1, doi='10.1/x')
        assert _pick_winner([more, less])['id'] == 2

    def test_pick_winner_tie_broken_by_lowest_id(self):
        class FakeRow(dict):
            def __getitem__(self, k):
                return super().get(k)
        a = FakeRow(id=5, doi='X', title='T')
        b = FakeRow(id=3, doi='X', title='T')
        assert _pick_winner([a, b])['id'] == 3


# ---------------------------------------------------------------------------
# Resolver cycles
# ---------------------------------------------------------------------------

class TestResolver:
    def test_no_parked_returns_zero(self, tmp_db_path, cache):
        r = Resolver(tmp_db_path, cache, batch_size=10)
        assert r.run_cycle() == 0

    def test_merges_two_rows_into_one(
        self, tmp_db_path, cache, insert_paper, db_conn, count_rows,
    ):
        insert_paper(doi='10.1/a', title='Same', year=2020)
        insert_paper(oa_id='W1',  title='Same', year=2020)
        cache.park_paper(PaperRecord(source='t', doi='10.1/a', oa_id='W1'))

        r = Resolver(tmp_db_path, cache, batch_size=10)
        r.run_cycle()

        assert count_rows('papers') == 1
        row = db_conn.execute(
            "SELECT doi, oa_id, title FROM papers"
        ).fetchone()
        assert row['doi'] == '10.1/a'
        assert row['oa_id'] == 'W1'
        assert r.merged == 1

    def test_winner_inherits_loser_citations(
        self, tmp_db_path, cache, insert_paper, db_conn,
    ):
        p1 = insert_paper(doi='10.1/a', title='Same', year=2020)
        p2 = insert_paper(oa_id='W1',  title='Same', year=2020)
        p3 = insert_paper(doi='10.1/citer')
        db_conn.execute("""
            INSERT INTO citations (citing_id, cited_id, provenance, discovered)
            VALUES (?, ?, 'test', '2024-01-01')
        """, (p3, p2))
        db_conn.commit()

        cache.park_paper(PaperRecord(source='t', doi='10.1/a', oa_id='W1'))
        r = Resolver(tmp_db_path, cache, batch_size=10)
        r.run_cycle()

        edges = db_conn.execute(
            "SELECT citing_id, cited_id FROM citations"
        ).fetchall()
        assert len(edges) == 1
        assert edges[0]['citing_id'] == p3
        survivor = db_conn.execute(
            "SELECT id, doi, oa_id FROM papers WHERE doi IS NOT NULL"
        ).fetchone()
        assert survivor is not None
        assert edges[0]['cited_id'] == survivor['id']

    def test_passthrough_when_only_one_match(
        self, tmp_db_path, cache, insert_paper,
    ):
        """A parked record that no longer multi-hits (race condition) is
        passed through as-is."""
        insert_paper(doi='10.1/x')
        cache.park_paper(PaperRecord(source='t', doi='10.1/x'))

        r = Resolver(tmp_db_path, cache, batch_size=10)
        r.run_cycle()
        assert r.merged == 0
        assert r.passthrough == 1
