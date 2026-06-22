"""
Handler registry — endpoint name -> the thin executor the dispatcher calls.

Each HandlerSpec ties a catalogue endpoint to its service, a client factory, the
handle() function, and an optional breaker check (budget exhausted -> defer).
Endpoints are added here as they're cut over (crossref first, then ncbi, s2, oa).
An endpoint with no entry stays on the legacy producer path.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class HandlerResult:
    """What a handler returns to the dispatcher: PaperRecords + CitationRecords
    to push (the writer applies them) and per-(paper_id, field) outcome marks."""
    papers: list = field(default_factory=list)
    citations: list = field(default_factory=list)
    succeeded: list = field(default_factory=list)
    failed: list = field(default_factory=list)


@dataclass(frozen=True)
class HandlerSpec:
    endpoint: str
    service: str
    make_client: Callable[[], object]
    handle: Callable[[object, list], HandlerResult]
    # True when the provider's budget/circuit breaker is open (defer routing).
    breaker_open: Callable[[object], bool] = lambda _client: False


def _default_breaker(client) -> bool:
    """Most clients expose a `breaker_open` property; treat missing as closed."""
    return bool(getattr(client, 'breaker_open', False))


import importlib
import logging as _logging

_log = _logging.getLogger(__name__)

# Handler modules, added as endpoints are cut over. Each declares ENDPOINTS,
# SERVICE, make_client, handle, and optionally breaker_open. A module that can't
# import (not built yet / a broken client) is skipped, not fatal.
_HANDLER_MODULES = (
    'crossref', 'oa_meta', 's2_meta', 'ncbi_meta', 'oa_stubs',
    'resolve_s2id', 'resolve_pmid', 'resolve_oa', 'resolve_s2',
    'incoming_oa', 'hop_s2',
)


def _build_handlers() -> dict:
    out: dict[str, HandlerSpec] = {}
    for name in _HANDLER_MODULES:
        try:
            m = importlib.import_module(f'{__name__}.{name}')
        except Exception as e:                       # not built / import error
            _log.debug("handler module %s unavailable: %s", name, e)
            continue
        for endpoint in m.ENDPOINTS:
            out[endpoint] = HandlerSpec(
                endpoint=endpoint,
                service=m.SERVICE,
                make_client=m.make_client,
                handle=m.handle,
                breaker_open=getattr(m, 'breaker_open', _default_breaker),
            )
    return out


HANDLERS: dict[str, HandlerSpec] = _build_handlers()
