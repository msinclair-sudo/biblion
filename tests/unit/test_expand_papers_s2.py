"""
Tests for expand_papers_s2 — the S2 citation-hop module.

Three layers:
  1. The query-id selector (_query_id_for) and identifier-parsing
     helpers in _resolve_targets.
  2. Record builders (_paper_record_from_work, _stub_record_for_neighbour,
     _edge).
  3. The shared chunk-processing logic (_process_chunk) with the S2 client
     mocked — covers the truncation fallback and the cache pushes.
"""
import json

import pytest

from biblion.cache.records import PaperRecord, CitationRecord
from biblion.modules.expand_papers_s2 import (
    ExpandPapersS2,
    _query_id_for, _paper_record_from_work,
    _stub_record_for_neighbour, _edge,
)
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

class TestQueryIdFor:
    def test_prefers_s2_over_doi(self):
        row = {'doi': '10.1/x', 's2_id': 'abc'}
        assert _query_id_for(row) == 'abc'

    def test_falls_back_to_doi_with_prefix(self):
        row = {'doi': '10.1/x', 's2_id': None}
        assert _query_id_for(row) == 'DOI:10.1/x'

    def test_none_when_no_identifier(self):
        row = {'doi': None, 's2_id': None}
        assert _query_id_for(row) is None


class TestPaperRecordFromWork:
    def test_full_metadata_translation(self):
        work = {
            'paperId': 'sha1',
            'externalIds': {'DOI': '10.1/x', 'PubMed': '99'},
            'title': 'X', 'year': 2024,
            'authors': [{'name': 'A'}, {'name': 'B'}],
            'venue': 'V',
            'abstract': 'lorem',
            'publicationTypes': ['JournalArticle'],
            'citationCount': 5,
            'referenceCount': 10,
        }
        r = _paper_record_from_work(work, 's2_hop_seed')
        assert r.source == 's2_hop_seed'
        assert r.doi == '10.1/x'
        assert r.s2_id == 'sha1'
        assert r.title == 'X'
        assert r.year == 2024
        assert r.venue == 'V'
        assert r.abstract == 'lorem'
        assert r.cit_count == 5
        assert r.ref_count == 10
        assert r.pub_type == 'journalarticle'
        assert r.pubmed_id == '99'
        assert 'A' in r.authors_json


class TestStubRecord:
    def test_returns_none_when_no_id(self):
        assert _stub_record_for_neighbour({'title': 'x'}) is None

    def test_keeps_identifiers_and_minimal_metadata(self):
        rec = _stub_record_for_neighbour({
            'paperId': 'sha9',
            'externalIds': {'DOI': '10.1/y'},
            'title': 'Y',
            'year': 2022,
            'authors': [{'name': 'Z'}],
        })
        assert rec.s2_id == 'sha9'
        assert rec.doi == '10.1/y'
        assert rec.title == 'Y'
        assert rec.year == 2022


class TestEdge:
    def test_builds_edge_with_dois(self):
        citing = {'externalIds': {'DOI': '10.1/a'}, 'paperId': 'A'}
        cited  = {'externalIds': {'DOI': '10.1/b'}, 'paperId': 'B'}
        e = _edge(citing, cited)
        assert e.citing_doi == '10.1/a'
        assert e.cited_doi == '10.1/b'
        assert e.citing_s2_id == 'A'
        assert e.cited_s2_id == 'B'

    def test_returns_none_when_either_side_has_no_id(self):
        citing = {'externalIds': {'DOI': '10.1/a'}, 'paperId': 'A'}
        cited  = {'externalIds': {}, 'paperId': None}
        assert _edge(citing, cited) is None


# ---------------------------------------------------------------------------
# Module logic via _process_chunk (used by both targeted + daemon paths)
# ---------------------------------------------------------------------------

class _FakeShutdown:
    requested = False


class _FakeCtx:
    def __init__(self, db_path, cache, config):
        self.db_path  = db_path
        self.cache    = cache
        self.config   = config
        self.shutdown = _FakeShutdown()

    def connect(self, readonly: bool = True):
        import sqlite3
        uri = f"file:{self.db_path}?mode=ro" if readonly else str(self.db_path)
        conn = sqlite3.connect(uri, uri=readonly)
        conn.row_factory = sqlite3.Row
        return conn


class _FakeClient:
    """Stand-in for SemanticScholarClient covering the methods _process_chunk uses."""
    def __init__(self, *, batch_result=None, paginated_results=None):
        self.batch_result = batch_result or []
        # paginated_results[(paper_id, direction)] = list[paper_dict]
        self.paginated_results = paginated_results or {}
        self.batch_calls: list[list[str]] = []
        self.paginated_calls: list[tuple[str, str]] = []
        # Make breaker_status work for the log line
        self.breaker_open = False
        self.api_key = 'test'

    def fetch_batch_by_id(self, ids, fields=''):
        self.batch_calls.append(list(ids))
        # Return the canned result. Tests may set per-call results via subclass.
        return self.batch_result

    def paginated_fetch(self, paper_id, direction, fields=''):
        self.paginated_calls.append((paper_id, direction))
        return self.paginated_results.get((paper_id, direction), [])

    def breaker_status(self):
        return {'open': False, 'current_rps': 5.0}


class TestProcessChunk:
    def test_pushes_seed_neighbours_and_edges(self, tmp_db_path, cache):
        """One seed + 2 refs + 1 citer → 1 seed push, 3 neighbour pushes,
        2 ref edges, 1 cit edge."""
        work = {
            'paperId': 'seedA', 'externalIds': {'DOI': '10.1/seed'},
            'title': 'Seed', 'year': 2024,
            'references': [
                {'paperId': 'ref1', 'externalIds': {'DOI': '10.1/r1'},
                 'title': 'R1', 'year': 2020, 'authors': []},
                {'paperId': 'ref2', 'externalIds': {'DOI': '10.1/r2'},
                 'title': 'R2', 'year': 2021, 'authors': []},
            ],
            'referenceCount': 2,
            'citations': [
                {'paperId': 'cit1', 'externalIds': {'DOI': '10.1/c1'},
                 'title': 'C1', 'year': 2025, 'authors': []},
            ],
            'citationCount': 1,
        }
        client = _FakeClient(batch_result=[work])
        ctx = _FakeCtx(tmp_db_path, cache, config={'verbose': False})
        m = ExpandPapersS2()
        stats = {'batches': 0, 'seeds_found': 0, 'seeds_missing': 0,
                 'refs_pushed': 0, 'cits_pushed': 0, 'neighbours_pushed': 0,
                 'paginated_calls': 0, 'errors': 0}
        m._process_chunk(ctx, client,
                         [{'id': 1, 'doi': '10.1/seed', 's2_id': 'seedA',
                           'is_seed': 0, 'discovery_count': 1}],
                         stats, verbose=False)

        assert stats['seeds_found'] == 1
        assert stats['refs_pushed'] == 2
        assert stats['cits_pushed'] == 1
        # 2 refs + 1 citer
        assert stats['neighbours_pushed'] == 3

        # Verify what landed in the cache (papers + citations).
        # Pop both queues and inspect.
        papers = cache.pop_papers_batch(100)
        cits   = cache.pop_citations_batch(100)
        # 1 seed + 3 neighbours = 4 paper pushes
        assert len(papers) == 4
        assert len(cits) == 3
        # Seed should have the seed source
        seed_recs = [p for p in papers if p.source == 's2_hop_seed']
        assert len(seed_recs) == 1
        assert seed_recs[0].s2_id == 'seedA'

    def test_truncation_triggers_paginated_fallback(self, tmp_db_path, cache):
        """referenceCount=100 but only 2 refs inlined → paginated_fetch is
        called for references."""
        work = {
            'paperId': 'seedA', 'externalIds': {'DOI': '10.1/seed'},
            'references': [
                {'paperId': 'ref1', 'externalIds': {'DOI': '10.1/r1'}},
                {'paperId': 'ref2', 'externalIds': {'DOI': '10.1/r2'}},
            ],
            'referenceCount': 100,
            'citations': [],
            'citationCount': 0,
        }
        # The paginated endpoint returns 5 refs (we asked for everything).
        client = _FakeClient(
            batch_result=[work],
            paginated_results={
                ('seedA', 'references'): [
                    {'paperId': f'r{i}', 'externalIds': {'DOI': f'10.1/rp{i}'}}
                    for i in range(5)
                ],
            },
        )
        ctx = _FakeCtx(tmp_db_path, cache, config={'verbose': False})
        m = ExpandPapersS2()
        stats = {'batches': 0, 'seeds_found': 0, 'seeds_missing': 0,
                 'refs_pushed': 0, 'cits_pushed': 0, 'neighbours_pushed': 0,
                 'paginated_calls': 0, 'errors': 0}
        m._process_chunk(ctx, client,
                         [{'id': 1, 'doi': '10.1/seed', 's2_id': 'seedA',
                           'is_seed': 0, 'discovery_count': 1}],
                         stats, verbose=False)
        # paginated_fetch was called once
        assert client.paginated_calls == [('seedA', 'references')]
        assert stats['paginated_calls'] == 1
        # And the 5 paginated refs all became edges
        assert stats['refs_pushed'] == 5

    def test_missing_work_marks_seed_missing(self, tmp_db_path, cache):
        """When S2 returns None for an id, it counts as missing, no pushes."""
        client = _FakeClient(batch_result=[None])
        ctx = _FakeCtx(tmp_db_path, cache, config={'verbose': False})
        m = ExpandPapersS2()
        stats = {'batches': 0, 'seeds_found': 0, 'seeds_missing': 0,
                 'refs_pushed': 0, 'cits_pushed': 0, 'neighbours_pushed': 0,
                 'paginated_calls': 0, 'errors': 0}
        m._process_chunk(ctx, client,
                         [{'id': 7, 'doi': None, 's2_id': 'nope',
                           'is_seed': 0, 'discovery_count': 1}],
                         stats, verbose=False)
        assert stats['seeds_missing'] == 1
        assert stats['seeds_found'] == 0


# ---------------------------------------------------------------------------
# Targeted mode end-to-end
# ---------------------------------------------------------------------------

class TestResolveTargets:
    def test_matches_by_doi(self, tmp_db_path, insert_paper):
        pid = insert_paper(doi='10.1/x')
        m = ExpandPapersS2()
        ctx = _FakeCtx(tmp_db_path, None, {})
        rows = m._resolve_targets(ctx, ['DOI:10.1/x'])
        assert [r['id'] for r in rows] == [pid]

    def test_matches_by_bare_doi(self, tmp_db_path, insert_paper):
        pid = insert_paper(doi='10.1/x')
        m = ExpandPapersS2()
        ctx = _FakeCtx(tmp_db_path, None, {})
        rows = m._resolve_targets(ctx, ['10.1/x'])
        assert [r['id'] for r in rows] == [pid]

    def test_matches_by_oa_id(self, tmp_db_path, insert_paper):
        pid = insert_paper(oa_id='W123', title='X')
        m = ExpandPapersS2()
        ctx = _FakeCtx(tmp_db_path, None, {})
        rows = m._resolve_targets(ctx, ['W123'])
        assert [r['id'] for r in rows] == [pid]

    def test_matches_by_s2_sha(self, tmp_db_path, insert_paper):
        sha = 'a' * 40
        pid = insert_paper(s2_id=sha)
        m = ExpandPapersS2()
        ctx = _FakeCtx(tmp_db_path, None, {})
        rows = m._resolve_targets(ctx, [sha])
        assert [r['id'] for r in rows] == [pid]

    def test_skips_unknown_identifiers(self, tmp_db_path, insert_paper):
        # No matching paper.
        m = ExpandPapersS2()
        ctx = _FakeCtx(tmp_db_path, None, {})
        rows = m._resolve_targets(ctx, ['DOI:10.1/nope'])
        assert rows == []


# ---------------------------------------------------------------------------
# Seeds-only hop (claim-flow variant)
# ---------------------------------------------------------------------------

class TestSeedsOnlyHop:
    def test_claim_key_routes_to_seeds_variant(self):
        """seeds_only config selects the seeds-filtered candidate-query entry;
        without it, the default expand_papers_s2 entry."""
        # Mirror the selection logic in ExpandPapersS2.run().
        def claim_key(cfg):
            return ('expand_papers_s2_seeds'
                    if cfg.get('seeds_only') else 'expand_papers_s2')
        assert claim_key({}) == 'expand_papers_s2'
        assert claim_key({'seeds_only': True}) == 'expand_papers_s2_seeds'

    def test_seeds_candidate_query_filters_to_is_seed(
        self, tmp_db_path, claims_conn, insert_paper,
    ):
        """The seeds entry's candidate SQL only returns is_seed=1 papers,
        sharing the 's2_hop' service so tracking is unified with the full hop."""
        from biblion.framework.claims import CANDIDATE_QUERIES, claim_candidates
        seed = insert_paper(doi='10.1/seed', s2_id='aaa', is_seed=1)
        insert_paper(doi='10.1/notseed', s2_id='bbb', is_seed=0)

        spec = CANDIDATE_QUERIES['expand_papers_s2_seeds']
        assert spec['service'] == 's2_hop'        # shared tracking
        rows = claim_candidates(
            claims_conn, spec['service'],
            candidate_sql=spec['candidate_sql'], order_by=spec['order_by'],
            limit=50, fields=spec['fields'])
        assert [r['id'] for r in rows] == [seed]

    def test_full_hop_still_returns_non_seeds(
        self, tmp_db_path, claims_conn, insert_paper,
    ):
        """Sanity: the default (non-seeds) entry still returns every paper."""
        from biblion.framework.claims import CANDIDATE_QUERIES, claim_candidates
        s = insert_paper(doi='10.1/s', s2_id='aaa', is_seed=1)
        n = insert_paper(doi='10.1/n', s2_id='bbb', is_seed=0)
        spec = CANDIDATE_QUERIES['expand_papers_s2']
        rows = claim_candidates(
            claims_conn, spec['service'],
            candidate_sql=spec['candidate_sql'], order_by=spec['order_by'],
            limit=50, fields=spec['fields'])
        assert set(r['id'] for r in rows) == {s, n}


# ---------------------------------------------------------------------------
# Daemon-mode mark path — regression for the per-field marks crash
# ---------------------------------------------------------------------------

class TestDaemonModeMarks:
    """The hop's claim-flow path must report marks as (paper_id, field) pairs.

    Regression: it previously passed bare id lists to report_marks, which
    crashed with `'int' object is not iterable` once marks went per-field.
    """

    def test_report_marks_receives_id_field_pairs(self, tmp_db_path, monkeypatch):
        import biblion.modules.expand_papers_s2 as mod
        from biblion.cache.records import ResultMark

        # One claimable row with a usable S2 id, one with no identifier.
        grant = [
            {'id': 1, 'doi': '10.1/a', 's2_id': 'sha1',
             'is_seed': 1, 'discovery_count': 0},
            {'id': 2, 'doi': None, 's2_id': None,
             'is_seed': 0, 'discovery_count': 0},
        ]
        calls = {'n': 0}
        captured = {}

        def fake_request_claim(cache, name, batch_size, timeout_s=30.0):
            calls['n'] += 1
            return grant if calls['n'] == 1 else []

        def fake_report_marks(cache, name, succeeded, failed):
            captured['succeeded'] = list(succeeded)
            captured['failed'] = list(failed)
            # The exact operation that used to crash: ResultMark builds
            # [list(x) for x in succeeded]. Bare ints raise here.
            ResultMark(service=name,
                       succeeded=[list(x) for x in succeeded],
                       failed=[list(x) for x in failed])

        import biblion.framework.claims as claims
        monkeypatch.setattr(claims, 'request_claim', fake_request_claim)
        monkeypatch.setattr(claims, 'report_marks', fake_report_marks)
        # Don't hit S2: make the chunk processor a no-op that "finds" the seed.
        monkeypatch.setattr(mod.ExpandPapersS2, '_process_chunk',
                            lambda self, ctx, client, usable, stats, verbose:
                            stats.__setitem__('seeds_found',
                                              stats['seeds_found'] + len(usable)))
        class _FakeS2:
            api_key = 'k'
            breaker_open = False
        monkeypatch.setattr(mod, 'SemanticScholarClient', _FakeS2)

        ctx = _FakeCtx(tmp_db_path, cache=None, config={'loop': False})
        mod.ExpandPapersS2().run(ctx)

        # Every mark is a (paper_id, field) pair, field == '_all'.
        for pid, field in captured['succeeded'] + captured['failed']:
            assert isinstance(pid, int) and field == '_all'
        assert (1, '_all') in captured['succeeded']   # usable id succeeded
        assert (2, '_all') in captured['failed']       # no-id row failed
