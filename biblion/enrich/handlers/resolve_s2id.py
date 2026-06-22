"""Recover DOIs by S2 paperId — batch lookup. Service 's2_live', grain '_all'.
Succeeds only when a DOI comes back (metadata is still pushed regardless)."""
from __future__ import annotations

from ...clients.semanticscholar import SemanticScholarClient
from ...modules.enrich_metadata_s2 import (
    _parse_to_record, _citation_records, _S2_FIELDS,
)
from . import HandlerResult

ENDPOINTS = ('resolve_dois_via_s2id',)
SERVICE = 's2_live'
_SOURCE = 's2_batch_via_s2id'


def make_client():
    return SemanticScholarClient()


def handle(client, items) -> HandlerResult:
    res = HandlerResult()
    pairs = [(it.cols['s2_id'].strip(), it)
             for it in items if (it.cols.get('s2_id') or '').strip()]
    if not pairs:
        return res
    ids = [s for s, _ in pairs]
    results = client.fetch_batch_by_id(ids, fields=_S2_FIELDS) or []
    # results is parallel to ids.
    by_s2 = {s: r for (s, _it), r in zip(pairs, results) if r}
    for s2id, it in pairs:
        rec = by_s2.get(s2id)
        if rec is None:
            res.failed.append((it.paper_id, '_all'))
            continue
        pr = _parse_to_record(rec, _SOURCE)
        res.papers.append(pr)
        res.citations.extend(_citation_records(rec, _SOURCE))
        # "resolve DOI" succeeds only if a DOI was actually recovered.
        (res.succeeded if pr.doi else res.failed).append((it.paper_id, '_all'))
    return res
