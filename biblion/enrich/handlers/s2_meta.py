"""Semantic Scholar metadata handler — batch DOI -> metadata + edges (both
directions). Reuses legacy enrich_metadata_s2 parsing."""
from __future__ import annotations

from ...clients.semanticscholar import SemanticScholarClient, _normalise_doi
from ...modules.enrich_metadata_s2 import (
    _parse_to_record, _citation_records, _present_fields, _S2_FIELDS,
    _SERVICE_FIELDS,
)
from . import HandlerResult

ENDPOINTS = ('enrich_metadata_s2',)
SERVICE = 's2_live'
_SOURCE = 's2_batch'


def make_client():
    return SemanticScholarClient()


def handle(client, items) -> HandlerResult:
    doi_to_item = {}
    for it in items:
        d = _normalise_doi(it.cols.get('doi') or '')
        if d:
            doi_to_item[d] = it
    res = HandlerResult()
    if not doi_to_item:
        return res
    works = client.fetch_batch_by_doi(list(doi_to_item), fields=_S2_FIELDS)
    for doi, it in doi_to_item.items():
        needed = [f for f in _SERVICE_FIELDS if (SERVICE, f) in it.needs]
        work = works.get(doi)
        if work is None:
            res.failed += [(it.paper_id, f) for f in needed]
            continue
        rec = _parse_to_record(work, _SOURCE)
        res.papers.append(rec)
        res.citations.extend(_citation_records(work, _SOURCE))
        present = _present_fields(rec)
        for f in needed:
            (res.succeeded if f in present else res.failed).append((it.paper_id, f))
    return res
