"""
Tests for the API clients (NCBI, S2 bulk).

Both have mocked HTTP layers — no live network access happens. These
tests are the original test_ncbi.py and test_s2_bulk.py ported to
pytest with class-based grouping for readability.
"""
import gzip
import io
import json
from typing import Optional
from unittest import mock

import pytest

from biblion.clients import ncbi, s2_bulk
from biblion.clients.ncbi   import NcbiClient, NCBI_BATCH_SIZE
from biblion.clients.s2_bulk import S2BulkClient, _redact_url


pytestmark = pytest.mark.unit


# ===========================================================================
# NCBI
# ===========================================================================

def _resp(json_data=None, status=200, text=''):
    m = mock.MagicMock()
    m.status_code = status
    m.json.return_value = json_data or {}
    m.text = text
    m.content = text.encode() if text else b''
    return m


_REAL_PAYLOAD = {
    'header': {'type': 'esummary', 'version': '0.3'},
    'result': {
        'uids': ['23456789', '11111111'],
        '23456789': {
            'uid': '23456789',
            'articleids': [
                {'idtype': 'pubmed', 'value': '23456789'},
                {'idtype': 'pmc',    'value': 'PMC6121709'},
                {'idtype': 'pmcid',  'value': 'pmc-id: PMC6121709;manuscript-id: NIHMS864114;'},
                {'idtype': 'doi',    'value': '10.1002/cncr.27976'},
            ],
        },
        '11111111': {
            'uid': '11111111',
            'articleids': [{'idtype': 'pubmed', 'value': '11111111'}],
        },
    },
}


@pytest.fixture
def ncbi_client():
    return NcbiClient(api_key='test', email='t@example.com',
                      rate_limit_rps=1000.0)


class TestNcbiClient:
    def test_extracts_doi_and_clean_pmcid(self, ncbi_client):
        with mock.patch.object(ncbi_client._session, 'get',
                               return_value=_resp(_REAL_PAYLOAD)):
            out = ncbi_client.summary_by_pmid(['23456789', '11111111'])
        assert out['23456789']['doi'] == '10.1002/cncr.27976'
        assert out['23456789']['pmcid'] == 'PMC6121709'
        assert 'manuscript-id' not in out['23456789']['pmcid']

    def test_pmid_with_neither_doi_nor_pmcid_omitted(self, ncbi_client):
        with mock.patch.object(ncbi_client._session, 'get',
                               return_value=_resp(_REAL_PAYLOAD)):
            out = ncbi_client.summary_by_pmid(['23456789', '11111111'])
        assert '11111111' not in out

    def test_doi_normalised_lowercase(self, ncbi_client):
        payload = {'result': {
            'uids': ['1'],
            '1': {'articleids': [
                {'idtype': 'doi', 'value': 'HTTPS://DOI.ORG/10.X/Y'},
            ]},
        }}
        with mock.patch.object(ncbi_client._session, 'get',
                               return_value=_resp(payload)):
            out = ncbi_client.summary_by_pmid(['1'])
        assert out['1']['doi'] == '10.x/y'

    def test_pmc_prefix_added_when_missing(self, ncbi_client):
        payload = {'result': {
            'uids': ['1'],
            '1': {'articleids': [{'idtype': 'pmc', 'value': '1234567'}]},
        }}
        with mock.patch.object(ncbi_client._session, 'get',
                               return_value=_resp(payload)):
            out = ncbi_client.summary_by_pmid(['1'])
        assert out['1']['pmcid'] == 'PMC1234567'

    def test_input_deduplicated(self, ncbi_client):
        captured: list[list[str]] = []
        def fake_get(url, params=None, timeout=None):
            captured.append(params['id'].split(','))
            return _resp({'result': {'uids': []}})
        with mock.patch.object(ncbi_client._session, 'get', side_effect=fake_get):
            ncbi_client.summary_by_pmid(['1', '1', '2', '3', '2'])
        assert sorted(captured[0]) == ['1', '2', '3']

    def test_chunks_at_batch_size(self, ncbi_client):
        captured: list[list[str]] = []
        def fake_get(url, params=None, timeout=None):
            captured.append(params['id'].split(','))
            return _resp({'result': {'uids': []}})
        ids = [str(i) for i in range(NCBI_BATCH_SIZE + 50)]
        with mock.patch.object(ncbi_client._session, 'get', side_effect=fake_get):
            ncbi_client.summary_by_pmid(ids)
        assert len(captured) == 2

    def test_empty_input(self, ncbi_client):
        with mock.patch.object(ncbi_client._session, 'get',
                               side_effect=AssertionError('should not call')):
            assert ncbi_client.summary_by_pmid([]) == {}

    def test_retries_on_429(self, ncbi_client):
        responses = [_resp(status=429), _resp(_REAL_PAYLOAD)]
        def fake_get(url, params=None, timeout=None):
            return responses.pop(0)
        with mock.patch.object(ncbi_client._session, 'get', side_effect=fake_get), \
             mock.patch.object(ncbi.time, 'sleep'):
            out = ncbi_client.summary_by_pmid(['23456789'])
        assert '23456789' in out

    def test_gives_up_after_max_retries(self, ncbi_client):
        with mock.patch.object(ncbi_client._session, 'get',
                               return_value=_resp(status=503)), \
             mock.patch.object(ncbi.time, 'sleep'):
            assert ncbi_client.summary_by_pmid(['1']) == {}

    def test_4xx_not_retried(self, ncbi_client):
        calls = []
        def fake_get(url, params=None, timeout=None):
            calls.append(1)
            return _resp(status=400)
        with mock.patch.object(ncbi_client._session, 'get', side_effect=fake_get):
            assert ncbi_client.summary_by_pmid(['1']) == {}
        assert len(calls) == 1

    def test_includes_api_key_and_email(self, ncbi_client):
        captured: dict = {}
        def fake_get(url, params=None, timeout=None):
            captured.update(params)
            return _resp({'result': {'uids': []}})
        with mock.patch.object(ncbi_client._session, 'get', side_effect=fake_get):
            ncbi_client.summary_by_pmid(['1'])
        assert captured['api_key'] == 'test'
        assert captured['email'] == 't@example.com'

    def test_omits_auth_when_blank(self):
        c = NcbiClient(api_key='', email='', rate_limit_rps=1000.0)
        captured: dict = {}
        def fake_get(url, params=None, timeout=None):
            captured.update(params)
            return _resp({'result': {'uids': []}})
        with mock.patch.object(c._session, 'get', side_effect=fake_get):
            c.summary_by_pmid(['1'])
        assert 'api_key' not in captured
        assert 'email' not in captured


# efetch abstract XML fixture: one PMC-resident article (structured abstract,
# pmid + pmc + doi ArticleIds) and one article missing the abstract.
_EFETCH_XML = """<?xml version="1.0"?>
<PubmedArticleSet>
 <PubmedArticle>
  <MedlineCitation>
   <PMID>34487210</PMID>
   <Article>
    <ArticleTitle>A study of microalgae</ArticleTitle>
    <Abstract>
     <AbstractText Label="BACKGROUND">Algae grow.</AbstractText>
     <AbstractText Label="RESULTS">They grew.</AbstractText>
    </Abstract>
    <ArticleDate><Year>2021</Year></ArticleDate>
   </Article>
  </MedlineCitation>
  <PubmedData><ArticleIdList>
   <ArticleId IdType="pubmed">34487210</ArticleId>
   <ArticleId IdType="pmc">PMC5101388</ArticleId>
   <ArticleId IdType="doi">10.1/abc</ArticleId>
  </ArticleIdList></PubmedData>
 </PubmedArticle>
 <PubmedArticle>
  <MedlineCitation>
   <PMID>28688736</PMID>
   <Article><ArticleTitle>No abstract here</ArticleTitle></Article>
  </MedlineCitation>
  <PubmedData><ArticleIdList>
   <ArticleId IdType="doi">10.1/noabs</ArticleId>
  </ArticleIdList></PubmedData>
 </PubmedArticle>
</PubmedArticleSet>"""


class TestNcbiEfetch:
    def test_parse_harvests_ids_and_structured_abstract(self):
        out = ncbi._parse_efetch_xml(_EFETCH_XML)
        rec = out['34487210']
        # PMID + PMCID + DOI all collected.
        assert rec['doi'] == '10.1/abc'
        assert rec['pmcid'] == 'PMC5101388'
        assert rec['year'] == 2021
        assert rec['title'] == 'A study of microalgae'
        # Labelled sections joined.
        assert 'BACKGROUND: Algae grow.' in rec['abstract']
        assert 'RESULTS: They grew.' in rec['abstract']

    def test_parse_no_abstract_no_pmc(self):
        out = ncbi._parse_efetch_xml(_EFETCH_XML)
        rec = out['28688736']
        assert rec['abstract'] is None
        assert rec['pmcid'] is None
        assert rec['doi'] == '10.1/noabs'

    def test_parse_bad_xml_returns_empty(self):
        assert ncbi._parse_efetch_xml('<not valid') == {}

    def test_fetch_abstracts_by_pmid_calls_efetch(self, ncbi_client):
        captured: dict = {}
        def fake_get(url, params=None, timeout=None):
            captured['url'] = url
            captured['params'] = params
            return _resp(text=_EFETCH_XML)
        with mock.patch.object(ncbi_client._session, 'get', side_effect=fake_get):
            out = ncbi_client.fetch_abstracts_by_pmid(['34487210'])
        assert captured['url'].endswith('efetch.fcgi')
        assert captured['params']['rettype'] == 'abstract'
        assert out['34487210']['pmcid'] == 'PMC5101388'

    def test_pmids_for_dois_uses_esearch(self, ncbi_client):
        def fake_get(url, params=None, timeout=None):
            assert url.endswith('esearch.fcgi')
            assert params['term'] == '10.1/x[AID]'
            return _resp({'esearchresult': {'idlist': ['555']}})
        with mock.patch.object(ncbi_client._session, 'get', side_effect=fake_get):
            out = ncbi_client.pmids_for_dois(['10.1/x'])
        assert out == {'10.1/x': '555'}


# ===========================================================================
# S2 Bulk
# ===========================================================================

def _gz_jsonl(records: list[dict]) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb') as gz:
        for r in records:
            gz.write((json.dumps(r) + '\n').encode())
    return buf.getvalue()


class _FakeRawResponse:
    def __init__(self, body: bytes):
        self._body = body
        self.decode_content = True
        self.closed = False
    def stream(self, chunk_size, decode_content=False):
        i = 0
        while i < len(self._body):
            yield self._body[i:i + chunk_size]
            i += chunk_size
    def close(self): self.closed = True
    def read(self, n=-1):
        if n is None or n < 0:
            data, self._body = self._body, b''
        else:
            data, self._body = self._body[:n], self._body[n:]
        return data


class _FakeResponse:
    def __init__(self, body=b'', status_code=200, json_data=None):
        self.status_code = status_code
        self._json = json_data
        self.text = body.decode('utf-8', errors='replace') if body else ''
        self.raw = _FakeRawResponse(body)
        self.closed = False
    def __enter__(self): return self
    def __exit__(self, *a): self.close()
    def close(self):
        self.closed = True
        self.raw.close()
    def raise_for_status(self):
        if self.status_code >= 400:
            raise s2_bulk.requests.exceptions.HTTPError(self.status_code)
    def json(self):
        return self._json


class TestRedactUrl:
    def test_redacts_signed_url(self):
        url = ('https://ai2-s2ag.s3.amazonaws.com/staging/2026/abstracts/foo'
               '?X-Amz-Signature=abc&X-Amz-Expires=604800')
        assert _redact_url(url) == (
            'https://ai2-s2ag.s3.amazonaws.com/staging/2026/abstracts/foo'
            '?<signed-params>'
        )

    def test_url_without_query_unchanged(self):
        url = 'https://api.semanticscholar.org/datasets/v1/release/'
        assert _redact_url(url) == url


@pytest.fixture
def s2_bulk_client():
    return S2BulkClient(api_key='test')


@pytest.fixture
def sample_records():
    return [
        {'corpusid': 1, 'sha': 'aaa', 'primary': True},
        {'corpusid': 2, 'sha': 'bbb', 'primary': True},
        {'corpusid': 3, 'sha': 'ccc', 'primary': False},
    ]


class TestDownloadAndIterate:
    def test_download_then_iterate(self, s2_bulk_client, sample_records,
                                   tmp_path):
        body = _gz_jsonl(sample_records)
        dest = tmp_path / 'x.gz'
        with mock.patch.object(s2_bulk_client._session, 'get',
                               return_value=_FakeResponse(body=body)):
            n = s2_bulk_client.download_file('https://example/x.gz', dest)
        assert n == len(body)
        assert dest.exists()
        out = list(s2_bulk.iter_jsonl_gz_file(dest))
        assert out == sample_records

    def test_skips_when_already_present(self, s2_bulk_client, sample_records,
                                        tmp_path):
        body = _gz_jsonl(sample_records)
        dest = tmp_path / 'x.gz'
        dest.write_bytes(body)
        with mock.patch.object(s2_bulk_client._session, 'get',
                               side_effect=AssertionError('should not call')):
            n = s2_bulk_client.download_file('https://example/x.gz', dest)
        assert n == 0

    def test_redownloads_on_size_mismatch(self, s2_bulk_client, sample_records,
                                          tmp_path):
        body = _gz_jsonl(sample_records)
        dest = tmp_path / 'x.gz'
        dest.write_bytes(b'partial')
        with mock.patch.object(s2_bulk_client._session, 'get',
                               return_value=_FakeResponse(body=body)):
            s2_bulk_client.download_file(
                'https://example/x.gz', dest, expected_size=len(body),
            )
        assert dest.stat().st_size == len(body)

    def test_retries_on_transient_error(self, s2_bulk_client, sample_records,
                                         tmp_path):
        body = _gz_jsonl(sample_records)
        responses = [
            s2_bulk.requests.exceptions.ConnectionError('reset'),
            s2_bulk.requests.exceptions.ConnectionError('reset'),
            _FakeResponse(body=body),
        ]
        def fake_get(*a, **kw):
            r = responses.pop(0)
            if isinstance(r, Exception): raise r
            return r
        dest = tmp_path / 'x.gz'
        with mock.patch.object(s2_bulk_client._session, 'get', side_effect=fake_get), \
             mock.patch.object(s2_bulk.time, 'sleep'):
            s2_bulk_client.download_file('https://example/x.gz', dest)
        assert dest.stat().st_size == len(body)

    def test_gives_up_after_max_retries(self, s2_bulk_client, tmp_path):
        dest = tmp_path / 'x.gz'
        with mock.patch.object(s2_bulk_client._session, 'get',
                               side_effect=s2_bulk.requests.exceptions.ConnectionError('x')), \
             mock.patch.object(s2_bulk.time, 'sleep'):
            with pytest.raises(RuntimeError, match='exhausted'):
                s2_bulk_client.download_file('https://example/x.gz', dest)
        assert not dest.exists()

    def test_iter_skips_malformed_lines(self, tmp_path):
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode='wb') as gz:
            gz.write(b'{"corpusid": 1}\n')
            gz.write(b'this is not json\n')
            gz.write(b'{"corpusid": 2}\n')
        dest = tmp_path / 'x.gz'
        dest.write_bytes(buf.getvalue())
        out = list(s2_bulk.iter_jsonl_gz_file(dest))
        assert out == [{'corpusid': 1}, {'corpusid': 2}]


class TestMetadataCalls:
    def test_list_releases(self, s2_bulk_client):
        resp = _FakeResponse(json_data=['2026-05-14', '2026-05-21'])
        with mock.patch.object(s2_bulk_client._session, 'get', return_value=resp):
            assert s2_bulk_client.list_releases() == ['2026-05-14', '2026-05-21']

    def test_latest_release(self, s2_bulk_client):
        resp = _FakeResponse(json_data=['2026-05-14', '2026-05-21'])
        with mock.patch.object(s2_bulk_client._session, 'get', return_value=resp):
            assert s2_bulk_client.latest_release() == '2026-05-21'

    def test_list_datasets(self, s2_bulk_client):
        payload = {'datasets': [{'name': 'papers'}, {'name': 'abstracts'}]}
        resp = _FakeResponse(json_data=payload)
        with mock.patch.object(s2_bulk_client._session, 'get', return_value=resp):
            ds = s2_bulk_client.list_datasets('2026-05-21')
        assert [d['name'] for d in ds] == ['papers', 'abstracts']

    def test_dataset_files(self, s2_bulk_client):
        payload = {'name': 'abstracts', 'files': ['url1', 'url2']}
        resp = _FakeResponse(json_data=payload)
        with mock.patch.object(s2_bulk_client._session, 'get', return_value=resp):
            d = s2_bulk_client.dataset_files('2026-05-21', 'abstracts')
        assert len(d['files']) == 2

    def test_dataset_files_404(self, s2_bulk_client):
        resp = _FakeResponse(body=b'not found', status_code=404)
        with mock.patch.object(s2_bulk_client._session, 'get', return_value=resp):
            assert s2_bulk_client.dataset_files('x', 'y') is None

    def test_headers_include_api_key(self, s2_bulk_client):
        h = s2_bulk_client._headers()
        assert h['x-api-key'] == 'test'

    def test_headers_omit_api_key_when_blank(self):
        c = S2BulkClient(api_key='')
        h = c._headers()
        assert 'x-api-key' not in h
