"""
enrich_metadata_s2 — Semantic Scholar batched metadata enrichment.

Mirrors enrich_metadata_oa but uses S2's POST /paper/batch endpoint (500 IDs
per call). Runs in parallel with the OA enrichment module; the
enrichment_attempts table prevents both services from spending budget on the
same paper.

Service identifier in enrichment_attempts: 's2_live'.

S2 returns references in the same call as metadata when 'references.externalIds'
is in the fields list, so we get citation edges for free.
"""
import json
from typing import Optional

from ..cache.records import PaperRecord, CitationRecord
from ..clients.semanticscholar import (
    SemanticScholarClient, _normalise_doi, S2_BATCH_SIZE,
)
from ..framework import Module, ModuleResult, ValidationResult


# Fields requested per paper. Keep tight to minimise response payload.
# Both references (outgoing: papers this work cites) and citations (incoming:
# papers that cite this work) come back in the same batch call — we build
# directed edges for both, identifier-only (no stub-paper metadata; an
# unknown endpoint parks in pending_citations until it arrives).
_S2_FIELDS = (
    'title,year,authors,venue,abstract,'
    'publicationTypes,fieldsOfStudy,externalIds,'
    'citationCount,referenceCount,'
    'references.externalIds,citations.externalIds'
)

# Metadata fields this service can fill, tracked per-field by the claim flow.
# Must match the 'fields' tuple for enrich_metadata_s2 in claims.py.
_SERVICE_FIELDS = ('abstract', 'authors', 'venue', 'year', 'pub_type')


def _present_fields(rec) -> set:
    """Which of _SERVICE_FIELDS did Semantic Scholar actually return?"""
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
    """Adapt an S2 paper record into v3's PaperRecord."""
    ext = work.get('externalIds') or {}
    doi   = _normalise_doi(ext.get('DOI') or '')
    s2_id = work.get('paperId') or None
    # S2 returns authors as [{'authorId': ..., 'name': '...'}].
    raw_authors = [a.get('name') for a in (work.get('authors') or []) if a.get('name')]
    authors_json = json.dumps(raw_authors) or None
    venue = work.get('venue') or None
    # S2's publicationTypes is a list of strings; flatten to one canonical first value.
    pub_types = work.get('publicationTypes') or []
    pub_type  = (pub_types[0].lower() if pub_types else None)
    return PaperRecord(
        source       = source,
        doi          = doi,
        s2_id        = s2_id,
        title        = work.get('title'),
        year         = work.get('year'),
        authors_json = authors_json,
        venue        = venue,
        abstract     = work.get('abstract'),
        pub_type     = pub_type,
        cit_count    = work.get('citationCount'),
        ref_count    = work.get('referenceCount'),
    )


def _citation_records(work: dict, source: str) -> list[CitationRecord]:
    """Directed edges for both directions, identifier-only (no metadata).

    references → this work CITES each ref  (this=citing, ref=cited)
    citations  → each citer CITES this work (citer=citing, this=cited)
    """
    ext = work.get('externalIds') or {}
    this_doi   = _normalise_doi(ext.get('DOI') or '')
    this_s2_id = work.get('paperId') or None
    if not (this_doi or this_s2_id):
        return []

    def _ids(node):
        nx = node.get('externalIds') or {}
        return _normalise_doi(nx.get('DOI') or ''), (node.get('paperId') or None)

    out = []
    # Outgoing: this work cites each reference.
    for ref in (work.get('references') or []):
        rd, rs = _ids(ref)
        if rd or rs:
            out.append(CitationRecord(
                source=source,
                citing_doi=this_doi, citing_s2_id=this_s2_id,
                cited_doi=rd, cited_s2_id=rs,
            ))
    # Incoming: each citer cites this work (reverse direction).
    for citer in (work.get('citations') or []):
        cd, cs = _ids(citer)
        if cd or cs:
            out.append(CitationRecord(
                source=source,
                citing_doi=cd, citing_s2_id=cs,
                cited_doi=this_doi, cited_s2_id=this_s2_id,
            ))
    return out


class EnrichMetadataS2(Module):
    name        = 'enrich_metadata_s2'
    description = 'Batched Semantic Scholar metadata + references for papers with a DOI'

    requires    = {'papers.doi'}
    produces    = {'cache:papers', 'cache:citations'}
    eventually  = {'papers.abstract', 'papers.year', 'papers.authors',
                   'papers.venue', 'papers.pub_type',
                   'citation_counts.s2',
                   'citations.citing_id', 'citations.cited_id'}
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
                WHERE doi IS NOT NULL
                  AND is_rejected = 0
                  AND (abstract IS NULL OR authors IS NULL
                       OR venue IS NULL OR year IS NULL)
                LIMIT 1
            """).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(ok=False, missing=['papers.doi'],
                                    message='No DOI-having papers need enrichment')
        return ValidationResult(ok=True)

    def run(self, ctx):
        import time as _time
        from ..framework.claims import request_claim, report_marks

        client = SemanticScholarClient()
        source = 's2_batch'

        limit   = ctx.config.get('enrich_metadata_limit')
        loop    = ctx.config.get('loop', False)
        verbose = ctx.config.get('verbose', False)

        stats = {'total': 0, 'batches': 0, 'found': 0,
                 'missing_from_s2': 0, 'edges_pushed': 0, 'errors': 0,
                 'idle_loops': 0, 'budget_pauses': 0}

        print(f"  enrich_metadata_s2: loop={loop}, limit={limit}, "
              f"batch={self.batch_size}, auth={bool(client.api_key)}")

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
                print(f"  [breaker] S2 cooling off ({bs['consecutive_429']}× 429s); "
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

            doi_to_pid: dict[str, int] = {}
            for r in rows:
                d = _normalise_doi(r['doi'])
                if d:
                    doi_to_pid[d] = r['id']

            t_req = _time.time()
            try:
                works = client.fetch_batch_by_doi(list(doi_to_pid.keys()),
                                                  fields=_S2_FIELDS)
                stats['batches'] += 1
            except Exception as e:
                stats['errors'] += len(doi_to_pid)
                if verbose:
                    print(f"  [batch {stats['batches']+1}] ERROR {type(e).__name__}: "
                          f"{str(e)[:80]}")
                continue
            req_ms = (_time.time() - t_req) * 1000

            need_map = {r['id']: r for r in rows}
            succeeded: list = []
            failed:    list = []
            batch_found, batch_refs = 0, 0
            for doi, pid in doi_to_pid.items():
                work = works.get(doi)
                grant = need_map.get(pid, {})
                claimed = [f for f in _SERVICE_FIELDS if grant.get(f'need_{f}')]
                if work is None:
                    stats['missing_from_s2'] += 1
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
                  f"calls_today={client.breaker_status()['calls_today']}")

        stats['total'] = stats['found'] + stats['missing_from_s2'] + stats['errors']
        return ModuleResult(
            status='success' if stats['found'] else 'noop',
            message=(f"{stats['found']:,} papers enriched across "
                     f"{stats['batches']:,} S2 batches; "
                     f"{stats['edges_pushed']:,} edges pushed"),
            stats=stats,
        )
