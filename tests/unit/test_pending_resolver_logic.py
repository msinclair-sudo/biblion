"""
Tests for PendingResolver.run_cycle() logic.

Covers the resolver's contract:
  - resolvable rows produce PromoteCitationAction
  - unresolvable rows are skipped (cursor still advances)
  - self-citations are filtered
  - cursor wraps to 0 when no rows past it
  - regression: cursor stays put if push fails (the bug we just fixed)
"""
import pytest

from biblion.merge.pending_resolver import PendingResolver
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


class TestPendingResolver:
    def test_resolves_both_endpoints_present(
        self, tmp_db_path, cache, insert_paper, insert_pending_citation,
    ):
        a = insert_paper(doi='10.1/a')
        b = insert_paper(doi='10.1/b')
        pid = insert_pending_citation(
            citing_doi='10.1/a', cited_doi='10.1/b', provenance='oa',
        )
        r = PendingResolver(tmp_db_path, cache, batch_size=10)
        n = r.run_cycle()
        assert n == 1
        action = cache.pop_promote_citation_batch(10)[0]
        assert action.pending_id == pid
        assert action.citing_id == a
        assert action.cited_id == b

    def test_skips_when_endpoint_missing(
        self, tmp_db_path, cache, insert_paper, insert_pending_citation,
    ):
        insert_paper(doi='10.1/a')
        insert_pending_citation(
            citing_doi='10.1/a', cited_doi='10.1/missing', provenance='oa',
        )
        r = PendingResolver(tmp_db_path, cache, batch_size=10)
        assert r.run_cycle() == 0

    def test_skips_self_citation(
        self, tmp_db_path, cache, insert_paper, insert_pending_citation,
    ):
        insert_paper(doi='10.1/a')
        insert_pending_citation(
            citing_doi='10.1/a', cited_doi='10.1/a', provenance='oa',
        )
        r = PendingResolver(tmp_db_path, cache, batch_size=10)
        assert r.run_cycle() == 0

    def test_cursor_advances_past_examined_rows(
        self, tmp_db_path, cache, insert_paper, insert_pending_citation,
    ):
        insert_paper(doi='10.1/a')
        ids = [insert_pending_citation(
            citing_doi='10.1/a', cited_doi=f'10.1/x{i}', provenance='oa',
        ) for i in range(3)]
        r = PendingResolver(tmp_db_path, cache, batch_size=10)
        r.run_cycle()
        assert cache.get_pending_cursor() == ids[-1]

    def test_cursor_wraps_when_no_more_rows(
        self, tmp_db_path, cache, insert_paper, insert_pending_citation,
    ):
        a = insert_paper(doi='10.1/a')
        b = insert_paper(doi='10.1/b')
        insert_pending_citation(
            citing_doi='10.1/a', cited_doi='10.1/b', provenance='oa',
        )
        r = PendingResolver(tmp_db_path, cache, batch_size=10)
        # First cycle examines the one row.
        r.run_cycle()
        cache.pop_promote_citation_batch(10)
        assert cache.get_pending_cursor() > 0
        # Second cycle finds nothing past the cursor → wraps.
        r.run_cycle()
        assert cache.get_pending_cursor() == 0
        assert r.stats.wraps == 1


# ---------------------------------------------------------------------------
# Regression for the cursor-advance race (Fix #3)
# ---------------------------------------------------------------------------

class TestCursorRaceFix:
    def test_cursor_stays_put_when_push_fails(
        self, tmp_db_path, cache, insert_paper, insert_pending_citation,
        monkeypatch,
    ):
        """If push_promote_citations raises, the cursor must NOT advance
        — otherwise we lose the rows until the next wrap (hours later)."""
        a = insert_paper(doi='10.1/a')
        b = insert_paper(doi='10.1/b')
        pid = insert_pending_citation(
            citing_doi='10.1/a', cited_doi='10.1/b', provenance='oa',
        )

        def boom(_actions):
            raise ConnectionError('redis down')
        monkeypatch.setattr(cache, 'push_promote_citations', boom)

        r = PendingResolver(tmp_db_path, cache, batch_size=10)
        cursor_before = cache.get_pending_cursor()
        with pytest.raises(ConnectionError):
            r.run_cycle()
        # The cursor must not have moved past the un-pushed row.
        assert cache.get_pending_cursor() == cursor_before
        # The errors counter should have ticked.
        assert r.stats.errors == 1
