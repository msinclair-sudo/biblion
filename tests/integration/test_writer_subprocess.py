"""
Spawn a real merge writer subprocess and verify it drains the cache.

These tests prove the *deployed* writer actually works, not just the
in-process class. They catch supervisor / CLI / signal-handling
regressions.
"""
import time

import pytest

from biblion.cache.records import PaperRecord, CitationRecord
from tests.conftest import needs_redis


pytestmark = [pytest.mark.integration, needs_redis]


class TestWriterSubprocess:
    def test_writer_drains_staged_papers(
        self, worker_runner, tmp_db_path, claims_db_path, redis_url, cache,
        count_rows,
    ):
        """A paper pushed to the cache lands in the DB once the writer
        process picks it up."""
        # Spawn the real writer.
        worker_runner.spawn_writer(tmp_db_path, redis_url,
                                   batch_size=10, idle_sleep=0.1)
        cache.push_paper(PaperRecord(source='t', doi='10.1/a', title='X'))

        worker_runner.wait_for(
            lambda: count_rows('papers') == 1,
            timeout=10,
            msg='paper inserted by subprocess writer',
        )
        # And the cache is drained.
        assert cache.lengths()['staged_papers'] == 0

    def test_writer_processes_citation_to_pending(
        self, worker_runner, tmp_db_path, claims_db_path, redis_url, cache,
        count_rows,
    ):
        """A citation where neither endpoint is in the DB lands in
        pending_citations."""
        worker_runner.spawn_writer(tmp_db_path, redis_url,
                                   batch_size=10, idle_sleep=0.1)
        cache.push_citation(CitationRecord(
            source='t', citing_doi='10.1/a', cited_doi='10.1/b',
        ))
        worker_runner.wait_for(
            lambda: count_rows('pending_citations') == 1,
            timeout=10,
            msg='citation parked to pending',
        )

    def test_writer_logs_index_health_at_startup(
        self, worker_runner, tmp_db_path, claims_db_path, redis_url,
    ):
        """The startup probe should announce healthy indexes — proves
        every CANDIDATE_QUERIES module has an indexed candidate query."""
        w = worker_runner.spawn_writer(tmp_db_path, redis_url)
        worker_runner.wait_for(
            lambda: 'candidate-query indexes look healthy' in w.read_log(),
            timeout=10,
            msg='writer logged index-health line',
        )

    def test_writer_dies_cleanly_on_sigterm(
        self, worker_runner, tmp_db_path, claims_db_path, redis_url,
    ):
        """Critical for the supervisor's shutdown path."""
        w = worker_runner.spawn_writer(tmp_db_path, redis_url)
        # Let it boot
        time.sleep(1.0)
        worker_runner.stop(w, timeout=5)
        assert not w.is_alive()
        # Exit code 0 (signalled, but exited cleanly) or -SIGTERM are both fine.
        assert w.proc.returncode in (0, -15, 143)
