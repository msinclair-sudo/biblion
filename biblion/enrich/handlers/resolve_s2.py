"""Resolve DOIs via Semantic Scholar title search (per paper). Service
's2_live', '_all'. Reuses resolve_dois_s2 + enrich_metadata_s2 parsing."""
from __future__ import annotations

from ...clients.semanticscholar import SemanticScholarClient
from ...modules.resolve_dois_s2 import _title_similarity, _DEFAULT_THRESHOLD, _TOP_K
from ...modules.enrich_metadata_s2 import (
    _parse_to_record, _citation_records, _S2_FIELDS,
)
from . import HandlerResult

ENDPOINTS = ('resolve_dois_s2',)
SERVICE = 's2_live'
_SOURCE = 's2_search'


def make_client():
    return SemanticScholarClient()


def handle(client, items) -> HandlerResult:
    res = HandlerResult()
    for it in items:
        if getattr(client, 'breaker_open', False):
            break
        title = it.cols.get('title')
        if not title:
            res.failed.append((it.paper_id, '_all'))
            continue
        try:
            results = client.search_by_title(
                title, year=it.cols.get('year'), top_k=_TOP_K,
                fields=_S2_FIELDS) or []
        except Exception:
            continue
        best_sim, best = 0.0, None
        for w in results:
            sim = _title_similarity(title, w.get('title') or '')
            if sim > best_sim:
                best_sim, best = sim, w
        if best is None or best_sim < _DEFAULT_THRESHOLD:
            res.failed.append((it.paper_id, '_all'))
            continue
        res.papers.append(_parse_to_record(best, _SOURCE))
        res.citations.extend(_citation_records(best, _SOURCE))
        res.succeeded.append((it.paper_id, '_all'))
    return res
