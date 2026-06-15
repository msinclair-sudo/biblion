#!/usr/bin/env python3
"""Local dev server for the network-toy app — static files + a dataset API.

Replaces `python -m http.server 8000`. Same job (serve the static ES-module
app over HTTP, since `file://` can't load modules) plus a small stdlib JSON
API that drives the dataset picker and writes saves back to disk.

No third-party deps — stdlib only, keeping the toy's "no build step" promise.

Layout the server understands (rooted at this file's dir, network_toy/, whose
`data` symlinks to the repo-root `data/`):

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

Path-safety: <id> is validated against the discovered dataset set; <name> is
sanitised (no '/', no '..', must end '.zip'). Everything else falls through to
static file serving.
"""

import argparse
import json
import os
import re
import zipfile
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
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
    # Serve static files from network_toy/ so /app/, /data/ (symlink) resolve.
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

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

    server = ThreadingHTTPServer(("", port), Handler)
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
