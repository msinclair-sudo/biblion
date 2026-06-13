"""
OpenAlex API client.

Throttled, retrying wrapper around `requests.Session` that v3 producer
modules use to talk to api.openalex.org. Uses (connect, read) timeouts
so a stalled response body cannot block indefinitely.

The client is intentionally stateful: throttle state lives on the
instance, so a single OpenAlexClient should be reused for the duration
of a module run (creating a fresh client per request loses the rate
adaptation accumulated by previous 429s).

Usage
-----
    client = OpenAlexClient()
    work   = client.get_by_doi('10.1234/abc')
    works  = client.fetch_batch_by_doi(['10.1/a', '10.1/b', ...])
    hits   = client.search_by_title('Microbial diversity in soil', year=2018)
    parsed = client.parse_work(work)
"""
import json
import re
import time
from typing import Optional

import requests

from . import ratelimit
from ..config import (
    OPENALEX_API_KEY, OPENALEX_MAILTO, OPENALEX_BASE_URL, OPENALEX_RATE_LIMIT_RPS,
)

# Defaults — can be overridden per-instance.
_MAX_RETRIES   = 3
_BACKOFF_BASE  = 2.0
_BACKOFF_MAX   = 60.0
# (connect, read) — both required so a hung response body can never block forever.
_TIMEOUT       = (10, 30)
_BATCH_SIZE    = 50

REJECTED_OA_TYPES = {'patent', 'proceedings', 'proceedings-article'}

_PUB_TYPE_MAP = {
    'journal-article': 'journal-article',
    'review':          'review',
    'book-chapter':    'book-chapter',
    'book':            'book',
    'dataset':         'dataset',
    'preprint':        'preprint',
}

# Default selects for the most common endpoints. SELECT_FULL now also pulls
# the extended bibliographic fields (biblio numbers, language, secondary ids,
# date); these come back inside the already-requested primary_location.source.
SELECT_FULL = (
    'id,doi,type,title,publication_year,authorships,'
    'primary_location,cited_by_count,abstract_inverted_index,'
    'biblio,language,ids,publication_date,is_retracted'
)
SELECT_SLIM     = 'id,doi,type,title,publication_year'
SELECT_REFS     = 'id,doi,referenced_works'


def normalise_doi(doi: Optional[str]) -> Optional[str]:
    """Strip URL prefix and lowercase. Returns None for empty input."""
    if not doi:
        return None
    d = doi.strip().lower()
    for prefix in ('https://doi.org/', 'http://doi.org/', 'doi.org/', 'doi:'):
        if d.startswith(prefix):
            d = d[len(prefix):]
            break
    return d or None


def reconstruct_abstract(inv: Optional[dict]) -> Optional[str]:
    """OpenAlex abstracts are an inverted index of word → [positions]."""
    if not inv:
        return None
    words = {}
    for word, positions in inv.items():
        for pos in positions:
            words[pos] = word
    return ' '.join(words[i] for i in sorted(words)) if words else None


class OpenAlexClient:
    """
    Throttled, retrying HTTP client for the OpenAlex API.

    One instance per phase. Throttle interval adapts upward on 429s.
    """

    # Circuit breaker tuning — escalating "cool-off" periods when OA keeps 429-ing.
    # We start at 5 minutes; each subsequent trip waits 3× longer up to 6 hours.
    _BREAKER_TRIP_AFTER       = 5       # consecutive 429s before opening
    _BREAKER_FIRST_COOLOFF_S  = 300     # 5 minutes
    _BREAKER_MAX_COOLOFF_S    = 21600   # 6 hours
    _BREAKER_COOLOFF_MULT     = 3.0     # escalation factor per consecutive trip

    # Soft daily budget. OA's free tier caps at 10,000 calls/day; we cap ourselves
    # at 9,500 so concurrent clients learning from headers (each makes a few
    # calls before quota syncs) can't accidentally overshoot.
    _DEFAULT_DAILY_BUDGET = 9_500

    # Fallback parameters.
    #  - When keyed remaining drops below this many calls, swap to
    #    anonymous (which has its own fresh per-IP bucket).
    #  - 24h probe cadence so we re-check the keyed account daily.
    _FALLBACK_REMAINING_THRESHOLD = 100
    _PROBE_INTERVAL_S             = 24 * 3600

    def __init__(
        self,
        max_retries: int = _MAX_RETRIES,
        backoff_base: float = _BACKOFF_BASE,
        backoff_max: float = _BACKOFF_MAX,
        timeout = _TIMEOUT,                    # (connect, read) tuple, see requests docs
        rate_limit_rps: float = OPENALEX_RATE_LIMIT_RPS,
        daily_budget: int = _DEFAULT_DAILY_BUDGET,
    ):
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.backoff_max = backoff_max
        self.timeout = timeout
        self._base_interval = 1.0 / rate_limit_rps if rate_limit_rps > 0 else 0
        self._interval      = self._base_interval
        self._last          = 0.0
        # Single session reuses TCP connections across requests — large win.
        self._session = requests.Session()

        # Circuit breaker state.
        # closed: requests pass through normally.
        # open:   requests return None immediately until cooldown elapses.
        self._consecutive_429 = 0
        self._breaker_open_until = 0.0
        self._next_cooloff = self._BREAKER_FIRST_COOLOFF_S
        self._tripped_count = 0       # how many times we've tripped this session

        # Quota tracking from OA's response headers (per
        # https://developers.openalex.org/api-reference/authentication).
        self._quota_limit     = None   # X-RateLimit-Limit
        self._quota_remaining = None   # X-RateLimit-Remaining
        self._quota_reset_in  = None   # X-RateLimit-Reset (seconds until UTC midnight)

        # Soft daily budget — independent of OA's published quota so we have
        # a guaranteed margin. Reset implicitly when X-RateLimit-Reset rolls.
        self.daily_budget = daily_budget
        self._calls_today = 0

        # Key fallback state.
        # We can't blank an env-loaded key inside the client (it's module-level
        # constant) so instead we hold a flag — when set, _build_params() omits
        # the api_key URL param so the call uses the anonymous bucket. The
        # original key is still available for the periodic probe.
        self._in_fallback      = False
        self._fallback_started = 0.0
        # Make these instance-tunable for tests.
        self._fallback_threshold = self._FALLBACK_REMAINING_THRESHOLD
        self._probe_interval_s   = self._PROBE_INTERVAL_S

    # ------------------------------------------------------------------
    # Circuit breaker
    # ------------------------------------------------------------------

    @property
    def breaker_open(self) -> bool:
        """True if the breaker is currently refusing requests."""
        return time.time() < self._breaker_open_until

    def breaker_status(self) -> dict:
        """Snapshot for diagnostics / module reporting."""
        return {
            'open':              self.breaker_open,
            'open_for_s':        max(0, int(self._breaker_open_until - time.time())),
            'consecutive_429':   self._consecutive_429,
            'tripped_count':     self._tripped_count,
            'next_cooloff_s':    int(self._next_cooloff),
            'quota_limit':       self._quota_limit,
            'quota_remaining':   self._quota_remaining,
            'quota_reset_in_s':  self._quota_reset_in,
            'daily_budget':      self.daily_budget,
            'calls_today':       self._calls_today,
            'soft_remaining':    max(0, self.daily_budget - self._calls_today),
            'interval_s':        round(self._interval, 2),
            'in_fallback':       self._in_fallback,
            'fallback_age_s':    (int(time.time() - self._fallback_started)
                                  if self._in_fallback else 0),
        }

    # ------------------------------------------------------------------
    # Key fallback + probe
    # ------------------------------------------------------------------

    def _enter_fallback(self) -> None:
        """Switch to anonymous mode (don't send api_key on subsequent calls).

        Anonymous OA has its own per-IP 10,000-call bucket, so this gives
        us another ~10K calls/day after our keyed quota runs out. We also
        reset the breaker state so traffic flows immediately.
        """
        if self._in_fallback or not OPENALEX_API_KEY:
            return
        self._in_fallback = True
        self._fallback_started = time.time()
        # Reset breaker + 429 counter so anonymous traffic isn't blocked
        # by the keyed account's lingering state.
        self._breaker_open_until = 0.0
        self._consecutive_429    = 0
        self._next_cooloff       = self._BREAKER_FIRST_COOLOFF_S
        # Reset pacing to the configured base — the keyed account's
        # adaptive interval was tuned for its remaining quota, but
        # anonymous starts fresh.
        self._interval = self._base_interval
        print(f"[oa] entered fallback (anonymous) "
              f"after keyed remaining={self._quota_remaining}")

    def _should_probe_key(self) -> bool:
        """Time to re-check the keyed account?"""
        if not self._in_fallback or not OPENALEX_API_KEY:
            return False
        return (time.time() - self._fallback_started) >= self._probe_interval_s

    def _attempt_key_probe(self) -> bool:
        """Try one keyed call. On 200 with healthy remaining, restore."""
        if not OPENALEX_API_KEY:
            return False
        # Cheap probe: fetch a stable, known work with only the api_key.
        # We bypass our normal _request path so the probe doesn't get
        # entangled with rate-limit accounting.
        url = OPENALEX_BASE_URL + '/works/W2741809807'
        try:
            resp = self._session.get(
                url,
                params={'api_key': OPENALEX_API_KEY,
                        'select': 'id'},
                headers=self._headers(),
                timeout=(10, 15),
            )
        except requests.exceptions.RequestException:
            self._fallback_started = time.time()
            return False
        # Read headers without going through _capture_quota (we don't want
        # the probe to influence pacing decisions).
        try:
            remaining = int(resp.headers.get('X-RateLimit-Remaining', '0') or 0)
        except (TypeError, ValueError):
            remaining = 0
        if resp.status_code == 200 and remaining > self._fallback_threshold:
            # Keyed bucket has refilled. Restore.
            self._in_fallback = False
            self._fallback_started = 0.0
            self._interval = self._base_interval
            print(f"[oa] key probe succeeded "
                  f"(remaining={remaining}) — restoring keyed mode")
            return True
        # Probe failed or quota still low — stay in fallback, reset timer.
        self._fallback_started = time.time()
        return False

    def _trip_breaker(self) -> None:
        """Open the breaker with the current escalation level."""
        self._breaker_open_until = time.time() + self._next_cooloff
        self._tripped_count += 1
        self._next_cooloff = min(
            self._next_cooloff * self._BREAKER_COOLOFF_MULT,
            self._BREAKER_MAX_COOLOFF_S,
        )

    def _record_429(self) -> None:
        """Tally a 429 and trip the breaker if the streak is long enough."""
        self._consecutive_429 += 1
        if self._consecutive_429 >= self._BREAKER_TRIP_AFTER and not self.breaker_open:
            self._trip_breaker()

    def _record_success(self) -> None:
        """Successful response resets the 429 streak and gradually relaxes throttle."""
        self._consecutive_429 = 0
        # If we just probed successfully (half-open → closed), reset cooloff
        # so the next bad streak gets a fresh 5-minute window.
        self._next_cooloff = self._BREAKER_FIRST_COOLOFF_S
        # Gradually recover throttle interval toward its base.
        self._interval = max(self._base_interval, self._interval * 0.5)

    def _capture_quota(self, resp) -> None:
        """
        Read X-RateLimit-* response headers and adapt pacing.

        OA returns these on every response:
          X-RateLimit-Limit       total daily quota
          X-RateLimit-Remaining   remaining for today
          X-RateLimit-Credits-Used cost of this request
          X-RateLimit-Reset       seconds until midnight UTC

        Also enforces our local `daily_budget` ceiling (defaults below OA's
        published 10K so concurrent clients can't accidentally overshoot).
        """
        h = resp.headers
        try:
            limit     = int(h.get('X-RateLimit-Limit', '0') or 0)
            remaining = int(h.get('X-RateLimit-Remaining', '0') or 0)
            reset_in  = int(h.get('X-RateLimit-Reset', '0') or 0)
        except (TypeError, ValueError):
            return
        if limit <= 0:
            return    # OA didn't send valid headers
        self._quota_limit     = limit
        self._quota_remaining = remaining
        self._quota_reset_in  = reset_in

        # Two ways the budget can be considered exhausted:
        #   1. OA's own remaining hit zero  (hard reality)
        #   2. Our soft cap hit (calls_today >= daily_budget)
        # When keyed: drop to fallback (anonymous has its own 10K bucket).
        # When already anonymous: open the breaker until reset.
        soft_exhausted = self._calls_today >= self.daily_budget
        if remaining <= 0 or soft_exhausted:
            if not self._in_fallback and OPENALEX_API_KEY:
                self._enter_fallback()
                return
            self._breaker_open_until = time.time() + max(reset_in, 60) + 30
            self._tripped_count += 1
            return

        # Soft threshold: when keyed remaining is below the fallback
        # threshold, switch BEFORE hitting zero. This catches the case
        # where multiple producer processes are racing the same bucket.
        if (not self._in_fallback
                and OPENALEX_API_KEY
                and remaining < self._fallback_threshold):
            self._enter_fallback()
            return

        # Pace ourselves to spread the remaining quota evenly across the
        # remaining window. If we have 5,000 requests left and 12 hours to
        # midnight, interval should be (12*3600)/5000 = 8.6s.
        # Use min of OA's remaining and our soft-cap remaining.
        soft_remaining = max(0, self.daily_budget - self._calls_today)
        effective_remaining = min(remaining, soft_remaining) if soft_remaining else remaining
        if reset_in > 0 and effective_remaining > 0:
            ideal_interval = reset_in / effective_remaining
            self._interval = max(self._base_interval, ideal_interval)

    def _headers(self) -> dict:
        # OpenAlex authenticates via the `api_key=` URL parameter, NOT via an
        # Authorization header (per their docs). Sending Bearer-auth with a
        # non-matching scheme gets instant 429s.
        return {'Accept': 'application/json'}

    def get(self, path: str, params: Optional[dict] = None) -> Optional[dict]:
        """
        Low-level GET. `path` may be a full URL or a path relative to
        OPENALEX_BASE_URL. Returns parsed JSON, or None on 404 / final
        failure / breaker-open.

        Streaming + wall-clock deadline so a stalled body can't block.
        Circuit breaker so a persistent 429 streak (rate-limit ban) puts
        the client to sleep for minutes rather than thrashing.

        If the breaker is open the call returns None immediately. Callers
        can check `self.breaker_open` / `self.breaker_status()` to decide
        whether to abort cleanly.
        """
        # Before each request: if we're in fallback and 24h has elapsed,
        # try the key once. On success we proceed with key restored.
        if self._should_probe_key():
            self._attempt_key_probe()
        # Refuse fast if the breaker says we're in cool-off.
        if self.breaker_open:
            return None

        if path.startswith('http'):
            url = path
        else:
            url = OPENALEX_BASE_URL + path

        merged: dict = {}
        # Only send the api_key when not in fallback. In fallback we hit
        # the anonymous per-IP bucket which has its own quota.
        if OPENALEX_API_KEY and not self._in_fallback:
            merged['api_key'] = OPENALEX_API_KEY     # per OA docs: URL param, not header
        if OPENALEX_MAILTO:
            merged['mailto'] = OPENALEX_MAILTO
        if params:
            merged.update(params)
        headers = self._headers()

        connect_t, read_t = self.timeout if isinstance(self.timeout, tuple) else (10, 30)
        total_budget = read_t + connect_t       # wall-clock per attempt

        for attempt in range(self.max_retries + 1):
            # Throttle between attempts (and a final breaker re-check in case
            # a previous attempt's 429 just tripped it).
            if self.breaker_open:
                return None
            # Global cross-process rate gate (rates.config, engine 'openalex');
            # the local interval is the fallback when Redis is unavailable.
            if not ratelimit.throttle('openalex'):
                gap = self._interval - (time.time() - self._last)
                if gap > 0:
                    time.sleep(gap)

            deadline = time.time() + total_budget
            resp = None
            try:
                resp = self._session.get(
                    url,
                    params=merged,
                    headers=headers,
                    timeout=(connect_t, read_t),
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
            self._capture_quota(resp)

            if resp.status_code == 200:
                self._record_success()
                try:
                    return json.loads(body.decode('utf-8'))
                except (ValueError, UnicodeDecodeError):
                    return None

            if resp.status_code == 404:
                return None

            if resp.status_code == 429:
                self._record_429()
                # If recording this 429 tripped the breaker, abandon further
                # retries — _record_429 has set the cool-off deadline.
                if self.breaker_open:
                    return None
                try:
                    wait = float(resp.headers.get('Retry-After') or 0)
                except (TypeError, ValueError):
                    wait = 0
                wait = max(wait, min(self.backoff_base * (2 ** attempt), self.backoff_max))
                self._interval = min(self._interval * 2, self.backoff_max)
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

    def get_by_doi(self, doi: str, select: str = SELECT_FULL) -> Optional[dict]:
        """Fetch a single work record by DOI."""
        from urllib.parse import quote
        encoded = quote(doi, safe='')
        return self.get(f"/works/doi:{encoded}", {'select': select})

    def fetch_batch_by_doi(
        self,
        dois: list,
        select: str = SELECT_FULL,
    ) -> dict:
        """
        Fetch up to _BATCH_SIZE works in one request via OA's filter syntax.

        Returns: { normalised_doi: work_record } for found DOIs.
        Missing DOIs simply don't appear in the result dict.
        """
        if not dois:
            return {}
        if len(dois) > _BATCH_SIZE:
            raise ValueError(f"Batch exceeds OpenAlex limit of {_BATCH_SIZE}")

        params = {
            'filter':   'doi:' + '|'.join(dois),
            'per-page': str(len(dois)),
            'select':   select,
        }
        resp = self.get("/works", params)
        if not resp:
            return {}
        out = {}
        for work in resp.get('results') or []:
            d = normalise_doi(work.get('doi'))
            if d:
                out[d] = work
        return out

    def fetch_batch_by_oa_id(
        self,
        oa_ids: list,
        select: str = SELECT_FULL,
    ) -> dict:
        """
        Same as fetch_batch_by_doi but keyed by OpenAlex work IDs (e.g. 'W12345').

        Used to enrich stub papers — rows that were created from a citation
        reference (so we know the oa_id of a paper our corpus cites) but
        which we have no other metadata for. One OA call per 50 stubs.

        Returns: { oa_id (uppercase): work_record } for found IDs.
        """
        if not oa_ids:
            return {}
        if len(oa_ids) > _BATCH_SIZE:
            raise ValueError(f"Batch exceeds OpenAlex limit of {_BATCH_SIZE}")

        # Normalise to uppercase W-IDs (what OA accepts in filter syntax).
        clean = []
        for oid in oa_ids:
            if not oid:
                continue
            s = oid.strip()
            if s.startswith(('https://openalex.org/', 'http://openalex.org/')):
                s = s.rsplit('/', 1)[-1]
            clean.append(s.upper())
        if not clean:
            return {}

        params = {
            'filter':   'openalex_id:' + '|'.join(clean),
            'per-page': str(len(clean)),
            'select':   select,
        }
        resp = self.get("/works", params)
        if not resp:
            return {}
        out = {}
        for work in resp.get('results') or []:
            oid = (work.get('id') or '').rsplit('/', 1)[-1].upper() or None
            if oid:
                out[oid] = work
        return out

    def cites_of(self, oa_id: str, per_page: int = 200):
        """Yield identifiers of every work that CITES `oa_id` (incoming).

        Cursor-paginates OA's `cites:` filter through ALL citers. Yields dicts
        of {'oa_id', 'doi'} — identifiers only, no metadata (callers build
        edge-only CitationRecords). Stops if the breaker trips mid-pagination.
        """
        s = (oa_id or '').strip()
        if not s:
            return
        if s.startswith(('https://openalex.org/', 'http://openalex.org/')):
            s = s.rsplit('/', 1)[-1]
        s = s.upper()

        cursor = '*'
        while cursor:
            if self.breaker_open:
                return
            params = {
                'filter':   f'cites:{s}',
                'per-page': str(per_page),
                'select':   'id,doi',
                'cursor':   cursor,
            }
            resp = self.get("/works", params)
            if not resp:
                return
            for w in resp.get('results') or []:
                cid = (w.get('id') or '').rsplit('/', 1)[-1].upper() or None
                doi = normalise_doi(w.get('doi') or '')
                if cid or doi:
                    yield {'oa_id': cid, 'doi': doi}
            cursor = (resp.get('meta') or {}).get('next_cursor')

    def search_by_title(
        self,
        title: str,
        year: Optional[int] = None,
        top_k: int = 3,
        select: str = SELECT_SLIM,
    ) -> Optional[list]:
        """Free-text title search, optionally filtered to a publication year."""
        params = {
            'search':   title,
            'per-page': str(top_k),
            'select':   select,
        }
        if year is not None:
            params['filter'] = f'publication_year:{year}'
        resp = self.get("/works", params)
        if not resp:
            return None
        return resp.get('results') or []

    # ------------------------------------------------------------------
    # Parse helper
    # ------------------------------------------------------------------

    @staticmethod
    def parse_work(work: dict) -> dict:
        """
        Extract the fields v2 cares about from an OpenAlex work record.

        Returns a dict whose missing fields are None — safe for downstream
        COALESCE updates.
        """
        oa_type = (work.get('type') or '').lower()
        pub_type = _PUB_TYPE_MAP.get(oa_type, oa_type or None)

        raw_authors = [
            a.get('author', {}).get('display_name', '')
            for a in (work.get('authorships') or [])
        ]
        authors_json = json.dumps([a for a in raw_authors if a]) or None

        loc = work.get('primary_location') or {}
        venue = (loc.get('source') or {}).get('display_name') or None

        oa_id_raw = (work.get('id') or '').replace('https://openalex.org/', '') or None

        parsed = {
            'oa_id':    oa_id_raw,
            'oa_type':  oa_type,
            'pub_type': pub_type,
            'rejected': oa_type in REJECTED_OA_TYPES,
            'doi':      normalise_doi(work.get('doi') or ''),
            'title':    work.get('title'),
            'year':     work.get('publication_year'),
            'authors':  authors_json,
            'venue':    venue,
            'abstract': reconstruct_abstract(work.get('abstract_inverted_index')),
            'cit_count': work.get('cited_by_count'),
        }
        parsed.update(parse_biblio(work))
        return parsed


def _id_tail(url: Optional[str]) -> Optional[str]:
    """OpenAlex `ids.pmid`/`ids.pmcid` are URLs; return the trailing id."""
    if not url:
        return None
    m = re.search(r'([A-Za-z0-9]+)/?$', str(url).strip())
    return m.group(1) if m else None


def parse_biblio(work: dict) -> dict:
    """Extended bibliographic fields from an OpenAlex work: biblio numbers,
    publisher, language, publication date/month, and secondary identifiers.
    Returns kwargs ready to splat onto a PaperRecord (keys match its attrs)."""
    biblio = work.get('biblio') or {}
    source = (work.get('primary_location') or {}).get('source') or {}
    ids = work.get('ids') or {}
    pub_date = work.get('publication_date')

    extra_ids: dict = {}
    issns = source.get('issn') or []
    if isinstance(issns, str):
        issns = [issns]
    if issns:
        extra_ids['issn'] = list(issns)
    mag = ids.get('mag')
    if mag:
        extra_ids['mag'] = [_id_tail(mag) or str(mag)]

    month = pub_date[5:7] if (pub_date and len(pub_date) >= 7) else None

    return {
        'volume':            biblio.get('volume'),
        'issue':             biblio.get('issue'),
        'first_page':        biblio.get('first_page'),
        'last_page':         biblio.get('last_page'),
        'publisher':         source.get('host_organization_name'),
        'language':          work.get('language'),
        'publication_date':  pub_date,
        'month':             month,
        'pubmed_id':         _id_tail(ids.get('pmid')),
        'pubmed_central_id': _id_tail(ids.get('pmcid')),
        'extra_identifiers': extra_ids,
        # OpenAlex only distinguishes retracted; map True -> 'retracted'.
        'editorial_status':  'retracted' if work.get('is_retracted') else None,
    }
