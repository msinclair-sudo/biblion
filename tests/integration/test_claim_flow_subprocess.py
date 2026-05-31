"""
End-to-end claim flow through a real writer subprocess.

We push a ClaimRequest, wait for the writer to serve it as a ClaimGrant,
then push a ResultMark and verify enrichment_attempts reflects it.

This is the test that would have caught the lock contention if it was
present — if it doesn't complete within a few seconds, something is
serializing writes.
"""
import sqlite3
import time

import pytest

from biblion.cache.records import ClaimRequest, ResultMark
from tests.conftest import needs_redis


pytestmark = [pytest.mark.integration, needs_redis]


class TestClaimFlow:
    def test_request_grant_round_trip(
        self, worker_runner, tmp_db_path, claims_db_path, redis_url, cache,
        insert_paper,
    ):
        """Producer pushes ClaimRequest → writer cycle produces ClaimGrant."""
        # Seed a paper resolve_dois_via_pmid would claim.
        pid = insert_paper(pubmed_id='123', s2_id='s_123')

        worker_runner.spawn_writer(tmp_db_path, redis_url,
                                   batch_size=10, idle_sleep=0.1)

        cache.push_claim_request(ClaimRequest(
            service='resolve_dois_via_pmid', batch_size=10,
        ))

        # The grant should appear within seconds.
        grant = None
        deadline = time.time() + 10
        while time.time() < deadline:
            grant = cache.pop_claim_grant('resolve_dois_via_pmid')
            if grant is not None:
                break
            time.sleep(0.1)
        assert grant is not None, 'writer did not serve claim within 10s'
        assert any(r['id'] == pid for r in grant.rows)

    def test_result_mark_records_succeeded_in_claims_db(
        self, worker_runner, tmp_db_path, claims_db_path, redis_url, cache,
        insert_paper,
    ):
        pid = insert_paper(pubmed_id='123', s2_id='s_123')
        worker_runner.spawn_writer(tmp_db_path, redis_url,
                                   batch_size=10, idle_sleep=0.1)

        # Drive a full request → grant → mark cycle.
        cache.push_claim_request(ClaimRequest(
            service='resolve_dois_via_pmid', batch_size=10,
        ))
        # wait for grant
        grant = None
        for _ in range(100):
            grant = cache.pop_claim_grant('resolve_dois_via_pmid')
            if grant is not None: break
            time.sleep(0.1)
        assert grant is not None

        cache.push_result_mark(ResultMark(
            service='resolve_dois_via_pmid',
            succeeded=[[r['id'], '_all'] for r in grant.rows],
            failed=[],
        ))

        # Poll the claims DB until the row flips to succeeded.
        def status() -> str | None:
            try:
                conn = sqlite3.connect(
                    f'file:{claims_db_path}?mode=ro', uri=True,
                )
                row = conn.execute(
                    "SELECT status FROM enrichment_attempts "
                    "WHERE paper_id=? AND service=? AND field='_all'",
                    (pid, 'ncbi_pmid'),
                ).fetchone()
                conn.close()
                return row[0] if row else None
            except Exception:
                return None

        worker_runner.wait_for(
            lambda: status() == 'succeeded',
            timeout=10,
            msg='mark applied to claims DB',
        )

    def test_writer_serves_under_load(
        self, worker_runner, tmp_db_path, claims_db_path, redis_url, cache,
        insert_paper,
    ):
        """Regression for the writer stall: push many requests in a burst
        and verify they all get served in a reasonable time."""
        # Seed enough candidates that the SQL has work.
        for i in range(50):
            insert_paper(pubmed_id=str(i), s2_id=f's_{i}')

        worker_runner.spawn_writer(tmp_db_path, redis_url,
                                   batch_size=10, idle_sleep=0.1)

        N = 10
        for _ in range(N):
            cache.push_claim_request(ClaimRequest(
                service='resolve_dois_via_pmid', batch_size=5,
            ))

        # All grants should arrive within 30 seconds.
        grants = []
        deadline = time.time() + 30
        while time.time() < deadline and len(grants) < N:
            g = cache.pop_claim_grant('resolve_dois_via_pmid')
            if g is not None:
                grants.append(g)
            else:
                time.sleep(0.1)
        assert len(grants) == N, (
            f'only got {len(grants)}/{N} grants in 30s — '
            f'writer is too slow or stalled.'
        )
