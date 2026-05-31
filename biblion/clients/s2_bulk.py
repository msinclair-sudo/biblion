"""
Semantic Scholar Datasets API client.

Distinct from clients.semanticscholar (which talks to the live Graph API).
This client only knows how to:

  1. List weekly releases.
  2. List datasets in a release.
  3. Fetch the (signed) file URLs for a dataset.
  4. Stream a gzipped JSONL file into Python records.

The Datasets API is rate-limited modestly (a handful of metadata calls per
run), so we don't bother with throttling — but we DO retry transient
network errors on the bulk file streams, where a single dropped read of a
1.8 GB file is otherwise a 20-minute setback.

Auth: same `x-api-key` header as the Graph API, sourced from the
`semantic_scholar_key` env var (loaded by biblion.config).

Important security note: the file URLs returned by step 3 are pre-signed
S3 URLs. They grant download access for ~7 days and MUST NOT be logged
verbatim. Helpers in this module elide the query string when printing.
"""
from __future__ import annotations

import gzip
import io
import json
import logging
import os
import time
from typing import Iterator, Optional
from urllib.parse import urlsplit

import requests


S2_DATASETS_BASE_URL = 'https://api.semanticscholar.org/datasets/v1'
S2_API_KEY_ENV       = 'semantic_scholar_key'

# Per-file streaming defaults
_STREAM_CONNECT_T   = 30
_STREAM_READ_T      = 300
_STREAM_CHUNK_BYTES = 1024 * 1024     # 1 MB
_STREAM_MAX_RETRIES = 5
_STREAM_BACKOFF_S   = (2, 5, 15, 30, 60)

# Metadata-call (release/dataset listing) defaults — small payloads, polite
_META_TIMEOUT   = (10, 30)
_META_RETRIES   = 3


_log = logging.getLogger(__name__)


def _get_api_key() -> str:
    """Read S2 API key from .env via the package config side-effect."""
    from .. import config       # noqa: F401  (loads .env into os.environ)
    return os.environ.get(S2_API_KEY_ENV, '')


def _redact_url(url: str) -> str:
    """Strip signature query string before logging a pre-signed S3 URL."""
    parts = urlsplit(url)
    if parts.query:
        return f"{parts.scheme}://{parts.netloc}{parts.path}?<signed-params>"
    return url


class S2BulkClient:
    """
    Datasets API client.

    No throttling on metadata calls — a release listing is ~3 KB, a
    dataset listing ~6 KB, and we hit each once per bulk run.

    The streaming helper retries with exponential backoff on transient
    network errors. URLs themselves remain valid for ~7 days, so a re-fetch
    via `dataset_files()` is the right move if a download spans that long.
    """

    def __init__(self, api_key: Optional[str] = None):
        self.api_key  = api_key if api_key is not None else _get_api_key()
        self._session = requests.Session()

    # ------------------------------------------------------------------
    # Metadata calls
    # ------------------------------------------------------------------

    def _headers(self) -> dict:
        h = {'Accept': 'application/json'}
        if self.api_key:
            h['x-api-key'] = self.api_key
        return h

    def _get_json(self, path: str) -> Optional[dict | list]:
        url = S2_DATASETS_BASE_URL + path if not path.startswith('http') else path
        for attempt in range(_META_RETRIES + 1):
            try:
                resp = self._session.get(url, headers=self._headers(),
                                         timeout=_META_TIMEOUT)
            except requests.exceptions.RequestException as e:
                if attempt >= _META_RETRIES:
                    _log.error("Datasets API request failed after retries: %s", e)
                    return None
                time.sleep(2 ** attempt)
                continue
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 404:
                return None
            if resp.status_code in (401, 403):
                _log.error("Datasets API %s on %s (auth?): %s",
                           resp.status_code, path, resp.text[:200])
                return None
            if attempt >= _META_RETRIES:
                _log.error("Datasets API %s on %s: %s",
                           resp.status_code, path, resp.text[:200])
                return None
            time.sleep(2 ** attempt)
        return None

    def list_releases(self) -> list[str]:
        """Return all release IDs (YYYY-MM-DD strings), newest last."""
        data = self._get_json('/release/')
        return list(data) if isinstance(data, list) else []

    def latest_release(self) -> Optional[str]:
        releases = self.list_releases()
        return releases[-1] if releases else None

    def list_datasets(self, release_id: str) -> list[dict]:
        """List the datasets available in a release (no signed URLs yet)."""
        data = self._get_json(f'/release/{release_id}')
        if isinstance(data, dict):
            return data.get('datasets') or []
        return []

    def dataset_files(self, release_id: str, dataset_name: str) -> Optional[dict]:
        """
        Fetch the dataset descriptor including signed file URLs.

        Returns a dict with keys: name, description, README, files.
        Returns None if the dataset doesn't exist or auth failed.

        The URLs in `files` are pre-signed S3 URLs valid for ~7 days.
        Re-call this method if your run spans long enough for them to expire.
        """
        data = self._get_json(f'/release/{release_id}/dataset/{dataset_name}')
        if isinstance(data, dict):
            return data
        return None

    # ------------------------------------------------------------------
    # Download-then-read: download once to disk, then iterate locally.
    #
    # Why not stream directly? On urllib3 ≥ 2.0, a generator paused on
    # yield() between bulk records races against the underlying socket's
    # auto-close logic. Downloading to a regular file removes that whole
    # category of failure and gets us resumable per-file retries.
    # ------------------------------------------------------------------

    def download_file(
        self,
        url: str,
        dest: 'os.PathLike[str] | str',
        *,
        expected_size: Optional[int] = None,
    ) -> int:
        """
        Download `url` to `dest`. Atomic via temp-then-rename.

        Skips the download if `dest` already exists and either:
          - `expected_size` was passed and matches dest's size; or
          - `expected_size` was not passed (we trust whatever is on disk).

        Returns the number of bytes written (0 if skipped).
        """
        from pathlib import Path as _P
        dest = _P(dest)
        if dest.exists():
            actual = dest.stat().st_size
            if expected_size is None or actual == expected_size:
                _log.info("download_file: %s already exists (%d bytes); skipping",
                          dest.name, actual)
                return 0
            _log.warning("download_file: %s size mismatch "
                         "(have %d, expected %d) — redownloading",
                         dest.name, actual, expected_size)
            dest.unlink()

        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + '.partial')
        last_err: Optional[BaseException] = None
        for attempt in range(_STREAM_MAX_RETRIES + 1):
            try:
                written = self._download_one(url, tmp)
                os.replace(tmp, dest)
                return written
            except (requests.exceptions.RequestException,
                    OSError, ConnectionError) as e:
                last_err = e
                if attempt >= _STREAM_MAX_RETRIES:
                    break
                wait = _STREAM_BACKOFF_S[min(attempt, len(_STREAM_BACKOFF_S) - 1)]
                _log.warning("download_file of %s failed (%s); "
                             "retry %d/%d after %ds",
                             _redact_url(url), e, attempt + 1,
                             _STREAM_MAX_RETRIES, wait)
                try: tmp.unlink()
                except FileNotFoundError: pass
                time.sleep(wait)
        try: tmp.unlink()
        except FileNotFoundError: pass
        raise RuntimeError(
            f"download_file exhausted retries for {_redact_url(url)}: {last_err}"
        )

    def _download_one(self, url: str, dest_path) -> int:
        """Single attempt — caller handles retries."""
        from pathlib import Path as _P
        dest_path = _P(dest_path)
        resp = self._session.get(
            url, stream=True,
            timeout=(_STREAM_CONNECT_T, _STREAM_READ_T),
        )
        try:
            resp.raise_for_status()
            written = 0
            with open(dest_path, 'wb') as f:
                # decode_content=False — we want the bytes on disk to be the
                # gzipped bytes S3 served, not auto-decompressed content.
                for chunk in resp.raw.stream(_STREAM_CHUNK_BYTES,
                                             decode_content=False):
                    if not chunk:
                        continue
                    f.write(chunk)
                    written += len(chunk)
            return written
        finally:
            resp.close()


def iter_jsonl_gz_file(path) -> Iterator[dict]:
    """Iterate parsed records from a local gzipped JSONL file."""
    from pathlib import Path as _P
    path = _P(path)
    with gzip.open(path, 'rb') as gz:
        for line in gz:
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as e:
                _log.warning("Skipping malformed JSON line in %s: %s",
                             path.name, e)
                continue

