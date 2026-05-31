"""
expand_papers_s2 — S2 citation hop.

For each target paper, fetch its outgoing references AND incoming
citations via Semantic Scholar's batch endpoint. Push every discovered
paper (as a stub PaperRecord) and every edge (as a CitationRecord)
through the cache. The merge writer dedups against the existing corpus;
the pending_resolver promotes edges as both endpoints land.

Carried over from v2 phase 3 (_archive/v2/pipeline_v2/phase3_expand_seeds.py)
with the same correctness rules:

  * Bulk POST /paper/batch with up to 500 IDs per request.
  * Truncation fallback: if S2 reports referenceCount > len(references)
    or citationCount > len(citations), fall back to the paginated
    GET /paper/{id}/references and /paper/{id}/citations endpoints to
    recover the full edge list (1000 per page).
  * Both stub papers AND edges are pushed: the merge writer turns each
    referenced/citing paper into a `papers` row, then the citation edge
    finds two real paper_ids to resolve against.

Targeting
---------
Default candidate set: every paper in the corpus that has at least one
identifier and hasn't been hopped yet (claims framework handles the
"hasn't been hopped" exclusion via enrichment_attempts.service='s2_hop').

Targeted set: pass `ctx.config['hop_targets']` — a list of identifier
strings like `"DOI:10.1/foo"`, `"W12345"`, or bare S2 sha IDs. The
producer only claims papers matching one of those IDs.
"""
from __future__ import annotations

import json
import time
from typing import Optional

from ..cache.records import PaperRecord, CitationRecord
from ..clients.semanticscholar import (
    SemanticScholarClient, _normalise_doi, S2_BATCH_SIZE,
)
from ..framework import Module, ModuleResult, ValidationResult


# Fields requested per paper in the batch hop call. We ask for full
# metadata on the seed itself, plus enough on each ref/cit to seed a
# stub paper row (paperId + externalIds for identity, title+year+authors
# for the metadata we want to land).
_HOP_FIELDS = (
    'paperId,externalIds,title,year,authors,venue,abstract,'
    'publicationTypes,fieldsOfStudy,'
    'citationCount,referenceCount,influentialCitationCount,'
    'references.paperId,references.externalIds,'
    'references.title,references.year,references.authors,'
    'citations.paperId,citations.externalIds,'
    'citations.title,citations.year,citations.authors'
)

# Fields for the paginated fallback — keep small, we only need identity
# + minimal metadata to make a useful stub paper row.
_HOP_PAGE_FIELDS = (
    'paperId,externalIds,title,year,authors'
)

_SEED_SOURCE     = 's2_hop_seed'       # PaperRecord source for the target itself
_NEIGHBOUR_SRC   = 's2_hop_neighbour'  # PaperRecord source for ref/citer stubs
_CITATION_SRC    = 's2_hop'            # CitationRecord.source


def _query_id_for(row) -> Optional[str]:
    """Build the lookup identifier S2 expects, preferring s2_id over DOI.

    Returns the bare s2_id (sha) if available, otherwise "DOI:<doi>".
    None when neither is present — caller treats as 'failed' for this row.
    """
    if row['s2_id']:
        return row['s2_id']
    if row['doi']:
        d = _normalise_doi(row['doi'])
        if d:
            return f'DOI:{d}'
    return None


def _paper_record_from_work(work: dict, source: str) -> PaperRecord:
    """Translate an S2 paper dict into a PaperRecord."""
    ext = work.get('externalIds') or {}
    raw_authors = [a.get('name') for a in (work.get('authors') or []) if a.get('name')]
    authors_json = json.dumps(raw_authors) if raw_authors else None
    pub_types = work.get('publicationTypes') or []
    pub_type = pub_types[0].lower() if pub_types else None
    return PaperRecord(
        source       = source,
        doi          = _normalise_doi(ext.get('DOI') or ''),
        s2_id        = work.get('paperId') or None,
        title        = work.get('title') or None,
        year         = work.get('year') or None,
        authors_json = authors_json,
        venue        = work.get('venue') or None,
        abstract     = work.get('abstract') or None,
        pub_type     = pub_type,
        cit_count    = work.get('citationCount'),
        ref_count    = work.get('referenceCount'),
        pubmed_id    = ext.get('PubMed') or None,
        pubmed_central_id = ext.get('PubMedCentral') or None,
    )


def _stub_record_for_neighbour(neighbour: dict) -> Optional[PaperRecord]:
    """Make a minimal-metadata PaperRecord for a referenced or citing paper.

    Returns None when there's no identifier to dedup against — the cache
    client would drop it anyway.
    """
    ext = neighbour.get('externalIds') or {}
    doi = _normalise_doi(ext.get('DOI') or '')
    s2_id = neighbour.get('paperId') or None
    if not (doi or s2_id):
        return None
    raw_authors = [a.get('name') for a in (neighbour.get('authors') or []) if a.get('name')]
    authors_json = json.dumps(raw_authors) if raw_authors else None
    return PaperRecord(
        source       = _NEIGHBOUR_SRC,
        doi          = doi,
        s2_id        = s2_id,
        title        = neighbour.get('title') or None,
        year         = neighbour.get('year') or None,
        authors_json = authors_json,
        pubmed_id    = ext.get('PubMed') or None,
        pubmed_central_id = ext.get('PubMedCentral') or None,
    )


def _edge(citing_work: dict, cited_work: dict) -> Optional[CitationRecord]:
    """Build a CitationRecord between two S2 paper dicts. None if neither
    side has any identifier (would be rejected by the cache client)."""
    citing_ext = citing_work.get('externalIds') or {}
    cited_ext  = cited_work.get('externalIds') or {}
    citing_doi = _normalise_doi(citing_ext.get('DOI') or '')
    cited_doi  = _normalise_doi(cited_ext.get('DOI') or '')
    citing_s2  = citing_work.get('paperId') or None
    cited_s2   = cited_work.get('paperId') or None
    if not (citing_doi or citing_s2) or not (cited_doi or cited_s2):
        return None
    return CitationRecord(
        source       = _CITATION_SRC,
        citing_doi   = citing_doi,
        citing_s2_id = citing_s2,
        cited_doi    = cited_doi,
        cited_s2_id  = cited_s2,
    )


class ExpandPapersS2(Module):
    name        = 'expand_papers_s2'
    description = (
        'Citation hop: fetch refs + citers from S2 for target papers; '
        'push neighbour stubs + edges through the cache'
    )

    requires    = {'papers.s2_id'}     # we need at least one ID to hop; sql also accepts DOI
    produces    = {'cache:papers', 'cache:citations'}
    eventually  = {'papers.s2_id', 'papers.doi', 'papers.title',
                   'citations.citing_id', 'citations.cited_id'}
    resources   = {'s2_api'}

    # Distinct service from enrich_metadata_s2 so that "already enriched
    # this paper's metadata" doesn't accidentally exclude it from being
    # hopped. The S2 client's adaptive throttle is per-process so they
    # still pace politely against the shared API.
    SERVICE     = 's2_hop'
    # Smaller than enrich_metadata_s2's 500: each hop response can carry
    # 1000+ neighbours per paper, and we'd rather flush more frequently.
    CLAIM_BATCH = 100
    IDLE_SLEEP_S   = 30
    MAX_IDLE_LOOPS = 5

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        conn = ctx.connect(readonly=True)
        try:
            row = conn.execute("""
                SELECT 1 FROM papers
                WHERE (doi IS NOT NULL OR s2_id IS NOT NULL)
                  AND is_rejected = 0
                LIMIT 1
            """).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(
                ok=False, missing=['papers'],
                message='No identifier-having papers to hop',
            )
        return ValidationResult(ok=True)

    def run(self, ctx) -> ModuleResult:
        from ..framework.claims import request_claim, report_marks

        client  = SemanticScholarClient()
        verbose = ctx.config.get('verbose', False)
        loop    = ctx.config.get('loop', False)
        limit   = ctx.config.get('hop_limit')
        targets = ctx.config.get('hop_targets')   # list[str] | None

        stats = {
            'total':            0,
            'batches':          0,
            'seeds_found':      0,
            'seeds_missing':    0,
            'refs_pushed':      0,
            'cits_pushed':      0,
            'neighbours_pushed': 0,
            'paginated_calls':  0,
            'budget_pauses':    0,
            'idle_loops':       0,
            'errors':           0,
        }

        print(f"  expand_papers_s2: loop={loop}, limit={limit}, "
              f"batch={self.CLAIM_BATCH}, auth={bool(client.api_key)}")

        # ---- Targeted mode (one-shot, no claim flow) ----------------
        if targets:
            print(f"  target list: {len(targets)} ids — bypassing claim flow")
            return self._run_targeted(ctx, client, targets, stats, verbose, limit)
        # ---- Daemon mode (claim flow) -------------------------------
        # seeds_only swaps in the seeds-filtered candidate query (same
        # 's2_hop' service, so tracking is shared with the full hop).
        claim_key = ('expand_papers_s2_seeds'
                     if ctx.config.get('seeds_only') else self.name)
        if ctx.config.get('seeds_only'):
            print("  seeds-only: hopping is_seed=1 papers")

        consecutive_empty = 0
        while True:
            if ctx.shutdown.requested:
                print("  [shutdown] aborting")
                break
            if limit and stats['seeds_found'] >= int(limit):
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
                    time.sleep(min(5, wait - slept))
                    slept += 5
                continue

            rows = request_claim(ctx.cache, claim_key,
                                 batch_size=self.CLAIM_BATCH,
                                 timeout_s=30.0)
            if not rows:
                consecutive_empty += 1
                if not loop or consecutive_empty >= self.MAX_IDLE_LOOPS:
                    print(f"  [done] no candidates after "
                          f"{consecutive_empty} idle waits")
                    break
                stats['idle_loops'] += 1
                time.sleep(self.IDLE_SLEEP_S)
                continue
            consecutive_empty = 0

            # Identifier-less rows can never resolve in S2 — mark failed
            # so the claims framework doesn't re-claim them next pass. The hop
            # is not field-partitioned, so marks use the '_all' sentinel field.
            no_id = [(r['id'], '_all') for r in rows if not _query_id_for(r)]
            usable = [dict(r) for r in rows if _query_id_for(r)]
            if not usable:
                report_marks(ctx.cache, claim_key, [], no_id)
                continue

            # Shared chunk-processing path (also used by targeted mode).
            seeds_found_before = stats['seeds_found']
            self._process_chunk(ctx, client, usable, stats, verbose)
            seeds_found_this = stats['seeds_found'] - seeds_found_before

            # Marks: any row whose work-result was None counts as failed
            # for THIS service (S2 doesn't know about it); the rest succeeded.
            # Reconstruct from stats: simplest is to mark every claimed
            # row succeeded EXCEPT those without an id and those that
            # came back missing — _process_chunk already counted them.
            # Pragmatic split: succeed every usable row, fail none.
            # When S2 didn't have a paper, we still don't want to retry
            # via the same service.
            usable_marks = [(r['id'], '_all') for r in usable]
            # Heuristic mark split: succeed every usable id. The
            # alternative (per-row tracking) requires the chunk method
            # to surface which ids failed — we accept the simplification:
            # 'we tried this batch with this service'.
            report_marks(ctx.cache, claim_key, usable_marks, no_id)

        stats['total'] = stats['seeds_found'] + stats['seeds_missing'] + stats['errors']
        return ModuleResult(
            status='success' if stats['seeds_found'] else 'noop',
            message=(f"{stats['seeds_found']:,} seeds hopped: "
                     f"{stats['refs_pushed']:,} refs + "
                     f"{stats['cits_pushed']:,} cits, "
                     f"{stats['neighbours_pushed']:,} neighbours stubs "
                     f"({stats['paginated_calls']:,} truncation fallbacks)"),
            stats=stats,
        )

    # -------------------------------------------------------------------
    # Targeted-mode helpers
    # -------------------------------------------------------------------

    def _resolve_targets(self, ctx, targets: list[str]) -> list[dict]:
        """Translate user-supplied identifiers into rows of the same
        shape claim_candidates would return.

        Accepted identifier formats:
            DOI:<doi>       — explicit DOI
            W12345          — OpenAlex work id (leading W)
            <40-char hex>   — bare S2 sha id
            <anything else> — treated as a DOI

        Identifiers that match a row in `papers` are returned as a
        single-row dict. Identifiers that don't match are silently
        skipped (and counted) — the caller can decide whether to
        push them as new paper rows first.
        """
        conn = ctx.connect(readonly=True)
        out: list[dict] = []
        try:
            for t in targets:
                t = t.strip()
                if not t:
                    continue
                if t.upper().startswith('DOI:'):
                    doi = _normalise_doi(t[4:])
                    col, val = 'doi', doi
                elif t.startswith('W') and t[1:].isdigit():
                    col, val = 'oa_id', t
                elif len(t) == 40 and all(c in '0123456789abcdef' for c in t.lower()):
                    col, val = 's2_id', t.lower()
                else:
                    # Assume bare DOI
                    col, val = 'doi', _normalise_doi(t)
                if not val:
                    continue
                row = conn.execute(
                    f"SELECT id, doi, s2_id, is_seed, discovery_count "
                    f"FROM papers WHERE {col} = ? LIMIT 1",
                    (val,),
                ).fetchone()
                if row:
                    out.append(dict(row))
        finally:
            conn.close()
        return out

    def _run_targeted(self, ctx, client, targets: list[str],
                       stats: dict, verbose: bool,
                       limit: Optional[int]) -> ModuleResult:
        """One-shot: hop exactly the supplied list, no claim coordination."""
        rows = self._resolve_targets(ctx, targets)
        if not rows:
            print(f"  [targeted] none of {len(targets)} targets matched the corpus")
            return ModuleResult(
                status='noop',
                message=f'0 of {len(targets)} targets matched papers in DB',
                stats=stats,
            )

        n_unmatched = len(targets) - len(rows)
        if n_unmatched:
            print(f"  [targeted] {n_unmatched}/{len(targets)} targets "
                  f"did not match any paper — skipping those")

        for chunk_start in range(0, len(rows), self.CLAIM_BATCH):
            if ctx.shutdown.requested:
                break
            if limit and stats['seeds_found'] >= int(limit):
                break
            chunk = rows[chunk_start:chunk_start + self.CLAIM_BATCH]
            self._process_chunk(ctx, client, chunk, stats, verbose)

        stats['total'] = stats['seeds_found'] + stats['seeds_missing'] + stats['errors']
        return ModuleResult(
            status='success' if stats['seeds_found'] else 'noop',
            message=(f"targeted run: {stats['seeds_found']:,}/{len(rows):,} "
                     f"seeds hopped ({stats['refs_pushed']:,} refs, "
                     f"{stats['cits_pushed']:,} cits, "
                     f"{stats['neighbours_pushed']:,} neighbours)"),
            stats=stats,
        )

    def _process_chunk(self, ctx, client, rows: list[dict],
                        stats: dict, verbose: bool) -> None:
        """Shared seed-batch logic used by both targeted and claim-flow
        paths. Pushes papers + edges through the cache; updates stats
        in place; does NOT touch the claims DB.
        """
        qid_to_row: dict[str, dict] = {}
        for r in rows:
            qid = _query_id_for(r)
            if qid:
                qid_to_row[qid] = r
        if not qid_to_row:
            stats['seeds_missing'] += len(rows)
            return

        t_req = time.time()
        try:
            results = client.fetch_batch_by_id(
                list(qid_to_row.keys()), fields=_HOP_FIELDS,
            )
            stats['batches'] += 1
        except Exception as e:
            stats['errors'] += len(qid_to_row)
            if verbose:
                print(f"  [chunk {stats['batches']+1}] ERROR "
                      f"{type(e).__name__}: {str(e)[:80]}")
            return
        req_ms = (time.time() - t_req) * 1000

        batch_refs, batch_cits, batch_neighbours = 0, 0, 0
        for qid, work in zip(list(qid_to_row.keys()), results or []):
            if work is None:
                stats['seeds_missing'] += 1
                continue
            ctx.cache.push_paper(_paper_record_from_work(work, _SEED_SOURCE))
            stats['seeds_found'] += 1
            for direction, key, count_key, edge_builder in (
                ('references', 'references', 'referenceCount',
                 lambda neighbour: _edge(work, neighbour)),
                ('citations',  'citations',  'citationCount',
                 lambda neighbour: _edge(neighbour, work)),
            ):
                items = work.get(key) or []
                if (work.get(count_key) or 0) > len(items):
                    s2_for_pagination = work.get('paperId') or qid
                    try:
                        items = client.paginated_fetch(
                            s2_for_pagination, direction,
                            fields=_HOP_PAGE_FIELDS,
                        )
                        stats['paginated_calls'] += 1
                    except Exception as e:
                        if verbose:
                            print(f"  [paginate-{direction}] {s2_for_pagination} "
                                  f"ERROR {type(e).__name__}: {str(e)[:60]}")
                for item in items:
                    stub = _stub_record_for_neighbour(item)
                    if stub:
                        ctx.cache.push_paper(stub)
                        batch_neighbours += 1
                    edge = edge_builder(item)
                    if edge:
                        ctx.cache.push_citation(edge)
                        if direction == 'references':
                            batch_refs += 1
                        else:
                            batch_cits += 1

        stats['refs_pushed']        += batch_refs
        stats['cits_pushed']        += batch_cits
        stats['neighbours_pushed']  += batch_neighbours
        print(f"  [chunk {stats['batches']:>4}] {len(qid_to_row)} seeds → "
              f"{batch_refs} refs, {batch_cits} cits, "
              f"{batch_neighbours} neighbours  "
              f"({req_ms:.0f}ms) "
              f"rps={client.breaker_status()['current_rps']}")
