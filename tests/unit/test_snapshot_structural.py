"""Part B (spec §3): --include-structural surfaces stub / abstract-less
'ghost' endpoints as nodes, emitted AFTER the embedded nodes so embeddings.npy
stays a contiguous m*d block."""
import json
import sqlite3

import pytest

from biblion import db
from biblion.snapshot import run_snapshot


def _make_db(path):
    conn = sqlite3.connect(str(path))
    db.init_db(conn)
    now = "2026-01-01T00:00:00Z"
    # id=1: a full paper (title + abstract) -> embedded.
    # id=2: an abstract-less paper (has title, no abstract) -> structural.
    conn.execute(
        "INSERT INTO papers (id, title, abstract, year, is_stub, is_rejected, "
        "discovery_count, created_at) VALUES "
        "(1, 'Full Paper', 'An abstract.', 2020, 0, 0, 1, ?)", (now,))
    conn.execute(
        "INSERT INTO papers (id, title, abstract, year, is_stub, is_rejected, "
        "discovery_count, created_at) VALUES "
        "(2, 'Ghost Endpoint', NULL, 2019, 0, 0, 1, ?)", (now,))
    conn.execute(
        "INSERT INTO citations (citing_id, cited_id, provenance, discovered) "
        "VALUES (1, 2, 'test', ?)", (now,))
    conn.commit()
    conn.close()


@pytest.mark.unit
def test_include_structural_orders_embedded_first(tmp_path):
    live = tmp_path / "b.db"
    _make_db(live)

    manifest = run_snapshot(live, out_dir=tmp_path, include_structural=True)

    # Manifest counts.
    assert manifest["n_nodes"] == 2
    assert manifest["n_embedded"] == 1
    assert manifest["n_structural"] == 1
    assert manifest["include_structural"] is True
    assert manifest["node_set_where"] == (
        "is_rejected = 0 AND tombstone = 0 AND title IS NOT NULL")

    # nodes.jsonl: embedded (row 0) first, structural (row 1) last.
    lines = (tmp_path / "nodes.jsonl").read_text().splitlines()
    nodes = [json.loads(line) for line in lines]
    assert [nd["row"] for nd in nodes] == [0, 1]
    assert nodes[0]["id"] == 1 and nodes[0]["structural"] is False
    assert nodes[1]["id"] == 2 and nodes[1]["structural"] is True

    # paper_index.json carries the flag in structural mode.
    index = json.loads((tmp_path / "paper_index.json").read_text())
    assert index["0"]["id"] == 1 and index["0"]["structural"] is False
    assert index["1"]["id"] == 2 and index["1"]["structural"] is True


@pytest.mark.unit
def test_default_excludes_structural(tmp_path):
    """Flag absent: only the full paper is a node, plain index, no structural keys."""
    live = tmp_path / "b.db"
    _make_db(live)

    manifest = run_snapshot(live, out_dir=tmp_path)

    assert manifest["n_nodes"] == 1
    assert "n_structural" not in manifest
    assert "include_structural" not in manifest

    index = json.loads((tmp_path / "paper_index.json").read_text())
    assert index == {"0": 1}
    nodes = [json.loads(l) for l in (tmp_path / "nodes.jsonl").read_text().splitlines()]
    assert len(nodes) == 1
    assert "structural" not in nodes[0]


def _make_alias_db(path):
    """winner=1, loser=2 (tombstoned, ids freed, aliased to 1), node=3.
    Edge from the loser (2->3) must be rewritten to the winner (1->3)."""
    conn = sqlite3.connect(str(path))
    db.init_db(conn)
    now = "2026-01-01T00:00:00Z"
    for pid, title in ((1, 'Winner'), (3, 'Other')):
        conn.execute(
            "INSERT INTO papers (id, title, abstract, year, is_stub, "
            "is_rejected, tombstone, discovery_count, created_at) VALUES "
            "(?, ?, 'abs', 2020, 0, 0, 0, 1, ?)", (pid, title, now))
    # Loser: tombstoned, identifiers freed (as the writer leaves them).
    conn.execute(
        "INSERT INTO papers (id, title, abstract, year, is_stub, is_rejected, "
        "tombstone, discovery_count, created_at) VALUES "
        "(2, 'Loser', 'abs', 2019, 0, 0, 1, 1, ?)", (now,))
    conn.execute("INSERT INTO aliases (loser_id, winner_id, created_at) "
                 "VALUES (2, 1, ?)", (now,))
    # Edge keyed to the (tombstoned) loser, plus a normal edge.
    conn.execute("INSERT INTO citations (citing_id, cited_id, provenance, "
                 "discovered) VALUES (2, 3, 'test', ?)", (now,))
    conn.commit()
    conn.close()


@pytest.mark.unit
def test_snapshot_rewrites_alias_edges_and_excludes_tombstone(tmp_path):
    live = tmp_path / "b.db"
    _make_alias_db(live)
    run_snapshot(live, out_dir=tmp_path)
    snap = tmp_path / "b_snapshot.db"
    conn = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
    try:
        edges = conn.execute(
            "SELECT citing_id, cited_id FROM citations ORDER BY citing_id").fetchall()
        node_ids = [r[0] for r in conn.execute(
            "SELECT id FROM papers WHERE is_rejected=0 AND tombstone=0 "
            "AND is_stub=0 AND title IS NOT NULL AND abstract IS NOT NULL")]
    finally:
        conn.close()
    # Loser-keyed edge 2->3 rewritten to the winner 1->3; no edge on the loser.
    assert (1, 3) in edges
    assert all(c != 2 and t != 2 for c, t in edges)
    # Tombstoned loser excluded from the node set.
    assert 2 not in node_ids and set(node_ids) == {1, 3}
