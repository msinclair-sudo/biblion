"""
enrich_metadata_oa — batched metadata + references via OpenAlex.

For every paper with a DOI but missing metadata (abstract/year/authors/
venue/pub_type) or that hasn't been enriched recently, batch DOIs into
groups of 50 and call OpenAlex's `/works?filter=doi:X|Y|...` once per
batch. Push PaperRecord (with metadata) and CitationRecord (one per
referenced_works entry) into the cache.

This is the fast path. 50 papers per call; at OA's 5 RPS that's roughly
250 papers/second of throughput before the merge writer sees the data.
"""
import json
from typing import Optional

from ..clients.openalex import OpenAlexClient, normalise_doi, reconstruct_abstract
from ..cache.records import PaperRecord, CitationRecord
from ..framework import Module, ModuleResult, ValidationResult


_BATCH_SIZE = 50
_SELECT = (
    'id,doi,type,title,publication_year,authorships,'
    'primary_location,cited_by_count,abstract_inverted_index,referenced_works'
)

# Metadata fields this service can fill, tracked per-field by the claim flow.
# Must match the 'fields' tuple for enrich_metadata_oa in claims.py.
_SERVICE_FIELDS = ('abstract', 'authors', 'venue', 'year', 'pub_type')


def _present_fields(rec) -> set:
    """Which of _SERVICE_FIELDS did OpenAlex actually return for this paper?"""
    present = set()
    if rec.abstract:
        present.add('abstract')
    if rec.authors_json and rec.authors_json not in ('[]', 'null'):
        present.add('authors')
    if rec.venue:
        present.add('venue')
    if rec.year:
        present.add('year')
    if rec.pub_type:
        present.add('pub_type')
    return present


def _parse_to_record(work: dict, source: str) -> PaperRecord:
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
    )


def _citation_records(work: dict, source: str) -> list[CitationRecord]:
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


class EnrichMetadataOa(Module):
    name        = 'enrich_metadata_oa'
    description = 'Batched OpenAlex metadata + references for papers with a DOI'

    requires    = {'papers.doi'}
    produces    = {'cache:papers', 'cache:citations'}
    eventually  = {'papers.abstract', 'papers.year', 'papers.authors',
                   'papers.venue', 'papers.pub_type',
                   'citation_counts.openalex',
                   'citations.citing_id', 'citations.cited_id'}
    resources   = {'openalex_api'}

    batch_size  = _BATCH_SIZE

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        conn = ctx.connect(readonly=True)
        try:
            row = conn.execute("""
                SELECT 1 FROM papers
                WHERE doi IS NOT NULL
                  AND is_rejected = 0
                  AND (abstract IS NULL OR authors IS NULL OR venue IS NULL OR year IS NULL)
                LIMIT 1
            """).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(ok=False, missing=['papers.doi'],
                                    message='No DOI-having papers need enrichment')
        return ValidationResult(ok=True)

    SERVICE        = 'oa'
    IDLE_SLEEP_S   = 30
    MAX_IDLE_LOOPS = 5

    def run(self, ctx):
        import time as _time
        from ..framework.claims import request_claim, report_marks

        client = OpenAlexClient()
        source = 'oa_works_doi'

        limit   = ctx.config.get('enrich_metadata_limit')
        loop    = ctx.config.get('loop', False)
        verbose = ctx.config.get('verbose', False)

        stats = {'total': 0, 'batches': 0, 'found': 0,
                 'missing_from_oa': 0, 'edges_pushed': 0, 'errors': 0,
                 'idle_loops': 0, 'budget_pauses': 0}

        print(f"  enrich_metadata_oa: loop={loop}, limit={limit}, "
              f"batch={self.batch_size}")

        idle_loops = 0
        while True:
            if ctx.shutdown.requested:
                print(f"  [shutdown] stopping after {stats['found']} enriched")
                break
            if limit and stats['found'] >= int(limit):
                print(f"  [limit] {limit} reached")
                break

            # Daily budget exhausted → sleep until reset. Any in-flight
            # claims expire after 30 min via the framework's stuck-claim
            # sweep, so other services can pick them up.
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

            # Ask the writer for a batch.
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

            # Build the DOI → paper_id map for marking results
            doi_to_pid: dict[str, int] = {}
            for r in rows:
                d = normalise_doi(r['doi'])
                if d:
                    doi_to_pid[d] = r['id']

            t_req = _time.time()
            try:
                works = client.fetch_batch_by_doi(list(doi_to_pid.keys()), select=_SELECT)
                stats['batches'] += 1
            except Exception as e:
                stats['errors'] += len(doi_to_pid)
                # Leave 'claimed' — expiry will release for retry
                if verbose:
                    print(f"  [batch {stats['batches']+1}] ERROR {type(e).__name__}: "
                          f"{str(e)[:80]}")
                continue
            req_ms = (_time.time() - t_req) * 1000

            # Buffer per-(paper, field) outcomes; flush in one transaction at
            # the end so the claims-DB lock is held for milliseconds. Each
            # field claimed for a paper (per the grant's need_<field> flag) is
            # marked succeeded if OpenAlex returned a value, else failed (so we
            # don't re-spend until the retry interval — see config).
            need_map = {r['id']: r for r in rows}
            succeeded: list = []
            failed:    list = []
            batch_found, batch_refs = 0, 0
            for doi, pid in doi_to_pid.items():
                work = works.get(doi)
                grant = need_map.get(pid, {})
                claimed = [f for f in _SERVICE_FIELDS if grant.get(f'need_{f}')]
                if work is None:
                    stats['missing_from_oa'] += 1
                    # Paper absent from OA: every field we claimed failed.
                    failed += [(pid, f) for f in claimed]
                    continue
                rec = _parse_to_record(work, source)
                ctx.cache.push_paper(rec)
                refs = _citation_records(work, source)
                if refs:
                    ctx.cache.push_citations(refs)
                    stats['edges_pushed'] += len(refs)
                    batch_refs += len(refs)
                present = _present_fields(rec)
                for f in claimed:
                    (succeeded if f in present else failed).append((pid, f))
                stats['found'] += 1
                batch_found += 1

            report_marks(ctx.cache, self.name, succeeded, failed)

            print(f"  [batch {stats['batches']:>4}] {len(doi_to_pid)} DOIs → "
                  f"{batch_found} found, {batch_refs} edges  "
                  f"({req_ms:.0f}ms) | "
                  f"budget {client.breaker_status()['calls_today']}/{client.daily_budget}")

        stats['total'] = stats['found'] + stats['missing_from_oa'] + stats['errors']
        return ModuleResult(
            status='success' if stats['found'] else 'noop',
            message=(f"{stats['found']:,} papers enriched across "
                     f"{stats['batches']:,} OA batches; "
                     f"{stats['edges_pushed']:,} edges pushed"),
            stats=stats,
        )
