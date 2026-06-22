"""
Redis cache client — the only thing producers and the merge writer use
to talk to the cache.

Why a thin wrapper rather than direct redis-py?
  - Centralised key naming convention
  - Records validated at the boundary (rejected if no identifier)
  - Easy to swap the substrate later (Redis → some other queue)
  - Unit-test seams (CacheClient is mockable)

Keys
----
    staged:papers              List[json(PaperRecord)]       producer push, merge LPOP
    staged:citations           List[json(CitationRecord)]    producer push, merge LPOP
    parked:papers              List[json(PaperRecord)]       merge parks here on multi-hit
    parked:citations           List[json(CitationRecord)]    merge parks here when one endpoint missing
    resolved:papers            List[json(PaperRecord)]       resolver pushes back here after dedup; merge drains first

    claim_request:<service>    List[json(ClaimRequest)]      producer push, writer LPOP
    claim_grant:<service>      List[json(ClaimGrant)]        writer push, producer LPOP (BLPOP)
    result_mark:<service>      List[json(ResultMark)]        producer push, writer LPOP

    dirty:papers               Set[paper_id]                 writer SADD (post-commit), Reader SPOP
    dirty:seeded               flag                          set once the Reader has seeded the corpus
"""
from typing import Iterable, Optional
import json
import logging

from .records import (
    PaperRecord, CitationRecord, ClaimRequest, ClaimGrant, ResultMark,
    PromoteCitationAction, PendingDoiBackfill, AliasJob, UpsertWinnerJob,
    WritePaperJob, WriteEdgeJob, WritePendingEdgeJob,
)


# Default key names — orchestrator can override per environment
KEY_STAGED_PAPERS      = 'staged:papers'
KEY_STAGED_CITATIONS   = 'staged:citations'
KEY_PARKED_PAPERS      = 'parked:papers'
KEY_PARKED_CITATIONS   = 'parked:citations'
KEY_RESOLVED_PAPERS    = 'resolved:papers'

# Per-service key prefixes — actual keys are f"{PREFIX}{service}".
KEY_CLAIM_REQUEST_PREFIX = 'claim_request:'
KEY_CLAIM_GRANT_PREFIX   = 'claim_grant:'
KEY_RESULT_MARK_PREFIX   = 'result_mark:'

# pending-resolution flow
KEY_PROMOTE_CITATIONS  = 'promote:citations'
# The pending_resolver persists its sweep cursor here so a restart
# resumes where it stopped instead of redoing work.
KEY_PENDING_CURSOR     = 'pending_resolver:cursor'
# resolve_pending_dois → writer: oa_id→doi stamps to apply to pending_citations.
KEY_PENDING_DOI_BACKFILL = 'backfill:pending_dois'

# Dirty-set feed (enrich redesign). The writer SADDs every committed paper id
# (canonicalised through the alias map) here; the Reader SPOPs them. A SET, not a
# list, so repeated touches of the same paper between drains collapse to one
# entry. KEY_DIRTY_SEEDED is a one-shot flag the Reader sets after its initial
# full-corpus seed so it never re-seeds.
KEY_DIRTY_PAPERS  = 'dirty:papers'
KEY_DIRTY_SEEDED  = 'dirty:seeded'

# dedup → writer: alias / upsert-winner jobs (enrich redesign Phase 5+). The
# writer is the sole applier of alias rows. Phase 5 applies these inline; the
# queue is the durable boundary the pure-writer (Phase 6) consumes.
KEY_ALIAS_JOBS = 'alias:jobs'

# compute → pure writer (Phase 6): pre-resolved write-jobs. The compute stage
# does the identifier lookup; the writer applies without probing.
KEY_WRITE_JOBS = 'write:jobs'

# Daemon heartbeats (live dashboard). Each daemon SETs a single JSON blob at
# hb:<role> every cycle, stamped with time.time(). The dashboard reads them to
# derive working/stale (by ts age) and show live per-daemon counters. ts-based
# staleness, NOT a TTL: a stalled-but-alive daemon should stay readable with an
# OLD ts (its stall age is the signal) rather than vanish; process up/down is
# already authoritative from the supervisor's proc.poll().
KEY_HEARTBEAT_PREFIX = 'hb:'


def claim_request_key(service: str) -> str:
    return f"{KEY_CLAIM_REQUEST_PREFIX}{service}"


def claim_grant_key(service: str) -> str:
    return f"{KEY_CLAIM_GRANT_PREFIX}{service}"


def result_mark_key(service: str) -> str:
    return f"{KEY_RESULT_MARK_PREFIX}{service}"

_log = logging.getLogger(__name__)


def namespace_for_db(db_path) -> str:
    """Derive a short, stable Redis-key namespace from a database path.

    The same path always produces the same namespace, so subprocesses
    and re-runs reuse the same Redis state. Different paths get
    different namespaces, so two biblion instances against different
    DBs don't trample each other on a shared Redis."""
    import hashlib
    from pathlib import Path
    p = str(Path(db_path).expanduser().resolve())
    h = hashlib.sha256(p.encode('utf-8')).hexdigest()[:10]
    return f"bib_{h}"


class CacheClient:
    """
    Lightweight wrapper around redis-py.

    The connection is lazily established so importing this module does
    not require Redis to be running (useful for tests / docs builds).
    """

    def __init__(self, host: str = 'localhost', port: int = 6379, db: int = 0,
                 url: Optional[str] = None,
                 namespace: Optional[str] = None):
        # Lazy import keeps the rest of the package usable without redis-py.
        import redis
        import os
        if url:
            self._r = redis.from_url(url, decode_responses=True)
        else:
            self._r = redis.Redis(host=host, port=port, db=db, decode_responses=True)

        # Per-instance key prefix. Two biblion instances pointing at different
        # databases share Redis but never see each other's keys.
        # Resolution order:
        #   1. explicit namespace= arg
        #   2. BIBLION_REDIS_NAMESPACE env var (set by CLI from --db hash)
        #   3. '' (legacy bare keys — preserves backwards compatibility)
        ns = namespace or os.environ.get('BIBLION_REDIS_NAMESPACE') or ''
        self._prefix = f"{ns}:" if ns else ''

    def _k(self, key: str) -> str:
        """Apply this instance's namespace prefix to a Redis key."""
        return f"{self._prefix}{key}"

    # ------------------------------------------------------------------ push

    def push_paper(self, rec: PaperRecord) -> bool:
        """Push a PaperRecord onto staged:papers. Returns False if rejected."""
        if not rec.has_identifier():
            _log.warning("Dropping PaperRecord with no identifier (source=%s)", rec.source)
            return False
        self._r.rpush(self._k(KEY_STAGED_PAPERS), rec.to_json())
        return True

    def push_papers(self, recs: Iterable[PaperRecord]) -> int:
        """Bulk push. Returns count actually pushed."""
        payloads = [r.to_json() for r in recs if r.has_identifier()]
        if payloads:
            self._r.rpush(self._k(KEY_STAGED_PAPERS), *payloads)
        return len(payloads)

    def push_citation(self, rec: CitationRecord) -> bool:
        if not (rec.citing_identifiers() and rec.cited_identifiers()):
            _log.warning("Dropping CitationRecord missing endpoint identifier (source=%s)", rec.source)
            return False
        self._r.rpush(self._k(KEY_STAGED_CITATIONS), rec.to_json())
        return True

    def push_citations(self, recs: Iterable[CitationRecord]) -> int:
        payloads = [r.to_json() for r in recs
                    if r.citing_identifiers() and r.cited_identifiers()]
        if payloads:
            self._r.rpush(self._k(KEY_STAGED_CITATIONS), *payloads)
        return len(payloads)

    # ------------------------------------------------------------------- pop

    def pop_papers_batch(self, n: int, key: str = KEY_STAGED_PAPERS) -> list[PaperRecord]:
        """
        Atomically pop up to n records from the head of the list.

        Uses LPOP with count (Redis ≥ 6.2). Returns [] if list is empty.
        """
        raw = self._r.lpop(self._k(key), count=n) or []
        return [PaperRecord.from_json(s) for s in raw]

    def pop_citations_batch(self, n: int, key: str = KEY_STAGED_CITATIONS) -> list[CitationRecord]:
        raw = self._r.lpop(self._k(key), count=n) or []
        return [CitationRecord.from_json(s) for s in raw]

    # --------------------------------------------------------------- parking

    def park_paper(self, rec: PaperRecord) -> None:
        self._r.rpush(self._k(KEY_PARKED_PAPERS), rec.to_json())

    def park_papers(self, recs: Iterable[PaperRecord]) -> None:
        payloads = [r.to_json() for r in recs]
        if payloads:
            self._r.rpush(self._k(KEY_PARKED_PAPERS), *payloads)

    def park_citation(self, rec: CitationRecord) -> None:
        self._r.rpush(self._k(KEY_PARKED_CITATIONS), rec.to_json())

    def push_resolved_paper(self, rec: PaperRecord) -> None:
        """Resolver pushes here after it has merged the conflicting existing rows."""
        self._r.rpush(self._k(KEY_RESOLVED_PAPERS), rec.to_json())

    # ------------------------------------------------------------- claim flow
    # All claims-DB writes go through the merge writer, which serves these
    # queues. Producers only push requests / pop grants / push marks.

    def push_claim_request(self, req: ClaimRequest) -> None:
        """Producer asks for a batch. Writer LPOPs."""
        self._r.rpush(self._k(claim_request_key(req.service)), req.to_json())

    def pop_claim_request(self, service: str) -> Optional[ClaimRequest]:
        """Writer: get one outstanding request for `service`, or None."""
        raw = self._r.lpop(self._k(claim_request_key(service)))
        return ClaimRequest.from_json(raw) if raw else None

    def push_claim_grant(self, grant: ClaimGrant) -> None:
        """Writer hands a batch of claimed rows back to the producer."""
        self._r.rpush(self._k(claim_grant_key(grant.service)), grant.to_json())

    def pop_claim_grant(
        self, service: str, timeout: float = 0.0,
    ) -> Optional[ClaimGrant]:
        """
        Producer fetches the next grant.

        `timeout > 0` does a BLPOP (block until something arrives or the
        timeout fires). Use 0 for a non-blocking poll. Returns None on
        timeout / empty.
        """
        if timeout > 0:
            res = self._r.blpop([self._k(claim_grant_key(service))], timeout=timeout)
            if not res:
                return None
            _key, raw = res
            return ClaimGrant.from_json(raw)
        raw = self._r.lpop(self._k(claim_grant_key(service)))
        return ClaimGrant.from_json(raw) if raw else None

    def push_result_mark(self, mark: ResultMark) -> None:
        """Producer reports per-paper outcomes. Writer LPOPs."""
        self._r.rpush(self._k(result_mark_key(mark.service)), mark.to_json())

    def pop_result_mark(self, service: str) -> Optional[ResultMark]:
        raw = self._r.lpop(self._k(result_mark_key(service)))
        return ResultMark.from_json(raw) if raw else None

    # ------------------------------------------------------- pending resolution

    def push_promote_citation(self, action: PromoteCitationAction) -> None:
        """Reader pushes a resolved pending row for the writer to apply."""
        self._r.rpush(self._k(KEY_PROMOTE_CITATIONS), action.to_json())

    def push_promote_citations(self, actions: Iterable[PromoteCitationAction]) -> int:
        payloads = [a.to_json() for a in actions]
        if payloads:
            self._r.rpush(self._k(KEY_PROMOTE_CITATIONS), *payloads)
        return len(payloads)

    def pop_promote_citation_batch(self, n: int) -> list[PromoteCitationAction]:
        """Writer drains up to n promote actions in a single round-trip."""
        raw = self._r.lpop(self._k(KEY_PROMOTE_CITATIONS), count=n) or []
        return [PromoteCitationAction.from_json(s) for s in raw]

    def push_pending_doi_backfills(self, backfills: Iterable[PendingDoiBackfill]) -> int:
        """resolve_pending_dois pushes oa_id→doi stamps for the writer to apply."""
        payloads = [b.to_json() for b in backfills]
        if payloads:
            self._r.rpush(self._k(KEY_PENDING_DOI_BACKFILL), *payloads)
        return len(payloads)

    def pop_pending_doi_backfill_batch(self, n: int) -> list[PendingDoiBackfill]:
        """Writer drains up to n DOI backfills in a single round-trip."""
        raw = self._r.lpop(self._k(KEY_PENDING_DOI_BACKFILL), count=n) or []
        return [PendingDoiBackfill.from_json(s) for s in raw]

    # --------------------------------------------------------------- dirty set

    # SADD accepts many members, but a single command with millions of args is
    # unwieldy; chunk the initial full-corpus seed.
    _DIRTY_SADD_CHUNK = 5000

    def add_dirty_papers(self, ids: Iterable[int]) -> int:
        """SADD committed paper ids onto dirty:papers. Returns members added
        (duplicates already in the set don't count). No-op on empty input."""
        ids = [int(i) for i in ids]
        if not ids:
            return 0
        key = self._k(KEY_DIRTY_PAPERS)
        added = 0
        for i in range(0, len(ids), self._DIRTY_SADD_CHUNK):
            added += self._r.sadd(key, *ids[i:i + self._DIRTY_SADD_CHUNK])
        return added

    def pop_dirty_papers(self, n: int) -> list[int]:
        """Atomically SPOP up to n paper ids. Returns [] when the set is empty.

        The set may transiently contain merged-away losers (a paper SADDed and
        then aliased before being popped); consumers MUST canonicalise each id
        through the alias map on pop and re-add the winner if it changed."""
        raw = self._r.spop(self._k(KEY_DIRTY_PAPERS), count=n) or []
        return [int(x) for x in raw]

    def dirty_count(self) -> int:
        return self._r.scard(self._k(KEY_DIRTY_PAPERS))

    def seed_dirty_all(self, ids: Iterable[int]) -> int:
        """Bulk-add the whole corpus for the Reader's one-time bootstrap.
        Kept distinct from add_dirty_papers for intent; same SADD underneath."""
        return self.add_dirty_papers(ids)

    def dirty_seeded(self) -> bool:
        """True once the Reader has done its initial full-corpus seed."""
        return bool(self._r.exists(self._k(KEY_DIRTY_SEEDED)))

    def mark_dirty_seeded(self) -> None:
        self._r.set(self._k(KEY_DIRTY_SEEDED), '1')

    def clear_dirty_seeded(self) -> None:
        """Drop the one-time seed flag so the Reader re-seeds the whole corpus on
        its next pass. Call after a bulk change the dirty feed didn't observe
        (e.g. marking new seeds by SQL) so the dispatcher re-evaluates them."""
        self._r.delete(self._k(KEY_DIRTY_SEEDED))

    # --------------------------------------------------------------- alias jobs

    def push_alias_jobs(self, jobs: Iterable) -> int:
        """dedup pushes AliasJob / UpsertWinnerJob for the writer to apply.
        Each job is tagged with its class name so the writer can dispatch."""
        payloads = []
        for j in jobs:
            payloads.append(json.dumps(
                {'kind': type(j).__name__, 'data': j.to_json()},
                separators=(',', ':')))
        if payloads:
            self._r.rpush(self._k(KEY_ALIAS_JOBS), *payloads)
        return len(payloads)

    def pop_alias_job_batch(self, n: int) -> list:
        """Writer drains up to n alias/upsert jobs. Returns concrete
        AliasJob / UpsertWinnerJob instances."""
        raw = self._r.lpop(self._k(KEY_ALIAS_JOBS), count=n) or []
        out = []
        for s in raw:
            env = json.loads(s)
            cls = AliasJob if env['kind'] == 'AliasJob' else UpsertWinnerJob
            out.append(cls.from_json(env['data']))
        return out

    # --------------------------------------------------------------- write jobs

    def push_write_jobs(self, jobs: Iterable) -> int:
        """compute pushes WritePaperJob / WriteEdgeJob / WritePendingEdgeJob for
        the pure writer. Each is tagged with its class name for dispatch."""
        payloads = []
        for j in jobs:
            payloads.append(json.dumps(
                {'kind': type(j).__name__, 'data': j.to_json()},
                separators=(',', ':')))
        if payloads:
            self._r.rpush(self._k(KEY_WRITE_JOBS), *payloads)
        return len(payloads)

    def pop_write_job_batch(self, n: int) -> list:
        """Writer drains up to n write-jobs as concrete record instances."""
        raw = self._r.lpop(self._k(KEY_WRITE_JOBS), count=n) or []
        kinds = {'WritePaperJob': WritePaperJob, 'WriteEdgeJob': WriteEdgeJob,
                 'WritePendingEdgeJob': WritePendingEdgeJob}
        out = []
        for s in raw:
            env = json.loads(s)
            out.append(kinds[env['kind']].from_json(env['data']))
        return out

    # ----------------------------------------------------------- shadow counters

    def incr_counter(self, name: str, by: int = 1) -> int:
        """Bump a namespaced diagnostic counter (e.g. shadow:needs_mismatch).
        Used by the shadow-mode comparators to surface divergence without
        failing production."""
        return self._r.incrby(self._k(name), by)

    def get_counter(self, name: str) -> int:
        raw = self._r.get(self._k(name))
        try:
            return int(raw) if raw is not None else 0
        except (TypeError, ValueError):
            return 0

    def beat(self, role: str, stats) -> None:
        """Publish a daemon's per-cycle stats + wall-clock ts to hb:<role>.

        `stats` may be a dataclass (MergeStats / ResolverStats) or a plain dict
        (compute / dispatcher). Never raises on a Redis hiccup or an
        unserialisable field — a telemetry write must never crash the daemon's
        work loop."""
        import time as _time
        from dataclasses import is_dataclass, asdict
        try:
            payload = asdict(stats) if is_dataclass(stats) else dict(stats)
        except Exception:
            payload = {}
        payload['ts'] = _time.time()
        try:
            self._r.set(self._k(f"{KEY_HEARTBEAT_PREFIX}{role}"),
                        json.dumps(payload, separators=(',', ':'), default=str))
        except Exception:
            pass

    def get_heartbeats(self, roles: Iterable[str]) -> dict:
        """Read hb:<role> for each role in one pipeline round-trip. Returns
        {role: {'ts': float, ...stats}} with the value None when no beat exists
        yet (the daemon hasn't completed its first cycle)."""
        roles = list(roles)
        if not roles:
            return {}
        pipe = self._r.pipeline()
        for r in roles:
            pipe.get(self._k(f"{KEY_HEARTBEAT_PREFIX}{r}"))
        vals = pipe.execute()
        out: dict = {}
        for r, raw in zip(roles, vals):
            if raw is None:
                out[r] = None
                continue
            try:
                out[r] = json.loads(raw)
            except Exception:
                out[r] = None
        return out

    def get_pending_cursor(self) -> int:
        """Reader's saved sweep cursor (last pending_citations.id processed)."""
        raw = self._r.get(self._k(KEY_PENDING_CURSOR))
        try:
            return int(raw) if raw is not None else 0
        except (TypeError, ValueError):
            return 0

    def set_pending_cursor(self, value: int) -> None:
        self._r.set(self._k(KEY_PENDING_CURSOR), int(value))

    def claim_queue_lengths(self, services: Iterable[str]) -> dict:
        """Per-service queue depths for diagnostics."""
        services = list(services)
        if not services:
            return {}
        pipe = self._r.pipeline()
        for s in services:
            pipe.llen(self._k(claim_request_key(s)))
            pipe.llen(self._k(claim_grant_key(s)))
            pipe.llen(self._k(result_mark_key(s)))
        vals = pipe.execute()
        out: dict[str, dict[str, int]] = {}
        for i, s in enumerate(services):
            out[s] = {
                'request': vals[3 * i],
                'grant':   vals[3 * i + 1],
                'mark':    vals[3 * i + 2],
            }
        return out

    # -------------------------------------------------------------- introspection

    def lengths(self) -> dict:
        """Snapshot of all queue lengths — useful for QC / monitoring."""
        pipe = self._r.pipeline()
        for key in (KEY_STAGED_PAPERS, KEY_STAGED_CITATIONS,
                    KEY_PARKED_PAPERS, KEY_PARKED_CITATIONS,
                    KEY_RESOLVED_PAPERS, KEY_PROMOTE_CITATIONS,
                    KEY_PENDING_DOI_BACKFILL, KEY_ALIAS_JOBS, KEY_WRITE_JOBS):
            pipe.llen(self._k(key))
        pipe.scard(self._k(KEY_DIRTY_PAPERS))   # a set, not a list
        vals = pipe.execute()
        return dict(zip(
            ('staged_papers', 'staged_citations',
             'parked_papers', 'parked_citations',
             'resolved_papers', 'promote_citations', 'pending_doi_backfill',
             'alias_jobs', 'write_jobs', 'dirty_papers'),
            vals,
        ))

    def flush_all(self) -> None:
        """Wipe every queue this client knows about. For tests only.

        Also clears any per-service claim queues found by SCAN — tests can
        leave behind state when they exercise the claim flow. SCAN is
        scoped to this instance's namespace so we don't trash sibling
        instances' state.
        """
        self._r.delete(
            self._k(KEY_STAGED_PAPERS),   self._k(KEY_STAGED_CITATIONS),
            self._k(KEY_PARKED_PAPERS),   self._k(KEY_PARKED_CITATIONS),
            self._k(KEY_RESOLVED_PAPERS), self._k(KEY_PROMOTE_CITATIONS),
            self._k(KEY_PENDING_CURSOR),  self._k(KEY_PENDING_DOI_BACKFILL),
            self._k(KEY_DIRTY_PAPERS),    self._k(KEY_DIRTY_SEEDED),
            self._k(KEY_ALIAS_JOBS),      self._k(KEY_WRITE_JOBS),
        )
        for prefix in (KEY_CLAIM_REQUEST_PREFIX, KEY_CLAIM_GRANT_PREFIX,
                       KEY_RESULT_MARK_PREFIX, KEY_HEARTBEAT_PREFIX):
            for key in self._r.scan_iter(f"{self._k(prefix)}*"):
                self._r.delete(key)

    def ping(self) -> bool:
        """Cheap reachability check. Returns True if Redis answered PONG."""
        try:
            return bool(self._r.ping())
        except Exception:
            return False
