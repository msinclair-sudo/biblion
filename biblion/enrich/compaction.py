"""
Compaction — the offline pass that flattens the alias map.

Phase 5 dedup never deletes: losers are tombstoned + aliased and their edges stay
keyed to them, resolving through the alias map on read. Compaction makes that
physical: it rewrites every aliased edge endpoint to its canonical winner,
re-homes the losers' sidecar rows onto the winner, and finally deletes the
tombstoned losers — turning the alias map into a no-op so reads no longer need it.

MUST run quiesced: it deletes rows a live writer might target. The CLI refuses to
run while a writer for the same DB is up (pgrep guard). Order is strict —
re-home/rewrite everything off the losers BEFORE deleting them — or foreign keys
fail. Dry-run reports the counts it would change without writing.
"""
from __future__ import annotations

import logging
import sqlite3
import subprocess
from pathlib import Path

from ..merge.aliasmap import AliasMap

_log = logging.getLogger(__name__)

# Sidecar tables keyed by paper_id that must follow a loser onto its winner.
# (table, paper_id_column). citations is handled separately (two endpoints).
_SIDECAR_TABLES = (
    ('citation_counts', 'paper_id'),
    ('field_observations', 'paper_id'),
    ('field_conflicts', 'paper_id'),
    ('identifiers', 'paper_id'),
    ('paper_tags', 'paper_id'),
)


def _writer_running(db_path: Path) -> bool:
    """True if a merge writer (or dispatcher) for this DB appears to be up."""
    try:
        r = subprocess.run(
            ['pgrep', '-f',
             f'biblion.(merge.writer|enrich.dispatcher).*--db {db_path}'],
            capture_output=True, text=True)
        return bool(r.stdout.strip())
    except Exception:
        return False


def _winner_map(conn: sqlite3.Connection) -> dict:
    """loser_id -> ultimate winner id (alias chains fully resolved)."""
    am = AliasMap.load(conn)
    losers = [r[0] for r in conn.execute("SELECT loser_id FROM aliases")]
    return {lid: am.find(lid) for lid in losers}


def compact_conn(conn: sqlite3.Connection, dry_run: bool = False) -> dict:
    """Compact an open connection. Returns a stats dict of what changed (or
    would change, under dry_run). Caller owns the transaction boundary."""
    winners = _winner_map(conn)
    stats = {'losers': len(winners), 'edges_rewritten': 0, 'edges_dropped': 0,
             'self_loops': 0, 'sidecar_rehomed': 0, 'papers_deleted': 0}
    if not winners:
        return stats

    if dry_run:
        # Count rather than mutate.
        loser_ids = set(winners)
        for citing, cited in conn.execute(
                "SELECT citing_id, cited_id FROM citations"):
            if citing in loser_ids or cited in loser_ids:
                stats['edges_rewritten'] += 1
        for table, col in _SIDECAR_TABLES:
            stats['sidecar_rehomed'] += conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {col} IN "
                f"(SELECT loser_id FROM aliases)").fetchone()[0]
        stats['papers_deleted'] = conn.execute(
            "SELECT COUNT(*) FROM papers WHERE tombstone = 1").fetchone()[0]
        return stats

    # 1. Rewrite citation endpoints to ultimate winners. UPDATE OR IGNORE skips
    #    a rewrite that would duplicate an existing winner edge; loop to resolve
    #    chains, then drop leftover loser-keyed dups and self-loops.
    while True:
        c1 = conn.execute(
            "UPDATE OR IGNORE citations SET citing_id = "
            "(SELECT winner_id FROM aliases WHERE loser_id = citing_id) "
            "WHERE citing_id IN (SELECT loser_id FROM aliases)").rowcount
        c2 = conn.execute(
            "UPDATE OR IGNORE citations SET cited_id = "
            "(SELECT winner_id FROM aliases WHERE loser_id = cited_id) "
            "WHERE cited_id IN (SELECT loser_id FROM aliases)").rowcount
        stats['edges_rewritten'] += c1 + c2
        if not c1 and not c2:
            break
    stats['edges_dropped'] = conn.execute(
        "DELETE FROM citations WHERE citing_id IN (SELECT loser_id FROM aliases) "
        "OR cited_id IN (SELECT loser_id FROM aliases)").rowcount
    stats['self_loops'] = conn.execute(
        "DELETE FROM citations WHERE citing_id = cited_id").rowcount

    # 2. Re-home sidecar rows loser -> winner (INSERT OR IGNORE respects each
    #    table's PK, then drop the loser's). Must precede the paper DELETE so no
    #    child row references a soon-deleted loser.
    for table, col in _SIDECAR_TABLES:
        rows = conn.execute(
            f"SELECT * FROM {table} WHERE {col} IN (SELECT loser_id FROM aliases)"
        ).fetchall()
        if not rows:
            continue
        colnames = [d[0] for d in conn.execute(
            f"SELECT * FROM {table} LIMIT 0").description]
        idx = colnames.index(col)
        for r in rows:
            vals = list(r)
            vals[idx] = winners.get(vals[idx], vals[idx])
            ph = ', '.join('?' for _ in colnames)
            conn.execute(
                f"INSERT OR IGNORE INTO {table} ({', '.join(colnames)}) "
                f"VALUES ({ph})", vals)
        conn.execute(
            f"DELETE FROM {table} WHERE {col} IN (SELECT loser_id FROM aliases)")
        stats['sidecar_rehomed'] += len(rows)

    # 3. Delete the tombstoned losers (their edges + children are gone now).
    stats['papers_deleted'] = conn.execute(
        "DELETE FROM papers WHERE tombstone = 1").rowcount

    # 4. Integrity check — must be clean before the caller commits.
    fk = conn.execute("PRAGMA foreign_key_check").fetchall()
    if fk:
        raise RuntimeError(f"compaction left dangling FKs: {fk[:5]}")
    return stats


def compact(db_path: Path, dry_run: bool = False, force: bool = False) -> dict:
    """Compact a DB file. Refuses to run while a writer/dispatcher is up unless
    `force`. Commits on success."""
    db_path = Path(db_path)
    if not force and _writer_running(db_path):
        raise RuntimeError(
            f"refusing to compact {db_path}: a writer/dispatcher is running. "
            f"Stop the daemons first (compaction must be quiesced).")
    from ..db import get_connection
    conn = get_connection(db_path)
    try:
        if dry_run:
            return compact_conn(conn, dry_run=True)
        conn.execute("BEGIN IMMEDIATE")
        try:
            stats = compact_conn(conn, dry_run=False)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        conn.execute("VACUUM")          # reclaim space from the deleted losers
        return stats
    finally:
        conn.close()


def main():
    import argparse
    from ..db import get_db_path

    p = argparse.ArgumentParser(description='Compact the alias map (offline).')
    p.add_argument('--db', type=Path, default=None)
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--force', action='store_true',
                   help='run even if a writer appears to be up (dangerous)')
    args = p.parse_args()
    db_path = args.db or get_db_path()
    stats = compact(db_path, dry_run=args.dry_run, force=args.force)
    label = 'would change' if args.dry_run else 'compacted'
    print(f"[compaction] {label}: {stats}")


if __name__ == '__main__':
    main()
