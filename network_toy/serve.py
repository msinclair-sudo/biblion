#!/usr/bin/env python3
"""Local dev server for the network-toy app — static files + a dataset API.

Replaces `python -m http.server 8000`. Same job (serve the static ES-module
app over HTTP, since `file://` can't load modules) plus a small stdlib JSON
API that drives the dataset picker and writes saves back to disk.

No third-party deps — stdlib only, keeping the toy's "no build step" promise.

The static app lives under this file's dir (network_toy/); datasets live in the
repo-root `data/` dir (one level up). The server serves `/data/<...>` URLs from
that repo-root dir directly (see Handler.translate_path), so no symlink between
the two is needed.

Layout the server understands:

    data/<dataset>/
      <dataset>_snapshot.db   embeddings.npy   paper_index.json   manifest.json
      subsets/<name>/...       # sliced derived datasets (served as static files)
      saves/<name>.zip         # workflow saves for THIS dataset (this API writes them)

A dataset is *loadable* iff it has all four core files; incomplete dirs
(e.g. a half-built PhD_proposal) are omitted from /api/datasets.

API:
    GET    /api/datasets                       -> [{id,label,nNodes,embeddingDim,domain,savesCount}]
    GET    /api/datasets/<id>/saves            -> [{name,projectName,savedAt,sizeBytes}]
    GET    /api/datasets/<id>/saves/<name>     -> the save zip bytes
    POST   /api/datasets/<id>/saves/<name>     -> atomic write of the body
    DELETE /api/datasets/<id>/saves/<name>     -> unlink
    GET    /api/datasets/<id>/tags             -> {"<paperId>": ["tag", ...], ...}
    POST   /api/datasets/<id>/tags             -> {adds:[{paperId,tag,category?}], removes:[...]}
    GET    /api/datasets/<id>/tag-categories   -> {vocabulary:[...], byTag:{"<tag>":"<category>"}}

User tags are read/written against the dataset's LIVE project DB (data/<project>/
<project>.db, stripping any "::subset"), NOT the read-only snapshot — so a tag
survives re-snapshotting and is visible to the biblion CLI. The merge writer
never touches the paper_tags table, so these writes only take a brief WAL
writer-lock (busy_timeout); a dataset shipped snapshot-only (no live DB) reads
as {} and rejects writes with 409.

Path-safety: <id> is validated against the discovered dataset set; <name> is
sanitised (no '/', no '..', must end '.zip'). Everything else falls through to
static file serving.
"""

import argparse
import json
import os
import re
import sqlite3
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
# Datasets live in the repo-root data/ dir (one level up from network_toy/),
# not under network_toy/ itself. Resolved directly here so the toy needs no
# network_toy/data symlink; /data/ URLs are mapped to this dir in the Handler.
DATA = ROOT.parent / "data"
_DEFAULT_PORT = int(os.environ.get("NETWORK_TOY_PORT", "8000"))

# The four files that make a data/<id> dir a loadable dataset (see datasource/
# sqlite.js — the snapshot DB, the .npy embedding, the row->id index, and the
# identity manifest must all be present for the in-browser loader to align).
def _core_files(dataset_id):
    return [
        DATA / dataset_id / f"{dataset_id}_snapshot.db",
        DATA / dataset_id / "embeddings.npy",
        DATA / dataset_id / "paper_index.json",
        DATA / dataset_id / "manifest.json",
    ]


def _is_loadable(dataset_id):
    return all(p.exists() for p in _core_files(dataset_id))


def discover_datasets():
    """All loadable datasets under data/, with stats from each manifest.json."""
    out = []
    if not DATA.exists():
        return out
    for child in sorted(DATA.iterdir()):
        if not child.is_dir():
            continue
        dataset_id = child.name
        if not _is_loadable(dataset_id):
            continue
        manifest = {}
        try:
            manifest = json.loads((child / "manifest.json").read_text())
        except (ValueError, OSError):
            # A loadable dir with an unreadable manifest still lists, just
            # without the optional stat fields.
            manifest = {}
        out.append({
            "id": dataset_id,
            "label": manifest.get("label") or manifest.get("name") or dataset_id,
            # biblion's snapshot manifest uses snake_case; tolerate both.
            "nNodes": manifest.get("n_nodes") or manifest.get("nNodes"),
            "embeddingDim": manifest.get("embedding_dim") or manifest.get("embeddingDim"),
            "domain": manifest.get("domain"),
            "savesCount": _count_saves(dataset_id),
        })
    return out


def _saves_dir(dataset_id):
    return DATA / dataset_id / "saves"


# ── tags (read/write against the live project DB) ────────────────────────────
_TAG_NAME_MAX = 64

# Fixed tag-category vocabulary. A category is a property of the tag *label*
# (BRCA1 is always a gene), surfaced to the UI via /api/tag-categories so the
# picker can't drift from what the server will accept. "" / None = uncategorised.
# Mirrored by biblion's paper_tags schema; add a category by editing this list.
TAG_CATEGORIES = ["species", "gene", "method", "theme"]

_PAPER_TAGS_SCHEMA = """
CREATE TABLE IF NOT EXISTS paper_tags (
    paper_id INTEGER NOT NULL REFERENCES papers(id),
    tag      TEXT    NOT NULL,
    added_at TEXT    NOT NULL,
    added_by TEXT,
    category TEXT,
    PRIMARY KEY (paper_id, tag)
)
"""


def _live_db_path(dataset_id):
    """The LIVE project DB for a dataset id, stripping any '::subset' suffix
    (subsets share their project's DB). May not exist — datasets can ship
    snapshot-only (no live <project>.db)."""
    sep = dataset_id.find("::")
    project_id = dataset_id if sep == -1 else dataset_id[:sep]
    return DATA / project_id / f"{project_id}.db"


def _open_live_db(dataset_id):
    """Open the dataset's live project DB read/write with a busy_timeout, ensure
    the paper_tags table exists, and return the connection — or None when the
    live DB is absent (snapshot-only dataset)."""
    path = _live_db_path(dataset_id)
    if not path.exists():
        return None
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA journal_mode = WAL")
    # The table is in biblion's _SCHEMA, but a live DB created before this
    # feature won't have it; CREATE IF NOT EXISTS is cheap and idempotent.
    conn.execute(_PAPER_TAGS_SCHEMA)
    # A table created before the category feature lacks the column; add it.
    # Mirrors biblion.db._migrate_paper_tags_columns (ALTER can't be conditional
    # in SQL, so check table_info first).
    cols = {r[1] for r in conn.execute("PRAGMA table_info(paper_tags)").fetchall()}
    if "category" not in cols:
        conn.execute("ALTER TABLE paper_tags ADD COLUMN category TEXT")
    return conn


def _clean_tag(raw):
    """Sanitise a tag name: trim, reject empty / over-long / containing ',' or
    ';' (those would split the keywords field on .bib/.ris re-import)."""
    if not isinstance(raw, str):
        return None
    t = raw.strip()
    if not t or len(t) > _TAG_NAME_MAX or "," in t or ";" in t:
        return None
    return t


def _clean_category(raw):
    """Normalise a tag category: '' / None / missing -> '' (uncategorised); a
    value in TAG_CATEGORIES passes through; anything else is rejected (None)."""
    if raw is None or raw == "":
        return ""
    if isinstance(raw, str) and raw in TAG_CATEGORIES:
        return raw
    return None


def read_tags(dataset_id):
    """{ '<paperId>': ['tag', ...] } from the live DB; {} if snapshot-only."""
    conn = _open_live_db(dataset_id)
    if conn is None:
        return {}
    try:
        out = {}
        for r in conn.execute("SELECT paper_id, tag FROM paper_tags ORDER BY paper_id, tag"):
            out.setdefault(str(r["paper_id"]), []).append(r["tag"])
        return out
    finally:
        conn.close()


def read_tag_categories(dataset_id):
    """{ '<tag>': '<category>' } for tags that carry one, from the live DB; {}
    if snapshot-only. Category is a property of the label, so one row per tag."""
    conn = _open_live_db(dataset_id)
    if conn is None:
        return {}
    try:
        out = {}
        for r in conn.execute(
            "SELECT DISTINCT tag, category FROM paper_tags "
            "WHERE category IS NOT NULL AND category != '' ORDER BY tag"):
            out[r["tag"]] = r["category"]
        return out
    finally:
        conn.close()


def _count_saves(dataset_id):
    d = _saves_dir(dataset_id)
    if not d.exists():
        return 0
    return sum(1 for p in d.glob("*.zip"))


def list_saves(dataset_id):
    """Saves under data/<id>/saves/, with header info from each zip's manifest."""
    d = _saves_dir(dataset_id)
    out = []
    if not d.exists():
        return out
    for zip_path in sorted(d.glob("*.zip")):
        project_name = None
        saved_at = None
        try:
            with zipfile.ZipFile(zip_path) as zf:
                manifest = json.loads(zf.read("manifest.json"))
                project_name = manifest.get("projectName")
                saved_at = manifest.get("savedAt")
        except (zipfile.BadZipFile, KeyError, ValueError, OSError):
            # A corrupt or non-toy zip still lists by filename; the picker can
            # show it and the loader will reject it loudly on open.
            pass
        out.append({
            "name": zip_path.name,
            "projectName": project_name,
            "savedAt": saved_at,
            "sizeBytes": zip_path.stat().st_size,
        })
    return out


# Save filenames: a single path segment ending .zip, no separators / dotdot.
_SAFE_NAME = re.compile(r"^[^/\\]+\.zip$")


def _safe_save_name(name):
    if not name or not _SAFE_NAME.match(name):
        return None
    if ".." in name or "/" in name or "\\" in name:
        return None
    return name


class Handler(SimpleHTTPRequestHandler):
    # Static files (the /app/ ES-module tree) come from network_toy/; dataset
    # files under /data/ come from the repo-root data/ dir (DATA). See
    # translate_path — this split is what removes the need for a data symlink.
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path):
        # Map /data/<...> URLs onto DATA (repo-root data/) instead of ROOT.
        # We temporarily swap self.directory and defer to the stdlib
        # translate_path so its path-safety normalisation (which strips '..'
        # segments) still applies — guarding against traversal out of DATA.
        clean = urlparse(path).path
        if clean == "/data" or clean.startswith("/data/"):
            rel = clean[len("/data/"):]
            saved, self.directory = self.directory, str(DATA)
            try:
                return super().translate_path("/" + rel)
            finally:
                self.directory = saved
        return super().translate_path(path)

    # --- helpers -----------------------------------------------------------

    def _send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status, message):
        self._send_json({"error": message}, status=status)

    def _api_parts(self):
        """If the request path is /api/datasets[...], return its segments
        after that prefix; otherwise None (so it falls through to static)."""
        path = urlparse(self.path).path
        prefix = "/api/datasets"
        if path == prefix:
            return []
        if path.startswith(prefix + "/"):
            rest = path[len(prefix) + 1:]
            return [unquote(seg) for seg in rest.split("/") if seg != ""]
        return None

    def _resolve_save_path(self, parts):
        """parts == [<id>, 'saves', <name>] -> (dataset_id, name, path) or
        sends an error and returns None. Validates id against the discovered
        set and sanitises the save name (path-traversal defence)."""
        if len(parts) != 3 or parts[1] != "saves":
            self._send_error_json(HTTPStatus.NOT_FOUND, "unknown saves route")
            return None
        dataset_id, _, raw_name = parts
        if dataset_id not in {d["id"] for d in discover_datasets()}:
            self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown dataset {dataset_id!r}")
            return None
        name = _safe_save_name(raw_name)
        if name is None:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid save name")
            return None
        return dataset_id, name, _saves_dir(dataset_id) / name

    def _do_tags_post(self, dataset_id):
        """Apply a batch of tag adds/removes to the dataset's live project DB.
        Body: {"adds": [{paperId, tag}, ...], "removes": [...]}. Snapshot-only
        datasets reject with 409; a write-lock timeout returns 503."""
        if dataset_id not in {d["id"] for d in discover_datasets()}:
            return self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown dataset {dataset_id!r}")
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid JSON")
        conn = _open_live_db(dataset_id)
        if conn is None:
            return self._send_error_json(
                HTTPStatus.CONFLICT,
                "dataset has no live database (snapshot-only); tags cannot be written")
        now = datetime.now(timezone.utc).isoformat()
        applied = 0
        try:
            with conn:                       # one transaction: commit or roll back
                for item in (body.get("adds") or []):
                    if not isinstance(item, dict):
                        continue
                    tag = _clean_tag(item.get("tag"))
                    pid = item.get("paperId")
                    category = _clean_category(item.get("category"))
                    if tag is None or category is None or not isinstance(pid, int):
                        continue             # bad tag/unknown category -> skip
                    if not conn.execute("SELECT 1 FROM papers WHERE id = ?", (pid,)).fetchone():
                        continue             # unknown paper -> skip (clean, no FK trap)
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO paper_tags "
                        "(paper_id, tag, added_at, added_by, category) "
                        "VALUES (?, ?, ?, 'network_toy', ?)",
                        (pid, tag, now, category or None))
                    applied += cur.rowcount
                    # Category is a property of the label: when an explicit
                    # (non-empty) category is given, keep every row of this tag
                    # consistent. Also re-homes the INSERT-OR-IGNORE no-op case
                    # (tag already present) onto the chosen category.
                    if category:
                        conn.execute(
                            "UPDATE paper_tags SET category = ? WHERE tag = ? "
                            "AND (category IS NULL OR category != ?)",
                            (category, tag, category))
                for item in (body.get("removes") or []):
                    if not isinstance(item, dict):
                        continue
                    tag = _clean_tag(item.get("tag"))
                    pid = item.get("paperId")
                    if tag is None or not isinstance(pid, int):
                        continue
                    cur = conn.execute(
                        "DELETE FROM paper_tags WHERE paper_id = ? AND tag = ?", (pid, tag))
                    applied += cur.rowcount
        except sqlite3.OperationalError as e:
            return self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, f"database busy: {e}")
        finally:
            conn.close()
        return self._send_json({"ok": True, "applied": applied}, status=HTTPStatus.OK)

    # --- verbs -------------------------------------------------------------

    def do_GET(self):
        parts = self._api_parts()
        if parts is None:
            return super().do_GET()
        if parts == []:
            return self._send_json(discover_datasets())
        if len(parts) == 2 and parts[1] == "saves":
            dataset_id = parts[0]
            if dataset_id not in {d["id"] for d in discover_datasets()}:
                return self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown dataset {dataset_id!r}")
            return self._send_json(list_saves(dataset_id))
        if len(parts) == 2 and parts[1] == "tags":
            dataset_id = parts[0]
            if dataset_id not in {d["id"] for d in discover_datasets()}:
                return self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown dataset {dataset_id!r}")
            return self._send_json(read_tags(dataset_id))
        if len(parts) == 2 and parts[1] == "tag-categories":
            dataset_id = parts[0]
            if dataset_id not in {d["id"] for d in discover_datasets()}:
                return self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown dataset {dataset_id!r}")
            # vocabulary is the fixed list (same for every dataset); byTag is this
            # dataset's current label->category assignments.
            return self._send_json({
                "vocabulary": TAG_CATEGORIES,
                "byTag": read_tag_categories(dataset_id),
            })
        resolved = self._resolve_save_path(parts)
        if resolved is None:
            return
        _, _, path = resolved
        if not path.exists():
            return self._send_error_json(HTTPStatus.NOT_FOUND, "save not found")
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        parts = self._api_parts()
        if parts is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "no such endpoint")
        if len(parts) == 2 and parts[1] == "tags":
            return self._do_tags_post(parts[0])
        resolved = self._resolve_save_path(parts)
        if resolved is None:
            return
        _, _, path = resolved
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write-then-rename for atomicity (no half-written save on crash),
        # mirroring biblion/projects.py.
        tmp = path.with_suffix(".zip.tmp")
        tmp.write_bytes(body)
        os.replace(tmp, path)
        self._send_json({"ok": True, "name": path.name, "sizeBytes": len(body)},
                        status=HTTPStatus.CREATED)

    def do_DELETE(self):
        parts = self._api_parts()
        if parts is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "no such endpoint")
        resolved = self._resolve_save_path(parts)
        if resolved is None:
            return
        _, _, path = resolved
        if not path.exists():
            return self._send_error_json(HTTPStatus.NOT_FOUND, "save not found")
        path.unlink()
        self._send_json({"ok": True})


def main():
    parser = argparse.ArgumentParser(description="network-toy dev server")
    parser.add_argument("--port", type=int, default=_DEFAULT_PORT,
                        help=f"port to listen on (default: {_DEFAULT_PORT})")
    args = parser.parse_args()
    port = args.port

    # Bind to loopback only: the server does unauthenticated reads of the whole
    # data tree and write/delete of saves, so it must not be reachable off-host.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"network-toy serving {ROOT} at http://localhost:{port}/app/")
    print(f"  dataset API: http://localhost:{port}/api/datasets")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
