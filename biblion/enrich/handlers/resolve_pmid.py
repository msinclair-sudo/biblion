"""Recover DOIs from PubMed IDs via NCBI eSummary. Service 'ncbi_pmid', grain
'_all'. Knowing the PMID counts as settled (succeeded) even when NCBI has no
DOI, so we don't re-call; only a missing PubMed record fails."""
from __future__ import annotations

from ...cache.records import PaperRecord
from ...clients.ncbi import NcbiClient
from . import HandlerResult

ENDPOINTS = ('resolve_dois_via_pmid',)
SERVICE = 'ncbi_pmid'
_SOURCE = 'ncbi_pmid'


def make_client():
    return NcbiClient()


def handle(client, items) -> HandlerResult:
    res = HandlerResult()
    pmid_to_item = {}
    for it in items:
        pmid = (it.cols.get('pubmed_id') or '').strip()
        if pmid:
            pmid_to_item[pmid] = it
        else:
            res.failed.append((it.paper_id, '_all'))   # no usable PMID
    if not pmid_to_item:
        return res
    resolved = client.summary_by_pmid(list(pmid_to_item))
    for pmid, it in pmid_to_item.items():
        info = resolved.get(pmid)
        if not info:
            res.failed.append((it.paper_id, '_all'))
            continue
        doi = info.get('doi')
        pmcid = info.get('pmcid')
        if doi or pmcid:
            # push_papers drops it if it ends up with no primary identifier.
            res.papers.append(PaperRecord(
                source=_SOURCE, doi=doi or None, s2_id=it.cols.get('s2_id'),
                pubmed_id=pmid, pubmed_central_id=pmcid))
        res.succeeded.append((it.paper_id, '_all'))   # PMID known -> settled
    return res
