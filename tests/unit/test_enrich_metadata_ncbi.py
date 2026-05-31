"""Tests for enrich_metadata_ncbi — PubMed abstract enrichment.

Covers the pure record/field helpers and the run() loop with the NCBI client
and the claim-flow helpers (request_claim / report_marks) faked, so no network
or writer/Redis claim plumbing is needed.
"""
import pytest

from biblion.cache.records import PaperRecord
from biblion.modules.enrich_metadata_ncbi import (
    EnrichMetadataNcbi, _present_fields, _to_record, _SERVICE_FIELDS,
)
import biblion.modules.enrich_metadata_ncbi as mod
from tests.support.fake_clients import FakeNcbiClient

pytestmark = pytest.mark.unit


class _Shutdown:
    requested = False


class _Ctx:
    def __init__(self, cache=None, config=None):
        self.cache = cache
        self.config = config or {}
        self.shutdown = _Shutdown()


class _Cache:
    """Captures pushed PaperRecords."""
    def __init__(self):
        self.papers = []

    def push_paper(self, rec):
        self.papers.append(rec)
        return True


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

def test_present_fields():
    rec = PaperRecord(source='x', pubmed_id='1', abstract='A', title='T', year=None)
    assert _present_fields(rec) == {'abstract', 'title'}
    assert _present_fields(PaperRecord(source='x', pubmed_id='1')) == set()


def test_to_record_harvests_all_ids():
    rec = _to_record('123', {'abstract': 'A', 'title': 'T', 'year': 2020,
                             'doi': '10.1/x', 'pmcid': 'PMC9'}, 'ncbi_efetch')
    assert rec.pubmed_id == '123' and rec.abstract == 'A'
    assert rec.title == 'T' and rec.year == 2020 and rec.doi == '10.1/x'
    # PMID + PMCID + DOI are all collected as extra request handles.
    assert rec.pubmed_central_id == 'PMC9'
    assert rec.source == 'ncbi_efetch'


# ---------------------------------------------------------------------------
# run() loop — claim flow + client faked
# ---------------------------------------------------------------------------

def _patch_claim_flow(monkeypatch, grant_rows, captured):
    """request_claim yields grant_rows once, then [] to end the loop."""
    calls = {'n': 0}

    def fake_request_claim(cache, name, batch_size, timeout_s=30.0):
        calls['n'] += 1
        return grant_rows if calls['n'] == 1 else []

    def fake_report_marks(cache, name, succeeded, failed):
        captured['succeeded'] = list(succeeded)
        captured['failed'] = list(failed)

    monkeypatch.setattr(mod, 'request_claim', fake_request_claim, raising=False)
    monkeypatch.setattr(mod, 'report_marks', fake_report_marks, raising=False)
    # The module imports these names inside run(); patch at source too.
    import biblion.framework.claims as claims
    monkeypatch.setattr(claims, 'request_claim', fake_request_claim)
    monkeypatch.setattr(claims, 'report_marks', fake_report_marks)


def test_enriches_paper_with_pmid(monkeypatch):
    captured = {}
    grant = [{'id': 1, 'pubmed_id': '111', 'doi': None,
              'need_abstract': 1, 'need_title': 0, 'need_year': 0}]
    _patch_claim_flow(monkeypatch, grant, captured)
    fake = FakeNcbiClient(abstracts={'111': {'abstract': 'The abstract.',
                                             'title': 'T', 'year': 2020,
                                             'doi': '10.1/x'}})
    monkeypatch.setattr(mod, 'NcbiClient', lambda: fake)

    cache = _Cache()
    res = EnrichMetadataNcbi().run(_Ctx(cache, {'loop': False}))

    assert res.stats['found'] == 1
    assert cache.papers and cache.papers[0].abstract == 'The abstract.'
    # Only the claimed field (abstract) is reported succeeded.
    assert (1, 'abstract') in captured['succeeded']
    assert all(f == 'abstract' for _, f in captured['succeeded'])


def test_resolves_doi_only_paper_via_esearch(monkeypatch):
    captured = {}
    grant = [{'id': 2, 'pubmed_id': None, 'doi': '10.1/findme',
              'need_abstract': 1, 'need_title': 0, 'need_year': 0}]
    _patch_claim_flow(monkeypatch, grant, captured)
    fake = FakeNcbiClient(
        doi_to_pmid={'10.1/findme': '222'},
        abstracts={'222': {'abstract': 'Found via DOI.', 'title': None,
                           'year': None, 'doi': '10.1/findme'}})
    monkeypatch.setattr(mod, 'NcbiClient', lambda: fake)

    cache = _Cache()
    res = EnrichMetadataNcbi().run(_Ctx(cache, {'loop': False}))

    assert res.stats['doi_resolved'] == 1
    assert res.stats['found'] == 1
    assert cache.papers[0].abstract == 'Found via DOI.'
    assert (2, 'abstract') in captured['succeeded']


def test_missing_from_pubmed_marks_failed(monkeypatch):
    captured = {}
    grant = [{'id': 3, 'pubmed_id': '999', 'doi': None,
              'need_abstract': 1, 'need_title': 0, 'need_year': 0}]
    _patch_claim_flow(monkeypatch, grant, captured)
    fake = FakeNcbiClient(abstracts={})   # PubMed has nothing for 999
    monkeypatch.setattr(mod, 'NcbiClient', lambda: fake)

    cache = _Cache()
    res = EnrichMetadataNcbi().run(_Ctx(cache, {'loop': False}))

    assert res.stats['found'] == 0
    assert res.stats['missing_from_pubmed'] == 1
    assert (3, 'abstract') in captured['failed']


def test_unresolvable_doi_marks_failed(monkeypatch):
    captured = {}
    grant = [{'id': 4, 'pubmed_id': None, 'doi': '10.1/nope',
              'need_abstract': 1, 'need_title': 0, 'need_year': 0}]
    _patch_claim_flow(monkeypatch, grant, captured)
    fake = FakeNcbiClient(doi_to_pmid={}, abstracts={})  # DOI not in PubMed
    monkeypatch.setattr(mod, 'NcbiClient', lambda: fake)

    cache = _Cache()
    res = EnrichMetadataNcbi().run(_Ctx(cache, {'loop': False}))

    assert res.stats['found'] == 0
    assert (4, 'abstract') in captured['failed']
