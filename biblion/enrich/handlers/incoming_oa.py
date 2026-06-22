"""Incoming citations via OpenAlex cites: filter (who cites each seed). Service
'oa_incoming', field 'cites'. Per-paper paginated fetch; edge-only."""
from __future__ import annotations

from ...clients.openalex import OpenAlexClient
from ...cache.records import CitationRecord
from ...modules.expand_incoming_oa import _SOURCE
from . import HandlerResult

ENDPOINTS = ('expand_incoming_oa',)
SERVICE = 'oa_incoming'


def make_client():
    return OpenAlexClient()


def handle(client, items) -> HandlerResult:
    res = HandlerResult()
    for it in items:
        if getattr(client, 'breaker_open', False):
            break
        oa_id = it.cols.get('oa_id')
        if not oa_id:
            res.failed.append((it.paper_id, 'cites'))
            continue
        this_oa = (oa_id or '').rsplit('/', 1)[-1].upper() or None
        try:
            for citer in client.cites_of(oa_id):
                res.citations.append(CitationRecord(
                    source=_SOURCE,
                    citing_doi=citer.get('doi'),
                    citing_oa_id=citer.get('oa_id'),
                    cited_oa_id=this_oa))
        except Exception:
            res.failed.append((it.paper_id, 'cites'))
            continue
        res.succeeded.append((it.paper_id, 'cites'))
    return res
