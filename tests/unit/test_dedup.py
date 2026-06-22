"""
Phase 5 alias-dedup: the merge planner, the writer's inline alias-dedup path
(flagged), and parity with the Resolver's resulting canonical state.
"""
import pytest

from biblion.cache.records import PaperRecord, CitationRecord
from biblion.merge.writer import MergeWriter
from biblion.merge.resolver import Resolver
from biblion.enrich.dedup import plan_merge, pick_winner
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


def _row(**kw):
    base = dict(id=0, doi=None, s2_id=None, oa_id=None, title=None, year=None,
                venue=None, authors=None, abstract=None, pub_type=None)
    base.update(kw)
    return base


class TestPlanMerge:
    def test_winner_is_most_populated(self):
        a = _row(id=1, doi='10.1/a')
        b = _row(id=2, doi='10.1/b', title='T', year=2020, venue='V')
        assert pick_winner([a, b])['id'] == 2          # b has more fields

    def test_winner_tiebreak_lowest_id(self):
        a = _row(id=5, doi='10.1/a', title='T')
        b = _row(id=2, s2_id='S', title='T')
        assert pick_winner([a, b])['id'] == 2          # equal count -> lowest id

    def test_transplants_and_fills(self):
        # winner has doi+title; loser brings s2_id + year -> transplant + fill.
        win = _row(id=1, doi='10.1/a', title='T')
        lose = _row(id=2, s2_id='S1', year=2021)
        plan = plan_merge([win, lose])
        assert plan.winner_id == 1
        assert plan.loser_ids == [2]
        assert plan.identifier_transplants == {'s2_id': 'S1'}
        assert plan.field_fills == {'year': 2021}

    def test_identifier_conflict_recorded_not_overwritten(self):
        win = _row(id=1, doi='10.1/a', oa_id='W1', title='T', year=2020)
        lose = _row(id=2, oa_id='W2')
        plan = plan_merge([win, lose])
        assert ('oa_id', 'W1', 'W2') in plan.conflicts
        assert 'oa_id' not in plan.identifier_transplants


class TestWriterAliasDedup:
    @pytest.fixture
    def dedup_env(self, monkeypatch):
        monkeypatch.setenv('BIBLION_ALIAS_DEDUP', '1')

    def test_multihit_aliases_not_deletes(
        self, dedup_env, tmp_db_path, claims_db_path, cache, insert_paper,
        db_conn, count_rows,
    ):
        # Two rows that are the same paper seen via different identifiers.
        a = insert_paper(doi='10.1/a', title='T', year=2020, venue='V')  # richer
        b = insert_paper(s2_id='S1')
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='x', doi='10.1/a', s2_id='S1'))
        w.run_cycle()
        w.close()

        assert count_rows('papers') == 2          # loser tombstoned, NOT deleted
        assert w.stats.merged_papers == 1
        winner = db_conn.execute(
            "SELECT id, doi, s2_id, tombstone FROM papers WHERE id=?", (a,)
        ).fetchone()
        loser = db_conn.execute(
            "SELECT doi, s2_id, oa_id, tombstone FROM papers WHERE id=?", (b,)
        ).fetchone()
        assert winner['doi'] == '10.1/a' and winner['s2_id'] == 'S1'  # union
        assert winner['tombstone'] == 0
        assert loser['tombstone'] == 1
        assert loser['doi'] is None and loser['s2_id'] is None         # ids freed
        alias = db_conn.execute(
            "SELECT winner_id FROM aliases WHERE loser_id=?", (b,)).fetchone()
        assert alias['winner_id'] == a

    def test_default_off_still_parks(
        self, tmp_db_path, claims_db_path, cache, insert_paper,
    ):
        # Without the flag, a multi-hit parks for the Resolver (unchanged).
        insert_paper(doi='10.1/a', title='T')
        insert_paper(s2_id='S1')
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='x', doi='10.1/a', s2_id='S1'))
        w.run_cycle()
        w.close()
        assert w.stats.parked_papers == 1
        assert w.stats.merged_papers == 0


class TestResolverParity:
    """Same multi-hit, resolved both ways, must give the same canonical row."""

    def _scenario(self, insert_paper):
        a = insert_paper(doi='10.1/a', title='Paper', year=2020, venue='V')
        b = insert_paper(s2_id='S1', abstract='abs')
        return a, b

    def test_winner_fields_match(
        self, tmp_db_path, claims_db_path, cache, insert_paper, db_conn,
        monkeypatch,
    ):
        # Alias-dedup path.
        monkeypatch.setenv('BIBLION_ALIAS_DEDUP', '1')
        a, b = self._scenario(insert_paper)
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='x', doi='10.1/a', s2_id='S1'))
        w.run_cycle()
        w.close()
        alias_winner = dict(db_conn.execute(
            "SELECT doi, s2_id, title, year, venue, abstract FROM papers "
            "WHERE tombstone=0").fetchone())

        # Resolver path on a fresh DB.
        monkeypatch.setenv('BIBLION_ALIAS_DEDUP', '0')
        cache.flush_all()
        import biblion.db as _db
        p2 = tmp_db_path.with_name('parity2.db')
        conn2 = _db.get_connection(p2); _db.init_db(conn2)
        for doi, s2, title, year, venue, abstract in [
            ('10.1/a', None, 'Paper', 2020, 'V', None),
            (None, 'S1', None, None, None, 'abs')]:
            conn2.execute(
                "INSERT INTO papers (doi, s2_id, title, year, venue, abstract, "
                "created_at) VALUES (?,?,?,?,?,?, datetime('now'))",
                (doi, s2, title, year, venue, abstract))
        conn2.commit(); conn2.close()
        _db.ensure_claims_db(p2.with_name(p2.stem + '_claims.db'))
        w2 = MergeWriter(p2, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='x', doi='10.1/a', s2_id='S1'))
        w2.run_cycle()                              # parks
        res = Resolver(p2, cache)
        res.run_cycle()                             # merges -> resolved:papers
        w2.run_cycle()                              # applies resolved record
        w2.close()
        rconn = _db.get_connection(p2)
        resolver_winner = dict(rconn.execute(
            "SELECT doi, s2_id, title, year, venue, abstract FROM papers").fetchone())
        rconn.close()

        assert alias_winner == resolver_winner
