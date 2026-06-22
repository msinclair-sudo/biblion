"""
Dispatcher (Phase 4) with a stubbed crossref client — no network.

Covers: handler enriches + marks, double-dispatch prevention (claimed-blocking
across passes), crash-rehydrate of in-flight, termination (a settled paper isn't
re-dispatched), and that only the cutover endpoints are handled.
"""
from datetime import datetime, timezone

import pytest

from biblion.enrich.dispatcher import Dispatcher, parse_endpoints
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]

EP = 'enrich_biblio_crossref'


class StubCrossref:
    """Returns canned Crossref works keyed by DOI; counts batch calls."""
    def __init__(self, by_doi):
        self.by_doi = by_doi
        self.calls = 0

    def fetch_batch_by_doi(self, dois):
        self.calls += 1
        return {d: self.by_doi[d] for d in dois if d in self.by_doi}


def _work(doi, volume='12', page='100-110', publisher='Acme'):
    return {'DOI': doi, 'volume': volume, 'page': page, 'publisher': publisher}


def _dispatcher(cache, tmp_db_path, claims_db_path, stub, endpoints=(EP,)):
    return Dispatcher(cache, tmp_db_path, list(endpoints),
                      claims_db_path=claims_db_path,
                      clients={EP: stub})


def _attempts(claims_conn, service='crossref'):
    return {(r['paper_id'], r['field']): r['status'] for r in claims_conn.execute(
        "SELECT paper_id, field, status FROM enrichment_attempts "
        "WHERE service = ?", (service,))}


class TestParseEndpoints:
    def test_known(self):
        assert parse_endpoints('enrich_biblio_crossref') == [EP]

    def test_unknown_raises(self):
        with pytest.raises(ValueError):
            parse_endpoints('not_a_real_endpoint')

    def test_empty(self):
        assert parse_endpoints('') == []


class TestDispatchCrossref:
    def test_enriches_and_marks(self, cache, tmp_db_path, claims_db_path,
                                insert_paper, claims_conn):
        # crossref biblio is seed-only, so these must be seeds.
        p1 = insert_paper(doi='10.1/a', is_seed=1)   # missing volume/first_page/publisher
        p2 = insert_paper(doi='10.1/b', is_seed=1)
        stub = StubCrossref({'10.1/a': _work('10.1/a'), '10.1/b': _work('10.1/b')})
        d = _dispatcher(cache, tmp_db_path, claims_db_path, stub)
        try:
            n = d.run_pass()
        finally:
            d.close()
        assert n == 2
        assert stub.calls == 1
        # Records pushed for the writer to apply.
        recs = cache.pop_papers_batch(100)
        assert {r.doi for r in recs} == {'10.1/a', '10.1/b'}
        # Each crossref field marked succeeded.
        at = _attempts(claims_conn)
        for pid in (p1, p2):
            for f in ('volume', 'first_page', 'publisher'):
                assert at[(pid, f)] == 'succeeded'

    def test_missing_from_crossref_marks_failed(
        self, cache, tmp_db_path, claims_db_path, insert_paper, claims_conn,
    ):
        p1 = insert_paper(doi='10.1/a', is_seed=1)
        stub = StubCrossref({})                  # crossref returns nothing
        d = _dispatcher(cache, tmp_db_path, claims_db_path, stub)
        try:
            d.run_pass()
        finally:
            d.close()
        at = _attempts(claims_conn)
        assert at[(p1, 'volume')] == 'failed'

    def test_no_redispatch_after_settled(
        self, cache, tmp_db_path, claims_db_path, insert_paper,
    ):
        # R1 / termination: once crossref fields are settled, re-adding the
        # paper to the dirty set must NOT trigger a second provider call.
        p1 = insert_paper(doi='10.1/a', is_seed=1)
        stub = StubCrossref({'10.1/a': _work('10.1/a')})
        d = _dispatcher(cache, tmp_db_path, claims_db_path, stub)
        try:
            d.run_pass()
            assert stub.calls == 1
            cache.add_dirty_papers([p1])         # simulate writer re-SADD
            n2 = d.run_pass()
        finally:
            d.close()
        assert n2 == 0
        assert stub.calls == 1                   # not called again

    def test_only_cutover_endpoint_handled(
        self, cache, tmp_db_path, claims_db_path, insert_paper, claims_conn,
    ):
        # A seed missing metadata needs oa/s2/ncbi too, but with only crossref
        # cut over, no non-crossref attempt rows are written by the dispatcher.
        insert_paper(doi='10.1/a', is_seed=1)
        stub = StubCrossref({'10.1/a': _work('10.1/a')})
        d = _dispatcher(cache, tmp_db_path, claims_db_path, stub)
        try:
            d.run_pass()
        finally:
            d.close()
        services = {r['service'] for r in claims_conn.execute(
            "SELECT DISTINCT service FROM enrichment_attempts")}
        assert services == {'crossref'}


class TestDispatchMetadataWithCitations:
    def test_oa_meta_pushes_papers_and_citations(
        self, cache, tmp_db_path, claims_db_path, insert_paper, claims_conn,
    ):
        # A seed paper with a DOI but no metadata -> routed to enrich_metadata_oa.
        pid = insert_paper(doi='10.1/a', is_seed=1)

        class StubOA:
            breaker_open = False
            def fetch_batch_by_doi(self, dois, select=None):
                return {d: {'id': 'https://openalex.org/W1',
                            'doi': f'https://doi.org/{d}', 'title': 'T',
                            'publication_year': 2020,
                            'authorships': [{'author': {'display_name': 'A'}}],
                            'primary_location': {'source': {'display_name': 'V'}},
                            'abstract_inverted_index': None, 'type': 'article',
                            'cited_by_count': 1,
                            'referenced_works': ['https://openalex.org/W9'],
                            'biblio': {}, 'ids': {}} for d in dois}

        d = Dispatcher(cache, tmp_db_path, ['enrich_metadata_oa'],
                       claims_db_path=claims_db_path,
                       clients={'enrich_metadata_oa': StubOA()})
        try:
            d.run_pass()
        finally:
            d.close()
        assert {r.doi for r in cache.pop_papers_batch(100)} == {'10.1/a'}
        cits = cache.pop_citations_batch(100)
        assert len(cits) == 1                       # one referenced work edge
        # year/authors/venue/pub_type settled; abstract failed (none in stub).
        at = _attempts(claims_conn, service='oa')
        assert at.get((pid, 'year')) == 'succeeded'
        assert at.get((pid, 'abstract')) == 'failed'


class TestBatchChunking:
    def test_handler_called_in_endpoint_batch_chunks(
        self, cache, tmp_db_path, claims_db_path, insert_paper,
    ):
        # crossref batch size is 20; route 45 papers -> 3 handler calls (20+20+5),
        # never one 45-DOI request (which the legacy producer's claim batch capped).
        for i in range(45):
            insert_paper(doi=f'10.1/{i}', is_seed=1)
        stub = StubCrossref({f'10.1/{i}': _work(f'10.1/{i}') for i in range(45)})
        d = _dispatcher(cache, tmp_db_path, claims_db_path, stub)
        try:
            d.run_pass()
        finally:
            d.close()
        assert stub.calls == 3                 # 20 + 20 + 5, not 1
        assert len(cache.pop_papers_batch(100)) == 45


class TestDailyLimitResilience:
    """A provider exhausting its daily budget mid-pass must not crash the
    multi-provider dispatcher (DailyLimitReached is a BaseException that slips
    past `except Exception`)."""

    def test_daily_limit_defers_provider_without_crashing(
        self, cache, tmp_db_path, claims_db_path, insert_paper, claims_conn,
    ):
        from biblion.clients.ratelimit import DailyLimitReached

        class RaisingCrossref:
            def fetch_batch_by_doi(self, dois):
                raise DailyLimitReached('crossref')

        insert_paper(doi='10.1/a', is_seed=1)
        d = _dispatcher(cache, tmp_db_path, claims_db_path, RaisingCrossref())
        try:
            n = d.run_pass()                 # must NOT raise
        finally:
            d.close()
        assert n == 0
        assert d.stats['deferred_budget'] >= 1
        # The claim is left 'claimed' to expire and retry once the budget
        # resets — not marked failed.
        at = _attempts(claims_conn)
        assert at and all(s == 'claimed' for s in at.values())


class TestInflightRehydrate:
    def test_rehydrate_from_claimed(self, cache, tmp_db_path, claims_db_path,
                                    insert_paper, claims_conn):
        p1 = insert_paper(doi='10.1/a')
        now = datetime.now(timezone.utc).isoformat()
        claims_conn.execute(
            "INSERT INTO enrichment_attempts "
            "(paper_id, service, field, status, claimed_at) "
            "VALUES (?, 'crossref', 'volume', 'claimed', ?)", (p1, now))
        claims_conn.commit()
        stub = StubCrossref({})
        d = _dispatcher(cache, tmp_db_path, claims_db_path, stub)
        try:
            n = d.rehydrate_inflight()
        finally:
            d.close()
        assert n == 1
        assert (p1, 'crossref', 'volume') in d._inflight
