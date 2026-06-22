"""
The Phase 2 cutover-safety gate: the Reader's needs set must EQUAL the SQL
registry's eligibility (CANDIDATE_QUERIES) for every paper. This is what lets the
Reader subsume the per-module candidate queries.

Builds a corpus spanning every identifier/flag combination the registry gates on,
sprinkles enrichment_attempts of each status, and asserts shadow.compare_needs
reports zero mismatches — plus that the SQL ground truth is itself non-trivial.
"""
from datetime import datetime, timezone, timedelta

import pytest

from biblion.enrich.reader import Reader
from biblion.enrich import shadow
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


@pytest.fixture
def reader(cache, tmp_db_path, claims_db_path):
    r = Reader(cache, tmp_db_path, claims_db_path=claims_db_path)
    yield r
    r.close()


def _attempt(claims_conn, paper_id, service, field, status, finished_at=None):
    claims_conn.execute(
        "INSERT OR REPLACE INTO enrichment_attempts "
        "(paper_id, service, field, status, claimed_at, finished_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (paper_id, service, field, status,
         datetime.now(timezone.utc).isoformat(), finished_at))
    claims_conn.commit()


def _seed_corpus(insert_paper):
    """A spread of states the registry predicates discriminate on."""
    ids = []
    # seed with doi, fully missing metadata + biblio
    ids.append(insert_paper(doi='10.1/1', is_seed=1))
    # non-seed (ghost) with doi: ALL metadata gated out incl crossref/ncbi
    ids.append(insert_paper(doi='10.1/2', is_seed=0))
    # seed, partial metadata present
    ids.append(insert_paper(doi='10.1/3', is_seed=1, title='T', year=2020,
                            abstract='a'))
    # no doi, has title -> resolve_dois_oa/s2
    ids.append(insert_paper(s2_id='S4', title='Four', year=2019, is_seed=1))
    # ghost: pmid, no doi -> resolve_dois_via_pmid only (ncbi metadata gated out)
    ids.append(insert_paper(pubmed_id='P5', title='Five', is_seed=0))
    # oa_id only, no title -> enrich_stubs_oa + (seed) incoming cites
    ids.append(insert_paper(oa_id='W6', is_seed=1))
    # s2_id only, no doi -> resolve_dois_via_s2id + hop
    ids.append(insert_paper(s2_id='S7', is_seed=0))
    # rejected paper -> nothing
    ids.append(insert_paper(doi='10.1/8', is_seed=1, is_rejected=1))
    # fully enriched seed (doi+all metadata+biblio) -> only hop/incoming
    ids.append(insert_paper(doi='10.1/9', is_seed=1, title='T', year=2020,
                            abstract='a', authors='["X"]', venue='V',
                            pub_type='article', volume='1', first_page='1',
                            publisher='Pub', oa_id='W9'))
    return ids


class TestNeedsParity:
    def test_parity_no_attempts(self, insert_paper, reader, cache):
        ids = _seed_corpus(insert_paper)
        mismatches = shadow.compare_needs(reader, ids)
        assert mismatches == {}, mismatches
        # Sanity: the ground truth is non-empty (the corpus does need work).
        truth = shadow.sql_needs(reader._conn, ids)
        assert any(truth.values())

    def test_parity_with_mixed_attempts(
        self, insert_paper, reader, claims_conn,
    ):
        ids = _seed_corpus(insert_paper)
        now = datetime.now(timezone.utc).isoformat()
        old = (datetime.now(timezone.utc) - timedelta(days=3650)).isoformat()
        # succeeded (settles), claimed (in flight), failed-recent (blocks),
        # failed-old (retriable) — across several services/fields/papers.
        _attempt(claims_conn, ids[0], 'oa', 'abstract', 'succeeded', now)
        _attempt(claims_conn, ids[0], 's2_live', 'venue', 'claimed')
        _attempt(claims_conn, ids[0], 'oa', 'year', 'failed', now)
        _attempt(claims_conn, ids[0], 'crossref', 'volume', 'failed', old)
        _attempt(claims_conn, ids[3], 'oa', '_all', 'succeeded', now)
        _attempt(claims_conn, ids[5], 'oa_incoming', 'cites', 'claimed')
        mismatches = shadow.compare_needs(reader, ids)
        assert mismatches == {}, mismatches

    def test_assert_helper_counts_mismatch(
        self, insert_paper, reader, cache, monkeypatch,
    ):
        ids = _seed_corpus(insert_paper)
        # Force a mismatch by corrupting one spec's precondition in the Reader.
        import biblion.enrich.reader as rmod
        bad = tuple(s for s in rmod.NEEDS_SPEC
                    if s.module != 'enrich_biblio_crossref')
        monkeypatch.setattr(reader, 'needs_for',
                            lambda item: _needs_with(reader, item, bad))
        mismatches = shadow.assert_needs_parity(reader, ids, cache=cache)
        assert mismatches  # crossref needs now missing -> divergence
        assert cache.get_counter(shadow.NEEDS_MISMATCH_COUNTER) == len(mismatches)


def _needs_with(reader, item, specs):
    """Recompute needs using a restricted spec list (test helper)."""
    from biblion.framework.claims import (_retry_cutoff_iso,
                                           stale_claim_cutoff_iso)
    retry_iso = _retry_cutoff_iso()
    stale_iso = stale_claim_cutoff_iso()
    needs = set()
    for spec in specs:
        if not spec.precond(item.cols):
            continue
        for f in spec.fields:
            if (spec.service, f) in needs:
                continue
            if not spec.need(item.cols, f):
                continue
            if reader._attempt_blocks(item, spec.service, f, retry_iso, stale_iso):
                continue
            needs.add((spec.service, f))
    return needs
