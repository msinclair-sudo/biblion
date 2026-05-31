"""
Throughput tests for _batch_lookup.

The merge writer's `_process_citation_batch` and the pending_resolver's
sweep both call _batch_lookup with up to 2*batch_size probes. If that
query degrades, the writer's run_cycle takes minutes instead of
seconds.

We seed a temp DB with 10,000 papers and assert _batch_lookup at the
production batch size completes within a small time budget.
"""
import time

import pytest

from biblion.cache.records import PaperRecord
from biblion.merge.writer import _batch_lookup


pytestmark = [pytest.mark.perf, pytest.mark.slow]


# How many synthetic papers we seed before the benchmark.
N_PAPERS  = 10_000
N_PROBES  = 2_000     # equivalent to a citation batch_size of 1000

# Time budget in seconds. If the query degrades (e.g. an index goes
# missing) we'll blow past this.
BUDGET_S  = 2.0


@pytest.fixture
def seeded_db(db_conn):
    """Insert N_PAPERS rows with deterministic identifiers."""
    db_conn.execute('BEGIN')
    for i in range(N_PAPERS):
        db_conn.execute(
            "INSERT INTO papers (doi, s2_id, oa_id, title, created_at) "
            "VALUES (?, ?, ?, ?, datetime('now'))",
            (f'10.1/p{i}', f's{i}', f'W{i}', f'Paper {i}'),
        )
    db_conn.commit()
    return db_conn


class TestBatchLookupScales:
    def test_batch_lookup_with_2000_probes(self, seeded_db):
        """A 1000-citation batch is 2000 probes. Must finish in <2s."""
        probes = []
        for i in range(N_PROBES):
            probes.append(PaperRecord(
                source='test',
                doi=f'10.1/p{i % N_PAPERS}',
                s2_id=f's{i % N_PAPERS}',
                oa_id=f'W{i % N_PAPERS}',
            ))
        t = time.time()
        hits = _batch_lookup(seeded_db, probes)
        elapsed = time.time() - t
        assert len(hits) == N_PROBES
        # Every probe should hit at least one paper.
        n_hit = sum(1 for h in hits if h)
        assert n_hit == N_PROBES, f'Expected all to hit; got {n_hit}'
        assert elapsed < BUDGET_S, (
            f'_batch_lookup took {elapsed:.2f}s for {N_PROBES} probes '
            f'against {N_PAPERS} papers — budget was {BUDGET_S}s. '
            f'Likely a missing index or OR-join regression.'
        )

    def test_batch_lookup_with_no_hits(self, seeded_db):
        """All-miss case must also be fast."""
        probes = [
            PaperRecord(source='t', doi=f'10.1/MISS{i}')
            for i in range(N_PROBES)
        ]
        t = time.time()
        hits = _batch_lookup(seeded_db, probes)
        elapsed = time.time() - t
        assert all(not h for h in hits)
        assert elapsed < BUDGET_S, (
            f'All-miss _batch_lookup took {elapsed:.2f}s — budget {BUDGET_S}s'
        )
