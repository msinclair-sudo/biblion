"""Named node subsets: build_selector (shared with export) + build_subset
(carve a slim, embeddable-only slice sharing the project snapshot DB)."""
import argparse
import json
import sqlite3

import pytest

from biblion import db
from biblion.snapshot import build_subset, write_subset_index
from biblion.__main__ import build_selector, _SelectorError


def _make_snapshot(path):
    """A stand-in project snapshot DB: 3 embeddable papers + 1 abstract-less."""
    conn = sqlite3.connect(str(path))
    db.init_db(conn)
    now = "2026-01-01T00:00:00Z"
    rows = [
        (1, "P1", "abs", 2021, 1),   # embeddable, seed, recent
        (2, "P2", "abs", 2019, 0),   # embeddable, old
        (3, "P3", "abs", 2022, 1),   # embeddable, seed, recent
        (4, "P4", None, 2021, 0),    # abstract-less -> NOT embeddable
    ]
    for pid, title, abstract, year, seed in rows:
        conn.execute(
            "INSERT INTO papers (id, title, abstract, year, is_seed, is_stub, "
            "is_rejected, discovery_count, created_at) VALUES (?,?,?,?,?,0,0,1,?)",
            (pid, title, abstract, year, seed, now))
    conn.commit()
    conn.close()


def _args(**kw):
    base = dict(seeds=False, all=False, year=None, ids=None, where=None)
    base.update(kw)
    return argparse.Namespace(**base)


@pytest.mark.unit
def test_build_selector_variants():
    assert build_selector(_args(seeds=True)) == ("is_seed = 1", ())
    assert build_selector(_args(all=True)) == ("1 = 1", ())
    assert build_selector(_args(year=2019)) == ("year = ?", (2019,))
    where, params = build_selector(_args(ids="2,3"))
    assert where == "id IN (?,?)" and params == ("2", "3")
    assert build_selector(_args(where="year >= 2020")) == ("year >= 2020", ())


@pytest.mark.unit
def test_build_selector_requires_exactly_one():
    with pytest.raises(_SelectorError):
        build_selector(_args())                       # none
    with pytest.raises(_SelectorError):
        build_selector(_args(seeds=True, year=2020))  # two
    with pytest.raises(_SelectorError):
        build_selector(_args(ids="   "))              # empty ids


@pytest.mark.unit
def test_build_subset_where(tmp_path):
    snap = tmp_path / "proj_snapshot.db"
    _make_snapshot(snap)

    manifest = build_subset(snap, "recent", "year >= 2020", (), tmp_path, "proj")

    # year>=2020 AND embeddable -> ids 1 and 3 (id 4 has no abstract; id 2 old).
    assert manifest["n_nodes"] == 2
    assert manifest["selector"] == "year >= 2020"
    assert manifest["snapshot_db"] == "proj_snapshot.db"

    sd = tmp_path / "subsets" / "recent"
    index = json.loads((sd / "paper_index.json").read_text())
    assert index == {"0": 1, "1": 3}                  # ordered by id
    nodes = [json.loads(l) for l in (sd / "nodes.jsonl").read_text().splitlines()]
    assert [nd["id"] for nd in nodes] == [1, 3]
    assert manifest["embedding_model"] is None        # embed step fills this in

    # index.json lists the subset, not yet embedded.
    idx = json.loads((tmp_path / "subsets" / "index.json").read_text())
    assert idx["subsets"] == [
        {"name": "recent", "label": "recent", "n_nodes": 2,
         "selector": "year >= 2020", "embedded": False}
    ]


@pytest.mark.unit
def test_build_subset_ids_and_empty_and_missing(tmp_path):
    snap = tmp_path / "proj_snapshot.db"
    _make_snapshot(snap)

    where, params = build_selector(_args(ids="3,2"))
    m = build_subset(snap, "picks", where, params, tmp_path, "proj")
    # IN() ignores order; node set is ORDER BY id -> [2, 3].
    assert m["n_nodes"] == 2
    index = json.loads((tmp_path / "subsets" / "picks" / "paper_index.json").read_text())
    assert index == {"0": 2, "1": 3}

    with pytest.raises(ValueError):                   # selector matches nothing
        build_subset(snap, "none", "year < 1900", (), tmp_path, "proj")

    with pytest.raises(FileNotFoundError):            # project not snapshotted
        build_subset(tmp_path / "absent_snapshot.db", "x", "1=1", (), tmp_path, "p")


@pytest.mark.unit
def test_write_subset_index_marks_embedded(tmp_path):
    snap = tmp_path / "proj_snapshot.db"
    _make_snapshot(snap)
    build_subset(snap, "recent", "year >= 2020", (), tmp_path, "proj")
    # Simulate the embedding step having written embeddings.npy.
    (tmp_path / "subsets" / "recent" / "embeddings.npy").write_bytes(b"\x00")
    write_subset_index(tmp_path)
    idx = json.loads((tmp_path / "subsets" / "index.json").read_text())
    assert idx["subsets"][0]["embedded"] is True
