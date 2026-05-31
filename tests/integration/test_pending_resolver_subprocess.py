"""
Real pending_resolver + real writer running together — the full
"resolve pending citation" pipeline.

This is the test that would have caught the writer-stall issue: we
verify the resolver actually pushes promote actions and the writer
actually applies them, end-to-end.
"""
import pytest

from tests.conftest import needs_redis


pytestmark = [pytest.mark.integration, needs_redis]


class TestPendingResolverPipeline:
    def test_resolver_promotes_eligible_pending_row(
        self, worker_runner, tmp_db_path, claims_db_path, redis_url, cache,
        insert_paper, insert_pending_citation, count_rows,
    ):
        """End to end: pre-seed two papers + a pending citation between
        them. Spawn writer + pending_resolver. Verify the pending row
        gets promoted into citations."""
        a = insert_paper(doi='10.1/a', title='A')
        b = insert_paper(doi='10.1/b', title='B')
        pid = insert_pending_citation(
            citing_doi='10.1/a', cited_doi='10.1/b', provenance='oa',
        )
        assert count_rows('pending_citations') == 1
        assert count_rows('citations') == 0

        worker_runner.spawn_writer(tmp_db_path, redis_url,
                                   batch_size=10, idle_sleep=0.1)
        worker_runner.spawn_pending_resolver(tmp_db_path, redis_url,
                                             batch_size=10, idle_sleep=0.1)

        worker_runner.wait_for(
            lambda: count_rows('citations') == 1,
            timeout=15,
            msg='pending row promoted to citation',
        )
        # And the pending row is gone.
        assert count_rows('pending_citations') == 0

    def test_resolver_leaves_unresolvable_alone(
        self, worker_runner, tmp_db_path, claims_db_path, redis_url, cache,
        insert_paper, insert_pending_citation, count_rows,
    ):
        """If one endpoint isn't in papers, the pending row stays
        pending (no spurious deletion)."""
        insert_paper(doi='10.1/a')   # only one endpoint exists
        pid = insert_pending_citation(
            citing_doi='10.1/a', cited_doi='10.1/missing', provenance='oa',
        )

        worker_runner.spawn_writer(tmp_db_path, redis_url,
                                   batch_size=10, idle_sleep=0.1)
        worker_runner.spawn_pending_resolver(tmp_db_path, redis_url,
                                             batch_size=10, idle_sleep=0.1)

        # Wait until the resolver has clearly run at least one cycle.
        worker_runner.wait_for(
            # cursor advanced past 0 means it saw the row
            lambda: cache.get_pending_cursor() != 0
                    or 'wraps' in (worker_runner.workers[-1].read_log() or ''),
            timeout=10,
            msg='resolver completed first cycle',
        )

        # Pending row still there, no citation written.
        assert count_rows('pending_citations') == 1
        assert count_rows('citations') == 0
