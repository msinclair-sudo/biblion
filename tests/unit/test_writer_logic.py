"""
Tests for MergeWriter logic, running run_cycle() in-process against a
temp DB and real Redis db=15.

These cover the per-cycle correctness of:
  - paper insertion + COALESCE update
  - in-batch deduplication
  - field conflict logging
  - citation resolution into citations vs pending_citations
  - promote-action application
  - commit-failure handling
  - claim flow round trip

Plus regression tests for the specific bugs we hit:
  - cycle no longer calls init_db (would be a perf regression)
  - connection cleanup on exception
"""
import sqlite3

import pytest

from biblion.cache.records import (
    PaperRecord, CitationRecord, PromoteCitationAction, ClaimRequest,
    PendingDoiBackfill,
)
from biblion.merge.writer import MergeWriter
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


# ---------------------------------------------------------------------------
# Paper merging
# ---------------------------------------------------------------------------

class TestPaperMerging:
    def test_new_paper_inserted(self, tmp_db_path, claims_db_path, cache,
                                count_rows):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='t', doi='10.1/a', title='X'))
        w.run_cycle()
        assert count_rows('papers') == 1
        assert w.stats.new_papers == 1

    def test_single_hit_coalesces_nulls(self, tmp_db_path, claims_db_path,
                                        cache, insert_paper, db_conn):
        # Pre-existing title has no observation row (inserted directly), so the
        # resolver only sees the incoming record for year/abstract. title is
        # left untouched because the incoming record doesn't observe it.
        insert_paper(doi='10.1/a', title='Existing')
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(
            source='oa', doi='10.1/a', year=2024, abstract='new abs',
        ))
        w.run_cycle()
        row = db_conn.execute(
            "SELECT title, year, abstract FROM papers WHERE doi='10.1/a'"
        ).fetchone()
        assert row['title'] == 'Existing'       # not observed by incoming, kept
        assert row['year'] == 2024              # filled from sole observation
        assert row['abstract'] == 'new abs'

    def test_conflict_logged_when_equal_trust_sources_disagree(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        # Two observations from the SAME trust bucket (both openalex) that
        # disagree -> genuine post-resolution conflict. First-arriving value
        # wins the tie (stable sort), conflict is logged.
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='oa_a', doi='10.1/a', year=2020))
        w.run_cycle()
        cache.push_paper(PaperRecord(source='oa_b', doi='10.1/a', year=2099))
        w.run_cycle()
        n = db_conn.execute(
            "SELECT COUNT(*) FROM field_conflicts WHERE field='year'"
        ).fetchone()[0]
        assert n == 1

    def test_higher_trust_source_wins_no_conflict(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        # s2 says 2020, then openalex (higher trust) says 2099 -> openalex
        # wins, and a lower-trust disagreement is NOT a conflict.
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='s2_x', doi='10.1/a', year=2020))
        w.run_cycle()
        cache.push_paper(PaperRecord(source='oa_x', doi='10.1/a', year=2099))
        w.run_cycle()
        row = db_conn.execute(
            "SELECT year FROM papers WHERE doi='10.1/a'"
        ).fetchone()
        assert row['year'] == 2099
        n = db_conn.execute(
            "SELECT COUNT(*) FROM field_conflicts WHERE field='year'"
        ).fetchone()[0]
        assert n == 0

    def test_observations_recorded_on_insert_and_update(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='oa_x', doi='10.1/a',
                                     title='T', year=2020))
        w.run_cycle()
        cache.push_paper(PaperRecord(source='s2_x', doi='10.1/a', year=2021))
        w.run_cycle()
        # title observed once (oa), year observed twice (oa + s2).
        n_title = db_conn.execute(
            "SELECT COUNT(*) FROM field_observations WHERE field='title'"
        ).fetchone()[0]
        n_year = db_conn.execute(
            "SELECT COUNT(*) FROM field_observations WHERE field='year'"
        ).fetchone()[0]
        assert n_title == 1
        assert n_year == 2


# ---------------------------------------------------------------------------
# Citation processing
# ---------------------------------------------------------------------------

class TestCitationProcessing:
    def test_edge_created_when_both_endpoints_present(
        self, tmp_db_path, claims_db_path, cache, insert_paper, count_rows,
    ):
        a = insert_paper(doi='10.1/a', title='A')
        b = insert_paper(doi='10.1/b', title='B')
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_citation(CitationRecord(
            source='oa', citing_doi='10.1/a', cited_doi='10.1/b',
        ))
        w.run_cycle()
        assert count_rows('citations') == 1

    def test_unresolvable_edge_goes_to_pending(
        self, tmp_db_path, claims_db_path, cache, insert_paper, count_rows,
    ):
        insert_paper(doi='10.1/a', title='A')
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_citation(CitationRecord(
            source='oa', citing_doi='10.1/a', cited_doi='10.1/missing',
        ))
        w.run_cycle()
        assert count_rows('citations') == 0
        assert count_rows('pending_citations') == 1


# ---------------------------------------------------------------------------
# Promote-action application
# ---------------------------------------------------------------------------

class TestPromoteActions:
    def test_action_promotes_pending_to_citation(
        self, tmp_db_path, claims_db_path, cache,
        insert_paper, insert_pending_citation, count_rows,
    ):
        a = insert_paper(doi='10.1/a')
        b = insert_paper(doi='10.1/b')
        pid = insert_pending_citation(
            citing_doi='10.1/a', cited_doi='10.1/b',
            provenance='pending_resolver',
        )
        cache.push_promote_citation(PromoteCitationAction(
            pending_id=pid, citing_id=a, cited_id=b,
            provenance='pending_resolver',
        ))

        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        w.run_cycle()
        assert count_rows('citations') == 1
        assert count_rows('pending_citations') == 0
        assert w.stats.promote_actions_applied == 1

    def test_action_for_stale_pending_id_is_safe(
        self, tmp_db_path, claims_db_path, cache, insert_paper,
    ):
        a = insert_paper(doi='10.1/a')
        b = insert_paper(doi='10.1/b')
        cache.push_promote_citation(PromoteCitationAction(
            pending_id=9999, citing_id=a, cited_id=b,
            provenance='pending_resolver',
        ))
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        w.run_cycle()  # must not raise
        assert w.stats.promote_actions_applied == 1

    def test_action_with_vanished_endpoint_does_not_crash_cycle(
        self, tmp_db_path, claims_db_path, cache,
        insert_paper, insert_pending_citation, count_rows,
    ):
        """Regression: the Resolver can delete a paper between when the
        pending_resolver resolves an edge and when the writer applies the
        promotion. The citations FK then fails — which used to abort the whole
        cycle (writer exit 1, all producers stall). It must be caught per-action:
        the bad promotion is skipped, its pending row left for re-resolution, and
        a valid promotion in the same batch still lands."""
        a = insert_paper(doi='10.1/a')
        b = insert_paper(doi='10.1/b')
        good_pid = insert_pending_citation(
            citing_doi='10.1/a', cited_doi='10.1/b', provenance='pending_resolver')
        stale_pid = insert_pending_citation(
            citing_doi='10.1/a', cited_doi='10.9/gone', provenance='pending_resolver')
        # Valid action + one pointing at a cited_id that doesn't exist (999).
        cache.push_promote_citation(PromoteCitationAction(
            pending_id=good_pid, citing_id=a, cited_id=b, provenance='pending_resolver'))
        cache.push_promote_citation(PromoteCitationAction(
            pending_id=stale_pid, citing_id=a, cited_id=999, provenance='pending_resolver'))

        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        w.run_cycle()                                  # must NOT raise

        assert count_rows('citations') == 1            # only the valid edge
        assert w.stats.promotions_stale_endpoint == 1
        # Valid pending row consumed; the stale one is left to re-resolve later.
        assert count_rows('pending_citations', 'id = %d' % good_pid) == 0
        assert count_rows('pending_citations', 'id = %d' % stale_pid) == 1


# ---------------------------------------------------------------------------
# DOI backfill application (resolve_pending_dois -> writer)
# ---------------------------------------------------------------------------

class TestDoiBackfills:
    def test_backfill_stamps_doi_on_both_sides(
        self, tmp_db_path, claims_db_path, cache, insert_pending_citation, db_conn,
    ):
        # Same OA work appears as a cited endpoint in one row and a citing
        # endpoint in another; both lack a DOI.
        cited_id  = insert_pending_citation(citing_doi='10.1/a', cited_oa_id='W500')
        citing_id = insert_pending_citation(citing_oa_id='W500', cited_doi='10.1/b')
        # And a row that already has the DOI on that side — must not be clobbered.
        keep_id   = insert_pending_citation(citing_doi='10.1/c', cited_oa_id='W500',
                                            cited_doi='10.9/already')
        cache.push_pending_doi_backfills([PendingDoiBackfill(oa_id='W500', doi='10.9/resolved')])

        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        w.run_cycle()

        rows = {r['id']: r for r in db_conn.execute(
            "SELECT id, cited_doi, citing_doi FROM pending_citations")}
        assert rows[cited_id]['cited_doi']   == '10.9/resolved'   # stamped
        assert rows[citing_id]['citing_doi'] == '10.9/resolved'   # other side
        assert rows[keep_id]['cited_doi']    == '10.9/already'    # not clobbered
        assert w.stats.pending_dois_backfilled == 2               # two rows updated


# ---------------------------------------------------------------------------
# Regression tests for the bugs we fixed
# ---------------------------------------------------------------------------

class TestRegressionFixes:
    def test_run_cycle_does_not_call_init_db(
        self, tmp_db_path, claims_db_path, cache, monkeypatch,
    ):
        """Fix #4: init_db moved to __init__. Running run_cycle 100 times
        must not invoke init_db at all."""
        from biblion.merge import writer as writer_mod

        # Count calls to init_db
        calls = []
        orig = writer_mod.init_db
        def _spy(conn):
            calls.append(1)
            return orig(conn)
        monkeypatch.setattr(writer_mod, 'init_db', _spy)

        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        # __init__ runs init_db exactly once.
        init_calls_after_construction = len(calls)
        for _ in range(10):
            w.run_cycle()
        assert len(calls) == init_calls_after_construction, (
            "run_cycle is calling init_db; that's the bug we fixed."
        )

    def test_commit_failure_counted_and_propagated(
        self, tmp_db_path, claims_db_path, cache, monkeypatch,
        insert_paper,
    ):
        """Fix #5: a commit failure must increment commit_failures
        and re-raise so the supervisor can restart us."""
        from biblion.merge import writer as writer_mod

        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='t', doi='10.1/a'))

        # The writer holds ONE persistent connection (self._conn) reused across
        # cycles; wrap it so its commit() raises, simulating a disk-full commit.
        class BrokenConn:
            def __init__(self, real):
                self._real = real
            def __getattr__(self, name):
                return getattr(self._real, name)
            def commit(self):
                raise sqlite3.OperationalError('disk full')

        w._conn = BrokenConn(w._conn)

        with pytest.raises(sqlite3.OperationalError, match='disk full'):
            w.run_cycle()
        assert w.stats.commit_failures == 1


# ---------------------------------------------------------------------------
# Claim flow (served by the writer)
# ---------------------------------------------------------------------------

class TestClaimFlowFromWriter:
    def test_writer_serves_claim_request(
        self, tmp_db_path, claims_db_path, cache, insert_paper,
    ):
        """Push a ClaimRequest for resolve_dois_via_pmid; writer cycle
        should produce a ClaimGrant containing the matching paper."""
        # Seed a paper that resolve_dois_via_pmid's SQL would match.
        pid = insert_paper(pubmed_id='123', s2_id='s_123')
        w = MergeWriter(
            tmp_db_path, cache, batch_size=10,
            served_modules=['resolve_dois_via_pmid'],
        )
        cache.push_claim_request(ClaimRequest(
            service='resolve_dois_via_pmid', batch_size=10,
        ))
        w.run_cycle()
        grant = cache.pop_claim_grant('resolve_dois_via_pmid')
        assert grant is not None
        assert any(r['id'] == pid for r in grant.rows)


# ---------------------------------------------------------------------------
# Extended bibliographic fields + identifiers table
# ---------------------------------------------------------------------------

class TestExtendedFields:
    def test_new_paper_persists_biblio_columns(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(
            source='bib:t', doi='10.1/a', title='X',
            volume='12', issue='3', first_page='100', last_page='120',
            publisher='Springer', booktitle='BT', series='S', edition='2',
            language='en', month='07',
            editors_json='["Ng, Pat"]',
        ))
        w.run_cycle()
        row = db_conn.execute(
            "SELECT volume, issue, first_page, last_page, publisher, "
            "booktitle, series, edition, language, month, editors "
            "FROM papers WHERE doi = '10.1/a'").fetchone()
        assert row['volume'] == '12'
        assert row['first_page'] == '100' and row['last_page'] == '120'
        assert row['publisher'] == 'Springer'
        assert row['booktitle'] == 'BT' and row['series'] == 'S'
        assert row['edition'] == '2' and row['language'] == 'en'
        assert row['month'] == '07'
        import json as _json
        assert _json.loads(row['editors']) == ['Ng, Pat']

    def test_extra_identifiers_routed_to_table(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(
            source='s2_batch', doi='10.1/b', title='Y',
            extra_identifiers={'arxiv': ['2401.00001'], 'issn': ['1234-5678']},
        ))
        w.run_cycle()
        rows = dict(db_conn.execute(
            "SELECT scheme, value FROM identifiers "
            "WHERE paper_id = (SELECT id FROM papers WHERE doi='10.1/b')"
        ).fetchall())
        assert rows == {'arxiv': '2401.00001', 'issn': '1234-5678'}

    def test_identifiers_insert_or_ignore_dedupes(
        self, tmp_db_path, claims_db_path, cache, count_rows,
    ):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        for _ in range(2):
            cache.push_paper(PaperRecord(
                source='s2_batch', doi='10.1/c', title='Z',
                extra_identifiers={'issn': ['1111-2222']}))
            w.run_cycle()
        assert count_rows('identifiers') == 1


class TestEditorialStatus:
    def test_retraction_persists_and_is_sticky(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        # Crossref flags it retracted.
        cache.push_paper(PaperRecord(source='crossref_works', doi='10.1/r',
                                     editorial_status='retracted'))
        w.run_cycle()
        # A later OpenAlex observation with NO notice must NOT clear it
        # (producers emit None when clear -> no observation -> sticky-true).
        cache.push_paper(PaperRecord(source='oa_works_doi', doi='10.1/r',
                                     title='Paper', editorial_status=None))
        w.run_cycle()
        row = db_conn.execute(
            "SELECT editorial_status FROM papers WHERE doi='10.1/r'").fetchone()
        assert row['editorial_status'] == 'retracted'

    def test_most_severe_across_sources_wins(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='crossref_works', doi='10.2/x',
                                     editorial_status='correction'))
        w.run_cycle()
        cache.push_paper(PaperRecord(source='ncbi_efetch', doi='10.2/x',
                                     editorial_status='Retracted Publication'))
        w.run_cycle()
        row = db_conn.execute(
            "SELECT editorial_status FROM papers WHERE doi='10.2/x'").fetchone()
        assert row['editorial_status'] == 'retracted'

    def test_clean_paper_has_null_status(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='oa_works_doi', doi='10.3/ok',
                                     title='Fine'))
        w.run_cycle()
        row = db_conn.execute(
            "SELECT editorial_status FROM papers WHERE doi='10.3/ok'").fetchone()
        assert row['editorial_status'] is None


class TestEditorialStatusTimestamp:
    def test_timestamp_set_on_first_flag(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='crossref_works', doi='10.1/t',
                                     editorial_status='retracted'))
        w.run_cycle()
        row = db_conn.execute(
            "SELECT editorial_status, editorial_status_at FROM papers "
            "WHERE doi='10.1/t'").fetchone()
        assert row['editorial_status'] == 'retracted'
        assert row['editorial_status_at'] is not None

    def test_timestamp_preserved_when_status_unchanged(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='crossref_works', doi='10.2/t',
                                     editorial_status='retracted'))
        w.run_cycle()
        first = db_conn.execute(
            "SELECT editorial_status_at FROM papers WHERE doi='10.2/t'"
        ).fetchone()['editorial_status_at']
        # Same status again from another source -> timestamp must not move.
        cache.push_paper(PaperRecord(source='ncbi_efetch', doi='10.2/t',
                                     editorial_status='Retracted Publication'))
        w.run_cycle()
        again = db_conn.execute(
            "SELECT editorial_status_at FROM papers WHERE doi='10.2/t'"
        ).fetchone()['editorial_status_at']
        assert again == first

    def test_clean_paper_has_null_timestamp(
        self, tmp_db_path, claims_db_path, cache, db_conn,
    ):
        w = MergeWriter(tmp_db_path, cache, batch_size=10, served_modules=[])
        cache.push_paper(PaperRecord(source='oa_works_doi', doi='10.3/t',
                                     title='Fine'))
        w.run_cycle()
        row = db_conn.execute(
            "SELECT editorial_status_at FROM papers WHERE doi='10.3/t'").fetchone()
        assert row['editorial_status_at'] is None
