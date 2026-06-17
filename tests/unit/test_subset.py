"""Named node subsets: build_selector (shared with export) + build_subset
(carve a slim, embeddable-only slice sharing the project snapshot DB)."""
import argparse
import json
import sqlite3
import struct

import pytest

from biblion import db
from biblion.npy_slice import _v1_header, read_npy_header
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
    base = dict(seeds=False, all=False, year=None, ids=None, ids_file=None, where=None)
    base.update(kw)
    return argparse.Namespace(**base)


def _write_master(project_dir, ids, d=4, manifest=None):
    """Write a stand-in project master: embeddings.npy (row i = ids[i], filled
    with float(ids[i])) + paper_index.json + manifest.json. Returns the matrix."""
    mat = [[float(pid)] * d for pid in ids]
    payload = b"".join(struct.pack("<f", x) for row in mat for x in row)
    (project_dir / "embeddings.npy").write_bytes(_v1_header(len(ids), d) + payload)
    (project_dir / "paper_index.json").write_text(
        json.dumps({str(i): pid for i, pid in enumerate(ids)}))
    man = manifest if manifest is not None else {
        "embedding_model": "allenai/specter2_base",
        "embedding_adapter": "allenai/specter2",
        "embedding_dim": d, "embedding_normalized": False, "embedding_domain": "soil",
    }
    (project_dir / "manifest.json").write_text(json.dumps(man))
    return mat


def _row_bytes(path, i):
    n, dd, _dt, off = read_npy_header(path)
    with open(path, "rb") as f:
        f.seek(off + i * dd * 4)
        return f.read(dd * 4)


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
def test_build_selector_ids_file(tmp_path):
    # flat list
    f = tmp_path / "flat.json"
    f.write_text(json.dumps([3, 1]))
    where, params = build_selector(_args(ids_file=str(f)))
    assert where == "id IN (?,?)" and params == (3, 1)
    # cart export shape
    f.write_text(json.dumps({"papers": [{"id": 5, "source": "L2·c1"}, {"id": 6}]}))
    where, params = build_selector(_args(ids_file=str(f)))
    assert params == (5, 6)
    # {"ids": [...]}
    f.write_text(json.dumps({"ids": [9]}))
    assert build_selector(_args(ids_file=str(f)))[1] == (9,)
    # bad shapes / empty
    f.write_text(json.dumps({"nope": 1}))
    with pytest.raises(_SelectorError):
        build_selector(_args(ids_file=str(f)))
    f.write_text(json.dumps([]))
    with pytest.raises(_SelectorError):
        build_selector(_args(ids_file=str(f)))
    with pytest.raises(_SelectorError):                # missing file
        build_selector(_args(ids_file=str(tmp_path / "nope.json")))


def _make_resolvable_snapshot(path):
    """Snapshot whose papers carry a DOI / a citekey / an arXiv identifier, so a
    .bib can be resolved back to each by a different key."""
    conn = sqlite3.connect(str(path))
    db.init_db(conn)
    now = "2026-01-01T00:00:00Z"
    rows = [
        # id, title, doi,            citekey
        (1, "P1", "10.1234/p1",      None),
        (2, "P2", None,              "jones2019foo"),
        (3, "P3", None,              None),            # resolved via arXiv id
    ]
    for pid, title, doi, citekey in rows:
        conn.execute(
            "INSERT INTO papers (id, title, abstract, year, doi, citekey, is_seed, "
            "is_stub, is_rejected, discovery_count, created_at) "
            "VALUES (?,?,?,?,?,?,0,0,0,1,?)",
            (pid, title, "abs", 2021, doi, citekey, now))
    conn.execute("INSERT INTO identifiers (paper_id, scheme, value, source) "
                 "VALUES (3, 'arxiv', '2101.00003', 'test')")
    conn.commit()
    conn.close()


@pytest.mark.unit
def test_ids_from_bib_resolves_by_doi_citekey_identifier(tmp_path):
    snap = tmp_path / "proj_snapshot.db"
    _make_resolvable_snapshot(snap)
    bib = tmp_path / "cart.bib"
    bib.write_text(
        "@article{p1key,\n  title = {P1},\n  doi = {10.1234/P1},\n}\n\n"      # DOI, case-insensitive
        "@article{jones2019foo,\n  title = {P2},\n}\n\n"                      # citekey
        "@article{p3key,\n  title = {P3},\n  eprint = {2101.00003},\n"
        "  eprinttype = {arxiv},\n}\n\n"                                      # arXiv identifier
        "@article{ghostkey,\n  title = {Nope},\n  doi = {10.9999/missing},\n}\n"  # unresolved -> skipped
    )
    conn = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
    try:
        where, params = build_selector(_args(ids_file=str(bib)), conn=conn)
    finally:
        conn.close()
    assert where == "id IN (?,?,?)"
    assert sorted(params) == [1, 2, 3]


@pytest.mark.unit
def test_ids_from_bib_needs_conn_and_errors_when_nothing_matches(tmp_path):
    snap = tmp_path / "proj_snapshot.db"
    _make_resolvable_snapshot(snap)
    bib = tmp_path / "cart.bib"
    bib.write_text("@article{x,\n  title = {Z},\n  doi = {10.9999/none},\n}\n")
    # A .bib selector needs a DB connection.
    with pytest.raises(_SelectorError):
        build_selector(_args(ids_file=str(bib)))
    # conn present but no entry matches -> error (not a silent empty subset).
    conn = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
    try:
        with pytest.raises(_SelectorError):
            build_selector(_args(ids_file=str(bib)), conn=conn)
        # An entry-less .bib also errors.
        empty = tmp_path / "empty.bib"
        empty.write_text("% no entries here\n")
        with pytest.raises(_SelectorError):
            build_selector(_args(ids_file=str(empty)), conn=conn)
    finally:
        conn.close()


@pytest.mark.unit
def test_build_subset_slices_master(tmp_path):
    snap = tmp_path / "proj_snapshot.db"
    _make_snapshot(snap)
    _write_master(tmp_path, [1, 2, 3])               # master rows 0..2 = ids 1,2,3

    where, params = build_selector(_args(ids="3,1"))
    m = build_subset(snap, "picks", where, params, tmp_path, "proj")

    sd = tmp_path / "subsets" / "picks"
    # node set is ORDER BY id -> [1, 3]; both present in master -> flat index.
    assert json.loads((sd / "paper_index.json").read_text()) == {"0": 1, "1": 3}
    # manifest stamped from the master, dim from the npy header.
    assert m["embedding_model"] == "allenai/specter2_base"
    assert m["embedding_dim"] == 4
    assert m["embedding_normalized"] is False
    assert "include_structural" not in m
    # Δ=0: subset row i is byte-identical to its master row (id1->row0, id3->row2).
    assert _row_bytes(sd / "embeddings.npy", 0) == _row_bytes(tmp_path / "embeddings.npy", 0)
    assert _row_bytes(sd / "embeddings.npy", 1) == _row_bytes(tmp_path / "embeddings.npy", 2)
    # index marks it embedded.
    idx = json.loads((tmp_path / "subsets" / "index.json").read_text())
    assert idx["subsets"][0]["embedded"] is True


@pytest.mark.unit
def test_build_subset_master_absent_goes_structural(tmp_path):
    snap = tmp_path / "proj_snapshot.db"
    _make_snapshot(snap)
    _write_master(tmp_path, [1, 2])                  # master lacks id 3

    where, params = build_selector(_args(ids="1,3"))
    m = build_subset(snap, "mix", where, params, tmp_path, "proj")

    sd = tmp_path / "subsets" / "mix"
    # present (id1) first, absent (id3) demoted to a structural row.
    assert json.loads((sd / "paper_index.json").read_text()) == {
        "0": {"id": 1, "structural": False},
        "1": {"id": 3, "structural": True},
    }
    assert m["include_structural"] is True
    assert m["n_embedded"] == 1 and m["n_structural"] == 1
    # only the embedded row got a vector.
    assert read_npy_header(sd / "embeddings.npy")[0] == 1
    assert _row_bytes(sd / "embeddings.npy", 0) == _row_bytes(tmp_path / "embeddings.npy", 0)


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
