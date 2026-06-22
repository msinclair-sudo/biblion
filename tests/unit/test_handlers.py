"""
Per-endpoint handler unit tests with stub clients (no network). Each asserts the
handler emits the right PaperRecords / CitationRecords and per-(paper, field)
marks. Reuses the real legacy parsing, so a parse regression surfaces here too.
"""
from types import SimpleNamespace

import pytest

from biblion.enrich.handlers import (
    crossref, oa_meta, s2_meta, ncbi_meta, oa_stubs, resolve_s2id,
    resolve_pmid, resolve_oa, resolve_s2, incoming_oa, hop_s2,
)

pytestmark = pytest.mark.unit


def _item(pid, needs, **cols):
    base = dict(doi=None, s2_id=None, oa_id=None, pubmed_id=None, title=None,
                year=None)
    base.update(cols)
    return SimpleNamespace(paper_id=pid, cols=base, needs=set(needs))


# -- crossref ---------------------------------------------------------------
class _StubCrossref:
    def __init__(self, by_doi): self.by_doi = by_doi
    def fetch_batch_by_doi(self, dois): return {d: self.by_doi[d] for d in dois if d in self.by_doi}


def test_crossref_marks_present_fields():
    it = _item(1, {('crossref', 'volume'), ('crossref', 'publisher')}, doi='10.1/a')
    stub = _StubCrossref({'10.1/a': {'DOI': '10.1/a', 'volume': '7',
                                     'publisher': 'Acme'}})
    res = crossref.handle(stub, [it])
    assert res.papers and (1, 'volume') in res.succeeded
    assert (1, 'publisher') in res.succeeded


# -- oa / s2 metadata -------------------------------------------------------
class _StubOA:
    breaker_open = False
    def __init__(self, works): self.works = works
    def fetch_batch_by_doi(self, dois, select=None):
        return {d: self.works[d] for d in dois if d in self.works}


def _oa_work(doi):
    return {'id': 'https://openalex.org/W1',
            'doi': f'https://doi.org/{doi}', 'title': 'T',
            'publication_year': 2020,
            'authorships': [{'author': {'display_name': 'A. Author'}}],
            'primary_location': {'source': {'display_name': 'Venue'}},
            'abstract_inverted_index': None, 'type': 'article',
            'cited_by_count': 3, 'referenced_works': ['https://openalex.org/W9'],
            'biblio': {}, 'ids': {}}


def test_oa_meta_emits_paper_edges_and_marks():
    needs = {('oa', f) for f in ('abstract', 'authors', 'venue', 'year', 'pub_type')}
    it = _item(1, needs, doi='10.1/a')
    res = oa_meta.handle(_StubOA({'10.1/a': _oa_work('10.1/a')}), [it])
    assert len(res.papers) == 1
    assert len(res.citations) == 1                      # one referenced work
    assert (1, 'authors') in res.succeeded
    assert (1, 'abstract') in res.failed               # no abstract in stub


class _StubS2:
    breaker_open = False
    def __init__(self, works): self.works = works
    def fetch_batch_by_doi(self, dois, fields=None):
        return {d: self.works[d] for d in dois if d in self.works}
    def fetch_batch_by_id(self, ids, fields=None):
        return [self.works.get(i) for i in ids]


def _s2_work(doi=None, s2='S1'):
    return {'paperId': s2, 'externalIds': ({'DOI': doi} if doi else {}),
            'title': 'T', 'year': 2020,
            'authors': [{'name': 'A. Author'}], 'venue': 'Venue',
            'abstract': 'An abstract.', 'publicationTypes': ['JournalArticle'],
            'citationCount': 2, 'referenceCount': 1,
            'references': [{'externalIds': {'DOI': '10.1/ref'}, 'paperId': 'R1'}],
            'citations': []}


def test_s2_meta_emits_and_marks():
    needs = {('s2_live', f) for f in ('abstract', 'authors', 'venue', 'year', 'pub_type')}
    it = _item(1, needs, doi='10.1/a')
    res = s2_meta.handle(_StubS2({'10.1/a': _s2_work('10.1/a')}), [it])
    assert len(res.papers) == 1 and len(res.citations) == 1
    assert (1, 'abstract') in res.succeeded


# -- ncbi -------------------------------------------------------------------
class _StubNcbi:
    def __init__(self, pmid_doi=None, abstracts=None):
        self.pmid_doi = pmid_doi or {}
        self.abstracts = abstracts or {}
    def pmids_for_dois(self, dois): return self.pmid_doi
    def fetch_abstracts_by_pmid(self, pmids):
        return {p: self.abstracts[p] for p in pmids if p in self.abstracts}
    def summary_by_pmid(self, pmids):
        return {p: self.abstracts[p] for p in pmids if p in self.abstracts}


def test_ncbi_meta_pmid_path():
    it = _item(1, {('ncbi', 'abstract'), ('ncbi', 'title')}, pubmed_id='P1')
    stub = _StubNcbi(abstracts={'P1': {'abstract': 'A', 'title': 'T'}})
    res = ncbi_meta.handle(stub, [it])
    assert len(res.papers) == 1
    assert (1, 'abstract') in res.succeeded and (1, 'title') in res.succeeded


def test_ncbi_meta_doi_unresolved_fails():
    it = _item(1, {('ncbi', 'abstract')}, doi='10.1/a')   # no pmid, doesn't resolve
    res = ncbi_meta.handle(_StubNcbi(pmid_doi={}), [it])
    assert (1, 'abstract') in res.failed


# -- '_all' by-id handlers --------------------------------------------------
def test_oa_stubs_all_mark():
    it = _item(1, {('oa', '_all')}, oa_id='W6')
    class S(_StubOA):
        def fetch_batch_by_oa_id(self, oids, select=None):
            return {o: _oa_work('10.1/x') for o in oids}
    res = oa_stubs.handle(S({}), [it])
    assert res.papers and (1, '_all') in res.succeeded


def test_resolve_s2id_succeeds_only_with_doi():
    it_doi = _item(1, {('s2_live', '_all')}, s2_id='S1')
    it_nodoi = _item(2, {('s2_live', '_all')}, s2_id='S2')
    stub = _StubS2({'S1': _s2_work('10.1/a', 'S1'), 'S2': _s2_work(None, 'S2')})
    res = resolve_s2id.handle(stub, [it_doi, it_nodoi])
    assert (1, '_all') in res.succeeded     # DOI recovered
    assert (2, '_all') in res.failed        # S2 knew it but no DOI


def test_resolve_pmid_all_mark():
    it = _item(1, {('ncbi_pmid', '_all')}, pubmed_id='P1', s2_id='S1')
    stub = _StubNcbi(abstracts={'P1': {'doi': '10.1/a', 'pmcid': 'PMC1'}})
    res = resolve_pmid.handle(stub, [it])
    assert res.papers and (1, '_all') in res.succeeded


# -- title search -----------------------------------------------------------
class _StubSearchOA:
    breaker_open = False
    def __init__(self, results): self.results = results
    def search_by_title(self, title, year=None, top_k=3, select=None):
        return self.results


def test_resolve_oa_search_threshold():
    it = _item(1, {('oa', '_all')}, title='A Distinctive Title')
    # exact title -> similarity 1.0 > 0.85 threshold
    stub = _StubSearchOA([_oa_work('10.1/a') | {'title': 'A Distinctive Title'}])
    res = resolve_oa.handle(stub, [it])
    assert res.papers and (1, '_all') in res.succeeded

    it2 = _item(2, {('oa', '_all')}, title='A Distinctive Title')
    stub_low = _StubSearchOA([_oa_work('10.1/a') | {'title': 'Totally Unrelated'}])
    res2 = resolve_oa.handle(stub_low, [it2])
    assert (2, '_all') in res2.failed       # below threshold


class _StubSearchS2(_StubS2):
    def __init__(self, results): self.results = results; self.breaker_open = False
    def search_by_title(self, title, year=None, top_k=3, fields=None):
        return self.results


def test_resolve_oa_bridges_seed_id():
    # An s2-origin seed (s2_id, no DOI) resolved via OA: the pushed record must
    # carry the seed's s2_id so the merge links back instead of orphaning.
    it = _item(1, {('oa', '_all')}, title='A Distinctive Title', s2_id='SEED99')
    stub = _StubSearchOA([_oa_work('10.1/a') | {'title': 'A Distinctive Title'}])
    res = resolve_oa.handle(stub, [it])
    assert res.papers
    rec = res.papers[0]
    assert rec.s2_id == 'SEED99'                  # bridge to the seed
    assert rec.oa_id == 'W1'                       # plus the discovered OA id


def test_resolve_s2_search():
    it = _item(1, {('s2_live', '_all')}, title='Matchable Title')
    stub = _StubSearchS2([_s2_work('10.1/a') | {'title': 'Matchable Title'}])
    res = resolve_s2.handle(stub, [it])
    assert res.papers and (1, '_all') in res.succeeded


# -- expansion --------------------------------------------------------------
class _StubCites:
    breaker_open = False
    def __init__(self, citers): self.citers = citers
    def cites_of(self, oa_id):
        return iter(self.citers)


def test_incoming_oa_edges():
    it = _item(1, {('oa_incoming', 'cites')}, oa_id='https://openalex.org/W6')
    stub = _StubCites([{'doi': '10.1/c', 'oa_id': 'W7'}])
    res = incoming_oa.handle(stub, [it])
    assert len(res.citations) == 1 and (1, 'cites') in res.succeeded
    edge = res.citations[0]
    assert edge.cited_oa_id == 'W6' and edge.citing_oa_id == 'W7'


class _StubHop:
    breaker_open = False
    def __init__(self, by_qid): self.by_qid = by_qid
    def fetch_batch_by_id(self, qids, fields=None):
        return [self.by_qid.get(q) for q in qids]
    def paginated_fetch(self, *a, **k): return []


def test_hop_s2_refs_and_neighbours():
    it = _item(1, {('s2_hop', '_all')}, doi='10.1/seed', s2_id='S1')
    work = {'paperId': 'S1', 'externalIds': {'DOI': '10.1/seed'}, 'title': 'Seed',
            'referenceCount': 1, 'citationCount': 0,
            'references': [{'externalIds': {'DOI': '10.1/ref'}, 'paperId': 'R1',
                            'title': 'Ref', 'authors': []}],
            'citations': []}
    # _query_id_for prefers s2_id -> 'S1'
    stub = _StubHop({'S1': work})
    res = hop_s2.handle(stub, [it])
    assert (1, '_all') in res.succeeded
    assert any(c.cited_s2_id == 'R1' or c.cited_doi == '10.1/ref'
               for c in res.citations)
    # edges only: just the seed record, no neighbour stub papers
    assert len(res.papers) == 1
