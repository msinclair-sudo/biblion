"""
Tests for editorial_status (retraction / withdrawal / expression-of-concern /
correction): the severity-max "sticky-true" resolver, per-source scraper
extraction, and export surfacing.
"""
import json

import pytest

from biblion.merge.resolve import (
    resolve, canonicalize, Observation, _canon_editorial,
)
from biblion.clients.openalex import parse_biblio
from biblion.clients.crossref import parse_work as crossref_parse
from biblion.clients.ncbi import _parse_efetch_xml
from biblion.modules.export import paper_to_bibtex, paper_to_ris, _PAPER_COLUMNS


pytestmark = pytest.mark.unit


def _ob(v, source):
    return Observation(value=canonicalize('editorial_status', v), raw=v,
                       source=source)


# ---------------------------------------------------------------------------
# Canonicalization
# ---------------------------------------------------------------------------

class TestCanonEditorial:
    @pytest.mark.parametrize('raw,expected', [
        ('retraction', 'retracted'),
        ('Retracted Publication', 'retracted'),
        ('RetractionIn', 'retracted'),
        ('withdrawal', 'withdrawn'),
        ('expression_of_concern', 'concern'),
        ('ExpressionOfConcernIn', 'concern'),
        ('correction', 'corrected'),
        ('Published Erratum', 'corrected'),
        ('ErratumIn', 'corrected'),
        ('corrigendum', 'corrected'),
        ('retracted RetractionIn', 'retracted'),     # blob -> most severe
        ('correction retraction', 'retracted'),
        (None, None),
        ('', None),
        ('none', None),
        ('some unrelated type', None),
    ])
    def test_canon(self, raw, expected):
        assert _canon_editorial(raw) == expected


# ---------------------------------------------------------------------------
# Severity-max, sticky-true resolution
# ---------------------------------------------------------------------------

class TestResolveEditorialStatus:
    def test_single_source(self):
        r = resolve('editorial_status', [_ob('retraction', 'crossref')])
        assert r.value == 'retracted' and r.conflict is None

    def test_most_severe_wins_regardless_of_trust(self):
        # Crossref (rank 1) says corrected; NCBI (rank 4) says retracted.
        # Severity must win over trust -> retracted, and it is NOT a conflict.
        r = resolve('editorial_status', [
            _ob('correction', 'crossref'),
            _ob('Retracted Publication', 'ncbi'),
        ])
        assert r.value == 'retracted'
        assert r.conflict is None

    def test_concern_vs_corrected(self):
        r = resolve('editorial_status', [
            _ob('correction', 'crossref'),
            _ob('expression_of_concern', 'openalex'),
        ])
        assert r.value == 'concern'

    def test_unknown_tokens_ignored(self):
        r = resolve('editorial_status', [_ob('some notice', 's2')])
        assert r.value is None


# ---------------------------------------------------------------------------
# Scraper extraction
# ---------------------------------------------------------------------------

class TestScraperExtraction:
    def test_openalex_is_retracted(self):
        assert parse_biblio({'is_retracted': True})['editorial_status'] == 'retracted'
        assert parse_biblio({'is_retracted': False})['editorial_status'] is None
        assert parse_biblio({})['editorial_status'] is None

    def test_crossref_update_to_most_severe(self):
        w = {'DOI': '10.1/x',
             'update-to': [{'type': 'correction'}, {'type': 'retraction'}]}
        raw = crossref_parse(w)['editorial_status']
        assert _canon_editorial(raw) == 'retracted'

    def test_crossref_no_notice(self):
        assert crossref_parse({'DOI': '10.1/x'})['editorial_status'] is None

    def test_ncbi_retracted_publication(self):
        xml = """<PubmedArticleSet><PubmedArticle><MedlineCitation>
          <PMID>1</PMID><Article><ArticleTitle>T</ArticleTitle>
          <PublicationTypeList>
            <PublicationType>Journal Article</PublicationType>
            <PublicationType>Retracted Publication</PublicationType>
          </PublicationTypeList></Article>
          <CommentsCorrectionsList>
            <CommentsCorrections RefType="RetractionIn"><PMID>2</PMID></CommentsCorrections>
          </CommentsCorrectionsList></MedlineCitation></PubmedArticle></PubmedArticleSet>"""
        es = _parse_efetch_xml(xml)['1']['editorial_status']
        assert _canon_editorial(es) == 'retracted'

    def test_ncbi_erratum_only(self):
        xml = """<PubmedArticleSet><PubmedArticle><MedlineCitation>
          <PMID>5</PMID><Article><ArticleTitle>T</ArticleTitle></Article>
          <CommentsCorrectionsList>
            <CommentsCorrections RefType="ErratumIn"><PMID>6</PMID></CommentsCorrections>
          </CommentsCorrectionsList></MedlineCitation></PubmedArticle></PubmedArticleSet>"""
        es = _parse_efetch_xml(xml)['5']['editorial_status']
        assert _canon_editorial(es) == 'corrected'

    def test_ncbi_no_notice(self):
        xml = """<PubmedArticleSet><PubmedArticle><MedlineCitation>
          <PMID>9</PMID><Article><ArticleTitle>T</ArticleTitle></Article>
          </MedlineCitation></PubmedArticle></PubmedArticleSet>"""
        assert _parse_efetch_xml(xml)['9']['editorial_status'] is None


# ---------------------------------------------------------------------------
# Export surfacing
# ---------------------------------------------------------------------------

def _row(**over):
    base = {c: None for c in _PAPER_COLUMNS}
    base.update({'id': 1, 'pub_type': 'article', 'title': 'X', 'year': 2020})
    base.update(over)
    return base


class TestExportSurfacing:
    def test_bibtex_note_carries_status(self):
        out = paper_to_bibtex(_row(editorial_status='retracted'), {}, {}, 'k')
        assert 'note' in out and 'RETRACTED' in out

    def test_bibtex_merges_status_and_eav_note(self):
        out = paper_to_bibtex(_row(editorial_status='retracted'),
                              {1: {'note': 'see X'}}, {}, 'k')
        # single combined note field, not two
        assert out.count('note ') == 1
        assert 'RETRACTED; see X' in out

    def test_no_status_no_marker(self):
        out = paper_to_bibtex(_row(), {}, {}, 'k')
        assert 'RETRACTED' not in out

    def test_ris_n1_carries_status(self):
        out = paper_to_ris(_row(editorial_status='withdrawn'), {}, {})
        assert 'N1  - WITHDRAWN' in out
