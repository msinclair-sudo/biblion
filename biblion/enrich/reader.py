"""
Reader — the single read-once scan of the enrich redesign.

Cadence is PURE DIRTY-SET: the merge writer SADDs every committed (canonical)
paper id onto `dirty:papers`; the Reader SPOPs a batch, canonicalises each id
through the alias map (the set may transiently hold merged-away losers), and in
ONE scan builds a WorkItem per paper:

  * a presence bitmask over identifiers / metadata / biblio columns,
  * the attempted matrix for the paper (status per (service, field) from
    enrichment_attempts), and
  * the `needs` set — the (service, field) pairs still wanted, reproducing the
    union of today's CANDIDATE_QUERIES eligibility WITHOUT running per-module SQL.

On first start (Redis flag `dirty:seeded` absent) it seeds the whole corpus once
so every existing paper is evaluated, then runs purely incrementally.

Phase 2 runs this in SHADOW: it computes needs and (via enrich/shadow.py) asserts
they match the SQL registry, but dispatches nothing and writes nothing.
"""
from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass, field as _dc_field
from pathlib import Path
from typing import Callable, Iterable, Optional

from ..merge.aliasmap import AliasMap
from ..framework.claims import _retry_cutoff_iso, stale_claim_cutoff_iso

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Presence bitmask. Compact summary of which columns/edges a paper already has.
# ---------------------------------------------------------------------------
BIT_DOI       = 1 << 0
BIT_S2        = 1 << 1
BIT_OA        = 1 << 2
BIT_PMID      = 1 << 3
BIT_TITLE     = 1 << 4
BIT_ABSTRACT  = 1 << 5
BIT_AUTHORS   = 1 << 6
BIT_VENUE     = 1 << 7
BIT_YEAR      = 1 << 8
BIT_PUBTYPE   = 1 << 9
BIT_VOLUME    = 1 << 10
BIT_FIRSTPAGE = 1 << 11
BIT_PUBLISHER = 1 << 12
BIT_REFS      = 1 << 13   # outgoing references fetched (attempt field 'refs')
BIT_CITES     = 1 << 14   # incoming citations fetched (attempt field 'cites')

# (column name -> bit) for the column-derived bits. Edge bits (refs/cites) come
# from the attempted matrix, not a column, so they're set separately.
_COLUMN_BITS = (
    ('doi', BIT_DOI), ('s2_id', BIT_S2), ('oa_id', BIT_OA),
    ('pubmed_id', BIT_PMID), ('title', BIT_TITLE), ('abstract', BIT_ABSTRACT),
    ('authors', BIT_AUTHORS), ('venue', BIT_VENUE), ('year', BIT_YEAR),
    ('pub_type', BIT_PUBTYPE), ('volume', BIT_VOLUME),
    ('first_page', BIT_FIRSTPAGE), ('publisher', BIT_PUBLISHER),
)

# Columns the Reader scans per paper. Drives both the bitmask and the needs
# predicates below.
SCAN_COLUMNS = (
    'id', 'doi', 's2_id', 'oa_id', 'pubmed_id',
    'title', 'abstract', 'authors', 'venue', 'year', 'pub_type',
    'volume', 'first_page', 'publisher',
    'is_seed', 'is_stub', 'is_rejected', 'tombstone',
)


# ---------------------------------------------------------------------------
# Needs spec — the Python re-expression of CANDIDATE_QUERIES (framework/claims).
#
# Each entry mirrors one registry module: a paper-level precondition (identifier
# / flag gates) and, per field, whether that field is still wanted. The "(field
# IS NULL OR ...)" clause in each candidate_sql WHERE is subsumed by the
# per-field need, so the precondition here keeps only the identifier / is_rejected
# / is_seed gates. Modules sharing a (service, field) collapse to one need via
# the union in Reader.needs_for().
#
# The is_seed gate on the metadata + incoming-citation entries is LOAD-BEARING:
# it leaf-bounds expansion to the seeds (see CANDIDATE_QUERIES comments and the
# citation-coverage-termination guard). Reproduce it exactly.
# ---------------------------------------------------------------------------

# `cols` is a dict of the SCAN_COLUMNS for a paper. Ints 0/1 for the flags.
ColPred = Callable[[dict], bool]
NeedPred = Callable[[dict, str], bool]


def _null(c: dict, f: str) -> bool:
    """Field still wanted because the column is NULL."""
    return c[f] is None


def _always(c: dict, f: str) -> bool:
    """Grain-less need ('_all' / 'cites'): the want lives wholly in precond."""
    return True


@dataclass(frozen=True)
class NeedSpec:
    module: str                 # CANDIDATE_QUERIES key (traceability only)
    service: str
    fields: tuple
    precond: ColPred
    need: NeedPred = _null


NEEDS_SPEC: tuple[NeedSpec, ...] = (
    NeedSpec('enrich_metadata_oa', 'oa',
             ('abstract', 'authors', 'venue', 'year', 'pub_type'),
             precond=lambda c: c['doi'] is not None and not c['is_rejected']
             and bool(c['is_seed'])),
    NeedSpec('enrich_metadata_s2', 's2_live',
             ('abstract', 'authors', 'venue', 'year', 'pub_type'),
             precond=lambda c: c['doi'] is not None and not c['is_rejected']
             and bool(c['is_seed'])),
    NeedSpec('enrich_metadata_ncbi', 'ncbi',
             ('abstract', 'title', 'year'),
             precond=lambda c: (c['pubmed_id'] is not None or c['doi'] is not None)
             and not c['is_rejected'] and bool(c['is_seed'])),
    NeedSpec('enrich_biblio_crossref', 'crossref',
             ('volume', 'first_page', 'publisher'),
             precond=lambda c: c['doi'] is not None and not c['is_rejected']
             and bool(c['is_seed'])),
    NeedSpec('enrich_stubs_oa', 'oa', ('_all',),
             precond=lambda c: c['oa_id'] is not None and not c['is_rejected']
             and c['title'] is None,
             need=_always),
    NeedSpec('resolve_dois_oa', 'oa', ('_all',),
             precond=lambda c: c['doi'] is None and c['title'] is not None
             and not c['is_rejected'],
             need=_always),
    NeedSpec('resolve_dois_s2', 's2_live', ('_all',),
             precond=lambda c: c['doi'] is None and c['title'] is not None
             and not c['is_rejected'],
             need=_always),
    NeedSpec('resolve_dois_via_pmid', 'ncbi_pmid', ('_all',),
             precond=lambda c: c['pubmed_id'] is not None and c['doi'] is None
             and not c['is_rejected'],
             need=_always),
    NeedSpec('resolve_dois_via_s2id', 's2_live', ('_all',),
             precond=lambda c: c['s2_id'] is not None and c['doi'] is None
             and not c['is_rejected'],
             need=_always),
    NeedSpec('expand_papers_s2', 's2_hop', ('_all',),
             precond=lambda c: (c['doi'] is not None or c['s2_id'] is not None)
             and not c['is_rejected'],
             need=_always),
    NeedSpec('expand_incoming_oa', 'oa_incoming', ('cites',),
             precond=lambda c: c['oa_id'] is not None and not c['is_rejected']
             and bool(c['is_seed']),
             need=_always),
    NeedSpec('expand_papers_s2_seeds', 's2_hop', ('_all',),
             precond=lambda c: (c['doi'] is not None or c['s2_id'] is not None)
             and not c['is_rejected'] and bool(c['is_seed']),
             need=_always),
)


# ---------------------------------------------------------------------------
# Work item
# ---------------------------------------------------------------------------

@dataclass
class WorkItem:
    paper_id: int                          # canonical id
    cols: dict                             # SCAN_COLUMNS values
    present: int                          # presence bitmask
    # (service, field) -> (status, finished_at, claimed_at) from enrichment_attempts
    attempts: dict
    needs: set                            # {(service, field), ...} still wanted

    def has(self, bit: int) -> bool:
        return bool(self.present & bit)


def _compute_present(cols: dict, attempts: dict) -> int:
    present = 0
    for col, bit in _COLUMN_BITS:
        if cols.get(col) is not None:
            present |= bit
    # Edge coverage from the attempted matrix (any service that fetched them).
    for (_svc, fld), (status, _fin, _cl) in attempts.items():
        if status == 'succeeded':
            if fld == 'refs':
                present |= BIT_REFS
            elif fld == 'cites':
                present |= BIT_CITES
    return present


# ---------------------------------------------------------------------------
# Reader
# ---------------------------------------------------------------------------

class Reader:
    """Read-once dirty-set consumer. Read-only on both DBs.

    Uses a get_claims_connection (claims DB open, main DB ATTACHed as main_v3
    read-only); unqualified `papers` / `enrichment_attempts` resolve to the
    right schema. The Reader never writes either DB.
    """

    def __init__(self, cache, main_db_path: Path,
                 claims_db_path: Optional[Path] = None,
                 retry_days: Optional[int] = None):
        from ..db import get_claims_connection
        self.cache = cache
        self.main_db_path = main_db_path
        self._conn = get_claims_connection(
            claims_db_path=claims_db_path, main_db_path=main_db_path)
        self._aliases = AliasMap.load(self._conn)
        self._alias_count = self._count_aliases()
        self._retry_days = retry_days

    # -- lifecycle ---------------------------------------------------------
    def close(self) -> None:
        c = getattr(self, '_conn', None)
        if c is not None:
            try:
                c.close()
            except Exception:
                pass
            self._conn = None

    def __del__(self):
        self.close()

    def _count_aliases(self) -> int:
        return self._conn.execute("SELECT COUNT(*) FROM aliases").fetchone()[0]

    def _refresh_aliases_if_changed(self) -> None:
        """Reload the alias map when the table has grown (a snapshot can go stale
        between dedup commits, building items for soon-dead losers otherwise)."""
        n = self._count_aliases()
        if n != self._alias_count:
            self._aliases = AliasMap.load(self._conn)
            self._alias_count = n

    # -- dirty-set bootstrap + drain --------------------------------------
    def seed_corpus_if_needed(self) -> int:
        """One-time full-corpus seed so every existing live paper is evaluated.
        Idempotent via the dirty:seeded flag. Returns rows seeded (0 if already)."""
        if self.cache.dirty_seeded():
            return 0
        ids = [r[0] for r in self._conn.execute(
            "SELECT id FROM papers WHERE tombstone = 0")]
        self.cache.seed_dirty_all(ids)
        self.cache.mark_dirty_seeded()
        return len(ids)

    def next_dirty_batch(self, n: int) -> list[int]:
        """SPOP up to n ids and canonicalise. A popped loser is dropped and its
        winner re-added to the set (self-healing); the returned list is the
        de-duplicated canonical ids to actually evaluate this pass."""
        raw = self.cache.pop_dirty_papers(n)
        if not raw:
            return []
        self._refresh_aliases_if_changed()
        canon: list[int] = []
        seen: set[int] = set()
        readd: list[int] = []
        for pid in raw:
            cid = self._aliases.find(pid)
            if cid != pid:
                readd.append(cid)        # loser popped -> re-home onto winner
            if cid not in seen:
                seen.add(cid)
                canon.append(cid)
        if readd:
            self.cache.add_dirty_papers(readd)
        return canon

    # -- scan -> work items ------------------------------------------------
    def build_items(self, paper_ids: Iterable[int]) -> list[WorkItem]:
        """One scan over papers + one over enrichment_attempts for the batch."""
        ids = [int(i) for i in paper_ids]
        if not ids:
            return []
        rows = self._scan_papers(ids)
        attempts = self._scan_attempts(ids)
        items: list[WorkItem] = []
        for cols in rows:
            pid = cols['id']
            at = attempts.get(pid, {})
            present = _compute_present(cols, at)
            item = WorkItem(paper_id=pid, cols=cols, present=present,
                            attempts=at, needs=set())
            item.needs = self.needs_for(item)
            items.append(item)
        return items

    def _scan_papers(self, ids: list[int]) -> list[dict]:
        """Fetch SCAN_COLUMNS for the batch via a VALUES probe (mirrors the
        writer's _batch_lookup idiom — avoids a giant IN-list)."""
        out: list[dict] = []
        select = ', '.join(f'p.{c}' for c in SCAN_COLUMNS)
        # Chunk to stay well under SQLite's parameter limit.
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            placeholders = ', '.join(['(?)'] * len(chunk))
            sql = (f"WITH probe(id) AS (VALUES {placeholders}) "
                   f"SELECT {select} FROM probe JOIN papers p ON p.id = probe.id")
            for r in self._conn.execute(sql, chunk):
                out.append({c: r[c] for c in SCAN_COLUMNS})
        return out

    def _scan_attempts(self, ids: list[int]) -> dict:
        """paper_id -> {(service, field): (status, finished_at, claimed_at)}."""
        out: dict[int, dict] = {}
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            placeholders = ', '.join(['(?)'] * len(chunk))
            sql = (f"WITH probe(id) AS (VALUES {placeholders}) "
                   "SELECT ea.paper_id, ea.service, ea.field, ea.status, "
                   "       ea.finished_at, ea.claimed_at "
                   "FROM probe JOIN enrichment_attempts ea "
                   "  ON ea.paper_id = probe.id")
            for r in self._conn.execute(sql, chunk):
                out.setdefault(r['paper_id'], {})[(r['service'], r['field'])] = (
                    r['status'], r['finished_at'], r['claimed_at'])
        return out

    # -- needs -------------------------------------------------------------
    def _attempt_blocks(self, item: WorkItem, service: str, field: str,
                        retry_iso: str, stale_iso: str) -> bool:
        """True if this (service, field) is already settled or in flight, i.e.
        succeeded / currently (recently) claimed / failed too recently to retry —
        exactly the not-eligible condition from claims._build_eligibility.

        A 'claimed' row only blocks while fresh: one older than the stale-claim
        window (claimed_at <= stale_iso) no longer blocks, so a claim that
        outlived its producer (crash, SIGTERM between claim and mark, a
        daily-limit break mid-flight) self-heals instead of pinning its paper
        forever — matching the expiry claim_candidates() applies on the legacy
        path."""
        prior = item.attempts.get((service, field))
        if prior is None:
            return False
        status, finished_at, claimed_at = prior
        if status == 'succeeded':
            return True
        if status == 'claimed':
            return (claimed_at or '') > stale_iso
        if status == 'failed' and (finished_at or '') > retry_iso:
            return True
        return False

    def needs_for(self, item: WorkItem) -> set:
        """The (service, field) pairs still wanted for this paper — the union
        over NEEDS_SPEC, deduped (modules sharing a (service, field) collapse)."""
        retry_iso = _retry_cutoff_iso(self._retry_days)
        stale_iso = stale_claim_cutoff_iso()
        needs: set = set()
        c = item.cols
        for spec in NEEDS_SPEC:
            if not spec.precond(c):
                continue
            for f in spec.fields:
                if (spec.service, f) in needs:
                    continue           # already established by another module
                if not spec.need(c, f):
                    continue
                if self._attempt_blocks(item, spec.service, f, retry_iso, stale_iso):
                    continue
                needs.add((spec.service, f))
        return needs
