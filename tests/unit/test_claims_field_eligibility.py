"""Per-(paper, service, field) claim eligibility.

These pin the behaviour that fixed the abstract-coverage ceiling: a paper that
Semantic Scholar already 'succeeded' on (author/venue/year) but that still
lacks an abstract must remain eligible for OpenAlex to fetch the abstract.
Failures become retriable after a configurable interval; a 'succeeded' field
is never retried.
"""
import pytest

from biblion.framework.claims import claim_candidates, CANDIDATE_QUERIES

pytestmark = pytest.mark.unit


OA_SPEC = CANDIDATE_QUERIES['enrich_metadata_oa']
OA_FIELDS = OA_SPEC['fields']


def _claim_oa(conn, limit=10, retry_days=180):
    return claim_candidates(
        conn, OA_SPEC['service'],
        candidate_sql=OA_SPEC['candidate_sql'],
        order_by=OA_SPEC['order_by'],
        limit=limit, fields=OA_FIELDS, retry_days=retry_days,
    )


def _attempt(conn, paper_id, service, field, status, finished_at='2020-01-01T00:00:00+00:00'):
    conn.execute(
        "INSERT OR REPLACE INTO enrichment_attempts "
        "(paper_id, service, field, status, claimed_at, finished_at) "
        "VALUES (?,?,?,?,?,?)",
        (paper_id, service, field, status, '2020-01-01T00:00:00+00:00', finished_at),
    )
    conn.commit()


def test_abstract_still_eligible_for_oa_after_s2_succeeded(insert_paper, claims_conn):
    """The core regression: S2 filled author/venue/year but no abstract.
    OpenAlex must still be offered the paper to fetch the abstract."""
    pid = insert_paper(doi='10.1/a', title='T', authors='["A"]', is_seed=1,
                       venue='J', year=2020, abstract=None, pub_type='article')
    # S2 succeeded on the non-abstract fields, failed (recently) on abstract.
    for f in ('authors', 'venue', 'year'):
        _attempt(claims_conn, pid, 's2_live', f, 'succeeded')
    _attempt(claims_conn, pid, 's2_live', 'abstract', 'failed',
             finished_at='2030-01-01T00:00:00+00:00')  # recent -> S2 won't retry

    rows = _claim_oa(claims_conn)
    assert pid in [r['id'] for r in rows], "OA should be offered the abstract"

    # OA claimed ONLY the abstract field (authors/venue/year are not NULL).
    claimed = claims_conn.execute(
        "SELECT field, status FROM enrichment_attempts "
        "WHERE paper_id=? AND service='oa'", (pid,)).fetchall()
    claimed_fields = {r[0]: r[1] for r in claimed}
    assert claimed_fields == {'abstract': 'claimed'}, claimed_fields


def test_fully_populated_paper_not_offered(insert_paper, claims_conn):
    pid = insert_paper(doi='10.1/b', title='T', authors='["A"]', venue='J',
                       year=2020, abstract='full text', pub_type='article')
    rows = _claim_oa(claims_conn)
    assert pid not in [r['id'] for r in rows]


def test_service_does_not_retry_recent_failed_field(insert_paper, claims_conn):
    """If OA already tried abstract recently and failed, OA isn't re-offered
    (cheap), but the paper stays eligible for OTHER services."""
    pid = insert_paper(doi='10.1/c', title='T', authors='["A"]', venue='J',
                       year=2020, abstract=None, pub_type='article')
    _attempt(claims_conn, pid, 'oa', 'abstract', 'failed',
             finished_at='2030-01-01T00:00:00+00:00')  # recent

    rows = _claim_oa(claims_conn, retry_days=180)
    assert pid not in [r['id'] for r in rows], "recent OA failure: no retry"


def test_failed_field_retriable_after_interval(insert_paper, claims_conn):
    """An OLD failed attempt becomes retriable (sources backfill over time)."""
    pid = insert_paper(doi='10.1/d', title='T', authors='["A"]', venue='J', is_seed=1,
                       year=2020, abstract=None, pub_type='article')
    _attempt(claims_conn, pid, 'oa', 'abstract', 'failed',
             finished_at='2020-01-01T00:00:00+00:00')  # very old

    rows = _claim_oa(claims_conn, retry_days=180)
    assert pid in [r['id'] for r in rows], "old OA failure should be retriable"


def test_succeeded_field_never_retried(insert_paper, claims_conn):
    """A field OA succeeded on is never re-offered even with the field NULL.

    (Abstract is NULL on the paper but OA already 'succeeded' — meaning OA's
    response simply had no abstract; we don't keep re-asking the same source.
    Other still-wanted fields keep the paper eligible.)"""
    pid = insert_paper(doi='10.1/e', title='T', authors=None, venue='J', is_seed=1,
                       year=2020, abstract=None, pub_type='article')
    _attempt(claims_conn, pid, 'oa', 'abstract', 'succeeded',
             finished_at='2000-01-01T00:00:00+00:00')  # ancient, still no retry

    rows = _claim_oa(claims_conn)
    # Paper is still offered (authors is NULL+untried) ...
    assert pid in [r['id'] for r in rows]
    # ... but OA does NOT re-claim the already-succeeded abstract field.
    claimed = claims_conn.execute(
        "SELECT field FROM enrichment_attempts "
        "WHERE paper_id=? AND service='oa' AND status='claimed'", (pid,)).fetchall()
    assert 'abstract' not in [r[0] for r in claimed]
    assert 'authors' in [r[0] for r in claimed]


def test_fresh_claim_by_other_service_blocks_paper(insert_paper, claims_conn):
    """Two services shouldn't double-spend: a fresh claim by S2 hides the
    paper from OA until that claim expires."""
    import datetime as _dt
    pid = insert_paper(doi='10.1/f', title='T', authors=None, venue=None,
                       year=None, abstract=None, pub_type=None)
    now = _dt.datetime.now(_dt.timezone.utc).isoformat()
    claims_conn.execute(
        "INSERT INTO enrichment_attempts "
        "(paper_id, service, field, status, claimed_at) VALUES (?,?,?,?,?)",
        (pid, 's2_live', 'abstract', 'claimed', now))
    claims_conn.commit()

    rows = _claim_oa(claims_conn)
    assert pid not in [r['id'] for r in rows], "fresh S2 claim should block OA"
