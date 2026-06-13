"""
enrich_biblio_crossref — publisher-deposited bibliographic detail via Crossref.

Targets DOI'd papers still missing the structured detail OpenAlex/Semantic
Scholar rarely expose: volume, page range, publisher (plus issue, ISBN/ISSN,
container title, editors as a bonus). Batches DOIs into Crossref's filter
endpoint and pushes a PaperRecord per hit back through the cache.

Crossref is trust-rank 1 (db._SOURCE_TRUST_SEED), so its authoritative fields
win resolution against OA/S2. Per-field claim tracking (service='crossref')
keeps a paper eligible here for its volume even after OA filled its abstract.
"""
from ..clients.crossref import CrossrefClient, parse_work
from ..cache.records import PaperRecord
from ..framework import Module, ModuleResult, ValidationResult


_BATCH_SIZE = 20

# Fields gating this service's claims. Must match the 'fields' tuple for
# enrich_biblio_crossref in claims.py.
_SERVICE_FIELDS = ('volume', 'first_page', 'publisher')


def _present_fields(rec: PaperRecord) -> set:
    present = set()
    if rec.volume:
        present.add('volume')
    if rec.first_page:
        present.add('first_page')
    if rec.publisher:
        present.add('publisher')
    return present


def _to_record(work: dict, source: str) -> PaperRecord:
    return PaperRecord(source=source, **parse_work(work))


class EnrichBiblioCrossref(Module):
    name        = 'enrich_biblio_crossref'
    description = ('Volume / pages / publisher (+ ISBN/ISSN) via Crossref for '
                  'DOI-bearing papers missing publisher-deposited detail')

    requires    = {'papers.doi'}
    produces    = {'cache:papers'}
    eventually  = {'papers.volume', 'papers.first_page', 'papers.publisher'}
    resources   = {'crossref_api'}

    SERVICE        = 'crossref'
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
                WHERE doi IS NOT NULL AND is_rejected = 0
                  AND (volume IS NULL OR first_page IS NULL OR publisher IS NULL)
                LIMIT 1
            """).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(
                ok=False, missing=['papers.doi'],
                message='No DOI papers need Crossref biblio detail')
        return ValidationResult(ok=True)

    def run(self, ctx):
        import time as _time
        from ..framework.claims import request_claim, report_marks

        client = CrossrefClient()
        source = 'crossref_works'

        limit   = ctx.config.get('enrich_metadata_limit')
        loop    = ctx.config.get('loop', False)
        verbose = ctx.config.get('verbose', False)

        stats = {'total': 0, 'batches': 0, 'found': 0, 'missing': 0,
                 'errors': 0, 'idle_loops': 0}

        print(f"  enrich_biblio_crossref: loop={loop}, limit={limit}, "
              f"batch={self.batch_size}, mailto={bool(client.mailto)}")

        idle_loops = 0
        while True:
            if ctx.shutdown.requested:
                break
            if limit and stats['found'] >= int(limit):
                print(f"  [limit] {limit} reached")
                break

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

            need_map = {r['id']: r for r in rows}
            doi_to_pid = {r['doi']: r['id'] for r in rows if r['doi']}

            try:
                fetched = client.fetch_batch_by_doi(list(doi_to_pid.keys()))
                stats['batches'] += 1
            except Exception as e:
                stats['errors'] += len(rows)
                if verbose:
                    print(f"  [batch {stats['batches']+1}] ERROR "
                          f"{type(e).__name__}: {str(e)[:80]}")
                continue

            succeeded: list = []
            failed:    list = []
            batch_found = 0
            for doi, pid in doi_to_pid.items():
                grant = need_map.get(pid, {})
                claimed = [f for f in _SERVICE_FIELDS if grant.get(f'need_{f}')]
                work = fetched.get(doi)
                if work is None:
                    stats['missing'] += 1
                    failed += [(pid, f) for f in claimed]
                    continue
                rec = _to_record(work, source)
                ctx.cache.push_paper(rec)
                present = _present_fields(rec)
                for f in claimed:
                    (succeeded if f in present else failed).append((pid, f))
                stats['found'] += 1
                batch_found += 1

            report_marks(ctx.cache, self.name, succeeded, failed)
            print(f"  [batch {stats['batches']:>4}] {len(rows)} papers → "
                  f"{batch_found} enriched | calls={client._calls}")

        stats['total'] = stats['found'] + stats['missing'] + stats['errors']
        return ModuleResult(
            status='success' if stats['found'] else 'noop',
            message=(f"{stats['found']:,} papers enriched from Crossref across "
                     f"{stats['batches']:,} batches"),
            stats=stats,
        )
