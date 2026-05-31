"""Redis-backed staging cache for producer/merge decoupling."""
from .client  import CacheClient, namespace_for_db
from .records import (
    PaperRecord, CitationRecord,
    ClaimRequest, ClaimGrant, ResultMark,
    PromoteCitationAction,
)

__all__ = [
    'CacheClient', 'namespace_for_db',
    'PaperRecord', 'CitationRecord',
    'ClaimRequest', 'ClaimGrant', 'ResultMark',
    'PromoteCitationAction',
]
