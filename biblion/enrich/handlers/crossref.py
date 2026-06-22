"""
Crossref handler — thin wrapper over clients/crossref for the dispatcher.

Takes the WorkItems routed to enrich_biblio_crossref, calls the batch DOI
endpoint, and returns (records_to_push, succeeded, failed) where succeeded /
failed are (paper_id, field) pairs over the crossref fields the paper still
needs. The dispatcher pushes the records (the writer applies them) and marks the
outcomes. Mirrors modules/enrich_biblio_crossref so behaviour is identical.
"""
from __future__ import annotations

from ...clients.crossref import CrossrefClient, parse_work
from ...cache.records import PaperRecord
from . import HandlerResult

ENDPOINTS = ('enrich_biblio_crossref',)
SERVICE = 'crossref'
FIELDS = ('volume', 'first_page', 'publisher')
_SOURCE = 'crossref_works'


def make_client():
    return CrossrefClient()


def _present(rec: PaperRecord) -> set:
    present = set()
    if rec.volume:
        present.add('volume')
    if rec.first_page:
        present.add('first_page')
    if rec.publisher:
        present.add('publisher')
    return present


def handle(client, items) -> HandlerResult:
    """items: WorkItems routed to crossref."""
    doi_to_item = {it.cols['doi']: it for it in items if it.cols.get('doi')}
    res = HandlerResult()
    if not doi_to_item:
        return res
    fetched = client.fetch_batch_by_doi(list(doi_to_item))
    for doi, it in doi_to_item.items():
        needed = [f for f in FIELDS if (SERVICE, f) in it.needs]
        work = fetched.get(doi)
        if work is None:
            res.failed += [(it.paper_id, f) for f in needed]
            continue
        rec = PaperRecord(source=_SOURCE, **parse_work(work))
        res.papers.append(rec)
        present = _present(rec)
        for f in needed:
            (res.succeeded if f in present else res.failed).append((it.paper_id, f))
    return res
