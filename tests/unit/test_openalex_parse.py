"""
Unit tests for OpenAlex parse_biblio — the extended bibliographic fields now
harvested from a work record (no network).
"""
import pytest

from biblion.clients.openalex import parse_biblio, _id_tail


pytestmark = pytest.mark.unit


SAMPLE_WORK = {
    'id': 'https://openalex.org/W123',
    'biblio': {'volume': '12', 'issue': '3',
               'first_page': '100', 'last_page': '120'},
    'language': 'en',
    'publication_date': '2024-07-15',
    'primary_location': {
        'source': {
            'display_name': 'Journal of Things',
            'host_organization_name': 'Springer',
            'issn': ['1234-5678', '8765-4321'],
        }
    },
    'ids': {
        'pmid': 'https://pubmed.ncbi.nlm.nih.gov/39000001',
        'pmcid': 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345',
        'mag': '2999999999',
    },
}


class TestParseBiblio:
    def setup_method(self):
        self.p = parse_biblio(SAMPLE_WORK)

    def test_biblio_numbers(self):
        assert self.p['volume'] == '12'
        assert self.p['issue'] == '3'
        assert self.p['first_page'] == '100'
        assert self.p['last_page'] == '120'

    def test_publisher_and_language(self):
        assert self.p['publisher'] == 'Springer'
        assert self.p['language'] == 'en'

    def test_date_and_month(self):
        assert self.p['publication_date'] == '2024-07-15'
        assert self.p['month'] == '07'

    def test_pubmed_ids_extracted_from_urls(self):
        assert self.p['pubmed_id'] == '39000001'
        assert self.p['pubmed_central_id'] == 'PMC12345'

    def test_issn_and_mag_identifiers(self):
        assert self.p['extra_identifiers']['issn'] == ['1234-5678', '8765-4321']
        assert self.p['extra_identifiers']['mag'] == ['2999999999']

    def test_empty_work_is_all_none(self):
        p = parse_biblio({})
        assert p['volume'] is None and p['publisher'] is None
        assert p['extra_identifiers'] == {}


class TestIdTail:
    def test_pmid_url(self):
        assert _id_tail('https://pubmed.ncbi.nlm.nih.gov/39000001') == '39000001'

    def test_none(self):
        assert _id_tail(None) is None
