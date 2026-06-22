"""
Union-find over the `aliases` table — the dedup substrate for the enrich
redesign.

A merged-away "loser" paper is never deleted; an `aliases(loser_id, winner_id)`
row folds it into the "winner" it duplicates, and `papers.tombstone` is set on
the loser. Reads resolve a paper id to its canonical winner through this map
until offline compaction (Phase 7) rewrites edge endpoints and drops tombstones.

The map holds only *non-identity* entries: a paper id absent from the map is its
own canonical id (this mirrors the `papers.canonical_id IS NULL == id`
convention, so an unmerged corpus needs zero memory). `find()` is path-compressed
so chains (a -> b -> c) collapse on first lookup.

The writer is the sole applier of alias rows (it owns this map in-RAM and updates
it via `union()` as it commits alias jobs), so the persisted table is only ever
written through `union()` semantics and cannot contain a cycle. `add_edge()` —
used only when loading trusted rows — still guards against closing a loop so a
corrupt table can't make `find()` spin.
"""
from __future__ import annotations

import sqlite3
from typing import Iterable


class AliasMap:
    """In-RAM union-find loadable from the `aliases` table.

    Only non-identity mappings are stored; `find(x)` returns `x` for any id not
    in the map. Pointers always run loser-root -> winner-root, so the canonical
    id of a cluster is whichever winner was never itself a loser.
    """

    __slots__ = ("_parent",)

    def __init__(self) -> None:
        self._parent: dict[int, int] = {}

    # -- queries -----------------------------------------------------------
    def find(self, pid: int) -> int:
        """Canonical id for `pid`, with path compression. Identity if absent."""
        parent = self._parent
        path: list[int] = []
        while pid in parent:
            path.append(pid)
            pid = parent[pid]
        # `pid` is now the root; repoint every node on the path straight at it.
        for node in path:
            parent[node] = pid
        return pid

    def resolve_many(self, ids: Iterable[int]) -> dict[int, int]:
        """Batch `find()`; returns {id: canonical_id} for every input id."""
        return {i: self.find(i) for i in ids}

    def __contains__(self, pid: int) -> bool:
        return pid in self._parent

    def __len__(self) -> int:
        """Number of non-identity mappings (merged-away losers)."""
        return len(self._parent)

    # -- mutation ----------------------------------------------------------
    def union(self, loser: int, winner: int) -> None:
        """Fold `loser`'s cluster into `winner`'s. Cycle-safe by construction
        (always points root -> root); a no-op if already unified."""
        rl = self.find(loser)
        rw = self.find(winner)
        if rl == rw:
            return
        self._parent[rl] = rw

    def add_edge(self, loser: int, winner: int) -> None:
        """Insert a raw loser -> winner edge while loading from the DB.

        Unlike `union()` this does not re-root through `find(loser)` — the table
        stores one winner per loser (PK on loser_id), so each loser is a fresh
        node. It still refuses an edge that would close a cycle, so a corrupt
        table can't make `find()` loop; `rebuild()` compresses afterwards.
        """
        if loser == winner:
            return
        if self.find(winner) == loser:
            return  # would close a loop — drop the offending edge
        self._parent[loser] = winner

    def rebuild(self) -> None:
        """Full path-compression pass so every entry points straight at its
        root. Call once after bulk `add_edge()` loading."""
        for node in list(self._parent):
            self.find(node)

    # -- construction ------------------------------------------------------
    @classmethod
    def load(cls, conn: sqlite3.Connection) -> "AliasMap":
        """Build from the `aliases` table on an open connection."""
        m = cls()
        for loser, winner in conn.execute(
            "SELECT loser_id, winner_id FROM aliases"
        ):
            m.add_edge(loser, winner)
        m.rebuild()
        return m
