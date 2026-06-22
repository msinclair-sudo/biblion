"""
WorkItem construction + needs logic for the Phase 2 Reader.

Covers the presence bitmask, the attempted-matrix blocking (succeeded / claimed /
failed-recent vs failed-old), and the is_seed / is_stub gating that leaf-bounds
expansion. Parity against the SQL registry is in test_reader_shadow_parity.py.
"""
from datetime import datetime, timezone, timedelta

import pytest

from biblion.enrich.reader import (
    Reader, BIT_DOI, BIT_TITLE, BIT_ABSTRACT, BIT_OA, BIT_CITES,
)
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


def _attempt(claims_conn, paper_id, service, field, status, finished_at=None,
             claimed_at=None):
    claims_conn.execute(
        "INSERT OR REPLACE INTO enrichment_attempts "
        "(paper_id, service, field, status, claimed_at, finished_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (paper_id, service, field, status,
         claimed_at or datetime.now(timezone.utc).isoformat(), finished_at))
    claims_conn.commit()


@pytest.fixture
def reader(cache, tmp_db_path, claims_db_path):
    r = Reader(cache, tmp_db_path, claims_db_path=claims_db_path)
    yield r
    r.close()


class TestBitmask:
    def test_present_bits_from_columns(self, insert_paper, reader):
        pid = insert_paper(doi='10.1/a', title='A', oa_id='W1')
        item = reader.build_items([pid])[0]
        assert item.has(BIT_DOI)
        assert item.has(BIT_TITLE)
        assert item.has(BIT_OA)
        assert not item.has(BIT_ABSTRACT)

    def test_cites_bit_from_attempt(self, insert_paper, reader, claims_conn):
        pid = insert_paper(doi='10.1/a', oa_id='W1', title='A', is_seed=1)
        _attempt(claims_conn, pid, 'oa_incoming', 'cites', 'succeeded',
                 finished_at=datetime.now(timezone.utc).isoformat())
        item = reader.build_items([pid])[0]
        assert item.has(BIT_CITES)


class TestNeeds:
    def test_seed_with_doi_needs_metadata(self, insert_paper, reader):
        pid = insert_paper(doi='10.1/a', is_seed=1, title='A')  # missing abstract..
        needs = reader.build_items([pid])[0].needs
        # both metadata providers want the still-NULL fields
        assert ('oa', 'abstract') in needs
        assert ('s2_live', 'abstract') in needs
        assert ('oa', 'year') in needs
        # title present -> not a need; crossref biblio wanted
        assert ('crossref', 'volume') in needs

    def test_non_seed_gets_no_metadata_only_doi(self, insert_paper, reader):
        # Ghosts (is_seed=0) get NO metadata enrichment at all — not OA/S2, not
        # NCBI, not crossref biblio. They only ever get their DOI resolved.
        pid = insert_paper(doi='10.1/a', is_seed=0, title='A')
        needs = reader.build_items([pid])[0].needs
        assert ('oa', 'abstract') not in needs
        assert ('s2_live', 'abstract') not in needs
        assert ('ncbi', 'abstract') not in needs
        assert ('crossref', 'volume') not in needs
        # the broad s2 hop still applies (not metadata; the hop tool is separate)
        assert ('s2_hop', '_all') in needs

    def test_incoming_citations_seed_only(self, insert_paper, reader):
        seed = insert_paper(oa_id='W1', doi='10.1/a', is_seed=1, title='A')
        ghost = insert_paper(oa_id='W2', doi='10.1/b', is_seed=0, title='B')
        assert ('oa_incoming', 'cites') in reader.build_items([seed])[0].needs
        assert ('oa_incoming', 'cites') not in reader.build_items([ghost])[0].needs

    def test_resolve_dois_when_no_doi(self, insert_paper, reader):
        pid = insert_paper(s2_id='S1', title='A', year=2020)  # no doi
        needs = reader.build_items([pid])[0].needs
        assert ('oa', '_all') in needs        # resolve_dois_oa
        assert ('s2_live', '_all') in needs   # resolve_dois_s2 / via_s2id

    def test_rejected_paper_no_needs(self, insert_paper, reader):
        pid = insert_paper(doi='10.1/a', is_seed=1, is_rejected=1, title='A')
        assert reader.build_items([pid])[0].needs == set()


class TestAttemptBlocking:
    def test_succeeded_removes_that_service_field(
        self, insert_paper, reader, claims_conn,
    ):
        pid = insert_paper(doi='10.1/a', is_seed=1, title='A')
        _attempt(claims_conn, pid, 'oa', 'abstract', 'succeeded',
                 finished_at=datetime.now(timezone.utc).isoformat())
        needs = reader.build_items([pid])[0].needs
        assert ('oa', 'abstract') not in needs       # settled by oa
        assert ('s2_live', 'abstract') in needs      # s2 still free to try

    def test_claimed_blocks(self, insert_paper, reader, claims_conn):
        pid = insert_paper(doi='10.1/a', is_seed=1, title='A')
        _attempt(claims_conn, pid, 'oa', 'abstract', 'claimed')
        assert ('oa', 'abstract') not in reader.build_items([pid])[0].needs

    def test_stale_claim_no_longer_blocks(
        self, insert_paper, reader, claims_conn,
    ):
        # A 'claimed' row that outlived its producer (older than the stale
        # window) must NOT pin the paper — it becomes eligible again, the way
        # claim_candidates() reclaims expired claims on the legacy path.
        pid = insert_paper(doi='10.1/a', is_seed=1, title='A')
        old = (datetime.now(timezone.utc) - timedelta(hours=12)).isoformat()
        _attempt(claims_conn, pid, 'oa', 'abstract', 'claimed', claimed_at=old)
        assert ('oa', 'abstract') in reader.build_items([pid])[0].needs

    def test_failed_recent_blocks_but_old_retries(
        self, insert_paper, reader, claims_conn,
    ):
        pid = insert_paper(doi='10.1/a', is_seed=1, title='A')
        recent = datetime.now(timezone.utc).isoformat()
        _attempt(claims_conn, pid, 'oa', 'abstract', 'failed', finished_at=recent)
        assert ('oa', 'abstract') not in reader.build_items([pid])[0].needs
        # Move the failure well past the retry window -> eligible again.
        old = (datetime.now(timezone.utc) - timedelta(days=3650)).isoformat()
        _attempt(claims_conn, pid, 'oa', 'abstract', 'failed', finished_at=old)
        assert ('oa', 'abstract') in reader.build_items([pid])[0].needs


class TestDirtyConsumer:
    def test_canonicalises_on_pop(self, insert_paper, reader, cache, db_conn):
        loser = insert_paper(doi='10.1/lose', title='L')
        winner = insert_paper(doi='10.1/win', title='W')
        db_conn.execute(
            "INSERT INTO aliases (loser_id, winner_id, created_at) "
            "VALUES (?, ?, datetime('now'))", (loser, winner))
        db_conn.commit()
        # The reader was built before the alias existed; next_dirty_batch reloads
        # the map when the alias count changes, then canonicalises the popped id.
        cache.add_dirty_papers([loser])
        batch = reader.next_dirty_batch(10)
        assert winner in batch
        assert loser not in batch
        # The winner was re-added to the set for re-evaluation.
        assert winner in set(cache.pop_dirty_papers(10))

    def test_seed_bootstrap_once(self, insert_paper, reader, cache):
        a = insert_paper(doi='10.1/a', title='A')
        b = insert_paper(doi='10.1/b', title='B')
        n = reader.seed_corpus_if_needed()
        assert n == 2 and cache.dirty_seeded()
        assert set(cache.pop_dirty_papers(100)) == {a, b}
        # Idempotent: a second call seeds nothing.
        cache.add_dirty_papers([])  # noop
        assert reader.seed_corpus_if_needed() == 0
