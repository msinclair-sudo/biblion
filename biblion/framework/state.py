"""
v3 run-state persistence.

The orchestrator records every module invocation in `module_runs`, so
later runs can answer questions like:

  - When did module X last complete successfully?
  - On which git SHA?
  - What were its stats?
  - Did it crash, partially complete, or finish cleanly?

This is separate from per-row state (e.g. pipeline_state.oa_fetched in v2).
Per-row state is owned by individual modules and lives in their own tables.
The orchestrator only tracks module-level metadata.
"""
import json
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


DDL = """
CREATE TABLE IF NOT EXISTS module_runs (
    run_id        TEXT PRIMARY KEY,         -- uuid4
    module_name   TEXT NOT NULL,
    started_at    TEXT NOT NULL,            -- ISO 8601 UTC
    finished_at   TEXT,                     -- NULL while running / on crash
    status        TEXT,                     -- success|partial|failed|noop|running
    message       TEXT,
    stats_json    TEXT,                     -- JSON of ModuleResult.stats
    error         TEXT,                     -- traceback if failed
    git_sha       TEXT
);
CREATE INDEX IF NOT EXISTS idx_module_runs_name
    ON module_runs(module_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_module_runs_status
    ON module_runs(status, started_at DESC);
"""


def init(conn: sqlite3.Connection) -> None:
    """Create the module_runs table if absent."""
    conn.executescript(DDL)
    conn.commit()


def _ts() -> str:
    return datetime.now(timezone.utc).isoformat()


def _git_sha() -> Optional[str]:
    """Best-effort git sha of the working tree. Returns None outside a repo."""
    try:
        out = subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        return out.decode().strip()
    except (subprocess.SubprocessError, FileNotFoundError):
        return None


def reap_orphans(conn: sqlite3.Connection) -> int:
    """
    Mark any 'running' rows from killed previous runs as 'orphaned'.

    Called by the orchestrator at startup. SQLite rows can be left with
    status='running' indefinitely if a process was SIGKILL'd before its
    state.finish() call ran. This catches them at the next start so the
    history stays interpretable.

    Returns the number of rows reaped.
    """
    cur = conn.execute("""
        UPDATE module_runs
        SET status      = 'orphaned',
            finished_at = ?,
            error       = COALESCE(error, 'process killed; reaped at next startup')
        WHERE status = 'running'
          AND finished_at IS NULL
    """, (_ts(),))
    conn.commit()
    return cur.rowcount


def start(conn: sqlite3.Connection, run_id: str, module_name: str) -> None:
    """Insert a 'running' row at the start of execution."""
    conn.execute("""
        INSERT INTO module_runs
            (run_id, module_name, started_at, status, git_sha)
        VALUES (?, ?, ?, 'running', ?)
    """, (run_id, module_name, _ts(), _git_sha()))
    conn.commit()


def finish(
    conn: sqlite3.Connection,
    run_id: str,
    *,
    status: str,
    message: str = '',
    stats: Optional[dict] = None,
    error: Optional[str] = None,
) -> None:
    """Update the run row with final status."""
    conn.execute("""
        UPDATE module_runs
        SET finished_at = ?,
            status      = ?,
            message     = ?,
            stats_json  = ?,
            error       = ?
        WHERE run_id = ?
    """, (
        _ts(), status, message,
        json.dumps(stats) if stats else None,
        error,
        run_id,
    ))
    conn.commit()


def last_success(conn: sqlite3.Connection, module_name: str) -> Optional[sqlite3.Row]:
    """Return the most recent successful run row, or None."""
    return conn.execute("""
        SELECT * FROM module_runs
        WHERE module_name = ? AND status = 'success'
        ORDER BY started_at DESC
        LIMIT 1
    """, (module_name,)).fetchone()


def history(conn: sqlite3.Connection, module_name: Optional[str] = None,
            limit: int = 20) -> list[sqlite3.Row]:
    """Return recent runs (optionally filtered to one module)."""
    if module_name:
        return conn.execute("""
            SELECT * FROM module_runs WHERE module_name = ?
            ORDER BY started_at DESC LIMIT ?
        """, (module_name, limit)).fetchall()
    return conn.execute("""
        SELECT * FROM module_runs ORDER BY started_at DESC LIMIT ?
    """, (limit,)).fetchall()
