"""
Tests for the RIS importer.

Three layers:
  1. Pure parser helpers (parse_ris, _normalize_doi, ris_record_to_paper)
     — no I/O, fast.
  2. The Module.run() loop with an in-memory cache, asserting it pushes
     PaperRecords with the right shape.
  3. mark_seeds() against a fresh DB.
"""
import json
import sqlite3
from pathlib import Path

import pytest

from biblion.cache.records import PaperRecord
from biblion.modules.import_ris import (
    ImportRis,
    _extract_authors,
    _extract_doi,
    _extract_pub_type,
    _extract_venue,
    _extract_year,
    _normalize_doi,
    mark_seeds,
    parse_ris,
    resolve_via_title,
    ris_record_to_paper,
)


pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# parse_ris
# ---------------------------------------------------------------------------

SAMPLE = """\
TY  - JOUR
AU  - Smith, J.
AU  - Doe, A.
PY  - 2024
TI  - On a thing
T2  - Journal of Things
VL  - 12
IS  - 3
SP  - 100
EP  - 110
DO  - 10.1234/abcd
UR  - https://doi.org/10.1234/abcd
ER  -

TY  - CHAP
AU  - Lee, K.
PY  - 2020
TI  - A chapter
T2  - Big Handbook of Stuff
SP  - 50
EP  - 75
DO  - 10.5678/xyz
ER  -
"""


class TestParseRis:
    def test_parses_two_records(self):
        recs = list(parse_ris(SAMPLE))
        assert len(recs) == 2

    def test_scalar_first_write_wins(self):
        # T2 vs JF — first non-empty wins
        text = "TY  - JOUR\nT2  - First\nJF  - Second\nER  -\n"
        rec = next(parse_ris(text))
        assert rec.get('T2', 'JF') == 'First'

    def test_lists_collect_repeats(self):
        rec = next(parse_ris(SAMPLE))
        assert rec.all('AU') == ['Smith, J.', 'Doe, A.']

    def test_empty_input_yields_nothing(self):
        assert list(parse_ris('')) == []

    def test_orphan_lines_outside_record_ignored(self):
        text = "AU  - Stray\nTY  - JOUR\nTI  - Real\nER  -\n"
        recs = list(parse_ris(text))
        assert len(recs) == 1
        assert recs[0].get('TI') == 'Real'
        # Stray author should not appear in the only real record
        assert recs[0].all('AU') == []

    def test_ignores_unknown_tags_gracefully(self):
        text = "TY  - JOUR\nTI  - hi\nZZ  - whatever\nER  -\n"
        rec = next(parse_ris(text))
        assert rec.get('TI') == 'hi'
        # Unknown tag is kept as scalar for forensics
        assert rec.get('ZZ') == 'whatever'


# ---------------------------------------------------------------------------
# DOI normalisation
# ---------------------------------------------------------------------------

class TestNormalizeDoi:
    @pytest.mark.parametrize('inp,want', [
        ('10.1234/abc',                       '10.1234/abc'),
        ('10.1234/ABC',                       '10.1234/abc'),    # lowercased
        ('https://doi.org/10.1234/abc',       '10.1234/abc'),
        ('http://doi.org/10.1234/abc',        '10.1234/abc'),
        ('doi:10.1234/abc',                   '10.1234/abc'),
        ('DOI:10.1234/abc',                   '10.1234/abc'),
        ('https://www.example.com/x/10.1234/abc/foo',
                                              '10.1234/abc/foo'),
    ])
    def test_strips_and_lowercases(self, inp, want):
        assert _normalize_doi(inp) == want

    def test_none_and_empty(self):
        assert _normalize_doi(None) is None
        assert _normalize_doi('') is None
        assert _normalize_doi('   ') is None

    def test_non_doi_string(self):
        assert _normalize_doi('not a doi') is None


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------

class TestExtractDoi:
    def test_prefers_do(self):
        text = ("TY  - JOUR\nDO  - 10.1234/abcd\n"
                "UR  - https://doi.org/10.5678/efgh\nER  -\n")
        rec = next(parse_ris(text))
        assert _extract_doi(rec) == '10.1234/abcd'

    def test_falls_back_to_ur(self):
        text = "TY  - JOUR\nUR  - https://doi.org/10.5678/efgh\nER  -\n"
        rec = next(parse_ris(text))
        assert _extract_doi(rec) == '10.5678/efgh'

    def test_no_doi_returns_none(self):
        text = "TY  - JOUR\nTI  - x\nUR  - https://example.com/foo\nER  -\n"
        rec = next(parse_ris(text))
        assert _extract_doi(rec) is None


class TestExtractYear:
    @pytest.mark.parametrize('py,want', [
        ('2024',         2024),
        ('2024/01/15',   2024),
        ('2024 Jan 15',  2024),
        ('© 2024',       2024),
    ])
    def test_extracts_four_digit(self, py, want):
        text = f"TY  - JOUR\nPY  - {py}\nER  -\n"
        rec = next(parse_ris(text))
        assert _extract_year(rec) == want

    def test_no_year(self):
        text = "TY  - JOUR\nTI  - x\nER  -\n"
        rec = next(parse_ris(text))
        assert _extract_year(rec) is None


class TestExtractVenue:
    def test_prefers_t2(self):
        text = "TY  - JOUR\nT2  - Journal A\nJF  - Journal B\nER  -\n"
        rec = next(parse_ris(text))
        assert _extract_venue(rec) == 'Journal A'

    def test_falls_back_to_jf(self):
        text = "TY  - JOUR\nJF  - Journal B\nER  -\n"
        rec = next(parse_ris(text))
        assert _extract_venue(rec) == 'Journal B'


class TestExtractAuthors:
    def test_collects_au(self):
        rec = next(parse_ris(SAMPLE))
        out = json.loads(_extract_authors(rec))
        assert out == ['Smith, J.', 'Doe, A.']

    def test_combines_au_a1_dedups(self):
        text = ("TY  - JOUR\nAU  - Smith, J.\n"
                "A1  - Smith, J.\nA1  - Lee, K.\nER  -\n")
        rec = next(parse_ris(text))
        out = json.loads(_extract_authors(rec))
        assert out == ['Smith, J.', 'Lee, K.']

    def test_no_authors_returns_none(self):
        text = "TY  - JOUR\nTI  - x\nER  -\n"
        rec = next(parse_ris(text))
        assert _extract_authors(rec) is None


class TestExtractPubType:
    @pytest.mark.parametrize('ty,want', [
        ('JOUR',   'article'),
        ('CHAP',   'book-chapter'),
        ('BOOK',   'book'),
        ('CONF',   'conference'),
        ('CPAPER', 'conference'),
        ('THES',   'thesis'),
        ('RPRT',   'report'),
        ('GEN',    'other'),
        ('FOO',    'foo'),         # unknown → lowercased passthrough
    ])
    def test_canonical_map(self, ty, want):
        text = f"TY  - {ty}\nTI  - x\nER  -\n"
        rec = next(parse_ris(text))
        assert _extract_pub_type(rec) == want


# ---------------------------------------------------------------------------
# ris_record_to_paper
# ---------------------------------------------------------------------------

class TestRisRecordToPaper:
    def test_full_record(self):
        rec = next(parse_ris(SAMPLE))
        pr = ris_record_to_paper(rec, source='ris:test.ris')
        assert pr.source == 'ris:test.ris'
        assert pr.doi == '10.1234/abcd'
        assert pr.title == 'On a thing'
        assert pr.year == 2024
        assert pr.venue == 'Journal of Things'
        assert pr.pub_type == 'article'
        assert json.loads(pr.authors_json) == ['Smith, J.', 'Doe, A.']

    def test_record_without_identifier(self):
        text = "TY  - JOUR\nTI  - Mysterious paper\nPY  - 2020\nER  -\n"
        rec = next(parse_ris(text))
        pr = ris_record_to_paper(rec, source='ris:x.ris')
        # Still builds a record — caller decides whether to push or resolve
        assert pr is not None
        assert pr.doi is None
        assert not pr.has_identifier()

    def test_raw_payload_preserved(self):
        rec = next(parse_ris(SAMPLE))
        pr = ris_record_to_paper(rec, source='ris:test.ris')
        raw = json.loads(pr.raw)
        assert raw['tags']['DO'] == '10.1234/abcd'
        assert raw['lists']['AU'] == ['Smith, J.', 'Doe, A.']


# ---------------------------------------------------------------------------
# resolve_via_title (only the pure logic — uses a fake client)
# ---------------------------------------------------------------------------

class _FakeOaClient:
    def __init__(self, hits):
        self._hits = hits
    def search_by_title(self, title, year=None, top_k=3):
        return self._hits


class TestResolveViaTitle:
    def test_returns_top_match_above_threshold(self):
        hits = [{'title': 'On a thing', 'doi': '10.x/y', 'id': 'W1'}]
        c = _FakeOaClient(hits)
        out = resolve_via_title(c, 'On a thing')
        assert out is not None
        assert out['doi'] == '10.x/y'

    def test_rejects_below_threshold(self):
        hits = [{'title': 'Something completely different', 'doi': '10/x'}]
        c = _FakeOaClient(hits)
        assert resolve_via_title(c, 'On a thing') is None

    def test_short_title_skipped(self):
        c = _FakeOaClient([{'title': 'short', 'doi': '10/x'}])
        assert resolve_via_title(c, 'short') is None

    def test_no_hits(self):
        assert resolve_via_title(_FakeOaClient([]), 'A long enough title') is None


# ---------------------------------------------------------------------------
# mark_seeds — UPDATE against the temp DB
# ---------------------------------------------------------------------------

class TestMarkSeeds:
    def test_flags_by_doi(self, tmp_db_path, insert_paper):
        pid = insert_paper(doi='10.1234/abcd', title='t')
        touched = mark_seeds(tmp_db_path, {'doi': ['10.1234/abcd'],
                                            's2_id': [], 'oa_id': []})
        assert touched == 1
        conn = sqlite3.connect(str(tmp_db_path))
        try:
            row = conn.execute(
                "SELECT is_seed FROM papers WHERE id = ?", (pid,),
            ).fetchone()
            assert row[0] == 1
        finally:
            conn.close()

    def test_idempotent(self, tmp_db_path, insert_paper):
        insert_paper(doi='10.1234/abcd', title='t')
        ids = {'doi': ['10.1234/abcd'], 's2_id': [], 'oa_id': []}
        first  = mark_seeds(tmp_db_path, ids)
        second = mark_seeds(tmp_db_path, ids)
        assert first == 1
        assert second == 0       # already flagged, WHERE is_seed=0 skipped

    def test_no_match_does_nothing(self, tmp_db_path):
        touched = mark_seeds(tmp_db_path, {'doi': ['10.9999/does-not-exist'],
                                            's2_id': [], 'oa_id': []})
        assert touched == 0
