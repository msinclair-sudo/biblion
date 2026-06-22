"""
Phase 3 cutover-safety gate: with unlimited budget the solver's routed coverage
must EQUAL each paper's needs at the (service, field) grain (nothing dropped,
nothing invented) and never route an ineligible endpoint. Built on the same
state-spanning corpus as the needs-parity gate.
"""
from datetime import datetime, timezone

import pytest

from biblion.enrich.reader import Reader
from biblion.enrich.catalogue import CATALOGUE
from biblion.enrich import shadow
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


@pytest.fixture
def reader(cache, tmp_db_path, claims_db_path):
    r = Reader(cache, tmp_db_path, claims_db_path=claims_db_path)
    yield r
    r.close()


def _seed_corpus(insert_paper):
    ids = []
    ids.append(insert_paper(doi='10.1/1', is_seed=1))
    ids.append(insert_paper(doi='10.1/2', is_seed=0))
    ids.append(insert_paper(doi='10.1/3', is_seed=1, title='T', year=2020,
                            abstract='a'))
    ids.append(insert_paper(s2_id='S4', title='Four', year=2019, is_seed=1))
    ids.append(insert_paper(pubmed_id='P5', title='Five', is_seed=0))
    ids.append(insert_paper(oa_id='W6', is_seed=1))
    ids.append(insert_paper(s2_id='S7', is_seed=0))
    ids.append(insert_paper(doi='10.1/8', is_seed=1, is_rejected=1))
    ids.append(insert_paper(doi='10.1/9', is_seed=1, title='T', year=2020,
                            abstract='a', authors='["X"]', venue='V',
                            pub_type='article', volume='1', first_page='1',
                            publisher='Pub', oa_id='W9'))
    return ids


def test_routing_covers_needs_exactly(insert_paper, reader):
    ids = _seed_corpus(insert_paper)
    _decisions, mismatches = shadow.compare_routing(
        reader, ids, CATALOGUE, budgets=None)
    assert mismatches == {}, mismatches


def test_routing_parity_with_attempts(insert_paper, reader, claims_conn):
    ids = _seed_corpus(insert_paper)
    now = datetime.now(timezone.utc).isoformat()
    for pid, svc, fld, st in [
        (ids[0], 'oa', 'abstract', 'succeeded'),
        (ids[0], 's2_live', 'venue', 'claimed'),
        (ids[5], 'oa_incoming', 'cites', 'succeeded'),
    ]:
        claims_conn.execute(
            "INSERT OR REPLACE INTO enrichment_attempts "
            "(paper_id, service, field, status, claimed_at, finished_at) "
            "VALUES (?, ?, ?, ?, ?, ?)", (pid, svc, fld, st, now, now))
    claims_conn.commit()
    _decisions, mismatches = shadow.compare_routing(
        reader, ids, CATALOGUE, budgets=None)
    assert mismatches == {}, mismatches


def test_no_redundant_oa_metadata_call(insert_paper, reader):
    # A seed missing all metadata is routed to enrich_metadata_oa exactly once
    # (greedy collapses the 5 oa fields into one call), plus the s2 counterpart.
    pid = insert_paper(doi='10.1/x', is_seed=1)
    decisions, _ = shadow.compare_routing(reader, [pid], CATALOGUE, budgets=None)
    names = [n for n, pids in decisions if pid in pids]
    assert names.count('enrich_metadata_oa') == 1
    assert names.count('enrich_metadata_s2') == 1


def test_assert_helper_counts_routing_mismatch(insert_paper, reader, cache):
    ids = _seed_corpus(insert_paper)
    # Drop crossref from the catalogue -> biblio needs become uncovered ->
    # mismatch surfaces and is counted. assert_routing_parity uses the catalogue
    # we pass it, so no monkeypatching is required.
    broken = {k: v for k, v in CATALOGUE.items() if k != 'enrich_biblio_crossref'}
    mism = shadow.assert_routing_parity(reader, ids, broken, cache=cache)
    assert mism
    assert cache.get_counter(shadow.ROUTING_MISMATCH_COUNTER) == len(mism)
