"""OpenAlex metadata handler — batch DOI -> metadata + references.

Reuses the legacy enrich_metadata_oa parsing so behaviour is identical; the
dispatcher owns claiming. Emits a PaperRecord per hit plus its reference edges.
"""
from __future__ import annotations

from ...clients.openalex import OpenAlexClient, normalise_doi
from ...modules.enrich_metadata_oa import (
    _parse_to_record, _citation_records, _present_fields, _SELECT,
    _SERVICE_FIELDS,
)
from . import HandlerResult

ENDPOINTS = ('enrich_metadata_oa',)
SERVICE = 'oa'
_SOURCE = 'oa_works_doi'


def make_client():
    return OpenAlexClient()


def handle(client, items) -> HandlerResult:
    doi_to_item = {}
    for it in items:
        d = normalise_doi(it.cols.get('doi') or '')
        if d:
            doi_to_item[d] = it
    res = HandlerResult()
    if not doi_to_item:
        return res
    works = client.fetch_batch_by_doi(list(doi_to_item), select=_SELECT)
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
