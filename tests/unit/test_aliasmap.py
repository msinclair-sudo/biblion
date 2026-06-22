"""
Tests for biblion.merge.aliasmap.AliasMap — the dedup union-find.

Pure unit tests (no Redis); only `test_load_*` touches a DB via the db_conn
fixture, which now ships the `aliases` table.
"""
import pytest

from biblion.merge.aliasmap import AliasMap


pytestmark = pytest.mark.unit


class TestFind:
    def test_identity_when_absent(self):
        m = AliasMap()
        assert m.find(7) == 7          # an unmerged id is its own canonical
        assert len(m) == 0             # find() of an absent id adds nothing

    def test_single_edge(self):
        m = AliasMap()
        m.union(1, 2)                  # 1 (loser) folds into 2 (winner)
        assert m.find(1) == 2
        assert m.find(2) == 2

    def test_chain_collapses(self):
        m = AliasMap()
        m.union(1, 2)
        m.union(2, 3)
        m.union(3, 4)
        # Every id in the chain resolves to the ultimate winner.
        assert m.find(1) == 4
        assert m.find(2) == 4
        assert m.find(3) == 4

    def test_path_compression_flattens(self):
        # Build a chain with raw edges (no re-rooting), then assert find()
        # repoints intermediate nodes straight at the root.
        m = AliasMap()
        m.add_edge(1, 2)
        m.add_edge(2, 3)
        m.add_edge(3, 4)
        assert m.find(1) == 4
        # After compression 1 points directly at 4, not via 2/3.
        assert m._parent[1] == 4
        assert m._parent[2] == 4


class TestUnion:
    def test_idempotent_reunion(self):
        m = AliasMap()
        m.union(1, 2)
        m.union(1, 2)                  # repeat is a no-op
        assert m.find(1) == 2
        assert len(m) == 1

    def test_already_unified_noop(self):
        m = AliasMap()
        m.union(1, 3)
        m.union(2, 3)
        # 1 and 2 already share root 3; unioning them does nothing new.
        before = dict(m._parent)
        m.union(1, 2)
        assert m._parent == before
        assert m.find(1) == 3 and m.find(2) == 3

    def test_transitive_winner_was_loser(self):
        # winner (2) is later itself merged into 3 — losers of 2 must follow.
        m = AliasMap()
        m.union(1, 2)
        m.union(2, 3)
        assert m.find(1) == 3

    def test_cycle_is_noop(self):
        # union always points root -> root, so the reverse union can't cycle.
        m = AliasMap()
        m.union(1, 2)
        m.union(2, 1)                  # roots already equal -> no-op
        assert m.find(1) == m.find(2)


class TestAddEdge:
    def test_self_edge_ignored(self):
        m = AliasMap()
        m.add_edge(5, 5)
        assert len(m) == 0
        assert m.find(5) == 5

    def test_refuses_cycle(self):
        # A corrupt pair (a->b, b->a) must not make find() spin: the second
        # edge is dropped because b already resolves to a's cluster... here
        # winner(1) resolves to 2, and loser is 2 -> closing the loop, drop it.
        m = AliasMap()
        m.add_edge(1, 2)
        m.add_edge(2, 1)              # would close the loop -> ignored
        assert m.find(1) == 2
        assert m.find(2) == 2        # terminates (no infinite loop)


class TestRebuild:
    def test_rebuild_compresses_all(self):
        m = AliasMap()
        m.add_edge(1, 2)
        m.add_edge(2, 3)
        m.add_edge(3, 4)
        m.rebuild()
        # Every stored node now points straight at the root.
        assert m._parent[1] == 4
        assert m._parent[2] == 4
        assert m._parent[3] == 4


class TestResolveMany:
    def test_batch(self):
        m = AliasMap()
        m.union(1, 2)
        m.union(3, 4)
        assert m.resolve_many([1, 2, 3, 4, 99]) == {
            1: 2, 2: 2, 3: 4, 4: 4, 99: 99,
        }


class TestLoad:
    def test_load_from_db(self, db_conn):
        db_conn.executemany(
            "INSERT INTO aliases (loser_id, winner_id, created_at) "
            "VALUES (?, ?, datetime('now'))",
            [(1, 2), (2, 3), (10, 11)],
        )
        db_conn.commit()
        m = AliasMap.load(db_conn)
        assert m.find(1) == 3          # chain 1->2->3 collapsed on load
        assert m.find(2) == 3
        assert m.find(10) == 11
        assert m.find(42) == 42        # absent id is identity

    def test_load_empty_is_identity(self, db_conn):
        m = AliasMap.load(db_conn)
        assert len(m) == 0
        assert m.find(123) == 123
