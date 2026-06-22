"""
search_s2_factorial — boolean-keyword search ingestion via S2.

Carried over from _archive/scripts/run_searches.py with the same
semantics:

  * Input: a JSON file at `data/searches/*.json` shaped like
    {"queries": [{"id": 1, "title": "...", "query": "(A OR B) AND (C OR D)"}]}
  * `expand` mode: parse each query into Cartesian product of AND groups
    of OR alternatives; each combination becomes one S2 /paper/search call.
  * `simplify` mode: one representative term per AND clause, one call per
    query.
  * NOT clauses are stripped (S2 ignores boolean NOT).
  * Per sub_query, top-N results (default 100) are paged via offset.
  * Results stream as PaperRecord into the cache; the merge writer dedups
    against the existing corpus. Search hits ARE the seeds — the `search` CLI
    flags them is_seed=1 by provenance after the cache drains (the writer can't
    set is_seed from a PaperRecord). Endpoints discovered later from refs/
    citations keep is_seed=0 (ghosts).
  * Checkpoints in Redis: `search:s2:ckpt:<query_id>` -> JSON list of
    completed sub_queries. Resumable on restart.

This module does NOT use the claim flow — its input is a static JSON
file. Run as a one-shot via the `search` CLI subcommand.
"""
from __future__ import annotations

import json
import re
from itertools import product as cartesian
from pathlib import Path
from typing import Optional

from ..cache.records import PaperRecord
from ..clients.semanticscholar import (
    SemanticScholarClient, _normalise_doi, parse_external_ids,
)
from ..framework import Module, ModuleResult, ValidationResult


# Fields S2 returns on /paper/search relevance results — mirror the
# original v1 set so we get enough to build a useful PaperRecord.
_SEARCH_FIELDS = (
    'paperId,externalIds,title,abstract,venue,year,'
    'citationCount,influentialCitationCount,'
    'fieldsOfStudy,authors,isOpenAccess,openAccessPdf,'
    'publicationTypes'
)

_DEFAULT_SUB_LIMIT = 100   # papers per sub-query (matches original)

# PaperRecord.source prefix for search hits. These ARE the seeds — the CLI flags
# them is_seed=1 after the cache drains (the merge writer can't set is_seed from
# a PaperRecord). Single source of truth for that match.
SEARCH_SOURCE_PREFIX = 's2_search_factorial:'


# ---------------------------------------------------------------------------
# Boolean-query parser — ported verbatim from run_searches.py
# ---------------------------------------------------------------------------

def _clean_term(t: str) -> str:
    """Strip whitespace and trailing wildcards from a single term."""
    t = t.strip().rstrip('* ').strip()
    if ' ' in t and not t.startswith('"'):
        t = f'"{t}"'
    return t


def _strip_not_clauses(q: str) -> str:
    """Remove NOT (...) and NOT <term> clauses from a query.

    S2 relevance search ignores boolean NOT, so passing NOT terms
    as-is would make them positive AND signals instead of exclusions.
    Strip before query construction.
    """
    q = re.sub(r'\bNOT\s*\([^)]*\)', '', q)
    q = re.sub(r'\bNOT\s+\S+', '', q)
    q = re.sub(r'\b(AND|OR)\s*$', '', q.strip())
    return q.strip()


def _parse_or_groups(q: str) -> list[list[str]]:
    """Parse `(A OR B) AND (C OR D OR E)` into `[["A","B"],["C","D","E"]]`.

    Wildcards stripped, phrases preserved, NOT clauses removed.
    """
    q = _strip_not_clauses(q)
    groups_raw = re.findall(r'\(([^()]+)\)', q)
    if not groups_raw:
        groups_raw = [q]
    result = []
    for group in groups_raw:
        terms = [t.strip() for t in re.split(r'\bOR\b', group)]
        cleaned = []
        for t in terms:
            m = re.match(r'^"([^"]+)"$', t)
            if m:
                term = _clean_term(m.group(1))
                if term and len(term.strip('"')) > 2:
                    cleaned.append(f'"{term.strip(chr(34))}"')
            else:
                term = _clean_term(t)
                if term and len(term.strip('"')) > 2:
                    cleaned.append(term)
        if cleaned:
            result.append(cleaned)
    return result


def _expand_queries(q: str) -> list[str]:
    """Cartesian product over the AND groups.

    `(A OR B) AND (C OR D) -> ["A C", "A D", "B C", "B D"]`
    """
    groups = _parse_or_groups(q)
    if not groups:
        return [_simplify_query(q)]
    return [' '.join(combo) for combo in cartesian(*groups)]


def _simplify_query(q: str) -> str:
    """One representative term per AND clause, joined as relevance search.

    Used in simplify mode (the default for huge searches).
    """
    q = _strip_not_clauses(q)
    and_clauses = re.split(r'\)\s*AND\s*\(|\bAND\b', q)
    result = []
    seen: set[str] = set()
    for clause in and_clauses:
        phrases = re.findall(r'"([^"]+)"', clause)
        chosen = None
        for p in phrases:
            p = p.rstrip('* ').strip()
            if len(p) > 3 and p.lower() not in seen:
                chosen = f'"{p}"'
                seen.add(p.lower())
                break
        if not chosen:
            bare = re.sub(r'[()"\*]', ' ', clause)
            bare = re.sub(r'\b(AND|OR|NOT)\b', ' ', bare)
            for w in bare.split():
                w = w.rstrip('*').strip()
                if len(w) > 4 and w.lower() not in seen:
                    chosen = w
                    seen.add(w.lower())
                    break
        if chosen:
            result.append(chosen)
    return ' '.join(result)


# ---------------------------------------------------------------------------
# Translation: S2 search-result dict → PaperRecord
# ---------------------------------------------------------------------------

def _paper_record_from_search_hit(hit: dict, query_id, query_title: str,
                                   sub_query: str) -> Optional[PaperRecord]:
    """Build a PaperRecord with provenance baked into the `source` field.

    The `source` carries query attribution so future analysis can ask
    "which factorial sub-query found this paper?"
    """
    s2_id = hit.get('paperId') or None
    ext   = hit.get('externalIds') or {}
    doi   = _normalise_doi(ext.get('DOI') or '')
    if not (s2_id or doi):
        return None
    # Same externalIds parse as enrich_metadata_s2: capture arxiv/mag/dblp/acl
    # (+ pubmed) at search time instead of waiting for a later enrichment pass.
    extra_ids, pmid, pmcid = parse_external_ids(ext)
    raw_authors = [a.get('name') for a in (hit.get('authors') or [])
                   if a.get('name')]
    authors_json = json.dumps(raw_authors) if raw_authors else None
    pub_types = hit.get('publicationTypes') or []
    pub_type  = pub_types[0].lower() if pub_types else None
    is_oa = hit.get('isOpenAccess')
    # Stuff query attribution into `raw` so downstream consumers can
    # reconstruct it without polluting the PaperRecord schema.
    raw_payload = json.dumps({
        'query_id':    query_id,
        'query_title': query_title,
        'sub_query':   sub_query,
    }, separators=(',', ':'))
    return PaperRecord(
        source       = f'{SEARCH_SOURCE_PREFIX}{query_id}',
        doi          = doi,
        s2_id        = s2_id,
        title        = hit.get('title') or None,
        year         = hit.get('year') or None,
        authors_json = authors_json,
        venue        = hit.get('venue') or None,
        abstract     = hit.get('abstract') or None,
        pub_type     = pub_type,
        cit_count    = hit.get('citationCount'),
        influential_cit_count = hit.get('influentialCitationCount'),
        is_open_access = bool(is_oa) if is_oa is not None else None,
        pubmed_id    = pmid,
        pubmed_central_id = pmcid,
        extra_identifiers = extra_ids,
        raw          = raw_payload,
    )


# ---------------------------------------------------------------------------
# Checkpoint persistence — Redis keys per query_id
# ---------------------------------------------------------------------------

_CKPT_KEY_PREFIX = 'search:s2:ckpt:'


def _ckpt_key(cache, query_id) -> str:
    """Namespaced checkpoint key, so two projects on the same Redis (and a
    rebuilt DB) don't share/inherit each other's search progress."""
    return cache._k(f'{_CKPT_KEY_PREFIX}{query_id}')


def _ckpt_load(cache, query_id) -> set[str]:
    """Read the set of already-completed sub_queries for one top-level query."""
    raw = cache._r.get(_ckpt_key(cache, query_id))
    if not raw:
        return set()
    try:
        return set(json.loads(raw))
    except Exception:
        return set()


def _ckpt_save(cache, query_id, completed: set[str]) -> None:
    cache._r.set(
        _ckpt_key(cache, query_id),
        json.dumps(sorted(completed), separators=(',', ':')),
    )


# ---------------------------------------------------------------------------
# Module
# ---------------------------------------------------------------------------

class SearchS2Factorial(Module):
    name        = 'search_s2_factorial'
    description = (
        'Boolean-keyword S2 search ingestion. Reads searches/*.json, '
        'optionally Cartesian-expands AND/OR queries, pushes results.'
    )

    # No DB prereqs — input is a JSON file.
    requires    = set()
    produces    = {'cache:papers'}
    eventually  = {'papers.s2_id', 'papers.doi', 'papers.title',
                   'papers.year', 'papers.authors', 'papers.abstract'}
    resources   = {'s2_api'}

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        sf = ctx.config.get('search_file')
        if not sf:
            return ValidationResult(
                ok=False, missing=['search_file'],
                message='Pass --search-file <path> on the search subcommand',
            )
        if not Path(sf).exists():
            return ValidationResult(
                ok=False, missing=['search_file'],
                message=f'Search file not found: {sf}',
            )
        return ValidationResult(ok=True)

    def run(self, ctx) -> ModuleResult:
        search_file = Path(ctx.config['search_file'])
        mode        = ctx.config.get('search_mode', 'simplify')
        sub_limit   = int(ctx.config.get('sub_limit', _DEFAULT_SUB_LIMIT))
        year_min    = ctx.config.get('year_min')
        year_max    = ctx.config.get('year_max')

        if mode not in ('simplify', 'expand'):
            return ModuleResult(
                status='failed',
                message=f"search_mode must be 'simplify' or 'expand', got {mode!r}",
            )

        with open(search_file, encoding='utf-8') as f:
            data = json.load(f)
        queries = data.get('queries') or []
        if not queries:
            return ModuleResult(status='failed',
                                message=f'No "queries" in {search_file}')

        client = SemanticScholarClient()
        stats = {
            'queries':       len(queries),
            'sub_queries':   0,
            'sub_skipped':   0,
            'papers_seen':   0,
            'papers_pushed': 0,
            'mode':          mode,
        }

        print(f"  search_s2_factorial: file={search_file.name} "
              f"mode={mode} sub_limit={sub_limit} "
              f"queries={len(queries)} auth={bool(client.api_key)}")

        for q in queries:
            if ctx.shutdown.requested:
                print("  [shutdown] aborting")
                break
            qid      = q.get('id')
            qtitle   = q.get('title') or ''
            qstr     = q.get('query') or ''
            if not qstr:
                continue

            if mode == 'expand':
                sub_queries = _expand_queries(qstr)
            else:
                sub_queries = [_simplify_query(qstr)]

            completed = _ckpt_load(ctx.cache, qid)
            remaining = [s for s in sub_queries if s not in completed]
            stats['sub_skipped'] += (len(sub_queries) - len(remaining))

            print(f"\n  [query {qid}] {qtitle}")
            print(f"    {len(sub_queries)} combinations | "
                  f"{len(remaining)} remaining | "
                  f"{len(completed)} already done")

            local_seen: set[str] = set()
            for i, sub_q in enumerate(remaining, 1):
                if ctx.shutdown.requested:
                    break
                print(f"    [{i}/{len(remaining)}] {sub_q[:80]}")
                try:
                    papers = client.search(
                        sub_q,
                        fields=_SEARCH_FIELDS,
                        year_min=year_min,
                        year_max=year_max,
                        limit=sub_limit,
                    )
                except Exception as e:
                    print(f"      ERROR {type(e).__name__}: {str(e)[:80]}")
                    continue

                for hit in papers:
                    stats['papers_seen'] += 1
                    s2_id = hit.get('paperId') or None
                    if s2_id and s2_id in local_seen:
                        continue
                    if s2_id:
                        local_seen.add(s2_id)
                    rec = _paper_record_from_search_hit(hit, qid, qtitle, sub_q)
                    if rec and ctx.cache.push_paper(rec):
                        stats['papers_pushed'] += 1

                completed.add(sub_q)
                _ckpt_save(ctx.cache, qid, completed)
                stats['sub_queries'] += 1

        return ModuleResult(
            status='success' if stats['papers_pushed'] else 'noop',
            message=(f"{stats['papers_pushed']:,} papers pushed across "
                     f"{stats['sub_queries']:,} sub-queries "
                     f"(skipped {stats['sub_skipped']:,} already done)"),
            stats=stats,
        )
