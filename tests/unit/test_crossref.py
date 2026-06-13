"""
Unit tests for the Crossref client's pure parse path (no network).
"""
import json

import pytest

from biblion.clients.crossref import parse_work, _normalise_doi


pytestmark = pytest.mark.unit


SAMPLE_WORK = {
    'DOI': '10.1234/ABCD',
    'title': ['On a Thing'],
    'container-title': ['Journal of Things'],
    'volume': '12',
    'issue': '3',
    'page': '100-120',
    'publisher': 'Springer',
    'type': 'journal-article',
    'ISSN': ['1234-5678', '8765-4321'],
    'author': [
        {'family': 'Smith', 'given': 'Jane'},
        {'family': 'Doe', 'given': 'Alan'},
    ],
    'editor': [{'family': 'Ng', 'given': 'Pat'}],
    'published': {'date-parts': [[2024, 7, 1]]},
}


class TestParseWork:
    def setup_method(self):
        self.p = parse_work(SAMPLE_WORK)

    def test_doi_normalised(self):
        assert self.p['doi'] == '10.1234/abcd'

    def test_scalar_fields(self):
        assert self.p['title'] == 'On a Thing'
        assert self.p['venue'] == 'Journal of Things'
        assert self.p['volume'] == '12'
        assert self.p['issue'] == '3'
        assert self.p['publisher'] == 'Springer'
        assert self.p['pub_type'] == 'journal-article'

    def test_pages_split(self):
        assert self.p['first_page'] == '100'
        assert self.p['last_page'] == '120'

    def test_year_and_month(self):
        assert self.p['year'] == 2024
        assert self.p['month'] == '07'

    def test_names(self):
        assert json.loads(self.p['authors_json']) == ['Smith, Jane', 'Doe, Alan']
        assert json.loads(self.p['editors_json']) == ['Ng, Pat']

    def test_issn_identifiers(self):
        assert self.p['extra_identifiers']['issn'] == ['1234-5678', '8765-4321']

    def test_isbn_when_present(self):
        w = {'DOI': '10.1/x', 'ISBN': ['978-0-00-000000-0'], 'type': 'book'}
        assert parse_work(w)['extra_identifiers']['isbn'] == ['978-0-00-000000-0']

    def test_single_page(self):
        w = {'DOI': '10.1/x', 'page': 'e12345'}
        p = parse_work(w)
        assert p['first_page'] == 'e12345' and p['last_page'] is None

    def test_missing_fields_are_none(self):
        p = parse_work({'DOI': '10.1/x'})
        assert p['volume'] is None and p['publisher'] is None
        assert p['extra_identifiers'] == {}


class TestNormaliseDoi:
    def test_strips_url_and_lowercases(self):
        assert _normalise_doi('https://doi.org/10.1/AB') == '10.1/ab'

    def test_none(self):
        assert _normalise_doi(None) is None
