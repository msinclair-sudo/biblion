"""
Tests for CacheClient against real Redis (db=15).

Every test gets a freshly-flushed db=15 via the `cache` / `redis_client`
fixtures from conftest.
"""
import pytest

from biblion.cache.records import (
    PaperRecord, CitationRecord,
    ClaimRequest, ClaimGrant, ResultMark,
    PromoteCitationAction,
)
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


# ---------------------------------------------------------------------------
# Paper queues
# ---------------------------------------------------------------------------

class TestPaperQueues:
    def test_push_then_pop_round_trip(self, cache):
        cache.push_paper(PaperRecord(source='t', doi='10.1/a', title='X'))
        out = cache.pop_papers_batch(10)
        assert len(out) == 1
        assert out[0].doi == '10.1/a'

    def test_push_drops_record_without_identifier(self, cache):
        ok = cache.push_paper(PaperRecord(source='t', title='only title'))
        assert not ok
        assert cache.lengths()['staged_papers'] == 0

    def test_bulk_push_returns_accepted_count(self, cache):
        n = cache.push_papers([
            PaperRecord(source='t', doi='10.1/a'),
            PaperRecord(source='t'),               # no id, rejected
            PaperRecord(source='t', oa_id='W1'),
        ])
        assert n == 2


# ---------------------------------------------------------------------------
# Citation queues
# ---------------------------------------------------------------------------

class TestCitationQueues:
    def test_push_then_pop(self, cache):
        cache.push_citation(CitationRecord(
            source='t', citing_doi='10.1/a', cited_doi='10.1/b',
        ))
        out = cache.pop_citations_batch(10)
        assert len(out) == 1
        assert out[0].citing_doi == '10.1/a'

    def test_push_drops_when_endpoint_missing(self, cache):
        # No cited identifier — should be rejected.
        ok = cache.push_citation(CitationRecord(
            source='t', citing_doi='10.1/a',
        ))
        assert not ok


# ---------------------------------------------------------------------------
# Claim flow
# ---------------------------------------------------------------------------

class TestClaimQueues:
    def test_request_grant_round_trip(self, cache):
        cache.push_claim_request(ClaimRequest(service='svc', batch_size=10))
        req = cache.pop_claim_request('svc')
        assert req is not None
        assert req.service == 'svc'
        assert req.batch_size == 10

    def test_grant_consumed_by_requesting_service_only(self, cache):
        cache.push_claim_grant(ClaimGrant(service='svc', rows=[{'id': 1}]))
        assert cache.pop_claim_grant('other_svc') is None
        grant = cache.pop_claim_grant('svc')
        assert grant.rows == [{'id': 1}]

    def test_blocking_pop_returns_within_short_timeout(self, cache):
        """BLPOP semantics — blocks until something arrives or timeout.

        We test the timeout path here (no producer) and verify the
        returned value is None, not an exception."""
        out = cache.pop_claim_grant('nobody_here', timeout=0.5)
        assert out is None

    def test_result_mark_round_trip(self, cache):
        cache.push_result_mark(ResultMark(
            service='svc', succeeded=[[1, 'abstract'], [2, '_all']],
            failed=[[3, 'venue']],
        ))
        m = cache.pop_result_mark('svc')
        assert m.succeeded == [[1, 'abstract'], [2, '_all']]
        assert m.failed == [[3, 'venue']]


# ---------------------------------------------------------------------------
# Promote-citation flow
# ---------------------------------------------------------------------------

class TestPromoteQueue:
    def test_round_trip(self, cache):
        cache.push_promote_citation(PromoteCitationAction(
            pending_id=1, citing_id=10, cited_id=20,
            provenance='pending_resolver',
        ))
        out = cache.pop_promote_citation_batch(10)
        assert len(out) == 1
        assert out[0].pending_id == 1

    def test_pop_batch_respects_limit(self, cache):
        cache.push_promote_citations([
            PromoteCitationAction(pending_id=i, citing_id=10, cited_id=20,
                                  provenance='x') for i in range(5)
        ])
        first = cache.pop_promote_citation_batch(3)
        assert len(first) == 3
        rest = cache.pop_promote_citation_batch(10)
        assert len(rest) == 2

    def test_pending_cursor_round_trip(self, cache):
        assert cache.get_pending_cursor() == 0   # default for missing key
        cache.set_pending_cursor(42)
        assert cache.get_pending_cursor() == 42


# ---------------------------------------------------------------------------
# Introspection
# ---------------------------------------------------------------------------

class TestIntrospection:
    def test_lengths_includes_promote_queue(self, cache):
        cache.push_paper(PaperRecord(source='t', doi='10.1/a'))
        cache.push_promote_citation(PromoteCitationAction(
            pending_id=1, citing_id=1, cited_id=2, provenance='x',
        ))
        lens = cache.lengths()
        assert lens['staged_papers'] == 1
        assert lens['promote_citations'] == 1

    def test_flush_all_clears_everything(self, cache):
        cache.push_paper(PaperRecord(source='t', doi='10.1/a'))
        cache.push_claim_request(ClaimRequest(service='svc', batch_size=10))
        cache.push_promote_citation(PromoteCitationAction(
            pending_id=1, citing_id=1, cited_id=2, provenance='x',
        ))
        cache.set_pending_cursor(99)
        cache.flush_all()
        lens = cache.lengths()
        assert sum(lens.values()) == 0
        assert cache.get_pending_cursor() == 0

    def test_ping(self, cache):
        assert cache.ping() is True


# ---------------------------------------------------------------------------
# Daemon heartbeats
# ---------------------------------------------------------------------------

class TestHeartbeats:
    def test_beat_then_get_round_trip(self, cache):
        cache.beat('writer', {'cycles': 5, 'new_papers': 7})
        hb = cache.get_heartbeats(['writer'])
        assert hb['writer']['cycles'] == 5
        assert hb['writer']['new_papers'] == 7
        assert isinstance(hb['writer']['ts'], float)

    def test_get_missing_role_is_none(self, cache):
        assert cache.get_heartbeats(['nobody'])['nobody'] is None

    def test_get_no_roles_is_empty(self, cache):
        assert cache.get_heartbeats([]) == {}

    def test_beat_accepts_dataclass(self, cache):
        # MergeStats is a dataclass — beat() must asdict() it transparently.
        from biblion.merge.writer import MergeStats
        cache.beat('writer', MergeStats(cycles=3, new_papers=2))
        hb = cache.get_heartbeats(['writer'])
        assert hb['writer']['cycles'] == 3 and hb['writer']['new_papers'] == 2

    def test_beat_overwrites(self, cache):
        cache.beat('writer', {'cycles': 1})
        cache.beat('writer', {'cycles': 9})        # SET, not a list
        assert cache.get_heartbeats(['writer'])['writer']['cycles'] == 9

    def test_flush_all_clears_heartbeats(self, cache):
        cache.beat('writer', {'cycles': 1})
        cache.beat('compute', {'passes': 1})
        cache.flush_all()
        hb = cache.get_heartbeats(['writer', 'compute'])
        assert hb['writer'] is None and hb['compute'] is None
        # heartbeats aren't queues, so the lengths() invariant still holds.
        assert sum(cache.lengths().values()) == 0
