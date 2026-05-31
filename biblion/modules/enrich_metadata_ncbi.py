"""
enrich_metadata_ncbi — PubMed abstracts via NCBI E-utilities.

Targets papers that are missing an abstract (or title/year) and are reachable
in PubMed: either they already carry a `pubmed_id`, or they have a DOI we can
resolve to a PMID via esearch. We then efetch the PubMed record and push the
abstract + title/year back through the cache.

This is the third metadata source alongside OpenAlex and Semantic Scholar.
PubMed often has abstracts the other two lack (publisher-deposit gaps), so it
fills the per-field abstract holes left after OA/S2 have run. Per-field claim
tracking (service='ncbi') means a paper stays eligible for NCBI's abstract
even after OA/S2 succeeded on its other fields.
"""
from typing import Optional

from ..clients.ncbi import NcbiClient
from ..cache.records import PaperRecord
from ..framework import Module, ModuleResult, ValidationResult


_BATCH_SIZE = 100

# Metadata fields this service can fill (efetch returns these). Must match the
# 'fields' tuple for enrich_metadata_ncbi in claims.py.
_SERVICE_FIELDS = ('abstract', 'title', 'year')


def _present_fields(rec: PaperRecord) -> set:
    present = set()
    if rec.abstract:
        present.add('abstract')
    if rec.title:
        present.add('title')
    if rec.year:
        present.add('year')
    return present


def _to_record(pmid: str, info: dict, source: str) -> PaperRecord:
    # Harvest every identifier efetch returned — pmid, pmcid, doi — not just
    # the abstract. Each ID is another handle for requesting metadata later;
    # the merge writer COALESCEs any the paper was missing.
    return PaperRecord(
        source            = source,
        doi               = info.get('doi'),
        pubmed_id         = pmid,
        pubmed_central_id = info.get('pmcid'),
        title             = info.get('title'),
        year              = info.get('year'),
        abstract          = info.get('abstract'),
    )


class EnrichMetadataNcbi(Module):
    name        = 'enrich_metadata_ncbi'
    description = 'PubMed abstracts via NCBI E-utilities (efetch), DOI- or PMID-keyed'

    requires    = {'papers.pubmed_id'}
    produces    = {'cache:papers'}
    eventually  = {'papers.abstract', 'papers.title', 'papers.year'}
    resources   = {'ncbi_api'}

    SERVICE        = 'ncbi'
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
                WHERE abstract IS NULL
                  AND is_rejected = 0
                  AND (pubmed_id IS NOT NULL OR doi IS NOT NULL)
                LIMIT 1
            """).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(ok=False, missing=['papers.pubmed_id'],
                                    message='No PubMed-reachable papers need an abstract')
        return ValidationResult(ok=True)

    def run(self, ctx):
        import time as _time
        from ..framework.claims import request_claim, report_marks

        client = NcbiClient()
        source = 'ncbi_efetch'

        limit   = ctx.config.get('enrich_metadata_limit')
        loop    = ctx.config.get('loop', False)
        verbose = ctx.config.get('verbose', False)

        stats = {'total': 0, 'batches': 0, 'found': 0, 'doi_resolved': 0,
                 'missing_from_pubmed': 0, 'errors': 0, 'idle_loops': 0}

        print(f"  enrich_metadata_ncbi: loop={loop}, limit={limit}, "
              f"batch={self.batch_size}, auth={bool(client.api_key)}")

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
            # Split: papers with a PMID go straight to efetch; DOI-only papers
            # need a DOI->PMID esearch first.
            pmid_to_pid: dict[str, int] = {}
            doi_only: dict[str, int] = {}   # doi -> paper_id
            for r in rows:
                pid = r['id']
                pmid = (r['pubmed_id'] or '').strip() if r['pubmed_id'] else None
                if pmid:
                    pmid_to_pid[pmid] = pid
                elif r['doi']:
                    doi_only[r['doi']] = pid

            try:
                if doi_only:
                    resolved = client.pmids_for_dois(list(doi_only.keys()))
                    for doi, pmid in resolved.items():
                        pmid_to_pid.setdefault(pmid, doi_only[doi])
                        stats['doi_resolved'] += 1
                fetched = client.fetch_abstracts_by_pmid(list(pmid_to_pid.keys())) \
                    if pmid_to_pid else {}
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
            # A paper "claimed" only the fields that were wanted-NULL for it.
            for pmid, pid in pmid_to_pid.items():
                grant = need_map.get(pid, {})
                claimed = [f for f in _SERVICE_FIELDS if grant.get(f'need_{f}')]
                info = fetched.get(pmid)
                if info is None:
                    stats['missing_from_pubmed'] += 1
                    failed += [(pid, f) for f in claimed]
                    continue
                rec = _to_record(pmid, info, source)
                ctx.cache.push_paper(rec)
                present = _present_fields(rec)
                for f in claimed:
                    (succeeded if f in present else failed).append((pid, f))
                stats['found'] += 1
                batch_found += 1

            # Papers we never got a PMID for (DOI didn't resolve) — mark their
            # claimed fields failed so we don't re-spend on them immediately.
            resolved_pids = set(pmid_to_pid.values())
            for r in rows:
                if r['id'] in resolved_pids:
                    continue
                grant = need_map.get(r['id'], {})
                failed += [(r['id'], f) for f in _SERVICE_FIELDS
                           if grant.get(f'need_{f}')]

            report_marks(ctx.cache, self.name, succeeded, failed)
            print(f"  [batch {stats['batches']:>4}] {len(rows)} papers → "
                  f"{batch_found} enriched "
                  f"({stats['doi_resolved']} via DOI→PMID) | "
                  f"calls={client.status()['calls']}")

        stats['total'] = stats['found'] + stats['missing_from_pubmed'] + stats['errors']
        return ModuleResult(
            status='success' if stats['found'] else 'noop',
            message=(f"{stats['found']:,} papers enriched from PubMed across "
                     f"{stats['batches']:,} batches "
                     f"({stats['doi_resolved']:,} reached via DOI→PMID)"),
            stats=stats,
        )
