"""
resolve_dois_via_pmid — recover missing DOIs from PubMed IDs.

For each paper that has a PMID (collected by bulk_abstracts / bulk_papers)
but no DOI, ask NCBI eSummary for the article's DOI. PMID → DOI is an
exact mapping, so no fuzzy matching is needed — if NCBI returns a DOI we
take it.

The bulk pass populated 783K PMIDs; among those, ~5K papers still lack
a DOI. This module targets exactly that subset.

Design notes:
  * One-shot, not a producer-loop. The candidate set is small and fixed.
  * Uses the same claims DB pattern as other resolvers so re-runs skip
    PMIDs we've already processed (succeeded or failed).
  * Pushes through the merge cache so v3's normal first-write-wins +
    identifier-merge logic applies.
"""
from __future__ import annotations

from typing import Optional

from ..cache.records import PaperRecord
from ..clients.ncbi import NcbiClient, NCBI_BATCH_SIZE
from ..framework import Module, ModuleResult, ValidationResult


_SOURCE = 'ncbi_pmid'


class ResolveDoisViaPmid(Module):
    name        = 'resolve_dois_via_pmid'
    description = 'Recover missing DOIs from PubMed IDs via NCBI eSummary'

    requires    = {'papers.pubmed_id'}
    produces    = {'cache:papers'}
    eventually  = {'papers.doi', 'papers.pubmed_central_id'}
    resources   = {'ncbi_api'}

    SERVICE     = 'ncbi_pmid'
    # NCBI accepts up to 200 PMIDs per request, but we claim slightly less
    # so a single claim batch ↔ a single NCBI call.
    CLAIM_BATCH = NCBI_BATCH_SIZE

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        from ..clients.ncbi import _get_api_key
        if not _get_api_key():
            return ValidationResult(
                ok=False, missing=['ENTREZ_api'],
                message='ENTREZ_api not set in .env',
            )
        conn = ctx.connect(readonly=True)
        try:
            row = conn.execute("""
                SELECT 1 FROM papers
                WHERE pubmed_id IS NOT NULL
                  AND doi IS NULL
                  AND is_rejected = 0
                LIMIT 1
            """).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(
                ok=False, missing=['papers.pubmed_id'],
                message='No PMID-having, no-DOI papers to resolve',
            )
        return ValidationResult(ok=True)

    def run(self, ctx) -> ModuleResult:
        import time as _time
        from ..framework.claims import request_claim, report_marks

        client = NcbiClient()
        verbose = ctx.config.get('verbose', False)
        limit   = ctx.config.get('resolve_dois_limit')

        stats = {
            'total':         0,
            'batches':       0,
            'doi_recovered': 0,
            'pmcid_filled':  0,
            'no_record':     0,
            'no_doi':        0,
            'errors':        0,
        }

        print(f"  resolve_dois_via_pmid: claim_batch={self.CLAIM_BATCH}, "
              f"auth={bool(client.api_key)}")

        consecutive_empty = 0
        while True:
            if ctx.shutdown.requested:
                print("  [shutdown] aborting")
                break
            if limit and stats['doi_recovered'] >= int(limit):
                print(f"  [limit] {limit} reached")
                break

            rows = request_claim(ctx.cache, self.name,
                                 batch_size=self.CLAIM_BATCH,
                                 timeout_s=30.0)
            if not rows:
                consecutive_empty += 1
                # The writer may simply be busy on a different module's
                # request — give it a few tries before declaring done.
                if consecutive_empty >= 3:
                    print("  [done] no candidates left")
                    break
                continue
            consecutive_empty = 0

            # Map PMID → (paper_id, s2_id) so we can match NCBI's response
            # back to our paper rows. Skip rows with no PMID just in case.
            pmid_to_row: dict[str, tuple[int, Optional[str]]] = {}
            for r in rows:
                pmid = (r['pubmed_id'] or '').strip()
                if pmid:
                    pmid_to_row[pmid] = (r['id'], r['s2_id'])

            if not pmid_to_row:
                # All claimed rows lacked usable PMIDs — mark them all failed
                # so they don't get re-claimed.
                report_marks(ctx.cache, self.name, [], [(r['id'], '_all') for r in rows])
                continue

            t_req = _time.time()
            try:
                resolved = client.summary_by_pmid(list(pmid_to_row.keys()))
                stats['batches'] += 1
            except Exception as e:
                stats['errors'] += len(pmid_to_row)
                if verbose:
                    print(f"  [batch {stats['batches']+1}] ERROR "
                          f"{type(e).__name__}: {str(e)[:80]}")
                # Don't mark — let the claim TTL expire so a retry can run.
                continue
            req_ms = (_time.time() - t_req) * 1000

            succeeded_ids: list[int] = []
            failed_ids:    list[int] = []
            batch_doi_recovered = 0
            batch_pmcid_filled  = 0

            for pmid, (pid, s2_id) in pmid_to_row.items():
                info = resolved.get(pmid)
                if not info:
                    stats['no_record'] += 1
                    failed_ids.append(pid)
                    continue
                doi = info.get('doi')
                pmcid = info.get('pmcid')
                if not doi:
                    # NCBI knew the PMID but had no DOI for it — still mark
                    # succeeded so we don't re-call NCBI for the same paper.
                    stats['no_doi'] += 1
                    if pmcid:
                        # We can still backfill the PMC ID.
                        ctx.cache.push_paper(PaperRecord(
                            source            = _SOURCE,
                            s2_id             = s2_id,
                            pubmed_id         = pmid,
                            pubmed_central_id = pmcid,
                        ))
                        stats['pmcid_filled'] += 1
                        batch_pmcid_filled += 1
                    succeeded_ids.append(pid)
                    continue
                # Got a DOI — push it through the merge cache. Use s2_id
                # as the lookup identifier; the merge writer's COALESCE
                # will add the DOI.
                ctx.cache.push_paper(PaperRecord(
                    source            = _SOURCE,
                    doi               = doi,
                    s2_id             = s2_id,
                    pubmed_id         = pmid,
                    pubmed_central_id = pmcid,
                ))
                stats['doi_recovered'] += 1
                batch_doi_recovered += 1
                if pmcid:
                    stats['pmcid_filled'] += 1
                    batch_pmcid_filled += 1
                succeeded_ids.append(pid)

            report_marks(ctx.cache, self.name,
                      [(i, '_all') for i in succeeded_ids],
                      [(i, '_all') for i in failed_ids])

            print(f"  [batch {stats['batches']:>4}] "
                  f"{len(pmid_to_row)} PMIDs → "
                  f"{batch_doi_recovered} DOIs, "
                  f"{batch_pmcid_filled} PMCIDs  "
                  f"({req_ms:.0f}ms)")

        stats['total'] = (stats['doi_recovered'] + stats['no_record']
                          + stats['no_doi'] + stats['errors'])
        return ModuleResult(
            status='success' if stats['doi_recovered'] else 'noop',
            message=(f"{stats['doi_recovered']:,} DOIs recovered "
                     f"({stats['pmcid_filled']:,} PMCIDs filled) "
                     f"across {stats['batches']:,} NCBI batches; "
                     f"{stats['no_doi']:,} had PMID but no DOI, "
                     f"{stats['no_record']:,} not found"),
            stats=stats,
        )

