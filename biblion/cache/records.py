"""
Typed records that flow through the Redis cache.

Every producer module pushes one of these into a Redis list; the merge
writer pops batches of them and reconciles into the v3 SQLite DB.

Why typed records rather than free-form dicts?
  - Cheap validation at the producer/cache boundary (catch typos)
  - One JSON serialisation format for all sources, easy to evolve
  - The merge writer can do `record.identifiers()` instead of probing keys
"""
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional
import json

from ..titles import clean_title


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# PaperRecord
# ---------------------------------------------------------------------------

@dataclass
class PaperRecord:
    """
    A single paper as observed by some producer.

    At least one of {doi, s2_id, oa_id} must be non-None for the merge
    writer to attempt a lookup. Records with no identifiers are dropped
    by the cache client (with a warning).
    """
    source:        str                          # 'oa_works_doi', 'oa_works_search', 's2_batch', ...
    discovered_at: str        = field(default_factory=_now)

    # Identifiers (any subset may be set)
    doi:           Optional[str] = None
    s2_id:         Optional[str] = None
    oa_id:         Optional[str] = None

    # Metadata (all optional — merge writer COALESCEs)
    title:                 Optional[str] = None
    year:                  Optional[int] = None
    authors_json:          Optional[str] = None    # already-serialised JSON list of author names
    venue:                 Optional[str] = None
    abstract:              Optional[str] = None
    pub_type:              Optional[str] = None
    publication_date:      Optional[str] = None    # ISO 'YYYY-MM-DD' when S2 has it
    is_open_access:        Optional[bool] = None
    influential_cit_count: Optional[int] = None
    s2_fields_of_study:    Optional[str] = None    # JSON array of {'category', 'source'} dicts
    pubmed_id:             Optional[str] = None
    pubmed_central_id:     Optional[str] = None
    citekey:               Optional[str] = None    # pandoc/BibTeX citation key (@key)

    # Extended bibliographic fields (BibLaTeX superset). All optional; the
    # merge writer resolves them through field_observations like the rest.
    editors_json:          Optional[str] = None    # JSON list of editor names (mirrors authors_json)
    volume:                Optional[str] = None
    issue:                 Optional[str] = None
    first_page:            Optional[str] = None
    last_page:             Optional[str] = None
    publisher:             Optional[str] = None
    booktitle:             Optional[str] = None
    series:                Optional[str] = None
    edition:               Optional[str] = None
    language:              Optional[str] = None
    month:                 Optional[str] = None
    # Editorial notice from the source DB: 'retracted'|'withdrawn'|'concern'|
    # 'corrected'. None = no notice. Producers MUST leave it None (not a
    # 'none' string) when clear, so absence never overrides a positive flag.
    editorial_status:      Optional[str] = None

    # Scheme-keyed secondary identifiers ({'issn': [...], 'isbn': [...],
    # 'arxiv': [...], ...}); routed to the identifiers table by the writer.
    extra_identifiers:     dict = field(default_factory=dict)

    # Per-source citation counts (separate table; merge writer routes these)
    cit_count:     Optional[int] = None       # accompanies oa_id when source='oa_*'
    ref_count:     Optional[int] = None

    # Free-form payload for forensics (e.g. raw OA work JSON) — optional
    raw:           Optional[str] = None

    def __post_init__(self):
        # Single choke point for title hygiene: every producer (OA, S2, NCBI,
        # bulk, RIS import, citation expansion) builds its PaperRecord here, and
        # from_json reconstructs through the same path, so a title carrying
        # JATS/HTML markup is flattened the moment it is observed -- before it
        # ever reaches Redis or the merge writer. clean_title is a no-op on
        # already-clean titles (markup-free fast path), so this is cheap.
        if self.title is not None:
            self.title = clean_title(self.title)

    # ----- helpers -----

    def identifiers(self) -> dict:
        """Return only the non-None identifiers, keyed by column name."""
        return {k: v for k, v in (
            ('doi', self.doi), ('s2_id', self.s2_id), ('oa_id', self.oa_id),
        ) if v}

    def has_identifier(self) -> bool:
        return bool(self.doi or self.s2_id or self.oa_id)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'PaperRecord':
        # Drop unknown keys so older producers' records still parse after
        # the schema grows, and new fields default to None when missing.
        data = json.loads(s)
        known = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in data.items() if k in known})


# ---------------------------------------------------------------------------
# CitationRecord
# ---------------------------------------------------------------------------

@dataclass
class CitationRecord:
    """
    A single citation edge as observed by some producer.

    Either endpoint may be addressed by DOI, OA ID, or S2 ID — whichever
    the producer happens to have. The merge writer resolves both endpoints
    to paper IDs using the same batched lookup as papers.

    If only ONE endpoint can be resolved at merge time, the edge is parked
    in pending_unresolved_citations until the other endpoint lands in papers.
    """
    source:        str
    discovered_at: str        = field(default_factory=_now)

    citing_doi:    Optional[str] = None
    citing_s2_id:  Optional[str] = None
    citing_oa_id:  Optional[str] = None

    cited_doi:     Optional[str] = None
    cited_s2_id:   Optional[str] = None
    cited_oa_id:   Optional[str] = None

    def citing_identifiers(self) -> dict:
        return {k: v for k, v in (
            ('doi', self.citing_doi),
            ('s2_id', self.citing_s2_id),
            ('oa_id', self.citing_oa_id),
        ) if v}

    def cited_identifiers(self) -> dict:
        return {k: v for k, v in (
            ('doi', self.cited_doi),
            ('s2_id', self.cited_s2_id),
            ('oa_id', self.cited_oa_id),
        ) if v}

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'CitationRecord':
        return cls(**json.loads(s))


# ---------------------------------------------------------------------------
# Claim-coordination records
# ---------------------------------------------------------------------------
#
# Background: producer modules used to talk to the claims SQLite DB directly
# (claim_candidates, bulk_mark). Five concurrent producers serialized on the
# claims-DB write lock so badly that each spent ~90% of its time sleeping on
# "database is locked". The fix moves all claims-DB writes into the single
# merge writer process, which producers communicate with via these records
# pushed into Redis lists.
#
# Flow:
#
#   Producer wants work:
#       cache.push_claim_request(ClaimRequest(service, batch_size))
#       grant = cache.pop_claim_grant(service, timeout=...)  # blocks
#       ... API work ...
#       cache.push_result_mark(ResultMark(service, succeeded_ids, failed_ids))
#
#   Writer's loop drains both directions:
#       for service in registered:
#           req = cache.pop_claim_request(service)
#           if req: ... claim_candidates(...); cache.push_claim_grant(...)
#           mark = cache.pop_result_mark(service)
#           if mark: bulk_mark(...)
# ---------------------------------------------------------------------------


@dataclass
class ClaimRequest:
    """Producer → writer: "give me up to batch_size candidates for SERVICE."""
    service:    str
    batch_size: int
    requested_at: str = field(default_factory=_now)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'ClaimRequest':
        return cls(**json.loads(s))


@dataclass
class ClaimGrant:
    """
    Writer → producer: "here are the rows I claimed for you."

    `rows` is a list of dicts with whatever columns the service's candidate
    SQL selected (always includes 'id'). Producers consume rows the same
    way they used to iterate sqlite3.Row results.
    """
    service: str
    rows:    list[dict]
    granted_at: str = field(default_factory=_now)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'ClaimGrant':
        return cls(**json.loads(s))


@dataclass
class ResultMark:
    """
    Producer → writer: per-(paper, field) outcomes for SERVICE.

    `succeeded` / `failed` are lists of [paper_id, field] pairs. Field-less
    services use field '_all'. Both lists may be empty (e.g. a batch where
    every paper errored out and we want the claims to expire naturally).
    """
    service:   str
    succeeded: list = field(default_factory=list)   # [[paper_id, field], ...]
    failed:    list = field(default_factory=list)
    marked_at: str = field(default_factory=_now)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'ResultMark':
        d = json.loads(s)
        # Back-compat shim: accept the legacy paper-level wire format
        # (succeeded_ids / failed_ids) and map each id to field '_all'.
        if 'succeeded_ids' in d or 'failed_ids' in d:
            d['succeeded'] = [[pid, '_all'] for pid in d.pop('succeeded_ids', [])]
            d['failed'] = [[pid, '_all'] for pid in d.pop('failed_ids', [])]
        return cls(**d)


# ---------------------------------------------------------------------------
# Pending-citation resolution actions
# ---------------------------------------------------------------------------
#
# Background: the merge writer used to do a periodic in-process sweep over
# pending_citations to promote rows whose endpoints had since arrived. At
# ~1M pending rows the sweep stalled the writer for minutes.
#
# Replaced with a sibling daemon `merge.pending_resolver` that does the
# sweep on a read-only DB connection (no contention with the writer) and
# pushes one of these actions per resolvable row. The writer drains them
# in batched transactions.
#
#   reader → cache.push_promote_citation(action)
#   writer → cache.pop_promote_citation_batch(N) and applies them.


@dataclass
class PromoteCitationAction:
    """
    Reader → writer: "pending_citations row #pending_id now resolves to
    (citing_id, cited_id) — apply it."

    The writer is responsible for the actual INSERT INTO citations and
    DELETE FROM pending_citations. The reader never touches the DB.
    """
    pending_id: int
    citing_id:  int
    cited_id:   int
    provenance: str
    resolved_at: str = field(default_factory=_now)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'PromoteCitationAction':
        return cls(**json.loads(s))


@dataclass
class PendingDoiBackfill:
    """Reader → writer: "OpenAlex work `oa_id` resolves to `doi` — stamp that DOI
    onto every pending_citations endpoint that currently knows the work only by
    its oa_id."

    OpenAlex's referenced_works / cites: responses identify works by OA id, never
    DOI, while Semantic Scholar references carry the DOI. So the same external
    paper appears as an oa-id-only pending endpoint AND a doi-bearing one — two
    invisible halves until this stamps the DOI on the oa-id half, unifying them.
    The writer applies the UPDATE to both the citing and cited sides; the reader
    never touches the DB.
    """
    oa_id: str
    doi:   str
    resolved_at: str = field(default_factory=_now)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'PendingDoiBackfill':
        return cls(**json.loads(s))


@dataclass
class AliasJob:
    """dedup → writer: "fold paper `loser_id` into `winner_id`." The writer
    inserts the aliases row, updates its in-RAM union-find, NULLs the loser's
    identifier columns + tombstones it (never deletes — edges keep a live
    endpoint until offline compaction), and marks the winner dirty. Reads
    resolve the loser to the winner through the alias map until compaction
    rewrites the edge endpoints.
    """
    loser_id:  int
    winner_id: int
    created_at: str = field(default_factory=_now)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'AliasJob':
        return cls(**json.loads(s))


@dataclass
class UpsertWinnerJob:
    """dedup → writer: NULL-fill the winner's columns from the merged losers.
    `fields` is {column: value} of already-resolved values the writer applies
    with COALESCE (first-write-wins), never a blind overwrite."""
    winner_id: int
    fields: dict = field(default_factory=dict)
    created_at: str = field(default_factory=_now)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'UpsertWinnerJob':
        return cls(**json.loads(s))


@dataclass
class WritePaperJob:
    """compute -> pure writer (Phase 6). A paper to apply, with the identifier
    lookup already done so the writer never probes:
      * target_id is None  -> insert a new paper (writer assigns the id; the
        in-batch map + UNIQUE index handle a same-batch / stale-snapshot dup),
      * target_id set       -> single-hit update of that (canonical) paper,
      * plan set            -> multi-hit: apply the MergePlan (tombstone+alias
        the losers, transplant ids) then single-hit the winner.
    `record` is a PaperRecord.to_json() string (re-hydrated on apply); `plan` is
    the MergePlan fields dict or None.
    """
    target_id: Optional[int]
    record: str
    plan: Optional[dict] = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'WritePaperJob':
        return cls(**json.loads(s))


@dataclass
class WriteEdgeJob:
    """compute -> pure writer: a citation edge whose endpoints already resolved
    to canonical paper ids."""
    citing_id: int
    cited_id:  int
    provenance: str

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'WriteEdgeJob':
        return cls(**json.loads(s))


@dataclass
class WritePendingEdgeJob:
    """compute -> pure writer: an edge with an unresolved endpoint, parked in
    pending_citations exactly as the legacy writer would."""
    citing_doi: Optional[str]
    citing_s2_id: Optional[str]
    citing_oa_id: Optional[str]
    cited_doi: Optional[str]
    cited_s2_id: Optional[str]
    cited_oa_id: Optional[str]
    provenance: str

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(',', ':'))

    @classmethod
    def from_json(cls, s: str) -> 'WritePendingEdgeJob':
        return cls(**json.loads(s))
