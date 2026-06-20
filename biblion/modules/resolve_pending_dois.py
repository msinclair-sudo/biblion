"""
resolve_pending_dois — give pending-citation endpoints their DOI so the same
external paper, seen by different sources under different identifiers, unifies.

OpenAlex's referenced_works / cites: responses identify works by OpenAlex id
only (never a DOI), while Semantic Scholar's reference objects carry the DOI. So
one external paper our corpus cites can sit in `pending_citations` as BOTH an
oa-id-only endpoint AND a doi-bearing endpoint — two invisible halves whose true
co-citation degree is hidden until a unifying DOI exists (see
materialize_ghost_stubs, whose >=2 ghost threshold is only correct once endpoints
are DOI-unified).

This producer scans pending_citations for endpoints known only by an OpenAlex id
(no DOI), batch-resolves those ids -> DOI via OpenAlex (50/call), and pushes
`PendingDoiBackfill` actions. The merge writer stamps the DOI onto every matching
pending row (both citing and cited sides). It writes NOTHING to the DB itself —
read-only scan + cache pushes, like the pending_resolver.

NOT a claim-flow producer: the endpoints aren't `papers` rows, so there's nothing
to claim. Each run scans the current unresolved set and works through it until
the daily OA budget, a shutdown, or exhaustion. Backfilled endpoints drop out of
the scan next run, so it converges.
"""
from collections import defaultdict

from ..clients.openalex import OpenAlexClient, normalise_doi
from ..framework import Module, ModuleResult, ValidationResult
from ..cache.records import PendingDoiBackfill

_OA_BATCH = 50            # OpenAlex openalex_id filter caps at 50 ids/call
_SELECT   = 'id,doi'


def _to_w(stored: str):
    """Stored oa_id string -> bare uppercase W-id (OA filter + result key form)."""
    if not stored:
        return None
    s = stored.strip()
    if s.startswith(('https://openalex.org/', 'http://openalex.org/')):
        s = s.rsplit('/', 1)[-1]
    return s.upper() or None


class ResolvePendingDois(Module):
    name        = 'resolve_pending_dois'
    description = 'Resolve OpenAlex DOIs for pending-citation endpoints so cross-source halves unify'

    requires    = {'pending_citations.discovered_at'}
    produces    = {'cache:pending_doi_backfill'}
    eventually  = {'pending_citations.cited_doi', 'pending_citations.citing_doi'}
    resources   = {'openalex_api'}

    # Endpoints lacking a DOI but known by OA id, on either side of the edge.
    _SCAN_SQL = """
        SELECT oid FROM (
            SELECT DISTINCT cited_oa_id AS oid FROM pending_citations
                WHERE cited_oa_id IS NOT NULL AND cited_doi IS NULL
            UNION
            SELECT DISTINCT citing_oa_id AS oid FROM pending_citations
                WHERE citing_oa_id IS NOT NULL AND citing_doi IS NULL
        )
    """

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        conn = ctx.connect(readonly=True)
        try:
            row = conn.execute(self._SCAN_SQL + " LIMIT 1").fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(ok=False, missing=['pending_citations.cited_oa_id'],
                                    message='No OA-only pending endpoints to resolve')
        return ValidationResult(ok=True)

    def run(self, ctx):
        client  = OpenAlexClient()
        limit   = ctx.config.get('resolve_pending_limit')
        verbose = ctx.config.get('verbose', False)

        conn = ctx.connect(readonly=True)
        try:
            stored_ids = [r[0] for r in conn.execute(self._SCAN_SQL).fetchall()]
        finally:
            conn.close()

        stats = {'scanned': len(stored_ids), 'batches': 0, 'resolved': 0,
                 'no_doi': 0, 'pushed': 0, 'budget_pauses': 0, 'errors': 0}
        print(f"  resolve_pending_dois: {len(stored_ids):,} OA-only endpoints to resolve")

        for start in range(0, len(stored_ids), _OA_BATCH):
            if ctx.shutdown.requested:
                print(f"  [shutdown] stopping after {stats['resolved']:,} resolved")
                break
            if limit and stats['resolved'] >= int(limit):
                break
            if client.breaker_open:
                stats['budget_pauses'] += 1
                bs = client.breaker_status()
                print(f"  [budget] OA budget hit (calls_today={bs.get('calls_today')}); stopping run")
                break   # not a looping daemon; the next run resumes the scan

            chunk = stored_ids[start:start + _OA_BATCH]
            # normalised W-id -> the stored string(s) that produced it
            norm_map: dict = defaultdict(list)
            for s in chunk:
                w = _to_w(s)
                if w:
                    norm_map[w].append(s)
            if not norm_map:
                continue
            try:
                works = client.fetch_batch_by_oa_id(list(norm_map.keys()), select=_SELECT)
                stats['batches'] += 1
            except Exception as e:
                stats['errors'] += 1
                if verbose:
                    print(f"  [batch] ERROR {type(e).__name__}: {str(e)[:80]}")
                continue

            backfills = []
            for w, work in works.items():
                doi = normalise_doi(work.get('doi') or '')
                if not doi:
                    stats['no_doi'] += 1
                    continue
                for stored in norm_map.get(w, []):
                    backfills.append(PendingDoiBackfill(oa_id=stored, doi=doi))
            stats['resolved'] += len(backfills)
            stats['pushed'] += ctx.cache.push_pending_doi_backfills(backfills)

        msg = (f"{stats['resolved']:,} DOIs resolved across {stats['batches']:,} "
               f"OA batches ({stats['no_doi']:,} works had no DOI)")
        print(f"  resolve_pending_dois: {msg}")
        return ModuleResult(status='success' if stats['resolved'] else 'noop',
                            message=msg, stats=stats)
