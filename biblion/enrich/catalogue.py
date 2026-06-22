"""
Endpoint catalogue — the verified table of concrete provider calls the solver
routes to. One Endpoint per CANDIDATE_QUERIES module, so the catalogue is
provably 1:1 with the registry it replaces.

Built FROM reader.NEEDS_SPEC (the single source of truth for service / fields /
precondition) plus per-endpoint provider + batch metadata, so preconditions never
drift between "what's needed" (Reader) and "what can settle it" (catalogue).

An endpoint `settles` the (service, field) pairs it can fill. Because needs are
service-keyed, every need maps to a definite endpoint; the solver's job is to
pick a minimal covering set (one call settles several fields) and respect budget.

NOTE: resolved decision #4 (S2 default for metadata, OpenAlex reserved for
DOI-by-title + biblio + S2 misses) is a *routing policy* applied per-service at
Phase 4 cutover, NOT here. Phase 3 keeps the catalogue a faithful mirror of the
current modules so routing parity holds in shadow.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .reader import NEEDS_SPEC

# Service -> rate-limit / budget pool. Multiple services can share a provider
# (oa + oa_incoming -> openalex; s2_live + s2_hop -> s2).
PROVIDER_OF = {
    'oa': 'openalex',
    'oa_incoming': 'openalex',
    's2_live': 's2',
    's2_hop': 's2',
    'ncbi': 'ncbi',
    'ncbi_pmid': 'ncbi',
    'crossref': 'crossref',
}

# Per-endpoint provider call batch size (from the client constants:
# openalex _BATCH_SIZE=50, s2 S2_BATCH_SIZE=500, ncbi NCBI_BATCH_SIZE=200,
# crossref CROSSREF_BATCH_SIZE=20; expand_incoming_oa paginates one cites:
# query per paper, so _CLAIM_BATCH=25).
BATCH_OF = {
    'enrich_metadata_oa': 50,
    'enrich_metadata_s2': 500,
    'enrich_metadata_ncbi': 200,
    'enrich_biblio_crossref': 20,
    'enrich_stubs_oa': 50,
    'resolve_dois_oa': 50,
    'resolve_dois_s2': 500,
    'resolve_dois_via_pmid': 200,
    'resolve_dois_via_s2id': 500,
    'expand_papers_s2': 500,
    'expand_incoming_oa': 25,
    'expand_papers_s2_seeds': 500,
}


@dataclass(frozen=True)
class Endpoint:
    name: str
    service: str
    provider: str
    fields: tuple
    batch: int
    precond: Callable[[dict], bool]

    @property
    def settles(self) -> frozenset:
        """The (service, field) pairs this endpoint can fill."""
        return frozenset((self.service, f) for f in self.fields)


def _build_catalogue() -> dict:
    cat: dict[str, Endpoint] = {}
    for spec in NEEDS_SPEC:
        provider = PROVIDER_OF.get(spec.service)
        batch = BATCH_OF.get(spec.module)
        if provider is None or batch is None:
            raise KeyError(
                f"catalogue: missing provider/batch for endpoint {spec.module!r}")
        cat[spec.module] = Endpoint(
            name=spec.module, service=spec.service, provider=provider,
            fields=spec.fields, batch=batch, precond=spec.precond)
    return cat


CATALOGUE: dict[str, Endpoint] = _build_catalogue()
