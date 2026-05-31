"""
Shared helpers for the bulk_* modules.

Keeps bulk_abstracts.py and bulk_papers.py focused on what they EXTRACT
from each S2 record; the boilerplate (loading maps, throttling pushes,
emitting summary stats) lives here.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit


# ---------------------------------------------------------------------------
# On-disk cache for downloaded .gz files
# ---------------------------------------------------------------------------

def bulk_cache_root() -> Path:
    """Where downloaded .gz files live. Defaults to <db-dir>/bulk_cache.
    Override with BIBLION_BULK_CACHE."""
    override = os.environ.get('BIBLION_BULK_CACHE')
    if override:
        return Path(override).expanduser()
    from ..db import get_db_path
    return get_db_path().parent / 'bulk_cache'


def bulk_cache_dir(release_id: str, dataset: str) -> Path:
    """<root>/<release_id>/<dataset>/ — created on demand."""
    d = bulk_cache_root() / release_id / dataset
    d.mkdir(parents=True, exist_ok=True)
    return d


_FILENAME_SAFE = re.compile(r'[^A-Za-z0-9._-]+')


def filename_for_url(url: str, fallback_index: int) -> str:
    """
    Derive a stable local filename from a pre-signed S3 URL.

    Uses the basename of the URL path. Strips query string and any unsafe
    characters. Falls back to "file_<index>.gz" if extraction fails.
    """
    parts = urlsplit(url)
    name = os.path.basename(parts.path) or ''
    name = _FILENAME_SAFE.sub('_', name)
    if not name or not name.endswith('.gz'):
        return f'file_{fallback_index:04d}.gz'
    return name


# ---------------------------------------------------------------------------
# Identifier maps — bulk records key by corpusid; v3 papers key by integer pid.
# ---------------------------------------------------------------------------

def load_pid_to_s2id(ctx) -> dict[int, str]:
    """Reverse of the s2_id → pid lookup; PaperRecord needs the s2_id."""
    conn = ctx.connect(readonly=True)
    try:
        rows = conn.execute(
            "SELECT id, s2_id FROM papers WHERE s2_id IS NOT NULL"
        ).fetchall()
    finally:
        conn.close()
    return {r['id']: r['s2_id'] for r in rows}


# ---------------------------------------------------------------------------
# Cache back-pressure
# ---------------------------------------------------------------------------

class CacheThrottle:
    """
    Producer-side throttle so the bulk modules never let staged:papers grow
    unbounded.

    The merge writer drains continuously, but on a slow disk the producer
    can outrun it. When `staged_papers` exceeds `high_water`, sleep until
    it falls below `low_water`. Logs every wait so you can tell whether the
    writer keeps up or not.
    """

    def __init__(self, cache,
                 high_water: int = 50_000,
                 low_water: int  = 10_000,
                 check_every_n: int = 1_000):
        self.cache         = cache
        self.high_water    = high_water
        self.low_water     = low_water
        self.check_every_n = check_every_n
        self._since_check  = 0
        self.total_wait_s  = 0.0
        self.wait_events   = 0

    def maybe_wait(self, shutdown=None) -> None:
        self._since_check += 1
        if self._since_check < self.check_every_n:
            return
        self._since_check = 0
        try:
            depth = self.cache.lengths().get('staged_papers', 0)
        except Exception:
            return
        if depth < self.high_water:
            return
        # Backed up — wait it out
        self.wait_events += 1
        start = time.time()
        print(f"    [throttle] staged_papers={depth:,} ≥ {self.high_water:,}, "
              f"sleeping until ≤ {self.low_water:,}")
        while depth > self.low_water:
            if shutdown is not None and shutdown.requested:
                break
            time.sleep(2)
            try:
                depth = self.cache.lengths().get('staged_papers', 0)
            except Exception:
                break
        waited = time.time() - start
        self.total_wait_s += waited
        print(f"    [throttle] resumed after {waited:.0f}s "
              f"(staged_papers={depth:,})")


# ---------------------------------------------------------------------------
# Streaming progress logger
# ---------------------------------------------------------------------------

class StreamProgress:
    """Tally records / matches / pushes and print periodic summaries."""

    def __init__(self, dataset_name: str, label_every_s: float = 30.0):
        self.dataset_name = dataset_name
        self.label_every  = label_every_s
        self.records      = 0
        self.matched      = 0
        self.pushed       = 0
        self.skipped_no_field = 0
        self.t_start      = time.time()
        self._last_print  = self.t_start

    def tick_record(self) -> None:
        self.records += 1

    def tick_match(self) -> None:
        self.matched += 1

    def tick_push(self) -> None:
        self.pushed += 1

    def tick_skip(self) -> None:
        self.skipped_no_field += 1

    def maybe_print(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_print < self.label_every:
            return
        self._last_print = now
        elapsed = now - self.t_start
        rate = self.records / max(elapsed, 0.001)
        print(f"    [{self.dataset_name}] "
              f"{self.records:>12,} rec  "
              f"{self.matched:>10,} match  "
              f"{self.pushed:>10,} push  "
              f"{self.skipped_no_field:>9,} skip  "
              f"{rate:>8,.0f} rec/s")

    def summary_stats(self) -> dict:
        return {
            'records_scanned':  self.records,
            'matched':          self.matched,
            'pushed':           self.pushed,
            'skipped_no_field': self.skipped_no_field,
            'elapsed_s':        round(time.time() - self.t_start, 1),
        }


# ---------------------------------------------------------------------------
# Resolve release_id with sensible defaults
# ---------------------------------------------------------------------------

def resolve_release_id(ctx, client, scratch_release_id: Optional[str]) -> Optional[str]:
    """
    Decide which release to stream. Priority:
      1. ctx.config['bulk_release_id'] — explicit override.
      2. scratch_release_id from the corpusid map header (so the three
         bulk modules stay consistent within a session).
      3. client.latest_release() — fall back to fresh.
    """
    if ctx.config.get('bulk_release_id'):
        return ctx.config['bulk_release_id']
    if scratch_release_id:
        return scratch_release_id
    return client.latest_release()
