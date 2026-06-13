"""
Crossref API client.

Crossref is the canonical source for the publisher-deposited bibliographic
detail OpenAlex and Semantic Scholar mostly don't expose: volume, issue, page
range, publisher, ISBN, ISSN, and the container (journal/book) title. This
client is a throttled, retrying wrapper mirroring NcbiClient's shape.

Polite pool: a `mailto` (CROSSREF_MAILTO / OPENALEX_MAILTO in .env) earns a
better-behaved request pool. We send it as a query param and in the User-Agent,
per Crossref's etiquette guidance.

One-call surface:
    client = CrossrefClient()
    work   = client.get_by_doi('10.1234/abc')          # one work dict or None
    works  = client.fetch_batch_by_doi(['10.1/a', ...]) # {doi: work}
    parsed = parse_work(work)                            # PaperRecord kwargs
"""
from __future__ import annotations

import logging
import time
from typing import Optional

import requests

from . import ratelimit
from ..config import CROSSREF_BASE_URL, CROSSREF_MAILTO, CROSSREF_RATE_LIMIT_RPS


_MAX_RETRIES  = 4
_BACKOFF_BASE = 2.0
_BACKOFF_MAX  = 60.0
_TIMEOUT      = (10, 60)        # (connect, read)
# Crossref's /works?filter=doi:A,doi:B,... accepts many DOIs; keep batches
# modest so a single URL stays well within length limits.
CROSSREF_BATCH_SIZE = 20

_log = logging.getLogger(__name__)


def _normalise_doi(doi: Optional[str]) -> Optional[str]:
    if not doi:
        return None
    d = doi.strip().lower()
    for prefix in ('https://doi.org/', 'http://doi.org/', 'doi.org/', 'doi:'):
        if d.startswith(prefix):
            d = d[len(prefix):]
            break
    return d or None


class CrossrefClient:
    """Throttled, retrying client for Crossref /works."""

    def __init__(
        self,
        mailto: Optional[str] = None,
        max_retries: int = _MAX_RETRIES,
        timeout=_TIMEOUT,
        rate_limit_rps: Optional[float] = None,
    ):
        self.mailto = mailto if mailto is not None else CROSSREF_MAILTO
        self.max_retries = max_retries
        self.timeout = timeout
        rps = rate_limit_rps if rate_limit_rps is not None else CROSSREF_RATE_LIMIT_RPS
        self._interval = 1.0 / rps if rps > 0 else 0.0
        self._last = 0.0
        self._session = requests.Session()
        ua = 'biblion/1.0 (https://github.com/; mailto:%s)' % (self.mailto or 'none')
        self._session.headers.update({'User-Agent': ua})
        self._calls = 0

    # ------------------------------------------------------------------ HTTP
    def _get(self, path: str, params: dict) -> Optional[dict]:
        url = f'{CROSSREF_BASE_URL}{path}'
        if self.mailto:
            params = {**params, 'mailto': self.mailto}
        for attempt in range(self.max_retries + 1):
            # Global cross-process rate gate (rates.config, engine 'crossref');
            # the local interval is the fallback when Redis is unavailable.
            if not ratelimit.throttle('crossref'):
                gap = self._interval - (time.time() - self._last)
                if gap > 0:
                    time.sleep(gap)
            try:
                resp = self._session.get(url, params=params, timeout=self.timeout)
            except requests.exceptions.RequestException as e:
                self._last = time.time()
                if attempt >= self.max_retries:
                    _log.error("Crossref request failed after retries: %s", e)
                    return None
                time.sleep(min(_BACKOFF_BASE * (2 ** attempt), _BACKOFF_MAX))
                continue

            self._last = time.time()
            self._calls += 1
            if resp.status_code == 200:
                try:
                    return resp.json()
                except ValueError:
                    return None
            if resp.status_code == 404:
                return None
            if resp.status_code in (429, 500, 502, 503, 504):
                wait = min(_BACKOFF_BASE * (2 ** attempt), _BACKOFF_MAX)
                _log.warning("Crossref %d — backing off %.0fs (attempt %d/%d)",
                             resp.status_code, wait, attempt + 1,
                             self.max_retries + 1)
                if attempt >= self.max_retries:
                    return None
                time.sleep(wait)
                continue
            _log.error("Crossref %d: %s", resp.status_code, resp.text[:200])
            return None
        return None

    # --------------------------------------------------------------- surface
    def get_by_doi(self, doi: str) -> Optional[dict]:
        """Return the Crossref `message` (work) for one DOI, or None."""
        d = _normalise_doi(doi)
        if not d:
            return None
        # The DOI goes straight in the path; requests quotes it for us.
        body = self._get(f'/works/{d}', {})
        if not body:
            return None
        return body.get('message')

    def fetch_batch_by_doi(self, dois: list[str]) -> dict:
        """Return {normalised_doi: work} for the given DOIs. Uses the filter
        endpoint so one call covers the whole batch."""
        clean = [d for d in (_normalise_doi(x) for x in dois) if d]
        if not clean:
            return {}
        filt = ','.join(f'doi:{d}' for d in clean)
        body = self._get('/works', {'filter': filt, 'rows': str(len(clean))})
        out: dict[str, dict] = {}
        if not body:
            return out
        for item in (body.get('message') or {}).get('items', []) or []:
            d = _normalise_doi(item.get('DOI'))
            if d:
                out[d] = item
        return out


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def _join_names(people: Optional[list]) -> Optional[str]:
    """Crossref author/editor entries are {family, given, name?}. Render
    'Family, Given' to match biblion's stored display form."""
    import json
    if not people:
        return None
    names = []
    for p in people:
        family = (p.get('family') or '').strip()
        given = (p.get('given') or '').strip()
        if family and given:
            names.append(f"{family}, {given}")
        elif family:
            names.append(family)
        elif p.get('name'):
            names.append(p['name'].strip())
    return json.dumps(names) if names else None


def _first(values) -> Optional[str]:
    if isinstance(values, list):
        return values[0] if values else None
    return values or None


def parse_work(work: dict) -> dict:
    """Extract biblion fields from a Crossref work. Returns kwargs ready to
    splat onto a PaperRecord (keys match its attribute names)."""
    pages = work.get('page')
    first_page = last_page = None
    if pages:
        parts = str(pages).split('-', 1)
        first_page = parts[0].strip() or None
        last_page = parts[1].strip() if len(parts) == 2 else None

    pub_type = (work.get('type') or '').lower() or None

    extra_ids: dict = {}
    issn = work.get('ISSN') or []
    if issn:
        extra_ids['issn'] = list(issn)
    isbn = work.get('ISBN') or []
    if isbn:
        extra_ids['isbn'] = list(isbn)

    # Crossref published date: {'date-parts': [[YYYY, MM, DD]]}.
    date_parts = ((work.get('published') or work.get('issued') or {})
                  .get('date-parts') or [[None]])[0]
    year = date_parts[0] if date_parts and date_parts[0] else None
    month = (f"{date_parts[1]:02d}" if len(date_parts) >= 2 and date_parts[1]
             else None)

    # Editorial notices: Crossref carries `update-to` entries with a `type`
    # ('retraction'/'withdrawal'/'expression_of_concern'/'correction'/...), and
    # the Retraction Watch integration populates these. Join all type strings;
    # the resolver's _canon_editorial reduces them to the most-severe token.
    notice_types = ' '.join(
        str(u.get('type') or '') for u in (work.get('update-to') or []))
    editorial_status = notice_types.strip() or None

    return {
        'doi':         _normalise_doi(work.get('DOI')),
        'title':       _first(work.get('title')),
        'year':        year,
        'month':       month,
        'venue':       _first(work.get('container-title')),
        'authors_json': _join_names(work.get('author')),
        'editors_json': _join_names(work.get('editor')),
        'volume':      work.get('volume'),
        'issue':       work.get('issue'),
        'first_page':  first_page,
        'last_page':   last_page,
        'publisher':   work.get('publisher'),
        'pub_type':    pub_type,
        'extra_identifiers': extra_ids,
        'editorial_status': editorial_status,
    }
