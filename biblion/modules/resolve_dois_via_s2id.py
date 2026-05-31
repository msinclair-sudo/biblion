"""
resolve_dois_via_s2id — recover DOIs for papers that we know only by S2 ID.

Many papers entered the corpus via S2 references with a paperId but no DOI.
S2 *does* know the DOI for most of them — we just need to ask. This module
sends batches of 500 S2 paperIds to /paper/batch, requesting externalIds
(which includes DOI when S2 has it) plus all the usual metadata. One call,
many DOIs recovered.

Much faster than title-search resolution for these papers — and unlike
title-search, the match is exact (paperId is unambiguous), so no fuzzy
threshold to worry about.

Service identifier: 's2_live' (shares budget pool with the other S2
producers; if S2 is rate-limited, all three modules cool off together).
"""
from .enrich_metadata_s2 import _parse_to_record, _citation_records, _S2_FIELDS
from ..clients.semanticscholar import SemanticScholarClient, S2_BATCH_SIZE
from ..framework import Module, ModuleResult, ValidationResult


class ResolveDoisViaS2Id(Module):
    name        = 'resolve_dois_via_s2id'
    description = 'Recover DOIs via S2 batch lookup keyed by S2 paperId'

    requires    = {'papers.s2_id'}
    produces    = {'cache:papers', 'cache:citations'}
    eventually  = {'papers.doi', 'papers.abstract', 'papers.year',
                   'papers.authors', 'papers.venue', 'papers.pub_type',
                   'citations.citing_id', 'citations.cited_id',
                   'citation_counts.s2'}
    resources   = {'s2_api'}

    SERVICE        = 's2_live'
    batch_size     = S2_BATCH_SIZE
    IDLE_SLEEP_S   = 30
    MAX_IDLE_LOOPS = 5

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        conn = ctx.connect(readonly=True)
        try:
            row = conn.execute("""
                SELECT 1 FROM papers
                WHERE doi IS NULL
                  AND s2_id IS NOT NULL
                  AND is_rejected = 0
                LIMIT 1
            """).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(ok=False, missing=['papers.s2_id'],
                                    message='No papers with s2_id-but-no-doi')
        return ValidationResult(ok=True)

    def run(self, ctx):
        import time as _time
        from ..framework.claims import request_claim, report_marks

        client = SemanticScholarClient()
        source = 's2_batch_via_s2id'

        limit   = ctx.config.get('resolve_dois_limit') or ctx.config.get('enrich_metadata_limit')
        loop    = ctx.config.get('loop', False)
        verbose = ctx.config.get('verbose', False)

        stats = {'total': 0, 'batches': 0, 'doi_found': 0, 'no_doi': 0,
                 'missing_from_s2': 0, 'edges_pushed': 0, 'errors': 0,
                 'idle_loops': 0, 'budget_pauses': 0}

        print(f"  resolve_dois_via_s2id: loop={loop}, limit={limit}, "
              f"batch={self.batch_size}, auth={bool(client.api_key)}")

        idle_loops = 0
        while True:
            if ctx.shutdown.requested:
                break
            if limit and (stats['doi_found'] + stats['no_doi']) >= int(limit):
                print(f"  [limit] {limit} reached")
                break

            if client.breaker_open:
                bs = client.breaker_status()
                wait = max(60, bs.get('open_for_s') or 0) + 5
                stats['budget_pauses'] += 1
                print(f"  [breaker] S2 cooling off; sleeping {wait}s")
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

            # Map S2 paperId → our paper_id for marking results
            s2id_to_pid: dict[str, int] = {}
            for r in rows:
                s2 = (r['s2_id'] or '').strip()
                if s2:
                    s2id_to_pid[s2] = r['id']

            t_req = _time.time()
            try:
                # S2 batch endpoint accepts raw paperIds (no DOI: prefix needed).
                results = client.fetch_batch_by_id(
                    list(s2id_to_pid.keys()), fields=_S2_FIELDS,
                )
                stats['batches'] += 1
            except Exception as e:
                stats['errors'] += len(s2id_to_pid)
                if verbose:
                    print(f"  [batch {stats['batches']+1}] ERROR {type(e).__name__}: "
                          f"{str(e)[:80]}")
                continue
            req_ms = (_time.time() - t_req) * 1000

            # results is a list parallel to the IDs we sent. Build s2id → record map.
            by_s2id: dict[str, dict] = {}
            if results:
                for s2id, rec in zip(s2id_to_pid.keys(), results):
                    if rec:
                        by_s2id[s2id] = rec

            succeeded_ids: list[int] = []
            failed_ids:    list[int] = []
            batch_doi_found, batch_refs = 0, 0
            for s2id, pid in s2id_to_pid.items():
                rec = by_s2id.get(s2id)
                if rec is None:
                    stats['missing_from_s2'] += 1
                    failed_ids.append(pid)
                    continue
                paper_rec = _parse_to_record(rec, source)
                ctx.cache.push_paper(paper_rec)
                # Count whether this attempt actually yielded a DOI
                if paper_rec.doi:
                    stats['doi_found'] += 1
                    batch_doi_found += 1
                    succeeded_ids.append(pid)
                else:
                    # S2 knew the paper but had no DOI for it. We still wrote
                    # the metadata via the push, but for "resolve DOI" purposes
                    # this is a failure from this service.
                    stats['no_doi'] += 1
                    failed_ids.append(pid)
                refs = _citation_records(rec, source)
                if refs:
                    ctx.cache.push_citations(refs)
                    stats['edges_pushed'] += len(refs)
                    batch_refs += len(refs)

            report_marks(ctx.cache, self.name,
                          [(i, '_all') for i in succeeded_ids],
                          [(i, '_all') for i in failed_ids])

            print(f"  [batch {stats['batches']:>4}] {len(s2id_to_pid)} S2 IDs → "
                  f"{batch_doi_found} DOIs found ({stats['no_doi']:,} no-doi), "
                  f"{batch_refs} edges  ({req_ms:.0f}ms) | "
                  f"calls_today={client.breaker_status()['calls_today']}")

        stats['total'] = (stats['doi_found'] + stats['no_doi'] +
                          stats['missing_from_s2'] + stats['errors'])
        return ModuleResult(
            status='success' if stats['doi_found'] else 'noop',
            message=(f"{stats['doi_found']:,} DOIs recovered via S2 ID across "
                     f"{stats['batches']:,} S2 batches; "
                     f"{stats['edges_pushed']:,} edges pushed"),
            stats=stats,
        )
