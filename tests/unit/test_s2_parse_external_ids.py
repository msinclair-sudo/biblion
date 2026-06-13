"""
Unit tests for the shared S2 externalIds parser
(biblion.clients.semanticscholar.parse_external_ids), used by both the
metadata-enrichment and search producers.
"""
import pytest

from biblion.clients.semanticscholar import parse_external_ids


pytestmark = pytest.mark.unit


def test_splits_schemes_and_pubmed():
    extra, pmid, pmcid = parse_external_ids({
        'DOI': '10.1/x',          # handled separately by callers
        'ArXiv': '2401.00001',
        'MAG': '2999',
        'DBLP': 'conf/x/y',
        'ACL': 'P19-1',
        'CorpusId': '12345',
        'PubMed': '99',
        'PubMedCentral': 'PMC7',
    })
    assert extra == {
        'arxiv': ['2401.00001'], 'mag': ['2999'], 'dblp': ['conf/x/y'],
        'acl': ['P19-1'], 's2_corpus': ['12345'],
    }
    assert pmid == '99'
    assert pmcid == 'PMC7'


def test_empty_and_none():
    assert parse_external_ids({}) == ({}, None, None)
    assert parse_external_ids(None) == ({}, None, None)


def test_only_doi_yields_nothing_extra():
    assert parse_external_ids({'DOI': '10.1/x'}) == ({}, None, None)


def test_values_coerced_to_str():
    extra, pmid, _ = parse_external_ids({'MAG': 2999, 'PubMed': 99})
    assert extra == {'mag': ['2999']}
    assert pmid == '99'
