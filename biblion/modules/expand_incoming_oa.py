"""
expand_incoming_oa — incoming citations (who cites this paper) via OpenAlex.

For each paper we know an OpenAlex id for, query OA's `cites:` filter to find
every work that cites it, and push a directed edge `citer -> this_paper`. The
edges are identifier-only: we do NOT enrich the citer's metadata. The merge
writer resolves the citer against the corpus — a known citer makes a real
edge, an unknown one parks in pending_citations until (if ever) that paper
lands. So a heavily-cited paper becomes many cheap pending-edge rows, not many
enriched stub papers.

This complements:
  * enrich_metadata_oa / _s2 — push OUTGOING references (this paper cites X).
  * enrich_metadata_s2       — also bundles INCOMING citations for free.
OpenAlex doesn't return incoming inline, so this is a separate producer with
its own `cites:` query per paper (cursor-paginated through all citers).
"""
from ..clients.openalex import OpenAlexClient
from ..cache.records import CitationRecord
from ..framework import Module, ModuleResult, ValidationResult


_CLAIM_BATCH = 25   # one cites: query (paginated) per paper, so keep modest

_SOURCE = 'oa_incoming'


class ExpandIncomingOa(Module):
    name        = 'expand_incoming_oa'
    description = 'Incoming citations (who cites this paper) via OpenAlex cites: filter'

    requires    = {'papers.oa_id'}
    produces    = {'cache:citations'}
    eventually  = {'citations.citing_id', 'citations.cited_id'}
    resources   = {'openalex_api'}

    SERVICE        = 'oa_incoming'
    batch_size     = _CLAIM_BATCH
    IDLE_SLEEP_S   = 30
    MAX_IDLE_LOOPS = 5

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        conn = ctx.connect(readonly=True)
        try:
            row = conn.execute("""
                SELECT 1 FROM papers
                WHERE oa_id IS NOT NULL AND is_rejected = 0 LIMIT 1
            """).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(ok=False, missing=['papers.oa_id'],
                                    message='No papers with an OpenAlex id to expand')
        return ValidationResult(ok=True)

    def run(self, ctx):
        import time as _time
        from ..framework.claims import request_claim, report_marks

        client = OpenAlexClient()

        limit   = ctx.config.get('hop_limit')
        loop    = ctx.config.get('loop', False)
        verbose = ctx.config.get('verbose', False)

        stats = {'total': 0, 'papers': 0, 'edges_pushed': 0,
                 'errors': 0, 'idle_loops': 0, 'budget_pauses': 0}

        print(f"  expand_incoming_oa: loop={loop}, limit={limit}, "
              f"batch={self.batch_size}")

        idle_loops = 0
        while True:
            if ctx.shutdown.requested:
                break
            if limit and stats['papers'] >= int(limit):
                print(f"  [limit] {limit} reached")
                break

            if client.breaker_open:
                bs = client.breaker_status()
                wait = max(60, bs.get('open_for_s') or 0) + 5
                stats['budget_pauses'] += 1
                print(f"  [budget] OA budget hit; sleeping {wait}s")
                if not loop:
                    break
                slept = 0
                while slept < wait and not ctx.shutdown.requested:
                    _time.sleep(min(5, wait - slept))
                    slept += 5
                continue

            rows = request_claim(ctx.cache, self.name,
                                 batch_size=self.batch_size, timeout_s=30.0)
            if not rows:
                idle_loops += 1
                stats['idle_loops'] += 1
                if idle_loops >= self.MAX_IDLE_LOOPS or not loop:
                    print(f"  [done] no candidates after {idle_loops} idle loops")
                    break
                _time.sleep(self.IDLE_SLEEP_S)
                continue
            idle_loops = 0

            succeeded: list = []
            failed:    list = []
            for r in rows:
                pid = r['id']
                oa_id = r['oa_id']
                this_oa = (oa_id or '').rsplit('/', 1)[-1].upper() or None
                edges = 0
                try:
                    for citer in client.cites_of(oa_id):
                        rec = CitationRecord(
                            source       = _SOURCE,
                            citing_doi   = citer.get('doi'),
                            citing_oa_id = citer.get('oa_id'),
                            cited_oa_id  = this_oa,
                        )
                        ctx.cache.push_citation(rec)
                        edges += 1
                except Exception as e:
                    stats['errors'] += 1
                    failed.append((pid, '_all'))
                    if verbose:
                        print(f"  [paper {pid}] ERROR {type(e).__name__}: {str(e)[:60]}")
                    continue
                stats['edges_pushed'] += edges
                stats['papers'] += 1
                succeeded.append((pid, '_all'))

            report_marks(ctx.cache, self.name, succeeded, failed)
            print(f"  [batch] {len(rows)} papers → "
                  f"{stats['edges_pushed']:,} incoming edges so far | "
                  f"budget {client.breaker_status().get('calls_today')}")

        stats['total'] = stats['papers'] + stats['errors']
        return ModuleResult(
            status='success' if stats['edges_pushed'] else 'noop',
            message=(f"{stats['edges_pushed']:,} incoming edges from "
                     f"{stats['papers']:,} papers"),
            stats=stats,
        )
