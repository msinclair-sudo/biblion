"""
pending_resolver — read-only sweep of pending_citations.

Background
----------
When the merge writer processes a citation batch and one (or both)
endpoints aren't yet in the papers table, the edge is stored in
`pending_citations` with raw identifiers. Over time many of those
endpoints land in papers via later enrichment; the pending row could
then be promoted to a real citation row.

The original design ran this promotion sweep inside the merge writer's
cycle. At ~1M pending rows the writer stalled for minutes per sweep,
killing throughput.

This daemon takes the sweep off the writer. It:

  1. Reads a batch of pending rows from a read-only DB connection.
     SQLite WAL lets readers run while the writer writes; no contention.
  2. Looks up both endpoints in `papers` via _batch_lookup (the same
     batched probe the writer uses for new citations).
  3. For every pending row whose endpoints both resolve to a single
     distinct paper, builds a `PromoteCitationAction` and pushes it into
     the cache.
  4. The writer drains those actions in its own cycle, applying
     `INSERT INTO citations + DELETE FROM pending_citations` in a single
     transaction.

The sweep is **round-robin**: a cursor (saved in Redis) advances through
pending_citations.id ASC. When the cursor passes the highest id, it
wraps to 0 so newly-pending rows get covered on the next pass.

Invariants
----------
- This process NEVER writes to either SQLite DB. Read-only connections
  only. All writes go through the merge writer via the cache.
- Idempotent: if the writer already promoted a pending row (race or
  prior pass), the writer's `INSERT OR IGNORE` + `DELETE WHERE id`
  silently no-op.
- Crash-safe: cursor in Redis is updated after every batch push, so a
  restart resumes near where it stopped. Worst case re-sweeps one batch.
"""
from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ..cache import CacheClient, PromoteCitationAction
from ..cache.records import PaperRecord
from ..db    import get_db_path
from .writer import _batch_lookup


DEFAULT_BATCH_SIZE = 1000
DEFAULT_IDLE_SLEEP = 5.0       # seconds when the table is empty or we wrapped


_log = logging.getLogger(__name__)


@dataclass
class ResolverStats:
    cycles:           int = 0
    rows_scanned:     int = 0
    actions_pushed:   int = 0
    wraps:            int = 0
    empty_cycles:     int = 0
    errors:           int = 0


class PendingResolver:
    """
    Encapsulates one resolver loop iteration. Construct once, call
    run_cycle() repeatedly. The loop is exposed separately from main()
    so tests can drive it deterministically.
    """

    def __init__(self, db_path: Path, cache: CacheClient,
                 batch_size: int = DEFAULT_BATCH_SIZE):
        self.db_path    = db_path
        self.cache      = cache
        self.batch_size = batch_size
        self.stats      = ResolverStats()

    # ------------------------------------------------------------------
    # DB access
    # ------------------------------------------------------------------

    def _read_conn(self) -> sqlite3.Connection:
        """Open a read-only connection to the v3 DB.

        Read-only means: no chance of accidentally taking the write lock
        even if some future change adds a stray UPDATE here.
        """
        uri = f"file:{self.db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    # ------------------------------------------------------------------
    # Single sweep step
    # ------------------------------------------------------------------

    def run_cycle(self) -> int:
        """
        Fetch the next batch from pending_citations, resolve endpoints
        in-memory, push promotion actions for any resolved rows.

        Returns the number of actions pushed (0 on idle / empty table).
        """
        self.stats.cycles += 1
        cursor = self.cache.get_pending_cursor()
        conn = self._read_conn()
        try:
            rows = conn.execute("""
                SELECT id, citing_doi, citing_s2_id, citing_oa_id,
                       cited_doi,  cited_s2_id,  cited_oa_id, provenance
                FROM pending_citations
                WHERE id > ?
                ORDER BY id ASC
                LIMIT ?
            """, (cursor, self.batch_size)).fetchall()

            if not rows:
                # Nothing past the cursor — wrap to 0. If id=0 yields the
                # same empty result, the table is actually empty.
                self.stats.wraps += 1
                if cursor != 0:
                    self.cache.set_pending_cursor(0)
                self.stats.empty_cycles += 1
                return 0

            actions = self._resolve_rows(conn, rows)
            if actions:
                # Push BEFORE advancing the cursor. If Redis is unreachable
                # or the push partially fails, raise — the cursor stays put
                # and we retry the same rows on the next cycle. Advancing
                # past unpushed actions would silently lose pending rows
                # until the next full wrap, which can be hours.
                try:
                    self.cache.push_promote_citations(actions)
                except Exception:
                    self.stats.errors += 1
                    raise
                self.stats.actions_pushed += len(actions)

            # Advance cursor to the last id we examined. Unresolved rows
            # will be revisited on the next wrap. We only get here if the
            # push above succeeded (or there were no actions to push).
            new_cursor = rows[-1]['id']
            self.cache.set_pending_cursor(new_cursor)
            self.stats.rows_scanned += len(rows)
            return len(actions)
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # In-memory resolution
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_rows(conn: sqlite3.Connection,
                      rows: list[sqlite3.Row]) -> list[PromoteCitationAction]:
        """
        For each pending row, build a faux PaperRecord per endpoint,
        run _batch_lookup once, then construct an action for any row
        where both endpoints resolve to a single distinct paper.

        The two faux records per row are at indices (2*i, 2*i+1) in the
        lookup hits list — preserving the order convention used by the
        writer's own citation processing path.
        """
        faux: list[PaperRecord] = []
        for r in rows:
            faux.append(PaperRecord(
                source='_pending_resolver',
                doi=r['citing_doi'],
                s2_id=r['citing_s2_id'],
                oa_id=r['citing_oa_id'],
            ))
            faux.append(PaperRecord(
                source='_pending_resolver',
                doi=r['cited_doi'],
                s2_id=r['cited_s2_id'],
                oa_id=r['cited_oa_id'],
            ))
        hits = _batch_lookup(conn, faux)

        actions: list[PromoteCitationAction] = []
        for i, r in enumerate(rows):
            citing_hits = hits[2 * i]
            cited_hits  = hits[2 * i + 1]
            if len(citing_hits) != 1 or len(cited_hits) != 1:
                continue
            citing_id = citing_hits[0].paper_id
            cited_id  = cited_hits[0].paper_id
            if citing_id == cited_id:
                # Self-citation collapse — skip; the writer would
                # silently no-op on the INSERT anyway, but pushing it
                # wastes a round-trip.
                continue
            actions.append(PromoteCitationAction(
                pending_id=r['id'],
                citing_id=citing_id,
                cited_id=cited_id,
                provenance=r['provenance'] or 'pending_resolver',
            ))
        return actions


# ---------------------------------------------------------------------------
# CLI entry — `python -m biblion.merge.pending_resolver`
# ---------------------------------------------------------------------------

def main():
    import argparse
    from ..runtime import ShutdownFlag

    p = argparse.ArgumentParser(
        description='Continuously sweep pending_citations and emit promotion '
                    'actions for the merge writer to apply.',
    )
    p.add_argument('--db', type=Path, default=None)
    p.add_argument('--redis-url', default='redis://localhost:6379/0')
    p.add_argument('--batch-size', type=int, default=DEFAULT_BATCH_SIZE,
                   help='Pending rows per sweep iteration')
    p.add_argument('--idle-sleep', type=float, default=DEFAULT_IDLE_SLEEP,
                   help='Seconds to sleep when a sweep returns 0 actions')
    args = p.parse_args()
    db_path = args.db or get_db_path()

    cache    = CacheClient(url=args.redis_url)
    resolver = PendingResolver(db_path, cache, batch_size=args.batch_size)
    flag     = ShutdownFlag.install(name='pending-resolver')

    print(f"[pending] reading {db_path}")
    print(f"[pending] redis @ {args.redis_url}  batch={args.batch_size}")
    print(f"[pending] starting cursor: {cache.get_pending_cursor()}")

    while not flag.requested:
        try:
            n = resolver.run_cycle()
        except Exception as e:
            resolver.stats.errors += 1
            _log.exception("pending_resolver cycle failed: %s", e)
            time.sleep(args.idle_sleep)
            continue
        # Idle backoff only when a wrap happened (empty/end of table).
        if n == 0:
            time.sleep(args.idle_sleep)
        elif resolver.stats.cycles % 50 == 0:
            print(f"[pending] cycles={resolver.stats.cycles}  "
                  f"scanned={resolver.stats.rows_scanned}  "
                  f"pushed={resolver.stats.actions_pushed}  "
                  f"wraps={resolver.stats.wraps}  "
                  f"errors={resolver.stats.errors}  "
                  f"cursor={cache.get_pending_cursor()}")
    print(f"\n[pending] shutdown. final stats: {resolver.stats}")


if __name__ == '__main__':
    main()
