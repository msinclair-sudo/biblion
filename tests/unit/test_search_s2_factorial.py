"""
Tests for search_s2_factorial.

Two layers:
  1. Pure boolean-parser helpers (_strip_not_clauses, _parse_or_groups,
     _expand_queries, _simplify_query) — no I/O, fast, deterministic.
  2. The module's run() loop with the S2 client mocked, asserting it
     pushes PaperRecords with the right provenance.
"""
import json
from typing import Optional
from unittest import mock

import pytest

from biblion.cache.records import PaperRecord
from biblion.modules.search_s2_factorial import (
    SearchS2Factorial,
    _clean_term, _strip_not_clauses, _parse_or_groups,
    _expand_queries, _simplify_query,
    _paper_record_from_search_hit,
    _ckpt_load, _ckpt_save,
)
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

class TestNotStripping:
    def test_strips_parenthesised_not(self):
        q = '(A OR B) AND (C OR D) NOT (E OR F)'
        assert 'NOT' not in _strip_not_clauses(q)

    def test_strips_bare_not_term(self):
        q = '(A OR B) NOT microbial'
        out = _strip_not_clauses(q)
        assert 'NOT' not in out
        assert 'microbial' not in out

    def test_leaves_inclusion_untouched(self):
        q = '(A OR B) AND C'
        out = _strip_not_clauses(q)
        assert 'A' in out and 'B' in out and 'C' in out


class TestParseOrGroups:
    def test_simple_two_groups(self):
        # The parser drops terms shorter than 3 chars — use realistic words.
        groups = _parse_or_groups('(microbe OR fungi) AND (soil OR water)')
        assert groups == [['microbe', 'fungi'], ['soil', 'water']]

    def test_preserves_quoted_phrases(self):
        groups = _parse_or_groups('("soil microbiome" OR "rhizosphere")')
        assert groups[0][0].startswith('"')
        assert 'soil microbiome' in groups[0][0]

    def test_strips_wildcards(self):
        groups = _parse_or_groups('(metagenomic* OR "shotgun*")')
        # The trailing * is stripped by _clean_term
        assert 'metagenomic' in groups[0][0]
        assert '*' not in groups[0][0]

    def test_drops_short_terms(self):
        # Terms <=2 chars are skipped
        groups = _parse_or_groups('(ab OR microbe)')
        assert groups[0] == ['microbe']

    def test_no_parens_treated_as_single_group(self):
        groups = _parse_or_groups('microbe OR rhizosphere')
        assert groups == [['microbe', 'rhizosphere']]


class TestExpandQueries:
    def test_cartesian_product_size(self):
        out = _expand_queries(
            '(microbe OR fungi OR archaea) AND (soil OR water) AND (north OR south)'
        )
        # 3 * 2 * 2 = 12 combinations
        assert len(out) == 12

    def test_cartesian_combinations_unique(self):
        out = _expand_queries('(microbe OR fungi) AND (soil OR water)')
        assert sorted(out) == ['fungi soil', 'fungi water',
                               'microbe soil', 'microbe water']

    def test_falls_back_to_simplify_when_no_groups(self):
        # A query where everything gets filtered out should still
        # produce one entry.
        out = _expand_queries('()')
        assert isinstance(out, list)
        assert len(out) >= 1


class TestSimplifyQuery:
    def test_picks_one_phrase_per_and_clause(self):
        # Quoted phrases are preferred.
        out = _simplify_query('("soil microbiome" OR rhizosphere) AND ("nitrogen cycle" OR carbon)')
        # Output should include exactly one term from each AND clause.
        # Both quoted phrases get picked.
        assert '"soil microbiome"' in out
        assert '"nitrogen cycle"' in out

    def test_avoids_repeating_terms(self):
        out = _simplify_query('(microbe) AND (microbe)')
        # The same term shouldn't appear twice — `seen` set prevents it.
        assert out.lower().count('microbe') == 1


# ---------------------------------------------------------------------------
# Record construction
# ---------------------------------------------------------------------------

class TestPaperRecordFromSearchHit:
    def test_builds_record_with_provenance_in_raw(self):
        hit = {
            'paperId': 'sha123',
            'externalIds': {'DOI': '10.1/x', 'PubMed': '99'},
            'title': 'Soil microbes', 'year': 2023,
            'authors': [{'name': 'Smith'}, {'name': 'Lee'}],
            'venue': 'Soil J',
            'abstract': 'lorem',
            'citationCount': 5,
            'influentialCitationCount': 2,
            'isOpenAccess': True,
            'publicationTypes': ['JournalArticle'],
        }
        rec = _paper_record_from_search_hit(hit, query_id=7,
                                            query_title='Test query',
                                            sub_query='A B')
        assert rec.s2_id == 'sha123'
        assert rec.doi == '10.1/x'
        assert rec.title == 'Soil microbes'
        assert rec.year == 2023
        assert rec.venue == 'Soil J'
        assert rec.cit_count == 5
        assert rec.influential_cit_count == 2
        assert rec.is_open_access is True
        assert rec.pubmed_id == '99'
        # Authors serialised
        assert 'Smith' in rec.authors_json
        # Provenance in raw
        raw = json.loads(rec.raw)
        assert raw['query_id'] == 7
        assert raw['query_title'] == 'Test query'
        assert raw['sub_query'] == 'A B'

    def test_drops_records_with_no_identifier(self):
        hit = {'title': 'no id', 'externalIds': {}}
        rec = _paper_record_from_search_hit(hit, 1, '', '')
        assert rec is None


# ---------------------------------------------------------------------------
# Checkpoint round-trip
# ---------------------------------------------------------------------------

class TestCheckpoint:
    def test_round_trip(self, cache):
        _ckpt_save(cache, 7, {'A B', 'A C'})
        assert _ckpt_load(cache, 7) == {'A B', 'A C'}

    def test_empty_when_missing(self, cache):
        assert _ckpt_load(cache, 999) == set()


# ---------------------------------------------------------------------------
# Module run loop
# ---------------------------------------------------------------------------

@pytest.fixture
def search_file(tmp_path):
    """Tiny searches.json fixture."""
    payload = {
        'description': 'test',
        'queries': [
            {
                'id': 1,
                'title': 'Combo query',
                'query': '(microbe OR rhizosphere) AND (nitrogen OR carbon)',
            },
        ],
    }
    p = tmp_path / 'search.json'
    p.write_text(json.dumps(payload))
    return p


class TestModuleRun:
    def test_expand_mode_pushes_papers_per_subquery(
        self, tmp_db_path, cache, search_file, monkeypatch,
    ):
        """In expand mode every Cartesian sub-query becomes a search call
        and every returned paper becomes a PaperRecord push."""
        from biblion.modules import search_s2_factorial as mod

        captured_calls: list[str] = []
        # Fake the S2 search — bound instance method so first arg is self.
        def fake_search(self, query, fields=None, year_min=None,
                        year_max=None, limit=100):
            captured_calls.append(query)
            return [{
                'paperId': f'sha{len(captured_calls):02d}',
                'externalIds': {'DOI': f'10.1/q{len(captured_calls)}'},
                'title': f'Paper for {query}',
                'year': 2024,
                'authors': [{'name': 'A'}],
            }]
        monkeypatch.setattr(
            mod.SemanticScholarClient, 'search', fake_search,
        )

        m = SearchS2Factorial()
        result = m.run(_FakeCtx(tmp_db_path, cache, {
            'search_file': str(search_file),
            'search_mode': 'expand',
            'sub_limit':   50,
        }))
        # 2 OR-groups, each with 2 alternatives → 4 sub-queries
        assert len(captured_calls) == 4
        assert result.stats['sub_queries'] == 4
        assert result.stats['papers_pushed'] == 4

    def test_simplify_mode_runs_one_subquery_per_top_level(
        self, tmp_db_path, cache, search_file, monkeypatch,
    ):
        from biblion.modules import search_s2_factorial as mod

        captured: list[str] = []
        def fake_search(self, query, fields=None, year_min=None,
                        year_max=None, limit=100):
            captured.append(query)
            return []
        monkeypatch.setattr(
            mod.SemanticScholarClient, 'search', fake_search,
        )

        m = SearchS2Factorial()
        m.run(_FakeCtx(tmp_db_path, cache, {
            'search_file': str(search_file),
            'search_mode': 'simplify',
        }))
        # Just one sub-query in simplify mode.
        assert len(captured) == 1

    def test_checkpoint_skips_already_done_subqueries(
        self, tmp_db_path, cache, search_file, monkeypatch,
    ):
        """Re-running with the same input should not re-query S2 for
        sub-queries already in the checkpoint."""
        from biblion.modules import search_s2_factorial as mod

        # The expansion of `(microbe OR rhizosphere) AND (nitrogen OR carbon)`
        # is 4 combos. Pre-mark 2 as done.
        _ckpt_save(cache, 1, {'microbe nitrogen', 'rhizosphere carbon'})

        captured: list[str] = []
        def fake_search(self, query, fields=None, year_min=None,
                        year_max=None, limit=100):
            captured.append(query)
            return []
        monkeypatch.setattr(
            mod.SemanticScholarClient, 'search', fake_search,
        )

        m = SearchS2Factorial()
        result = m.run(_FakeCtx(tmp_db_path, cache, {
            'search_file': str(search_file),
            'search_mode': 'expand',
        }))
        # Only 2 remaining sub-queries should have been run.
        assert len(captured) == 2
        assert result.stats['sub_skipped'] == 2


# ---------------------------------------------------------------------------
# Test scaffolding
# ---------------------------------------------------------------------------

class _FakeShutdown:
    requested = False


class _FakeCtx:
    """Minimal Context replacement so we can call module.run() directly."""
    def __init__(self, db_path, cache, config):
        self.db_path  = db_path
        self.cache    = cache
        self.config   = config
        self.shutdown = _FakeShutdown()

    def connect(self, readonly: bool = True):
        # Used only by validate(); not needed in these tests but provide
        # a real connection so anything that does call it works.
        import sqlite3
        uri = f"file:{self.db_path}?mode=ro" if readonly else str(self.db_path)
        conn = sqlite3.connect(uri, uri=readonly)
        conn.row_factory = sqlite3.Row
        return conn
