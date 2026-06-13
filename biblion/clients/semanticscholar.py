"""
Semantic Scholar (S2) Graph API client.

Mirrors OpenAlexClient's shape: throttled, retrying, deadline-streaming reads,
circuit breaker on persistent 429s.

Key facts confirmed empirically and from the S2 tutorial
(https://www.semanticscholar.org/product/api/tutorial):

  - Authentication: `x-api-key: <key>` header (NOT Authorization Bearer).
  - With a personal key: 1 RPS sustained, all endpoints.
  - Without a key: shared bucket — unreliable; OK as a fallback.
  - POST /graph/v1/paper/batch: empirically 500 IDs per call works, 1000 → 429.
  - GET  /graph/v1/paper/search/bulk: keyword search with continuation tokens
                                       (use this over /paper/search for jobs).
  - 429 is the only documented rate-limit error; no Retry-After or
    X-RateLimit-* headers are published. Backoff is purely time-based.
  - No documented hard daily cap — only the per-second ceiling.

The client supports two main calls:

    fetch_batch_by_id(ids, fields)   POST /paper/batch
    search_papers(query, ...)        GET  /paper/search/bulk (paginated)

ID formats accepted in batch: corpus IDs, sha IDs, or prefixed strings like
'DOI:10.1234/abc', 'ARXIV:1234.5678', 'MAG:12345'.
"""
import json
import time
from typing import Iterable, Iterator, Optional

import requests

from . import ratelimit


S2_BASE_URL          = 'https://api.semanticscholar.org/graph/v1'
S2_API_KEY_ENV       = 'semantic_scholar_key'
S2_BATCH_SIZE        = 500

# Rate-limit strategy
# -------------------
# S2 returns NO X-RateLimit-* headers, so we can't read the live limit.
# Instead we adaptively probe: start at a conservative rate, bump after
# every N consecutive successful calls, halve on the first 429, and trip
# the breaker on a sustained 429-storm. Partner-tier accounts can sustain
# 100+ RPS but we cap ourselves below that so we never get banned.
_S2_RPS_INITIAL       = 5.0     # opening throttle when we have a key
_S2_RPS_MAX           = 50.0    # ceiling — partner tier can do more but stay polite
_S2_RPS_RAMP_STEP     = 1.0     # bump by this many RPS after each success window
_S2_RPS_RAMP_AFTER_N  = 100     # consecutive successes before a bump
_S2_RPS_HALVE_ON_429  = True    # halve rate on every 429
_S2_RPS_ANON          = 0.2     # very polite when running unauthenticated

# Key probe cadence — if we've fallen back to anonymous because the
# key got rate-limited, try the key again every PROBE_INTERVAL_S.
_S2_PROBE_INTERVAL_S  = 24 * 3600

_MAX_RETRIES         = 3
_BACKOFF_BASE        = 2.0
_BACKOFF_MAX         = 60.0
_TIMEOUT             = (10, 30)     # (connect, read)

# Backwards-compat — kept so any external code passing rate_limit_rps still
# works. Internally we use the adaptive logic.
_S2_DEFAULT_RPS      = _S2_RPS_INITIAL


# Default field sets covering what our v3 schema cares about.
S2_FIELDS_METADATA = (
    'title,year,authors,venue,abstract,publicationTypes,'
    'fieldsOfStudy,externalIds,citationCount,referenceCount'
)
S2_FIELDS_WITH_REFS  = S2_FIELDS_METADATA + ',references.externalIds'
S2_FIELDS_FOR_SEARCH = 'paperId,title,year,externalIds'   # cheap search payload


def _get_api_key() -> str:
    """Read the S2 API key from .env (loaded by biblion.config)."""
    # Importing config triggers the .env loader.
    from .. import config       # noqa: F401
    import os
    return os.environ.get(S2_API_KEY_ENV, '')


def _normalise_doi(doi: Optional[str]) -> Optional[str]:
    if not doi:
        return None
    d = doi.strip().lower()
    for prefix in ('https://doi.org/', 'http://doi.org/', 'doi.org/', 'doi:'):
        if d.startswith(prefix):
            d = d[len(prefix):]
            break
    return d or None


# S2 externalIds scheme name -> identifiers.scheme. PubMed/PubMedCentral get
# their own papers columns and are handled separately; the rest land in the
# identifiers table (only DOI used to be read). Shared by both the metadata
# enrichment producer and the search producer so they capture the same set.
_S2_EXTID_SCHEMES = {
    'ArXiv': 'arxiv', 'MAG': 'mag', 'DBLP': 'dblp', 'ACL': 'acl',
    'CorpusId': 's2_corpus',
}


def parse_external_ids(ext: dict) -> tuple[dict, Optional[str], Optional[str]]:
    """Split an S2 `externalIds` dict into
    (extra_identifiers, pubmed_id, pubmed_central_id)."""
    extra: dict = {}
    for s2_key, scheme in _S2_EXTID_SCHEMES.items():
        v = (ext or {}).get(s2_key)
        if v:
            extra[scheme] = [str(v)]
    pmid = (ext or {}).get('PubMed')
    pmcid = (ext or {}).get('PubMedCentral')
    return extra, (str(pmid) if pmid else None), (str(pmcid) if pmcid else None)


class SemanticScholarClient:
    """
    Throttled, retrying client for the S2 Academic Graph API.

    Auto-uses the key from .env (semantic_scholar_key) when present, otherwise
    runs unauthenticated with a more conservative throttle.
    """

    # Circuit breaker tuning (same shape as OpenAlexClient).
    _BREAKER_TRIP_AFTER       = 5
    _BREAKER_FIRST_COOLOFF_S  = 300
    _BREAKER_MAX_COOLOFF_S    = 21600
    _BREAKER_COOLOFF_MULT     = 3.0

    def __init__(
        self,
        api_key: Optional[str] = None,
        max_retries: int = _MAX_RETRIES,
        backoff_base: float = _BACKOFF_BASE,
        backoff_max: float = _BACKOFF_MAX,
        timeout = _TIMEOUT,
        rate_limit_rps: Optional[float] = None,
        rps_max: float = _S2_RPS_MAX,
        ramp_step: float = _S2_RPS_RAMP_STEP,
        ramp_after_n: int = _S2_RPS_RAMP_AFTER_N,
        probe_interval_s: float = _S2_PROBE_INTERVAL_S,
    ):
        # Two key slots: the original (which we'll restore to on probe success)
        # and the active one (None during anonymous fallback).
        original_key = api_key if api_key is not None else _get_api_key()
        self._original_key = original_key
        self.api_key       = original_key

        # If caller supplied a rate, honour it. Otherwise pick based on
        # auth mode and let the adaptive logic take over.
        if rate_limit_rps is not None:
            initial_rps = rate_limit_rps
        elif self.api_key:
            initial_rps = _S2_RPS_INITIAL
        else:
            initial_rps = _S2_RPS_ANON

        self.max_retries  = max_retries
        self.backoff_base = backoff_base
        self.backoff_max  = backoff_max
        self.timeout      = timeout

        # Adaptive throttling
        self._current_rps   = initial_rps
        self._rps_max       = rps_max
        self._ramp_step     = ramp_step
        self._ramp_after_n  = ramp_after_n
        self._consec_ok     = 0           # successes since last 429 / ramp
        self._base_interval = 1.0 / initial_rps if initial_rps > 0 else 0
        self._interval      = self._base_interval
        self._last          = 0.0
        self._session       = requests.Session()

        # Circuit breaker state
        self._consecutive_429    = 0
        self._breaker_open_until = 0.0
        self._next_cooloff       = self._BREAKER_FIRST_COOLOFF_S
        self._tripped_count      = 0
        # Counter for diagnostics (S2 publishes no daily limit, so this is
        # informational only).
        self._calls_today        = 0

        # Key-fallback / probe state
        self._in_fallback       = False          # True after we've dropped key
        self._fallback_started  = 0.0            # epoch when fallback started
        self._probe_interval_s  = probe_interval_s
        self._anon_rps          = _S2_RPS_ANON

    # ------------------------------------------------------------------
    # Circuit breaker
    # ------------------------------------------------------------------

    @property
    def breaker_open(self) -> bool:
        return time.time() < self._breaker_open_until

    def breaker_status(self) -> dict:
        return {
            'open':            self.breaker_open,
            'open_for_s':      max(0, int(self._breaker_open_until - time.time())),
            'consecutive_429': self._consecutive_429,
            'tripped_count':   self._tripped_count,
            'next_cooloff_s':  int(self._next_cooloff),
            'calls_today':     self._calls_today,
            'interval_s':      round(self._interval, 2),
            'current_rps':     round(self._current_rps, 2),
            'rps_ceiling':     self._rps_max,
            'consec_ok':       self._consec_ok,
            'authenticated':   bool(self.api_key),
            'in_fallback':     self._in_fallback,
            'fallback_age_s':  (int(time.time() - self._fallback_started)
                                if self._in_fallback else 0),
        }

    def _trip_breaker(self) -> None:
        self._breaker_open_until = time.time() + self._next_cooloff
        self._tripped_count += 1
        self._next_cooloff = min(
            self._next_cooloff * self._BREAKER_COOLOFF_MULT,
            self._BREAKER_MAX_COOLOFF_S,
        )

    def _record_429(self) -> None:
        """Halve the current RPS and tick the consecutive-429 counter.

        If the breaker trips AND we still have the key in hand, the next
        thing the caller does should be `_enter_fallback()` (we don't do
        it here because some callers want to retry first)."""
        self._consecutive_429 += 1
        self._consec_ok = 0
        # Halve the adaptive rate (down to a floor matching the polite-pool
        # anonymous rate). Even with a key, sustained 429s tell us our rate
        # is too fast for the current backend state.
        new_rps = max(self._anon_rps, self._current_rps / 2)
        self._set_rps(new_rps)
        if (self._consecutive_429 >= self._BREAKER_TRIP_AFTER
                and not self.breaker_open):
            self._trip_breaker()

    def _record_success(self) -> None:
        """Adaptive ramp: after every `_ramp_after_n` consecutive successes,
        bump the RPS by `_ramp_step` (up to the configured ceiling)."""
        self._consecutive_429 = 0
        self._next_cooloff = self._BREAKER_FIRST_COOLOFF_S
        self._consec_ok += 1
        if (self._consec_ok >= self._ramp_after_n
                and self._current_rps < self._rps_max):
            new_rps = min(self._rps_max, self._current_rps + self._ramp_step)
            if new_rps != self._current_rps:
                self._set_rps(new_rps)
            self._consec_ok = 0

    def _set_rps(self, rps: float) -> None:
        """Update both the displayed RPS and the internal interval."""
        self._current_rps = rps
        if rps > 0:
            self._interval = 1.0 / rps
        else:
            self._interval = 0

    # ------------------------------------------------------------------
    # Key fallback + probe
    # ------------------------------------------------------------------

    def _enter_fallback(self) -> None:
        """Drop the key and run anonymous. Schedule the next probe.

        Idempotent: calling repeatedly while already in fallback is fine.
        """
        if self._in_fallback or not self._original_key:
            return
        self.api_key = None
        self._in_fallback = True
        self._fallback_started = time.time()
        self._set_rps(self._anon_rps)
        # Reset the breaker — we want anonymous traffic to flow.
        self._breaker_open_until = 0.0
        self._consecutive_429    = 0
        self._consec_ok          = 0
        # Reset the cool-off ladder so we get fresh treatment after recovery.
        self._next_cooloff = self._BREAKER_FIRST_COOLOFF_S

    def _should_probe_key(self) -> bool:
        """Time to try the original key again?"""
        if not self._in_fallback or not self._original_key:
            return False
        return (time.time() - self._fallback_started) >= self._probe_interval_s

    def _attempt_key_probe(self) -> bool:
        """Try a single call with the original key. Return True on success.

        Called inline before issuing a real request when _should_probe_key()
        is true. If the probe wins, we restore the key and the caller's
        request will then use it; if it fails, we reset the probe timer
        and continue anonymous.
        """
        if not self._original_key:
            return False
        # Issue a cheap probe — single-paper /paper/batch is the lightest
        # endpoint we have that gives a clear 200 / 429 signal.
        url = S2_BASE_URL + '/paper/batch'
        try:
            resp = self._session.post(
                url,
                params={'fields': 'paperId'},
                json={'ids': ['DOI:10.1126/science.aaa9519']},
                headers={'x-api-key': self._original_key,
                         'Accept': 'application/json'},
                timeout=(10, 15),
            )
        except requests.exceptions.RequestException:
            # Probe network failure — assume key still bad, reset timer.
            self._fallback_started = time.time()
            return False
        if resp.status_code == 200:
            # Key works again. Restore it and reset the adaptive state.
            self.api_key = self._original_key
            self._in_fallback = False
            self._fallback_started = 0.0
            self._set_rps(_S2_RPS_INITIAL)
            self._consec_ok = 0
            return True
        # 429 / 403 / anything else — stay in fallback, reset timer.
        self._fallback_started = time.time()
        return False

    # ------------------------------------------------------------------
    # Low-level HTTP
    # ------------------------------------------------------------------

    def _headers(self) -> dict:
        h = {'Accept': 'application/json'}
        if self.api_key:
            h['x-api-key'] = self.api_key
        return h

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[dict] = None,
        json_body: Optional[dict] = None,
    ) -> Optional[dict]:
        """
        Low-level request. Returns parsed JSON, or None on 404 / breaker /
        final-retry failure.
        """
        # Before each request: if we're in fallback and 24h has elapsed,
        # try the key once. If it works we proceed with key restored.
        if self._should_probe_key():
            self._attempt_key_probe()
        # If the breaker is open AND we still have a key, drop to anonymous
        # rather than refuse every call for hours. The key probe will
        # eventually restore us.
        if self.breaker_open:
            if self.api_key and not self._in_fallback:
                self._enter_fallback()
            else:
                return None

        url = S2_BASE_URL + path if not path.startswith('http') else path
        headers = self._headers()
        connect_t, read_t = self.timeout if isinstance(self.timeout, tuple) else (10, 30)
        total_budget = read_t + connect_t

        for attempt in range(self.max_retries + 1):
            if self.breaker_open:
                return None

            # Global cross-process rate gate (rates.config, engine 's2'); the
            # local interval is only the fallback when Redis is unavailable.
            # DailyLimitReached propagates to the producer to stop for the day.
            if not ratelimit.throttle('s2'):
                gap = self._interval - (time.time() - self._last)
                if gap > 0:
                    time.sleep(gap)

            deadline = time.time() + total_budget
            resp = None
            try:
                resp = self._session.request(
                    method, url,
                    params=params, json=json_body,
                    headers=headers, timeout=(connect_t, read_t),
                    stream=True,
                )
                buf = bytearray()
                for chunk in resp.iter_content(chunk_size=8192):
                    if chunk:
                        buf.extend(chunk)
                    if time.time() > deadline:
                        raise requests.exceptions.Timeout(
                            f"body read exceeded {total_budget}s wall clock"
                        )
                body = bytes(buf)
            except requests.exceptions.RequestException:
                if resp is not None:
                    try: resp.close()
                    except Exception: pass
                self._last = time.time()
                if attempt >= self.max_retries:
                    return None
                time.sleep(min(self.backoff_base * (2 ** attempt), self.backoff_max))
                continue
            finally:
                if resp is not None:
                    try: resp.close()
                    except Exception: pass

            self._last = time.time()
            self._calls_today += 1

            if resp.status_code == 200:
                self._record_success()
                try:
                    return json.loads(body.decode('utf-8'))
                except (ValueError, UnicodeDecodeError):
                    return None

            if resp.status_code == 404:
                return None

            if resp.status_code == 403 and self.api_key:
                # 403 = key revoked or rate-cap exceeded. Drop to anonymous
                # via the proper fallback path so the probe timer is armed.
                print(f"[s2] 403 with api_key — entering fallback")
                self._enter_fallback()
                headers = self._headers()
                # Retry same attempt slot without consuming a retry budget
                continue

            if resp.status_code == 429:
                self._record_429()
                if self.breaker_open:
                    # Sustained 429s with a key → enter fallback rather than
                    # refuse calls for hours. The probe timer is now armed.
                    if self.api_key and not self._in_fallback:
                        self._enter_fallback()
                        headers = self._headers()
                        continue
                    return None
                # S2 doesn't publish Retry-After; use plain exponential backoff.
                # _record_429 has already halved our RPS.
                wait = min(self.backoff_base * (2 ** attempt), self.backoff_max)
                if attempt >= self.max_retries:
                    return None
                time.sleep(wait)
                continue

            # Other non-success → retry with backoff
            if attempt >= self.max_retries:
                return None
            time.sleep(min(self.backoff_base * (2 ** attempt), self.backoff_max))
        return None

    # ------------------------------------------------------------------
    # Higher-level helpers
    # ------------------------------------------------------------------

    def fetch_batch_by_id(
        self,
        ids: list[str],
        fields: str = S2_FIELDS_METADATA,
    ) -> Optional[list[Optional[dict]]]:
        """
        POST /paper/batch with up to 500 IDs.

        IDs may be S2 paperIds OR prefixed external IDs such as 'DOI:10.x/y',
        'ARXIV:2301.10140', 'MAG:12345'. Returns a list parallel to `ids` where
        each element is the work record, or None if S2 didn't find that ID.

        Returns None (not a list) if the entire request fails / breaker open.
        """
        if not ids:
            return []
        if len(ids) > S2_BATCH_SIZE:
            raise ValueError(f"S2 batch limit is {S2_BATCH_SIZE} IDs per request")
        return self._request(
            'POST',
            '/paper/batch',
            params={'fields': fields},
            json_body={'ids': ids},
        )

    def fetch_batch_by_doi(
        self,
        dois: Iterable[str],
        fields: str = S2_FIELDS_METADATA,
    ) -> dict:
        """
        Convenience: fetch a batch of papers by DOI. Returns a dict
        keyed by normalised DOI for the records S2 found.
        """
        clean = [d for d in (_normalise_doi(d) for d in dois) if d]
        if not clean:
            return {}
        prefixed = [f'DOI:{d}' for d in clean]
        results = self.fetch_batch_by_id(prefixed, fields=fields)
        if not results:
            return {}
        out: dict = {}
        # Response is parallel to request; element None means "not found".
        for input_doi, record in zip(clean, results):
            if record:
                # Prefer the DOI S2 echoes back if present, otherwise our input.
                rec_doi = (record.get('externalIds') or {}).get('DOI')
                key = _normalise_doi(rec_doi) or input_doi
                out[key] = record
        return out

    def search_by_title(
        self,
        title: str,
        fields: str = S2_FIELDS_METADATA,
        year: Optional[int] = None,
        top_k: int = 3,
    ) -> Optional[list[dict]]:
        """
        GET /paper/search — returns the top N relevance-ranked matches for `title`.

        Used by resolve_dois_s2 to map a title-only paper to an S2 paperId +
        externalIds (DOI etc). For browsing all matches of a keyword query
        use search_bulk() instead.
        """
        params = {'query': title, 'limit': top_k, 'fields': fields}
        if year is not None:
            params['year'] = str(year)
        resp = self._request('GET', '/paper/search', params=params)
        if not resp:
            return None
        return resp.get('data') or []

    def search(
        self,
        query: str,
        fields: str = S2_FIELDS_FOR_SEARCH,
        year_min: Optional[int] = None,
        year_max: Optional[int] = None,
        limit: int = 100,
    ) -> list[dict]:
        """
        GET /paper/search — relevance-ranked search, max 100 per page,
        auto-paginates via `offset` until either `limit` results reached
        or the API returns fewer than requested.

        This is the endpoint used by the original `run_searches.py`
        factorial-boolean workflow. It applies the relevance ranking
        users expect — different from /paper/search/bulk which is for
        bulk-export with continuation tokens.

        S2's `year` parameter takes a single year or a range like
        '2015-2020'. We translate year_min/year_max into that format.
        """
        results: list[dict] = []
        offset = 0
        # Build the optional year filter once.
        year_filter: Optional[str] = None
        if year_min is not None or year_max is not None:
            year_filter = f"{year_min or ''}-{year_max or ''}"

        # 100 is the API maximum per /paper/search page.
        PAGE = 100
        while len(results) < limit:
            batch = min(PAGE, limit - len(results))
            params: dict = {
                'query':  query,
                'fields': fields,
                'limit':  batch,
                'offset': offset,
            }
            if year_filter:
                params['year'] = year_filter
            page = self._request('GET', '/paper/search', params=params)
            if not page:
                break
            papers = page.get('data') or []
            if not papers:
                break
            results.extend(papers)
            # API signals end-of-results either by returning fewer items
            # than requested or by omitting `next`.
            if len(papers) < batch or page.get('next') is None:
                break
            offset += len(papers)
        return results[:limit]

    def paginated_fetch(
        self,
        paper_id: str,
        direction: str,
        fields: str = 'paperId,externalIds,title,year,authors',
        page_size: int = 1000,
        max_pages: int = 100,
    ) -> list[dict]:
        """
        GET /paper/{id}/references or /paper/{id}/citations with offset
        pagination, returning ALL items (or up to max_pages * page_size).

        Used by the citation-hop module to recover the full edge list
        when the bulk /paper/batch response truncated `references` or
        `citations` (which happens when the seed paper has more refs
        than S2 inlines into the bulk response — ~100 by default).

        `direction` must be 'references' or 'citations'. The response
        items wrap each paper in either `citedPaper` (for refs) or
        `citingPaper` (for citations); we unwrap to the inner paper.
        """
        if direction not in ('references', 'citations'):
            raise ValueError(f"direction must be references|citations, got {direction!r}")
        wrapper = 'citedPaper' if direction == 'references' else 'citingPaper'
        out: list[dict] = []
        offset = 0
        for _ in range(max_pages):
            page = self._request(
                'GET',
                f'/paper/{paper_id}/{direction}',
                params={'fields': fields, 'limit': page_size, 'offset': offset},
            )
            if not page:
                break
            items = page.get('data') or []
            if not items:
                break
            for it in items:
                inner = it.get(wrapper)
                if inner:
                    out.append(inner)
            if len(items) < page_size or page.get('next') is None:
                break
            offset += len(items)
        return out

    def search_bulk(
        self,
        query: str,
        fields: str = S2_FIELDS_FOR_SEARCH,
        year: Optional[int] = None,
        page_limit: int = 100,
        max_pages: int = 1,
    ) -> Iterator[dict]:
        """
        GET /paper/search/bulk with continuation-token pagination.

        Yields work records one at a time. Stops after max_pages.
        """
        params = {'query': query, 'fields': fields, 'limit': page_limit}
        if year is not None:
            params['year'] = str(year)

        token = None
        for _ in range(max_pages):
            if token:
                params['token'] = token
            page = self._request('GET', '/paper/search/bulk', params=params)
            if not page:
                return
            for paper in (page.get('data') or []):
                yield paper
            token = page.get('token')
            if not token:
                return
