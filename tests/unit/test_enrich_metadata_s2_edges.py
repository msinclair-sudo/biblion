"""The S2 enricher builds BOTH citation directions from one batch response.

references -> outgoing (this paper cites X); citations -> incoming
(Y cites this paper). Edge-only, identifier-addressed.
"""
import pytest

from biblion.modules.enrich_metadata_s2 import _citation_records

pytestmark = pytest.mark.unit


def _work():
    return {
        'paperId': 'THIS', 'externalIds': {'DOI': '10.1/this'},
        'references': [{'paperId': 'REF', 'externalIds': {'DOI': '10.1/ref'}}],
        'citations':  [{'paperId': 'CITER', 'externalIds': {'DOI': '10.1/citer'}}],
    }


def test_builds_both_directions():
    edges = _citation_records(_work(), 's2_batch')
    pairs = {(e.citing_s2_id, e.cited_s2_id) for e in edges}
    assert ('THIS', 'REF') in pairs       # outgoing: this cites ref
    assert ('CITER', 'THIS') in pairs     # incoming: citer cites this
    assert len(edges) == 2


def test_incoming_edge_carries_citer_doi():
    edges = _citation_records(_work(), 's2_batch')
    incoming = next(e for e in edges if e.cited_s2_id == 'THIS')
    assert incoming.citing_doi == '10.1/citer'
    assert incoming.cited_doi == '10.1/this'


def test_skips_endpoints_without_identifiers():
    work = {
        'paperId': 'THIS', 'externalIds': {'DOI': '10.1/this'},
        'references': [{'externalIds': {}}],          # no id -> skipped
        'citations':  [{'paperId': 'CITER', 'externalIds': {}}],  # has s2 id
    }
    edges = _citation_records(work, 's2_batch')
    assert len(edges) == 1
    assert edges[0].citing_s2_id == 'CITER'


def test_no_edges_when_this_work_has_no_id():
    work = {'externalIds': {}, 'references': [{'paperId': 'X'}]}
    assert _citation_records(work, 's2_batch') == []
