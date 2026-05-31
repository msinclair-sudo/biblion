"""
NCBI E-utilities client — narrow scope, just enough to resolve PMID → DOI.

Endpoint used:
    GET /entrez/eutils/esummary.fcgi
        db=pubmed
        id=<comma-separated PMIDs, up to ~200>
        retmode=json
        api_key=...
        email=...
        tool=biblion

NCBI returns one record per PMID under `result.<pmid>.articleids` as a list
of {idtype, value} dicts. We pull out idtype='doi' and idtype='pmc'.

Rate limits (NCBI policy):
  - With an API key: 10 RPS
  - Without:         3 RPS
We self-throttle below the ceiling because NCBI does count bursts.

Auth:
  - Read api_key from env var `ENTREZ_api`
  - Read email   from env var `ENTREZ_EMAIL`
  Both loaded by biblion.config from the project .env.

Why a dedicated client? The Graph and Datasets API clients hit different
hosts with different rate-limit models and different error codes; sharing
code would just paper over the differences. Keep this one tight and one
endpoint deep.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Iterable, Optional

import requests


NCBI_BASE_URL    = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
NCBI_API_KEY_ENV = 'ENTREZ_api'
NCBI_EMAIL_ENV   = 'ENTREZ_EMAIL'
NCBI_TOOL_NAME   = 'biblion'

# eSummary accepts up to 200 IDs per call comfortably; pushing higher
# (500+) sometimes returns truncated JSON. 200 is the documented safe max.
NCBI_BATCH_SIZE  = 200

_DEFAULT_RPS_AUTH   = 8.0   # below the 10 RPS limit for slack
_DEFAULT_RPS_NOAUTH = 2.5   # below the 3 RPS limit
_MAX_RETRIES        = 4
_BACKOFF_BASE       = 2.0
_BACKOFF_MAX        = 60.0
_TIMEOUT            = (10, 60)   # (connect, read)


_log = logging.getLogger(__name__)


def _get_api_key() -> str:
    """Load NCBI API key from .env via the package config side-effect."""
    from .. import config  # noqa: F401  (loads .env into os.environ)
    return os.environ.get(NCBI_API_KEY_ENV, '')


def _get_email() -> str:
    from .. import config  # noqa: F401
    return os.environ.get(NCBI_EMAIL_ENV, '')


def _normalise_doi(doi: Optional[str]) -> Optional[str]:
    """Same normalisation as the S2/OA clients use."""
    if not doi:
        return None
    d = doi.strip().lower()
    for prefix in ('https://doi.org/', 'http://doi.org/', 'doi.org/', 'doi:'):
        if d.startswith(prefix):
            d = d[len(prefix):]
            break
    return d or None


def _parse_efetch_xml(xml_text: str) -> dict:
    """Parse efetch PubMed XML into {pmid: {abstract,title,year,doi,pmcid}}.

    Abstracts may be split into labelled sections (<AbstractText Label="...">);
    we join them with the label as a prefix, mirroring how PubMed displays them.
    Uses the stdlib XML parser; PubMed XML is well-formed and not
    attacker-controlled here, but we still disable external entity surprises by
    using ElementTree (no DTD/entity expansion).
    """
    import xml.etree.ElementTree as ET
    out: dict = {}
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        _log.warning("NCBI efetch XML parse error: %s", e)
        return out
    for art in root.iter('PubmedArticle'):
        cit = art.find('.//MedlineCitation')
        if cit is None:
            continue
        pmid_el = cit.find('PMID')
        pmid = (pmid_el.text or '').strip() if pmid_el is not None else None
        if not pmid:
            continue
        article = cit.find('Article')
        title = year = abstract = doi = None
        if article is not None:
            t = article.find('ArticleTitle')
            if t is not None:
                title = ''.join(t.itertext()).strip() or None
            # Year: prefer ArticleDate, fall back to Journal PubDate.
            # NB: an ElementTree element with no children is falsy, so use an
            # explicit `is not None` check rather than `a or b`.
            y = article.find('.//ArticleDate/Year')
            if y is None:
                y = article.find('.//Journal/JournalIssue/PubDate/Year')
            if y is not None and (y.text or '').strip().isdigit():
                year = int(y.text.strip())
            # Abstract: join labelled sections.
            sections = []
            for at in article.findall('.//Abstract/AbstractText'):
                text = ''.join(at.itertext()).strip()
                if not text:
                    continue
                label = (at.get('Label') or '').strip()
                sections.append(f"{label}: {text}" if label else text)
            if sections:
                abstract = '\n'.join(sections)
        # DOI may be in an ELocationID; DOI + PMCID are also in the
        # PubmedData ArticleIdList. Collecting both IDs gives the pipeline
        # extra handles for later requests, so harvest them here for free.
        for eloc in art.iter('ELocationID'):
            if (eloc.get('EIdType') or '').lower() == 'doi' and eloc.text:
                doi = _normalise_doi(eloc.text)
                break
        pmcid = None
        for aid in art.iter('ArticleId'):
            idtype = (aid.get('IdType') or '').lower()
            val = (aid.text or '').strip()
            if not val:
                continue
            if idtype == 'doi' and doi is None:
                doi = _normalise_doi(val)
            elif idtype == 'pmc' and pmcid is None:
                pmcid = val if val.upper().startswith('PMC') else f'PMC{val}'
        out[pmid] = {'abstract': abstract, 'title': title,
                     'year': year, 'doi': doi, 'pmcid': pmcid}
    return out


class NcbiClient:
    """
    Throttled, retrying client for NCBI eSummary.

    One-call surface: summary_by_pmid(ids) → dict keyed by PMID.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        email:   Optional[str] = None,
        max_retries: int = _MAX_RETRIES,
        timeout = _TIMEOUT,
        rate_limit_rps: Optional[float] = None,
    ):
        self.api_key = api_key if api_key is not None else _get_api_key()
        self.email   = email   if email   is not None else _get_email()
        rps = rate_limit_rps if rate_limit_rps is not None else (
            _DEFAULT_RPS_AUTH if self.api_key else _DEFAULT_RPS_NOAUTH
        )
        self.max_retries = max_retries
        self.timeout     = timeout
        self._interval   = 1.0 / rps if rps > 0 else 0.0
        self._last       = 0.0
        self._session    = requests.Session()
        self._calls      = 0

    # ------------------------------------------------------------------
    # HTTP plumbing
    # ------------------------------------------------------------------

    def _params(self, ids: list[str]) -> dict:
        p: dict[str, str] = {
            'db':      'pubmed',
            'id':      ','.join(ids),
            'retmode': 'json',
            'tool':    NCBI_TOOL_NAME,
        }
        if self.api_key:
            p['api_key'] = self.api_key
        if self.email:
            p['email'] = self.email
        return p

    def _auth_params(self) -> dict:
        """Common auth/identity params for every E-utilities call."""
        p: dict[str, str] = {'tool': NCBI_TOOL_NAME}
        if self.api_key:
            p['api_key'] = self.api_key
        if self.email:
            p['email'] = self.email
        return p

    def _get(self, endpoint: str, params: dict):
        """Throttled, retried GET against one E-utilities endpoint.

        Returns the requests.Response on HTTP 200, or None after exhausting
        retries / on a non-retriable error. Callers parse the body (JSON for
        esummary/esearch, XML for efetch).
        """
        url = f'{NCBI_BASE_URL}/{endpoint}'
        for attempt in range(self.max_retries + 1):
            gap = self._interval - (time.time() - self._last)
            if gap > 0:
                time.sleep(gap)
            try:
                resp = self._session.get(url, params=params, timeout=self.timeout)
            except requests.exceptions.RequestException as e:
                self._last = time.time()
                if attempt >= self.max_retries:
                    _log.error("NCBI request failed after retries: %s", e)
                    return None
                time.sleep(min(_BACKOFF_BASE * (2 ** attempt), _BACKOFF_MAX))
                continue

            self._last = time.time()
            self._calls += 1

            if resp.status_code == 200:
                return resp
            if resp.status_code in (429, 500, 502, 503, 504):
                wait = min(_BACKOFF_BASE * (2 ** attempt), _BACKOFF_MAX)
                _log.warning("NCBI %d — backing off %.0fs (attempt %d/%d)",
                             resp.status_code, wait, attempt + 1,
                             self.max_retries + 1)
                if attempt >= self.max_retries:
                    return None
                time.sleep(wait)
                continue
            # 4xx other than 429: don't retry, surface as failure
            _log.error("NCBI %d: %s", resp.status_code, resp.text[:200])
            return None
        return None

    def _request(self, ids: list[str]) -> Optional[dict]:
        """Issue one eSummary call. Returns parsed JSON or None on failure."""
        if not ids:
            return None
        params = {**self._params(ids)}
        resp = self._get('esummary.fcgi', params)
        if resp is None:
            return None
        try:
            return resp.json()
        except ValueError:
            _log.warning("NCBI returned non-JSON body (%d bytes)",
                         len(resp.content))
            return None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def summary_by_pmid(self, ids: Iterable[str]) -> dict:
        """
        Resolve a batch of PMIDs to {pmid: {'doi': str|None, 'pmcid': str|None}}.

        Splits across NCBI_BATCH_SIZE-sized chunks internally. PMIDs that
        NCBI doesn't return at all are simply absent from the output dict —
        the caller can decide how to treat that (treat as "no record").
        """
        clean: list[str] = []
        seen: set[str] = set()
        for pmid in ids:
            p = str(pmid).strip()
            if not p or p in seen:
                continue
            seen.add(p)
            clean.append(p)
        if not clean:
            return {}

        out: dict = {}
        for i in range(0, len(clean), NCBI_BATCH_SIZE):
            chunk = clean[i:i + NCBI_BATCH_SIZE]
            payload = self._request(chunk)
            if not payload:
                continue
            result = payload.get('result') or {}
            # NCBI puts an 'uids' list and one key per PMID in the same dict.
            for pmid in result.get('uids') or []:
                rec = result.get(pmid) or {}
                doi = None
                pmcid = None
                # Prefer idtype='pmc' over idtype='pmcid' — NCBI's `pmcid`
                # entry is a compound string like
                # "pmc-id: PMC1234567;manuscript-id: NIHMS864114;"
                # while `pmc` is a clean "PMC1234567".
                for ent in rec.get('articleids') or []:
                    if not isinstance(ent, dict):
                        continue
                    idtype = (ent.get('idtype') or '').lower()
                    val    = (ent.get('value') or '').strip()
                    if not val:
                        continue
                    if idtype == 'doi':
                        doi = _normalise_doi(val)
                    elif idtype == 'pmc' and not pmcid:
                        pmcid = val if val.upper().startswith('PMC') else f'PMC{val}'
                if doi or pmcid:
                    out[pmid] = {'doi': doi, 'pmcid': pmcid}
        return out

    def pmids_for_dois(self, dois: Iterable[str]) -> dict:
        """Resolve DOIs to PMIDs via esearch. Returns {doi: pmid}.

        One esearch call per DOI (NCBI's term search can't reliably batch
        distinct DOIs in a single query), so use sparingly. DOIs with no
        PubMed match are simply absent from the result.
        """
        out: dict = {}
        for doi in dois:
            d = (doi or '').strip()
            if not d:
                continue
            params = {**self._auth_params(), 'db': 'pubmed',
                      'term': f'{d}[AID]', 'retmode': 'json'}
            resp = self._get('esearch.fcgi', params)
            if resp is None:
                continue
            try:
                idlist = (resp.json().get('esearchresult') or {}).get('idlist') or []
            except ValueError:
                continue
            if idlist:
                out[d] = idlist[0]
        return out

    def fetch_abstracts_by_pmid(self, ids: Iterable[str]) -> dict:
        """Fetch abstracts (+ a little metadata) for PMIDs via efetch.

        Returns {pmid: {'abstract', 'title', 'year', 'doi'}}; fields absent
        in PubMed are None. PMIDs with no abstract still appear (abstract=None)
        if PubMed returned the record at all. Batches internally.
        """
        clean, seen = [], set()
        for pmid in ids:
            p = str(pmid).strip()
            if p and p not in seen:
                seen.add(p); clean.append(p)
        if not clean:
            return {}

        out: dict = {}
        for i in range(0, len(clean), NCBI_BATCH_SIZE):
            chunk = clean[i:i + NCBI_BATCH_SIZE]
            params = {**self._auth_params(), 'db': 'pubmed',
                      'id': ','.join(chunk), 'rettype': 'abstract',
                      'retmode': 'xml'}
            resp = self._get('efetch.fcgi', params)
            if resp is None:
                continue
            out.update(_parse_efetch_xml(resp.text))
        return out

    def status(self) -> dict:
        """Diagnostics for logs."""
        return {
            'authenticated': bool(self.api_key),
            'interval_s':    round(self._interval, 3),
            'calls':         self._calls,
        }
