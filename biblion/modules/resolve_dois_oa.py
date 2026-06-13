"""
resolve_dois_oa — title-search DOI resolution via OpenAlex.

For every paper with a title but no DOI, query OpenAlex by title
(optionally filtered by year), fuzzy-match the top results against ours,
and push a PaperRecord carrying the resolved DOI + full metadata + any
referenced_works as CitationRecords.

This is the slow path (one request per candidate — search cannot be
batched). Runs before resolve_dois_oa so any DOIs it finds are available
to the batched enrichment pass that follows.
"""
import json
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Optional

from ..clients.openalex import (
    OpenAlexClient, normalise_doi, reconstruct_abstract, parse_biblio,
)
from ..cache.records import PaperRecord, CitationRecord
from ..framework import Module, ModuleResult, ValidationResult


_DEFAULT_THRESHOLD = 0.85
_TOP_K = 3
_SELECT = (
    'id,doi,type,title,publication_year,authorships,'
    'primary_location,cited_by_count,abstract_inverted_index,referenced_works,'
    'biblio,language,ids,publication_date,is_retracted'
)


def _title_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def _parse_to_record(work: dict, source: str) -> PaperRecord:
    """Adapt an OpenAlex work record into a PaperRecord."""
    oa_id_raw = (work.get('id') or '').replace('https://openalex.org/', '') or None
    raw_authors = [
        a.get('author', {}).get('display_name', '')
        for a in (work.get('authorships') or [])
    ]
    authors_json = json.dumps([a for a in raw_authors if a]) or None
    loc = work.get('primary_location') or {}
    venue = (loc.get('source') or {}).get('display_name') or None
    return PaperRecord(
        source       = source,
        doi          = normalise_doi(work.get('doi') or ''),
        oa_id        = oa_id_raw,
        title        = work.get('title'),
        year         = work.get('publication_year'),
        authors_json = authors_json,
        venue        = venue,
        abstract     = reconstruct_abstract(work.get('abstract_inverted_index')),
        pub_type     = (work.get('type') or '').lower() or None,
        cit_count    = work.get('cited_by_count'),
        **parse_biblio(work),
    )


def _citation_records(work: dict, source: str) -> list[CitationRecord]:
    """Turn referenced_works into CitationRecords (citing identified by DOI)."""
    citing_doi = normalise_doi(work.get('doi') or '')
    citing_oa  = (work.get('id') or '').replace('https://openalex.org/', '') or None
    if not (citing_doi or citing_oa):
        return []
    out = []
    for ref_url in work.get('referenced_works') or []:
        ref_oa = ref_url.replace('https://openalex.org/', '') if ref_url else None
        if ref_oa:
            out.append(CitationRecord(
                source       = source,
                citing_doi   = citing_doi,
                citing_oa_id = citing_oa,
                cited_oa_id  = ref_oa,
            ))
    return out


class ResolveDoisOa(Module):
    name        = 'resolve_dois_oa'
    description = 'Resolve missing DOIs via OpenAlex title search (sequential)'

    requires    = {'papers.title'}
    produces    = {'cache:papers', 'cache:citations'}
    eventually  = {'papers.doi',
                   'papers.abstract', 'papers.year', 'papers.authors',
                   'papers.venue', 'papers.pub_type',
                   'citations.citing_id', 'citations.cited_id'}
    resources   = {'openalex_api'}

    threshold   = _DEFAULT_THRESHOLD
    top_k       = _TOP_K

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

    SERVICE      = 'oa'
    CLAIM_BATCH  = 100
    IDLE_SLEEP_S = 30          # nothing to do → check again in this many seconds
    MAX_IDLE_LOOPS = 5         # after N consecutive empties, return 'noop' / 'success'

    def run(self, ctx):
        import time as _time
        from ..framework.claims import request_claim, report_marks

        client = OpenAlexClient()
        source = 'oa_works_search'

        limit         = ctx.config.get('resolve_dois_limit')
        loop          = ctx.config.get('loop', False)
        verbose       = ctx.config.get('verbose', False)

        stats = {'total': 0, 'resolved': 0, 'no_match': 0,
                 'low_conf': 0, 'errors': 0, 'edges_pushed': 0,
                 'claim_batches': 0, 'idle_loops': 0, 'budget_pauses': 0}

        print(f"  resolve_dois_oa: loop={loop}, limit={limit}, "
              f"claim_batch={self.CLAIM_BATCH}, threshold={self.threshold}")

        idle_loops = 0
        while True:
            if ctx.shutdown.requested:
                print(f"  [shutdown] stopping after {stats['resolved']} resolved")
                break
            if limit and stats['resolved'] >= int(limit):
                print(f"  [limit] {limit} reached")
                break

            # Daily budget exhausted → sleep until reset. In-flight claims
            # expire naturally via the framework's stuck-claim sweep.
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

            # Process each claimed paper — buffer outcomes, flush at end.
            succeeded_ids: list[int] = []
            failed_ids:    list[int] = []
            for row in rows:
                if ctx.shutdown.requested or client.breaker_open:
                    # Leave the rest as 'claimed' — they'll expire and be
                    # re-pickable by either service.
                    break
                paper_id = row['id']
                title    = row['title']
                year     = row['year']
                t_req = _time.time()
                try:
                    results = client.search_by_title(
                        title, year=year,
                        top_k=self.top_k, select=_SELECT,
                    ) or []
                except Exception as e:
                    stats['errors'] += 1
                    if verbose:
                        print(f"  [{paper_id}] ERROR {type(e).__name__}: {str(e)[:80]}")
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

            # Per-batch summary
            print(f"  [batch {stats['claim_batches']:>4}] "
                  f"resolved={stats['resolved']} "
                  f"low_conf={stats['low_conf']} "
                  f"no_match={stats['no_match']} "
                  f"err={stats['errors']} | "
                  f"budget {client.breaker_status()['calls_today']}/{client.daily_budget}")

        stats['total'] = (stats['resolved'] + stats['low_conf'] +
                          stats['no_match'] + stats['errors'])
        return ModuleResult(
            status='success' if stats['resolved'] else 'noop',
            message=(f"{stats['resolved']:,} DOIs resolved across "
                     f"{stats['claim_batches']} batches; "
                     f"{stats['edges_pushed']:,} edges pushed"),
            stats=stats,
        )
