"""
resolve_dois_s2 — title-search DOI resolution via Semantic Scholar.

For each paper with a title but no DOI, query S2's /paper/search endpoint
and accept matches above a similarity threshold. Push the resolved paper
(with full metadata + references) into the cache.

Mirrors resolve_dois_oa but on S2's per-paper search endpoint. Runs in
parallel with OA via the enrichment_attempts claim coordination.
"""
from difflib import SequenceMatcher
from typing import Optional

from .enrich_metadata_s2 import _parse_to_record, _citation_records, _S2_FIELDS
from ..clients.semanticscholar import SemanticScholarClient, _normalise_doi
from ..framework import Module, ModuleResult, ValidationResult


_DEFAULT_THRESHOLD = 0.85
_TOP_K = 3


def _title_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


class ResolveDoisS2(Module):
    name        = 'resolve_dois_s2'
    description = 'Resolve missing DOIs via Semantic Scholar title search'

    requires    = {'papers.title'}
    produces    = {'cache:papers', 'cache:citations'}
    eventually  = {'papers.doi',
                   'papers.abstract', 'papers.year', 'papers.authors',
                   'papers.venue', 'papers.pub_type',
                   'citations.citing_id', 'citations.cited_id'}
    resources   = {'s2_api'}

    SERVICE        = 's2_live'
    CLAIM_BATCH    = 50           # smaller than enrich; each call is sequential
    threshold      = _DEFAULT_THRESHOLD
    top_k          = _TOP_K
    IDLE_SLEEP_S   = 30
    MAX_IDLE_LOOPS = 5

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        conn = ctx.connect(readonly=True)
        try:
            row = conn.execute("""
                SELECT 1 FROM papers
                WHERE doi IS NULL AND title IS NOT NULL AND is_rejected = 0
                LIMIT 1
            """).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(ok=False, missing=['papers.title'],
                                    message='No papers with title-and-no-DOI to resolve')
        return ValidationResult(ok=True)

    def run(self, ctx):
        import time as _time
        from ..framework.claims import request_claim, report_marks

        client = SemanticScholarClient()
        source = 's2_search'

        limit   = ctx.config.get('resolve_dois_limit')
        loop    = ctx.config.get('loop', False)
        verbose = ctx.config.get('verbose', False)

        stats = {'total': 0, 'resolved': 0, 'no_match': 0,
                 'low_conf': 0, 'errors': 0, 'edges_pushed': 0,
                 'claim_batches': 0, 'idle_loops': 0, 'budget_pauses': 0}

        print(f"  resolve_dois_s2: loop={loop}, limit={limit}, "
              f"claim_batch={self.CLAIM_BATCH}, threshold={self.threshold}, "
              f"auth={bool(client.api_key)}")

        idle_loops = 0
        while True:
            if ctx.shutdown.requested:
                break
            if limit and stats['resolved'] >= int(limit):
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
                                 batch_size=self.CLAIM_BATCH,
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
            stats['claim_batches'] += 1

            succeeded_ids: list[int] = []
            failed_ids:    list[int] = []
            for row in rows:
                if ctx.shutdown.requested or client.breaker_open:
                    break
                paper_id, title, year = row['id'], row['title'], row['year']
                t_req = _time.time()
                try:
                    results = client.search_by_title(
                        title, year=year, top_k=self.top_k, fields=_S2_FIELDS,
                    ) or []
                except Exception as e:
                    stats['errors'] += 1
                    if verbose:
                        print(f"  [{paper_id}] ERROR {type(e).__name__}: "
                              f"{str(e)[:80]}")
                    continue
                req_ms = (_time.time() - t_req) * 1000

                if not results:
                    stats['no_match'] += 1
                    failed_ids.append(paper_id)
                    if verbose:
                        print(f"  [{paper_id}] no_match  ({req_ms:.0f}ms) "
                              f"title={title[:60]!r}")
                    continue

                best_sim, best = 0.0, None
                for w in results:
                    sim = _title_similarity(title, w.get('title') or '')
                    if sim > best_sim:
                        best_sim, best = sim, w
                if best_sim < self.threshold or best is None:
                    stats['low_conf'] += 1
                    failed_ids.append(paper_id)
                    if verbose:
                        print(f"  [{paper_id}] low_conf  ({req_ms:.0f}ms) "
                              f"sim={best_sim:.2f} title={title[:60]!r}")
                    continue

                ctx.cache.push_paper(_parse_to_record(best, source))
                cit_records = _citation_records(best, source)
                if cit_records:
                    ctx.cache.push_citations(cit_records)
                    stats['edges_pushed'] += len(cit_records)
                succeeded_ids.append(paper_id)
                stats['resolved'] += 1
                if verbose:
                    print(f"  [{paper_id}] resolved  ({req_ms:.0f}ms) "
                          f"sim={best_sim:.2f} +{len(cit_records)} cits")

            report_marks(ctx.cache, self.name,
                          [(i, '_all') for i in succeeded_ids],
                          [(i, '_all') for i in failed_ids])

            print(f"  [batch {stats['claim_batches']:>4}] "
                  f"resolved={stats['resolved']} "
                  f"low_conf={stats['low_conf']} "
                  f"no_match={stats['no_match']} "
                  f"err={stats['errors']} | "
                  f"calls_today={client.breaker_status()['calls_today']}")

        stats['total'] = (stats['resolved'] + stats['low_conf']
                          + stats['no_match'] + stats['errors'])
        return ModuleResult(
            status='success' if stats['resolved'] else 'noop',
            message=(f"{stats['resolved']:,} DOIs resolved across "
                     f"{stats['claim_batches']} batches; "
                     f"{stats['edges_pushed']:,} edges pushed"),
            stats=stats,
        )
