"""
Tests for the Phase 1 dirty-set feed: the writer SADDs committed (canonical)
paper ids onto dirty:papers after each commit, and the cache exposes the
SADD/SPOP/SCARD surface the Reader (Phase 2) will consume.

Real Redis on db=15 via the `cache` fixture.
"""
import pytest

from biblion.cache.records import PaperRecord, CitationRecord
from biblion.merge.writer import MergeWriter
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


class TestDirtyFeedCache:
    def test_add_pop_roundtrip(self, cache):
        cache.add_dirty_papers([1, 2, 3, 2])      # duplicate collapses in the set
        assert cache.dirty_count() == 3
        assert set(cache.pop_dirty_papers(10)) == {1, 2, 3}
        assert cache.dirty_count() == 0

    def test_empty_inputs(self, cache):
        assert cache.add_dirty_papers([]) == 0
        assert cache.pop_dirty_papers(5) == []

    def test_pop_returns_ints(self, cache):
        cache.add_dirty_papers([42])
        assert cache.pop_dirty_papers(5) == [42]

    def test_seeded_flag(self, cache):
        assert cache.dirty_seeded() is False
        cache.mark_dirty_seeded()
        assert cache.dirty_seeded() is True

    def test_lengths_reports_dirty(self, cache):
        cache.add_dirty_papers([7, 8])
        assert cache.lengths()['dirty_papers'] == 2


class TestWriterEmitsDirty:
    def test_new_paper_marks_dirty(self, tmp_db_path, claims_db_path, cache,
                                   db_conn):
        cache.push_paper(PaperRecord(source='t', doi='10.1/a', title='A'))
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        w.run_cycle()
        new_id = db_conn.execute(
            "SELECT id FROM papers WHERE doi='10.1/a'").fetchone()[0]
        assert set(cache.pop_dirty_papers(100)) == {new_id}

    def test_single_hit_marks_dirty(self, tmp_db_path, claims_db_path, cache,
                                    insert_paper):
        pid = insert_paper(doi='10.1/a', title='A')
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='oa', doi='10.1/a', year=2024))
        w.run_cycle()
        assert pid in set(cache.pop_dirty_papers(100))

    def test_citation_marks_both_endpoints(self, tmp_db_path, claims_db_path,
                                           cache, insert_paper):
        a = insert_paper(doi='10.1/a')
        b = insert_paper(doi='10.1/b')
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_citation(CitationRecord(
            source='oa', citing_doi='10.1/a', cited_doi='10.1/b'))
        w.run_cycle()
        assert set(cache.pop_dirty_papers(100)) == {a, b}

    def test_emitted_ids_are_canonical(self, tmp_db_path, claims_db_path, cache,
                                       insert_paper, db_conn):
        # A citation touching a merged-away loser must mark the WINNER dirty.
        loser  = insert_paper(doi='10.1/lose')
        winner = insert_paper(doi='10.1/win')
        b      = insert_paper(doi='10.1/b')
        db_conn.execute(
            "INSERT INTO aliases (loser_id, winner_id, created_at) "
            "VALUES (?, ?, datetime('now'))", (loser, winner))
        db_conn.commit()
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_citation(CitationRecord(
            source='oa', citing_doi='10.1/lose', cited_doi='10.1/b'))
        w.run_cycle()
        dirty = set(cache.pop_dirty_papers(100))
        assert winner in dirty
        assert loser not in dirty


class TestDirtyFeedDisabled:
    def test_env_disables_emission(self, tmp_db_path, claims_db_path, cache,
                                   monkeypatch):
        # The flag is read in MergeWriter.__init__, so set it before construct.
        monkeypatch.setenv('BIBLION_DIRTY_FEED', '0')
        cache.push_paper(PaperRecord(source='t', doi='10.1/a', title='A'))
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        w.run_cycle()
        assert cache.dirty_count() == 0
