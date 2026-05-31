"""
enrich_stubs_oa — fill in stub papers via OpenAlex by OA ID.

Stub papers (papers.is_stub=1 OR title IS NULL) enter the corpus from
referenced_works during enrichment: we discover that a known paper cites
work W123 even though W123 isn't in our corpus. The merge writer creates
a stub row with just oa_id set so future enrichment passes can find it.

This module picks up those stubs and calls OA by OA ID to enrich them.
50 stubs per batch via OA's filter=openalex_id:W1|W2|...

Service identifier in enrichment_attempts: 'oa' (shares budget with the
other OA modules — see the daily budget on OpenAlexClient).
"""
from typing import Optional

from .enrich_metadata_oa import (
    _parse_to_record, _citation_records, _SELECT, _BATCH_SIZE,
)
from ..clients.openalex import OpenAlexClient
from ..framework import Module, ModuleResult, ValidationResult


class EnrichStubsOa(Module):
    name        = 'enrich_stubs_oa'
    description = 'Fill in stub papers (oa_id known, no metadata) via OpenAlex'

    requires    = {'papers.oa_id'}
    produces    = {'cache:papers', 'cache:citations'}
    # 'papers.doi' is included because filling a stub via OA often yields
    # its DOI. 'papers.title' would create a cycle with resolve_dois_* and
    # is also produced by every enrich module, so we leave it out.
    eventually  = {'papers.doi', 'papers.year',
                   'papers.authors', 'papers.venue', 'papers.abstract',
                   'papers.pub_type',
                   'citations.citing_id', 'citations.cited_id',
                   'citation_counts.openalex'}
    resources   = {'openalex_api'}

    SERVICE        = 'oa'         # shares budget pool with enrich_metadata_oa
    batch_size     = _BATCH_SIZE
    IDLE_SLEEP_S   = 30
    MAX_IDLE_LOOPS = 5

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        conn = ctx.connect(readonly=True)
        try:
            row = conn.execute("""
                SELECT 1 FROM papers
                WHERE oa_id IS NOT NULL
                  AND is_rejected = 0
                  AND title IS NULL
                LIMIT 1
            """).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(ok=False, missing=['papers.oa_id'],
                                    message='No stub papers (title IS NULL & oa_id set)')
        return ValidationResult(ok=True)

    def run(self, ctx):
        import time as _time
        from ..framework.claims import (
            request_claim, report_marks,
        )

        client = OpenAlexClient()
        source = 'oa_works_by_oa_id'

        limit   = ctx.config.get('enrich_metadata_limit')
        loop    = ctx.config.get('loop', False)
        verbose = ctx.config.get('verbose', False)

        stats = {'total': 0, 'batches': 0, 'found': 0,
                 'missing_from_oa': 0, 'edges_pushed': 0, 'errors': 0,
                 'idle_loops': 0, 'budget_pauses': 0}

        print(f"  enrich_stubs_oa: loop={loop}, limit={limit}, batch={self.batch_size}")

        idle_loops = 0
        while True:
            if ctx.shutdown.requested:
                break
            if limit and stats['found'] >= int(limit):
                print(f"  [limit] {limit} reached")
                break

            if client.breaker_open:
                bs = client.breaker_status()
                wait = max(60, bs.get('open_for_s') or 0) + 5
                stats['budget_pauses'] += 1
                print(f"  [budget] OA budget hit (calls_today={bs['calls_today']}); "
                      f"sleeping {wait}s")
                if not loop:
                    break
                slept = 0
                while slept < wait and not ctx.shutdown.requested:
                    _time.sleep(min(5, wait - slept))
                    slept += 5
                continue

            rows = request_claim(ctx.cache, self.name,
                                 batch_size=self.batch_size,
                                 timeout_s=30.0)

            if not rows:
                idle_loops += 1
                stats['idle_loops'] += 1
                if idle_loops >= self.MAX_IDLE_LOOPS or not loop:
                    print(f"  [done] no candidates after {idle_loops} idle loops")
                    break
                _time.sleep(self.IDLE_SLEEP_S)
                continue
            idle_loops = 0

            # Build OA ID → paper_id map
            oid_to_pid: dict[str, int] = {}
            for r in rows:
                oid = (r['oa_id'] or '').strip().upper()
                if oid:
                    oid_to_pid[oid] = r['id']

            t_req = _time.time()
            try:
                works = client.fetch_batch_by_oa_id(
                    list(oid_to_pid.keys()), select=_SELECT,
                )
                stats['batches'] += 1
            except Exception as e:
                stats['errors'] += len(oid_to_pid)
                if verbose:
                    print(f"  [batch {stats['batches']+1}] ERROR {type(e).__name__}: "
                          f"{str(e)[:80]}")
                continue
            req_ms = (_time.time() - t_req) * 1000

            succeeded_ids: list[int] = []
            failed_ids:    list[int] = []
            batch_found, batch_refs = 0, 0
            for oid, pid in oid_to_pid.items():
                work = works.get(oid)
                if work is None:
                    stats['missing_from_oa'] += 1
                    failed_ids.append(pid)
                    continue
                ctx.cache.push_paper(_parse_to_record(work, source))
                refs = _citation_records(work, source)
                if refs:
                    ctx.cache.push_citations(refs)
                    stats['edges_pushed'] += len(refs)
                    batch_refs += len(refs)
                succeeded_ids.append(pid)
                stats['found'] += 1
                batch_found += 1

            report_marks(ctx.cache, self.name,
                          [(i, '_all') for i in succeeded_ids],
                          [(i, '_all') for i in failed_ids])

            print(f"  [batch {stats['batches']:>4}] {len(oid_to_pid)} OA IDs → "
                  f"{batch_found} found, {batch_refs} edges  "
                  f"({req_ms:.0f}ms) | "
                  f"budget {client.breaker_status()['calls_today']}/{client.daily_budget}")

        stats['total'] = stats['found'] + stats['missing_from_oa'] + stats['errors']
        return ModuleResult(
            status='success' if stats['found'] else 'noop',
            message=(f"{stats['found']:,} stubs enriched across "
                     f"{stats['batches']:,} OA batches; "
                     f"{stats['edges_pushed']:,} edges pushed"),
            stats=stats,
        )
