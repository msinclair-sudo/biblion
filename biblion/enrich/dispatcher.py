"""
Dispatcher — the single in-flight-owning process of the enrich redesign.

Embeds a Reader + the Solver in one process so the in-RAM in-flight set is
coherent (decision #8 / locked decisions). Per pass it:

  1. seeds the corpus once, then SPOPs a dirty batch (canonicalised),
  2. builds WorkItems and solves them into routing decisions,
  3. keeps only the decisions for endpoints it's been told to handle (the
     cutover set) — everything else stays on the legacy producer path,
  4. for each decision: skips papers already in flight, persists 'claimed'
     rows (durable in-flight, rehydrated on restart), calls the thin handler,
     pushes the returned PaperRecords (the writer is still the only main-DB
     writer), and marks per-(paper, field) outcomes.

Double-dispatch (race R1) is prevented two ways: the in-RAM in-flight set within
a process, and the persisted 'claimed' rows which make a paper's need invisible
to the Reader (it blocks 'claimed') so it isn't re-routed across passes — and
visible to any still-running legacy producer so it isn't poached during cutover.

Termination: a handled paper is re-SADDed by the writer after its record commits,
re-popped, but its now-succeeded/failed attempt blocks the need, so it isn't
re-dispatched.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

from .reader import Reader
from .catalogue import CATALOGUE
from .solver import solve
from .handlers import HANDLERS
from ..framework.claims import mark_claimed, bulk_mark
from ..clients.ratelimit import DailyLimitReached

_log = logging.getLogger(__name__)

DEFAULT_BATCH = 1000


def parse_endpoints(spec: Optional[str]) -> list[str]:
    """Parse a comma/space list of endpoint names against the handler registry.
    Unknown names raise (fail fast on a typo'd cutover flag)."""
    if not spec:
        return []
    names = [s.strip() for s in spec.replace(',', ' ').split() if s.strip()]
    unknown = [n for n in names if n not in HANDLERS]
    if unknown:
        raise ValueError(f"dispatcher: unknown endpoint(s) {unknown}; "
                         f"known: {sorted(HANDLERS)}")
    return names


class Dispatcher:
    def __init__(self, cache, main_db_path: Path, endpoints: list[str],
                 claims_db_path: Optional[Path] = None,
                 batch_size: int = DEFAULT_BATCH,
                 reader: Optional[Reader] = None,
                 clients: Optional[dict] = None):
        from ..db import get_claims_connection
        self.cache = cache
        self.main_db_path = main_db_path
        self.endpoints = [e for e in endpoints if e in HANDLERS]
        # Solve over ONLY the endpoints we dispatch, so a need served by two
        # endpoints sharing a (service, field) — e.g. ('s2_hop','_all') from both
        # expand_papers_s2 (broad) and expand_papers_s2_seeds — routes to the one
        # we actually handle, instead of the solver picking the excluded variant
        # and the decision getting dropped.
        self._catalogue = {k: v for k, v in CATALOGUE.items()
                           if k in self.endpoints}
        self.batch_size = batch_size
        self.reader = reader or Reader(
            cache, main_db_path, claims_db_path=claims_db_path)
        # Dedicated WRITE connection to the claims DB (mark_claimed / bulk_mark).
        self._claims = get_claims_connection(
            claims_db_path=claims_db_path, main_db_path=main_db_path)
        # (paper_id, service, field) -> True. Durable copy lives in the claims DB.
        self._inflight: dict[tuple, bool] = {}
        # Lazily-built (or injected, for tests) provider clients per endpoint.
        self._clients: dict = dict(clients or {})
        self.stats = {'passes': 0, 'dispatched': 0, 'records': 0,
                      'succeeded': 0, 'failed': 0, 'deferred_budget': 0}

    # -- lifecycle ---------------------------------------------------------
    def close(self) -> None:
        for attr in ('_claims',):
            c = getattr(self, attr, None)
            if c is not None:
                try:
                    c.close()
                except Exception:
                    pass
                setattr(self, attr, None)
        if getattr(self, 'reader', None) is not None:
            self.reader.close()
            self.reader = None

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass

    def _client_for(self, endpoint: str):
        if endpoint not in self._clients:
            self._clients[endpoint] = HANDLERS[endpoint].make_client()
        return self._clients[endpoint]

    # -- in-flight ---------------------------------------------------------
    def rehydrate_inflight(self) -> int:
        """Load outstanding 'claimed' rows for the cut services back into the
        in-RAM set after a restart, so we don't re-dispatch in-flight work.

        Only FRESH claims (claimed_at within the stale window) are rehydrated:
        a claim older than that outlived the producer that made it (crash,
        SIGTERM between claim and mark, a daily-limit break mid-flight), so
        re-loading it would pin its paper as ghost-in-flight forever. Stale ones
        are left for the Reader to treat as reclaimable."""
        from ..framework.claims import stale_claim_cutoff_iso
        services = {HANDLERS[e].service for e in self.endpoints}
        if not services:
            return 0
        placeholders = ', '.join('?' for _ in services)
        rows = self._claims.execute(
            f"SELECT paper_id, service, field FROM enrichment_attempts "
            f"WHERE status = 'claimed' AND service IN ({placeholders}) "
            f"  AND claimed_at > ?",
            list(services) + [stale_claim_cutoff_iso()]).fetchall()
        for r in rows:
            self._inflight[(r['paper_id'], r['service'], r['field'])] = True
        return len(rows)

    # -- budget ------------------------------------------------------------
    def _budgets(self) -> dict:
        """Provider -> remaining calls. 0 when the provider's breaker is open
        (defer this pass); None otherwise (unlimited this pass)."""
        budgets: dict[str, Optional[int]] = {}
        for endpoint in self.endpoints:
            ep = CATALOGUE[endpoint]
            spec = HANDLERS[endpoint]
            if budgets.get(ep.provider) == 0:
                continue
            open_ = False
            try:
                open_ = spec.breaker_open(self._client_for(endpoint))
            except Exception:
                open_ = False
            budgets[ep.provider] = 0 if open_ else None
        return budgets

    # -- one pass ----------------------------------------------------------
    def run_pass(self) -> int:
        """Drain one dirty batch and dispatch the cutover endpoints. Returns the
        number of (paper, endpoint) dispatches made this pass."""
        self.stats['passes'] += 1
        self.reader.seed_corpus_if_needed()
        ids = self.reader.next_dirty_batch(self.batch_size)
        if not ids or not self.endpoints:
            return 0
        items = self.reader.build_items(ids)
        by_id = {it.paper_id: it for it in items}
        budgets = self._budgets()
        decisions = solve(items, self._catalogue, budgets)

        dispatched = 0
        # Providers whose daily budget tripped mid-pass — skip their remaining
        # endpoints this pass; the breaker defers them on subsequent passes.
        exhausted: set = set()
        for endpoint, pids in decisions:
            if endpoint not in self.endpoints:
                continue                      # legacy producer still owns it
            ep = CATALOGUE[endpoint]
            if ep.provider in exhausted:
                continue
            service = ep.service
            call_items, claim_pairs = [], []
            for pid in pids:
                it = by_id.get(pid)
                if it is None:
                    continue
                pairs = [(pid, f) for (svc, f) in (ep.settles & it.needs)]
                # Skip a paper any of whose claims is already in flight, to avoid
                # a partial double-claim.
                if any((pid, service, f) in self._inflight for _p, f in pairs):
                    continue
                if not pairs:
                    continue
                call_items.append(it)
                claim_pairs.extend(pairs)
            if not call_items:
                continue

            # Persist claims (durable in-flight) BEFORE the API call.
            mark_claimed(self._claims, service, claim_pairs)
            for pid, f in claim_pairs:
                self._inflight[(pid, service, f)] = True

            # Call the handler in provider-batch-sized chunks. The clients build
            # one request per call (e.g. Crossref/OA put every id in one URL/POST
            # body), so a 1000-item dirty batch would otherwise blow the request
            # — the legacy producers capped this via their claim batch size.
            batch = max(1, ep.batch)
            for i in range(0, len(call_items), batch):
                chunk = call_items[i:i + batch]
                try:
                    result = HANDLERS[endpoint].handle(
                        self._client_for(endpoint), chunk)
                except DailyLimitReached:
                    # Provider's daily budget tripped mid-pass. DailyLimitReached
                    # is a BaseException (so it bubbles past legacy producers'
                    # `except Exception` to hard-stop them) — which means the
                    # generic handler-error branch below never catches it, and
                    # without this clause one exhausted provider would crash the
                    # whole multi-provider dispatcher and crash-loop. Leave this
                    # chunk's claims (they expire and retry once the budget
                    # resets), and defer this provider for the rest of the pass.
                    _log.warning("provider %s daily limit reached; deferring",
                                 ep.provider)
                    self.stats['deferred_budget'] += 1
                    exhausted.add(ep.provider)
                    break
                except Exception as e:
                    # Leave this chunk's claims in place; they expire and retry.
                    # Don't crash the dispatcher on one provider error.
                    _log.warning("handler %s failed: %s", endpoint, e)
                    break
                if result.papers:
                    self.cache.push_papers(result.papers)
                    self.stats['records'] += len(result.papers)
                if result.citations:
                    self.cache.push_citations(result.citations)
                    self.stats.setdefault('citations', 0)
                    self.stats['citations'] += len(result.citations)
                bulk_mark(self._claims, service, result.succeeded, result.failed)
                self.stats['succeeded'] += len(result.succeeded)
                self.stats['failed'] += len(result.failed)
                dispatched += len(chunk)
            for pid, f in claim_pairs:
                self._inflight.pop((pid, service, f), None)

        self.stats['dispatched'] += dispatched
        return dispatched

    # -- daemon loop -------------------------------------------------------
    def run(self, idle_sleep: float = 1.0, shutdown=None) -> None:
        import time as _time
        self.rehydrate_inflight()
        while shutdown is None or not shutdown.requested:
            n = self.run_pass()
            self.cache.beat('dispatcher', self.stats)    # live-dashboard heartbeat
            if n == 0:
                _time.sleep(idle_sleep)


# ---------------------------------------------------------------------------
# CLI entry — `python -m biblion.enrich.dispatcher`
# ---------------------------------------------------------------------------

def main():
    import argparse
    from ..cache import CacheClient
    from ..db import get_db_path
    from ..runtime import ShutdownFlag

    p = argparse.ArgumentParser(description='Run the enrich dispatcher daemon.')
    p.add_argument('--db', type=Path, default=None)
    p.add_argument('--redis-url', default='redis://localhost:6379/0')
    p.add_argument('--batch-size', type=int, default=DEFAULT_BATCH)
    p.add_argument('--idle-sleep', type=float, default=1.0)
    p.add_argument('--endpoints', default=os.environ.get('BIBLION_DISPATCH_ENDPOINTS', ''),
                   help='comma/space list of endpoint names to dispatch')
    args = p.parse_args()
    db_path = args.db or get_db_path()
    endpoints = parse_endpoints(args.endpoints)

    cache = CacheClient(url=args.redis_url)
    d = Dispatcher(cache, db_path, endpoints, batch_size=args.batch_size)
    flag = ShutdownFlag.install(name='enrich-dispatcher')
    print(f"[dispatch] db={db_path} endpoints={endpoints or '(none)'} "
          f"redis={args.redis_url}")
    try:
        d.run(idle_sleep=args.idle_sleep, shutdown=flag)
    finally:
        d.close()
        print(f"[dispatch] shutdown. stats={d.stats}")


if __name__ == '__main__':
    main()
