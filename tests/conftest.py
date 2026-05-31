"""
Top-level pytest fixtures for biblion tests.

The contract here is: any test can ask for `tmp_db_path`, `redis_url`,
`cache`, or `claims_db_path` and get an isolated, pre-initialised
environment. No test ever sees production state — DBs are in /tmp,
Redis is db=15.

Tests run in process unless they request the `worker_runner` fixture,
which spawns real subprocesses for the writer / pending_resolver / etc.
"""
from __future__ import annotations

import os
import sqlite3
import tempfile
from pathlib import Path

import pytest
import redis as redis_py

from biblion.cache import CacheClient
from biblion.db    import (
    get_connection, init_db, ensure_claims_db, get_claims_connection,
)

# Re-export the worker_runner fixture so tests/integration/* can pick it up
# without an explicit import.
from tests.support.workers import worker_runner  # noqa: F401


# ---------------------------------------------------------------------------
# Redis — db=15 (production uses db=0)
# ---------------------------------------------------------------------------
#
# We use a non-default db number so a misconfigured test can never trash
# the production cache. Every test that asks for `cache` or `redis_url`
# gets a freshly-flushed db=15.

REDIS_URL = os.environ.get('BIBLION_TEST_REDIS_URL', 'redis://localhost:6379/15')


def _redis_reachable() -> bool:
    try:
        r = redis_py.from_url(REDIS_URL, socket_connect_timeout=1)
        return bool(r.ping())
    except Exception:
        return False


# Skip integration tests that need Redis when it isn't running.
needs_redis = pytest.mark.skipif(
    not _redis_reachable(),
    reason=f'Redis not reachable at {REDIS_URL}',
)


@pytest.fixture
def redis_url() -> str:
    """The URL tests should pass to CacheClient / subprocess workers."""
    return REDIS_URL


@pytest.fixture
def redis_client(redis_url: str) -> redis_py.Redis:
    """Raw redis-py client on db=15, flushed before AND after the test."""
    r = redis_py.from_url(redis_url, decode_responses=True)
    r.flushdb()
    yield r
    r.flushdb()


@pytest.fixture
def cache(redis_client, redis_url: str) -> CacheClient:
    """A CacheClient pointed at the throwaway db=15."""
    return CacheClient(url=redis_url)


# ---------------------------------------------------------------------------
# Temp SQLite DBs — main + claims sidecar
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_db_path(tmp_path: Path) -> Path:
    """A fresh, fully-initialised v3 main DB. Lives in pytest's tmp_path
    so it's auto-cleaned at the end of the session."""
    path = tmp_path / 'biblion.db'
    conn = get_connection(path)
    try:
        init_db(conn)
        conn.commit()
    finally:
        conn.close()
    return path


@pytest.fixture
def claims_db_path(tmp_db_path: Path) -> Path:
    """A fresh claims DB sibling to tmp_db_path, with schema applied."""
    path = tmp_db_path.with_name(tmp_db_path.stem + '_claims.db')
    ensure_claims_db(path)
    return path


@pytest.fixture
def db_conn(tmp_db_path: Path):
    """A read/write connection to the temp main DB. Closed after the test."""
    conn = get_connection(tmp_db_path)
    yield conn
    conn.close()


@pytest.fixture
def claims_conn(tmp_db_path: Path, claims_db_path: Path):
    """A connection to the claims DB with the main DB attached read-only."""
    conn = get_claims_connection(claims_db_path=claims_db_path,
                                 main_db_path=tmp_db_path)
    yield conn
    conn.close()


# ---------------------------------------------------------------------------
# Convenience helpers — inserting test data
# ---------------------------------------------------------------------------

@pytest.fixture
def insert_paper(db_conn):
    """Returns a callable that inserts a paper and returns its id.

    Usage:
        def test_thing(insert_paper):
            pid = insert_paper(doi='10.1/a', title='Sample')
    """
    def _insert(**fields) -> int:
        fields.setdefault('created_at', "datetime('now')")
        cols, placeholders, params = [], [], []
        for c, v in fields.items():
            cols.append(c)
            if c == 'created_at' and v == "datetime('now')":
                placeholders.append("datetime('now')")
            else:
                placeholders.append('?')
                params.append(v)
        sql = (f"INSERT INTO papers ({', '.join(cols)}) "
               f"VALUES ({', '.join(placeholders)})")
        cur = db_conn.execute(sql, params)
        db_conn.commit()
        return cur.lastrowid
    return _insert


@pytest.fixture
def insert_pending_citation(db_conn):
    """Inserts a pending_citations row and returns its id."""
    def _insert(**fields) -> int:
        cols = list(fields)
        placeholders = ', '.join('?' for _ in cols)
        cur = db_conn.execute(
            f"INSERT INTO pending_citations "
            f"({', '.join(cols)}, discovered_at) "
            f"VALUES ({placeholders}, datetime('now'))",
            [fields[c] for c in cols],
        )
        db_conn.commit()
        return cur.lastrowid
    return _insert


@pytest.fixture
def count_rows(db_conn):
    """Returns a callable: count_rows('papers') -> int."""
    def _count(table: str, where: str = '') -> int:
        sql = f"SELECT COUNT(*) FROM {table}"
        if where:
            sql += f" WHERE {where}"
        return db_conn.execute(sql).fetchone()[0]
    return _count
