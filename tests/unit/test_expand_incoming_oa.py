"""Tests for expand_incoming_oa — incoming citations via OpenAlex cites:.

The producer pushes edge-only CitationRecords (citer -> this paper) with no
stub-paper metadata; unknown citers park in pending_citations downstream.
Claim flow + OA client are faked, so no network.
"""
import pytest

from biblion.cache.records import CitationRecord
import biblion.modules.expand_incoming_oa as mod
from biblion.modules.expand_incoming_oa import ExpandIncomingOa
from tests.support.fake_clients import FakeOpenAlexClient

pytestmark = pytest.mark.unit


class _Shutdown:
    requested = False


class _Ctx:
    def __init__(self, cache, config=None):
        self.cache = cache
        self.config = config or {}
        self.shutdown = _Shutdown()


class _Cache:
    def __init__(self):
        self.citations = []
        self.papers = []

    def push_citation(self, rec):
        self.citations.append(rec)

    def push_paper(self, rec):
        self.papers.append(rec)


def _patch(monkeypatch, grant_rows, captured, client):
    calls = {'n': 0}

    def fake_request_claim(cache, name, batch_size, timeout_s=30.0):
        calls['n'] += 1
        return grant_rows if calls['n'] == 1 else []

    def fake_report_marks(cache, name, succeeded, failed):
        captured['succeeded'] = list(succeeded)
        captured['failed'] = list(failed)

    import biblion.framework.claims as claims
    monkeypatch.setattr(claims, 'request_claim', fake_request_claim)
    monkeypatch.setattr(claims, 'report_marks', fake_report_marks)
    monkeypatch.setattr(mod, 'OpenAlexClient', lambda: client)


def test_pushes_incoming_edge_only(monkeypatch):
    captured = {}
    client = FakeOpenAlexClient(citers={
        'W100': [{'oa_id': 'W200', 'doi': '10.1/citer'}],
    })
    grant = [{'id': 1, 'oa_id': 'W100'}]
    _patch(monkeypatch, grant, captured, client)

    cache = _Cache()
    res = ExpandIncomingOa().run(_Ctx(cache, {'loop': False}))

    assert res.stats['edges_pushed'] == 1
    # Direction: citer W200 -> this paper W100.
    e = cache.citations[0]
    assert e.citing_oa_id == 'W200' and e.cited_oa_id == 'W100'
    assert e.citing_doi == '10.1/citer'
    # Edge-only: NO stub papers pushed for the citer.
    assert cache.papers == []
    assert (1, 'cites') in captured['succeeded']


def test_paginates_all_citers(monkeypatch):
    captured = {}
    citers = [{'oa_id': f'W{i}', 'doi': None} for i in range(250)]
    client = FakeOpenAlexClient(citers={'W100': citers})
    grant = [{'id': 1, 'oa_id': 'W100'}]
    _patch(monkeypatch, grant, captured, client)

    cache = _Cache()
    res = ExpandIncomingOa().run(_Ctx(cache, {'loop': False}))
    assert res.stats['edges_pushed'] == 250        # all citers, no cap
    assert len(cache.citations) == 250


def test_paper_with_no_citers_is_noop_but_marked(monkeypatch):
    captured = {}
    client = FakeOpenAlexClient(citers={})          # nothing cites it
    grant = [{'id': 5, 'oa_id': 'W999'}]
    _patch(monkeypatch, grant, captured, client)

    cache = _Cache()
    res = ExpandIncomingOa().run(_Ctx(cache, {'loop': False}))
    assert res.stats['edges_pushed'] == 0
    # Still marked succeeded — we DID check; nothing to do isn't a failure.
    assert (5, 'cites') in captured['succeeded']
