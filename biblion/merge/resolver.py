"""
Resolver worker — handles multi-hit conflicts the merge writer parks.

A multi-hit happens when an incoming PaperRecord brings together two or
more identifiers that point to *different* existing rows in papers. The
existing rows are the same paper recorded separately and must be merged.

Resolution rules:

  1. Pick the canonical winner:
     - row with the most non-NULL metadata fields
     - tiebreak on lowest id (older row wins)

  2. Re-home everything attached to losing rows:
     - citations: redirect citing_id / cited_id to winner
       (INSERT OR IGNORE handles edges that now collide)
     - citation_counts: keep the winner's row per source; drop losers
     - field_conflicts: redirect paper_id

  3. Apply the union of identifiers across all merged rows to the winner.

  4. Delete losing rows.

  5. Push the original cache record back into `resolved:papers` so the
     merge writer can re-process it on the next cycle — by then there
     is only one matching row and it goes through the single-hit path.
"""
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from ..cache import CacheClient, PaperRecord
from ..cache.client import KEY_PARKED_PAPERS
from ..db    import get_connection, init_db, get_db_path


_log = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


_FIELDS = ('doi', 's2_id', 'oa_id', 'title', 'year', 'venue', 'authors',
           'abstract', 'pub_type')


def _populated_count(row: sqlite3.Row) -> int:
    return sum(1 for f in _FIELDS if row[f] is not None)


def _find_matching_rows(conn: sqlite3.Connection, rec: PaperRecord) -> list[sqlite3.Row]:
    """Re-run the multi-identifier lookup for this specific record."""
    conditions, params = [], []
    if rec.doi:
        conditions.append("doi = ?");   params.append(rec.doi)
    if rec.s2_id:
        conditions.append("s2_id = ?"); params.append(rec.s2_id)
    if rec.oa_id:
        conditions.append("oa_id = ?"); params.append(rec.oa_id)
    if not conditions:
        return []
    sql = f"SELECT * FROM papers WHERE {' OR '.join(conditions)}"
    return conn.execute(sql, params).fetchall()


def _pick_winner(rows: list[sqlite3.Row]) -> sqlite3.Row:
    """Most populated fields, tiebreak lowest id."""
    return min(rows, key=lambda r: (-_populated_count(r), r['id']))


def _merge_one(conn: sqlite3.Connection, rec: PaperRecord) -> bool:
    """
    Resolve one parked record. Returns True if the merge succeeded
    (and the record was pushed to resolved:papers), False if the situation
    no longer requires merging (e.g. only one match now — race with another
    process; just push to resolved and let the merge writer redo it).
    """
    rows = _find_matching_rows(conn, rec)
    if len(rows) <= 1:
        # No conflict anymore — punt back to the merge writer
        return False

    winner = _pick_winner(rows)
    losers = [r for r in rows if r['id'] != winner['id']]
    winner_id = winner['id']
    ts = _now()

    for loser in losers:
        lid = loser['id']

        # Capture the loser's identifiers BEFORE we delete the row so we can
        # transplant them onto the winner.
        loser_doi   = loser['doi']
        loser_s2    = loser['s2_id']
        loser_oa    = loser['oa_id']

        # 1. Redirect citations
        conn.execute("""
            INSERT OR IGNORE INTO citations (citing_id, cited_id, provenance, discovered)
            SELECT ?, cited_id, provenance, discovered FROM citations WHERE citing_id = ?
        """, (winner_id, lid))
        conn.execute("""
            INSERT OR IGNORE INTO citations (citing_id, cited_id, provenance, discovered)
            SELECT citing_id, ?, provenance, discovered FROM citations WHERE cited_id = ?
        """, (winner_id, lid))
        conn.execute("DELETE FROM citations WHERE citing_id = ? OR cited_id = ?", (lid, lid))

        # 2. Redirect citation_counts (winner takes priority per source)
        conn.execute("""
            INSERT OR IGNORE INTO citation_counts
                (paper_id, source, cit_count, ref_count, fetched_at)
            SELECT ?, source, cit_count, ref_count, fetched_at
            FROM citation_counts WHERE paper_id = ?
        """, (winner_id, lid))
        conn.execute("DELETE FROM citation_counts WHERE paper_id = ?", (lid,))

        # 3. Redirect field_conflicts
        conn.execute("UPDATE field_conflicts SET paper_id = ? WHERE paper_id = ?",
                     (winner_id, lid))

        # 3b. Re-home field_observations (winner keeps its own per-source row;
        #     INSERT OR IGNORE respects the (paper,field,source) PK, then drop
        #     the loser's). Without this, observations orphan on merge and the
        #     winner can't re-resolve from the loser's evidence.
        conn.execute("""
            INSERT OR IGNORE INTO field_observations
                (paper_id, field, value, raw_value, source, pub_type_hint, observed_at)
            SELECT ?, field, value, raw_value, source, pub_type_hint, observed_at
            FROM field_observations WHERE paper_id = ?
        """, (winner_id, lid))
        conn.execute("DELETE FROM field_observations WHERE paper_id = ?", (lid,))

        # 4. Same for non-identifier metadata fields (first-write-wins — only
        #    fills winner's NULLs).
        for col in ('title', 'year', 'venue', 'authors', 'abstract', 'pub_type'):
            if winner[col] is None and loser[col] is not None:
                conn.execute(f"UPDATE papers SET {col} = ?, updated_at = ? WHERE id = ?",
                             (loser[col], ts, winner_id))

        # 5. Delete the loser FIRST so its identifier rows free up the UNIQUE
        #    indexes, then transplant identifiers onto the winner.
        conn.execute("DELETE FROM papers WHERE id = ?", (lid,))

        for col, lval in (('doi', loser_doi), ('s2_id', loser_s2), ('oa_id', loser_oa)):
            wval = winner[col]
            if wval is None and lval is not None:
                conn.execute(f"UPDATE papers SET {col} = ?, updated_at = ? WHERE id = ?",
                             (lval, ts, winner_id))
            elif wval and lval and wval != lval:
                conn.execute("""
                    INSERT INTO field_conflicts
                        (paper_id, field, existing_value, proposed_value,
                         proposed_source, discovered_at)
                    VALUES (?, ?, ?, ?, 'merge_resolver', ?)
                """, (winner_id, col, wval, lval, ts))

    return True


class Resolver:
    """Single-process resolver worker."""

    def __init__(self, db_path: Path, cache: CacheClient, batch_size: int = 50):
        self.db_path    = db_path
        self.cache      = cache
        self.batch_size = batch_size
        self.merged     = 0
        self.passthrough = 0      # parked records that no longer need merging

    def run_cycle(self) -> int:
        """Process one batch of parked records. Returns count processed."""
        parked = self.cache.pop_papers_batch(self.batch_size, key=KEY_PARKED_PAPERS)
        if not parked:
            return 0

        conn = get_connection(self.db_path)
        init_db(conn)
        try:
            for rec in parked:
                merged = _merge_one(conn, rec)
                if merged:
                    self.merged += 1
                else:
                    self.passthrough += 1
                # Either way, push back so the merge writer reprocesses it
                # and applies the cache record's data (now to the winner).
                self.cache.push_resolved_paper(rec)
            conn.commit()
        finally:
            conn.close()

        return len(parked)


def main():
    import argparse, time
    from ..runtime import ShutdownFlag

    p = argparse.ArgumentParser(description='Run the v3 multi-hit resolver as a daemon.')
    p.add_argument('--db', type=Path, default=None)
    p.add_argument('--redis-url', default='redis://localhost:6379/0')
    p.add_argument('--batch-size', type=int, default=50)
    p.add_argument('--idle-sleep', type=float, default=2.0)
    args = p.parse_args()
    db_path = args.db or get_db_path()

    cache    = CacheClient(url=args.redis_url)
    resolver = Resolver(db_path, cache, batch_size=args.batch_size)
    flag     = ShutdownFlag.install(name='resolver')

    print(f"[resolver] db={args.db}  redis={args.redis_url}")
    while not flag.requested:
        n = resolver.run_cycle()
        if n == 0:
            time.sleep(args.idle_sleep)
        else:
            print(f"[resolver] merged={resolver.merged}  passthrough={resolver.passthrough}")
    print(f"\n[resolver] shutdown. merged={resolver.merged} passthrough={resolver.passthrough}")


if __name__ == '__main__':
    main()
