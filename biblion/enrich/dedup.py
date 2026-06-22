"""
Dedup planner — turns a cluster of duplicate paper rows into a merge plan the
writer applies as alias + upsert, instead of the Resolver's delete + re-home.

Same winner rule as merge/resolver._pick_winner (most populated metadata, then
lowest id) and the same field/identifier reconciliation, so the resulting
canonical record matches the Resolver's. The difference is purely structural:
losers are tombstoned and aliased to the winner (their edges stay put and resolve
through the alias map until compaction) rather than deleted with edges re-homed.

Pure functions — no DB, no Redis. The writer (Phase 5, flagged) or a dedup
producer (Phase 6) consumes the plan.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Mirrors merge/resolver._FIELDS so the winner choice is identical.
_FIELDS = ('doi', 's2_id', 'oa_id', 'title', 'year', 'venue', 'authors',
           'abstract', 'pub_type')
_ID_COLS = ('doi', 's2_id', 'oa_id')
_META_COLS = ('title', 'year', 'venue', 'authors', 'abstract', 'pub_type')


def _populated_count(row) -> int:
    return sum(1 for f in _FIELDS if row[f] is not None)


def pick_winner(rows):
    """Most populated metadata, tiebreak lowest id — identical to the Resolver."""
    return min(rows, key=lambda r: (-_populated_count(r), r['id']))


@dataclass
class MergePlan:
    winner_id: int
    loser_ids: list
    # identifier columns to transplant onto the winner (winner was NULL).
    identifier_transplants: dict = field(default_factory=dict)
    # non-identifier columns to NULL-fill on the winner (first-write-wins).
    field_fills: dict = field(default_factory=dict)
    # (column, winner_value, loser_value) genuine disagreements to log.
    conflicts: list = field(default_factory=list)


def plan_merge(rows) -> MergePlan:
    """Plan the merge of >=2 duplicate rows. `rows` are sqlite Rows / mappings
    exposing `id` + the _FIELDS columns. First-write-wins fills the winner's
    NULLs; differing identifiers are recorded as conflicts (not overwritten)."""
    winner = pick_winner(rows)
    losers = [r for r in rows if r['id'] != winner['id']]
    transplants: dict = {}
    fills: dict = {}
    conflicts: list = []
    # Track the winner's effective values as fills accumulate (first-write-wins
    # across multiple losers).
    wvals = {c: winner[c] for c in _FIELDS}

    for loser in losers:
        for col in _ID_COLS:
            lval = loser[col]
            if lval is None:
                continue
            if wvals[col] is None:
                transplants[col] = lval
                wvals[col] = lval
            elif wvals[col] != lval:
                conflicts.append((col, wvals[col], lval))
        for col in _META_COLS:
            lval = loser[col]
            if lval is None:
                continue
            if wvals[col] is None:
                fills[col] = lval
                wvals[col] = lval

    return MergePlan(
        winner_id=winner['id'],
        loser_ids=[loser['id'] for loser in losers],
        identifier_transplants=transplants,
        field_fills=fills,
        conflicts=conflicts,
    )
