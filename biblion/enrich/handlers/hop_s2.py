"""S2 citation hop — fetch a seed's references + citers and emit the EDGES.
Service 's2_hop', '_all'. In the enrich flow only the seeds variant is dispatched
(is_seed-gated → bounded, no cascade).

EDGES ONLY: unlike the legacy module, this does NOT push a paper row for every
neighbour. Eagerly materialising every 1-hop neighbour (with title/authors) would
bloat the corpus with thousands of titled ghost papers, against the "ghosts are
identifier-only, selective" model. The edges land in pending_citations and
materialize_ghost_stubs promotes only the well-connected (degree>=2) endpoints as
identifier-only ghosts."""
from __future__ import annotations

from ...clients.semanticscholar import SemanticScholarClient
from ...modules.expand_papers_s2 import (
    _query_id_for, _paper_record_from_work, _edge,
    _HOP_FIELDS, _HOP_PAGE_FIELDS, _SEED_SOURCE,
)
from . import HandlerResult

ENDPOINTS = ('expand_papers_s2', 'expand_papers_s2_seeds')
SERVICE = 's2_hop'

_DIRECTIONS = (
    ('references', 'referenceCount', lambda work, nb: _edge(work, nb)),
    ('citations', 'citationCount', lambda work, nb: _edge(nb, work)),
)


def make_client():
    return SemanticScholarClient()


def handle(client, items) -> HandlerResult:
    res = HandlerResult()
    qid_to_item = {}
    for it in items:
        qid = _query_id_for(it.cols)          # cols exposes doi / s2_id
        if qid:
            qid_to_item[qid] = it
        else:
            res.failed.append((it.paper_id, '_all'))
    if not qid_to_item:
        return res
    results = client.fetch_batch_by_id(list(qid_to_item), fields=_HOP_FIELDS) or []
    for qid, work in zip(list(qid_to_item), results):
        it = qid_to_item[qid]
        if work is None:
            res.failed.append((it.paper_id, '_all'))
            continue
        res.papers.append(_paper_record_from_work(work, _SEED_SOURCE))
        for key, count_key, edge_builder in _DIRECTIONS:
            neighbours = work.get(key) or []
            if (work.get(count_key) or 0) > len(neighbours):
                try:
                    neighbours = client.paginated_fetch(
                        work.get('paperId') or qid, key, fields=_HOP_PAGE_FIELDS)
                except Exception:
                    pass                       # keep the un-paginated subset
            for nb in neighbours:
                edge = edge_builder(work, nb)
                if edge:
                    res.citations.append(edge)   # edges only; no neighbour stubs
        res.succeeded.append((it.paper_id, '_all'))
    return res
