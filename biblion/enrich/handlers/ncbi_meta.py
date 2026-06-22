"""NCBI/PubMed metadata handler — PMID (or DOI->PMID via esearch) -> efetch
abstract/title/year. Reuses legacy enrich_metadata_ncbi parsing."""
from __future__ import annotations

from ...clients.ncbi import NcbiClient
from ...modules.enrich_metadata_ncbi import (
    _to_record, _present_fields, _SERVICE_FIELDS,
)
from . import HandlerResult

ENDPOINTS = ('enrich_metadata_ncbi',)
SERVICE = 'ncbi'
_SOURCE = 'ncbi_efetch'


def make_client():
    return NcbiClient()


def _needed(it):
    return [f for f in _SERVICE_FIELDS if (SERVICE, f) in it.needs]


def handle(client, items) -> HandlerResult:
    res = HandlerResult()
    pmid_to_item = {}
    doi_only = {}                       # doi -> item
    for it in items:
        pmid = (it.cols.get('pubmed_id') or '').strip() or None
        if pmid:
            pmid_to_item[pmid] = it
        elif it.cols.get('doi'):
            doi_only[it.cols['doi']] = it

    if doi_only:
        for doi, pmid in client.pmids_for_dois(list(doi_only)).items():
            pmid_to_item.setdefault(pmid, doi_only[doi])

    fetched = (client.fetch_abstracts_by_pmid(list(pmid_to_item))
               if pmid_to_item else {})

    handled = set()
    for pmid, it in pmid_to_item.items():
        handled.add(it.paper_id)
        needed = _needed(it)
        info = fetched.get(pmid)
        if info is None:
            res.failed += [(it.paper_id, f) for f in needed]
            continue
        rec = _to_record(pmid, info, _SOURCE)
        res.papers.append(rec)
        present = _present_fields(rec)
        for f in needed:
            (res.succeeded if f in present else res.failed).append((it.paper_id, f))
    # Papers whose DOI never resolved to a PMID -> mark their needs failed so we
    # don't re-spend immediately.
    for it in items:
        if it.paper_id not in handled:
            res.failed += [(it.paper_id, f) for f in _needed(it)]
    return res
