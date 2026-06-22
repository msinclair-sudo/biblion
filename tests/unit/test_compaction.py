"""
Phase 7 compaction: rewrite aliased edges to winners (including chains),
re-home sidecar rows, delete tombstoned losers, leave FKs clean.
"""
import sqlite3

import pytest

from biblion import db as _db
from biblion.enrich.compaction import compact_conn, compact


pytestmark = pytest.mark.unit


def _build(conn):
    """winner=1, loser=2 (alias 2->1), loser=3 (alias 3->2, chain ->1),
    node=4. Edges keyed to losers + a node->loser edge. Sidecar on a loser."""
    now = "2026-01-01T00:00:00Z"
    for pid, tomb in ((1, 0), (2, 1), (3, 1), (4, 0)):
        conn.execute(
            "INSERT INTO papers (id, title, abstract, tombstone, created_at) "
            "VALUES (?, 'P', 'a', ?, ?)", (pid, tomb, now))
    conn.execute("INSERT INTO aliases (loser_id, winner_id, created_at) "
                 "VALUES (2, 1, ?)", (now,))
    conn.execute("INSERT INTO aliases (loser_id, winner_id, created_at) "
                 "VALUES (3, 2, ?)", (now,))           # chain 3 -> 2 -> 1
    for citing, cited in ((2, 4), (3, 4), (4, 2)):
        conn.execute("INSERT INTO citations (citing_id, cited_id, provenance) "
                     "VALUES (?, ?, 'x')", (citing, cited))
    conn.execute("INSERT INTO citation_counts (paper_id, source, cit_count) "
                 "VALUES (2, 's2', 9)")
    conn.commit()


class TestCompactConn:
    def test_rewrites_rehomes_and_deletes(self, db_conn):
        _build(db_conn)
        stats = compact_conn(db_conn, dry_run=False)
        db_conn.commit()
        edges = sorted(tuple(r) for r in db_conn.execute(
            "SELECT citing_id, cited_id FROM citations"))
        # All loser-keyed edges collapse onto winner 1; node->loser becomes
        # node->winner. No self-loops, no loser endpoints.
        assert edges == [(1, 4), (4, 1)]
        # Losers gone.
        ids = [r[0] for r in db_conn.execute("SELECT id FROM papers ORDER BY id")]
        assert ids == [1, 4]
        # Sidecar re-homed to the winner.
        cc = db_conn.execute(
            "SELECT paper_id FROM citation_counts").fetchall()
        assert [r[0] for r in cc] == [1]
        assert stats['papers_deleted'] == 2
        # FK integrity (compact_conn raises otherwise, but assert explicitly).
        assert db_conn.execute("PRAGMA foreign_key_check").fetchall() == []

    def test_canonical_view_is_noop_after_compaction(self, db_conn):
        _build(db_conn)
        compact_conn(db_conn, dry_run=False)
        db_conn.commit()
        raw = sorted(tuple(r) for r in db_conn.execute(
            "SELECT citing_id, cited_id FROM citations"))
        canon = sorted(tuple(r) for r in db_conn.execute(
            "SELECT citing_id, cited_id FROM citations_canonical"))
        assert raw == canon            # nothing left to resolve

    def test_dry_run_writes_nothing(self, db_conn):
        _build(db_conn)
        before = db_conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        stats = compact_conn(db_conn, dry_run=True)
        after = db_conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        assert before == after == 4
        assert stats['papers_deleted'] == 2     # would delete 2

    def test_empty_aliases_noop(self, db_conn):
        db_conn.execute("INSERT INTO papers (id, title, created_at) "
                        "VALUES (1, 'P', '2026-01-01')")
        db_conn.commit()
        stats = compact_conn(db_conn, dry_run=False)
        assert stats['losers'] == 0


class TestCompactFile:
    def test_compact_file_force(self, tmp_path):
        path = tmp_path / 'c.db'
        conn = _db.get_connection(path)
        _db.init_db(conn)
        _build(conn)
        conn.close()
        stats = compact(path, force=True)       # force: no daemon guard in test
        assert stats['papers_deleted'] == 2
        conn = sqlite3.connect(str(path))
        assert [r[0] for r in conn.execute("SELECT id FROM papers ORDER BY id")] == [1, 4]
        conn.close()
