"""serve.py tag endpoints — GET/POST /api/datasets/<id>/tags against the live DB.

serve.py is plain stdlib, so we import it, point DATA at a tmp dataset dir, and
drive a real ThreadingHTTPServer on an ephemeral port. Covers: empty read, batch
add (with a rejected comma-tag + unknown paper), read-back, remove, and the
snapshot-only 409.
"""
import importlib.util
import json
import sqlite3
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]      # .../biblion
SERVE_PY = REPO_ROOT / "network_toy" / "serve.py"


def _load_serve():
    spec = importlib.util.spec_from_file_location("serve_under_test", SERVE_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _make_dataset(data_dir, dataset_id, with_live_db=True):
    """A loadable dataset dir: snapshot + (optionally) live DB + core files."""
    from biblion import db
    ds = data_dir / dataset_id
    ds.mkdir(parents=True)
    names = [f"{dataset_id}_snapshot.db"] + ([f"{dataset_id}.db"] if with_live_db else [])
    for name in names:
        conn = sqlite3.connect(str(ds / name))
        conn.row_factory = sqlite3.Row
        db.init_db(conn)
        conn.execute(
            "INSERT INTO papers (id, title, abstract, year, is_seed, is_stub, "
            "is_rejected, discovery_count, created_at) "
            "VALUES (1, 'T', 'A', 2020, 0, 0, 0, 1, datetime('now'))")
        conn.commit()
        conn.close()
    (ds / "embeddings.npy").write_bytes(b"\x93NUMPY")          # presence only
    (ds / "paper_index.json").write_text(json.dumps({"0": 1}))
    (ds / "manifest.json").write_text(json.dumps({"n_nodes": 1}))
    return ds


def _server(serve):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def _req(url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def test_tag_read_write_round_trip(tmp_path):
    serve = _load_serve()
    serve.DATA = tmp_path
    _make_dataset(tmp_path, "proj", with_live_db=True)
    httpd, port = _server(serve)
    base = f"http://127.0.0.1:{port}/api/datasets/proj/tags"
    try:
        assert _req(base) == (200, {})
        # one valid add; a comma-tag (rejected) and an unknown paper (skipped)
        status, resp = _req(base, "POST", {"adds": [
            {"paperId": 1, "tag": "to-read"},
            {"paperId": 1, "tag": "bad,tag"},
            {"paperId": 999, "tag": "ghost"},
        ]})
        assert status == 200 and resp["applied"] == 1
        assert _req(base) == (200, {"1": ["to-read"]})
        # remove
        status, resp = _req(base, "POST", {"removes": [{"paperId": 1, "tag": "to-read"}]})
        assert status == 200 and resp["applied"] == 1
        assert _req(base) == (200, {})
    finally:
        httpd.shutdown()

    # the write landed in the LIVE db, not the snapshot
    live = sqlite3.connect(str(tmp_path / "proj" / "proj.db"))
    assert live.execute("SELECT COUNT(*) FROM paper_tags").fetchone()[0] == 0
    live.close()


def test_snapshot_only_dataset_reads_empty_and_rejects_writes(tmp_path):
    serve = _load_serve()
    serve.DATA = tmp_path
    _make_dataset(tmp_path, "snaponly", with_live_db=False)
    httpd, port = _server(serve)
    base = f"http://127.0.0.1:{port}/api/datasets/snaponly/tags"
    try:
        assert _req(base) == (200, {})                       # no live DB -> {}
        status, _ = _req(base, "POST", {"adds": [{"paperId": 1, "tag": "x"}]})
        assert status == 409                                 # cannot write
    finally:
        httpd.shutdown()
