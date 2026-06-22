"""OpenAlex stub-fill handler — oa_id -> full metadata + references. Service
'oa', grain '_all'. Reuses enrich_metadata_oa parsing."""
from __future__ import annotations

from ...clients.openalex import OpenAlexClient
from ...modules.enrich_metadata_oa import (
    _parse_to_record, _citation_records, _SELECT,
)
from . import HandlerResult

ENDPOINTS = ('enrich_stubs_oa',)
SERVICE = 'oa'
_SOURCE = 'oa_works_by_oa_id'


def make_client():
    return OpenAlexClient()


def handle(client, items) -> HandlerResult:
    res = HandlerResult()
    oid_to_item = {}
    for it in items:
        oid = (it.cols.get('oa_id') or '').strip().upper()
        if oid:
            oid_to_item[oid] = it
    if not oid_to_item:
        return res
    works = client.fetch_batch_by_oa_id(list(oid_to_item), select=_SELECT)
    for oid, it in oid_to_item.items():
        work = works.get(oid)
        if work is None:
            res.failed.append((it.paper_id, '_all'))
            continue
        res.papers.append(_parse_to_record(work, _SOURCE))
        res.citations.extend(_citation_records(work, _SOURCE))
        res.succeeded.append((it.paper_id, '_all'))
    return res
