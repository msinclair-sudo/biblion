"""Resolve DOIs via OpenAlex title search (per paper). Service 'oa', '_all'.
Reuses resolve_dois_oa's parsing + similarity threshold."""
from __future__ import annotations

from ...clients.openalex import OpenAlexClient
from ...modules.resolve_dois_oa import (
    _parse_to_record, _citation_records, _title_similarity, _SELECT,
    _DEFAULT_THRESHOLD, _TOP_K,
)
from . import HandlerResult

ENDPOINTS = ('resolve_dois_oa',)
SERVICE = 'oa'
_SOURCE = 'oa_works_search'


def make_client():
    return OpenAlexClient()


def handle(client, items) -> HandlerResult:
    res = HandlerResult()
    for it in items:
        if getattr(client, 'breaker_open', False):
            break                              # budget hit -> leave rest claimed
        title = it.cols.get('title')
        if not title:
            res.failed.append((it.paper_id, '_all'))
            continue
        try:
            results = client.search_by_title(
                title, year=it.cols.get('year'), top_k=_TOP_K, select=_SELECT) or []
        except Exception:
            continue                           # leave claimed -> expire -> retry
        best_sim, best = 0.0, None
        for w in results:
            sim = _title_similarity(title, w.get('title') or '')
            if sim > best_sim:
                best_sim, best = sim, w
        if best is None or best_sim < _DEFAULT_THRESHOLD:
            res.failed.append((it.paper_id, '_all'))
            continue
        rec = _parse_to_record(best, _SOURCE)
        # Bridge: the OA match carries oa_id/DOI but no s2_id, while the seed is
        # often s2_id-only. Carry the seed's own identifiers (that the OA record
        # lacks) so the merge writer links this back to the seed by a shared id
        # instead of creating an orphan twin. The dedup then has its bridge.
        for col in ('s2_id', 'doi', 'oa_id', 'pubmed_id'):
            if getattr(rec, col, None) is None and it.cols.get(col):
                setattr(rec, col, it.cols[col])
        res.papers.append(rec)
        res.citations.extend(_citation_records(best, _SOURCE))
        res.succeeded.append((it.paper_id, '_all'))
    return res
