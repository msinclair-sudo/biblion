"""Migration of enrichment_attempts from per-(paper,service) to per-field.

ensure_claims_db must upgrade a legacy (pre-`field`) claims DB in place:
legacy rows map to field='_all' (audit-preserving, non-blocking), the new
index appears, the old one is gone, and re-running is a no-op.
"""
import sqlite3

import pytest

from biblion.db import ensure_claims_db

pytestmark = pytest.mark.unit


# The exact pre-field schema that shipped before this change.
_OLD_SCHEMA = """
CREATE TABLE enrichment_attempts (
    paper_id INTEGER NOT NULL, service TEXT NOT NULL, status TEXT NOT NULL,
    claimed_at TEXT NOT NULL, finished_at TEXT, PRIMARY KEY (paper_id, service));
CREATE INDEX idx_attempts_status ON enrichment_attempts(status, service);
CREATE INDEX idx_attempts_paper_status ON enrichment_attempts(paper_id, status);
"""


def _build_old_db(path):
    c = sqlite3.connect(str(path))
    c.executescript(_OLD_SCHEMA)
    c.executemany(
        "INSERT INTO enrichment_attempts VALUES (?,?,?,?,?)",
        [(1, 's2_live', 'succeeded', '2026-01-01', '2026-01-01'),
         (1, 'oa', 'failed', '2026-01-01', '2026-01-01'),
         (2, 's2_live', 'succeeded', '2026-01-01', '2026-01-01')])
    c.commit(); c.close()


def _cols(conn):
    return {r[1] for r in conn.execute("PRAGMA table_info(enrichment_attempts)")}


def _indexes(conn):
    return {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND tbl_name='enrichment_attempts'")}


def test_legacy_db_migrates_to_field_schema(tmp_path):
    path = tmp_path / 'legacy_claims.db'
    _build_old_db(path)

    ensure_claims_db(path)

    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    assert 'field' in _cols(conn)
    rows = conn.execute(
        "SELECT paper_id, service, field, status FROM enrichment_attempts "
        "ORDER BY paper_id, service").fetchall()
    # All three legacy rows preserved, each mapped to field='_all'.
    assert len(rows) == 3
    assert all(r['field'] == '_all' for r in rows)
    idx = _indexes(conn)
    assert 'idx_attempts_tried' in idx
    assert 'idx_attempts_paper_status' not in idx
    conn.close()


def test_migration_is_idempotent(tmp_path):
    path = tmp_path / 'legacy_claims.db'
    _build_old_db(path)
    ensure_claims_db(path)
    ensure_claims_db(path)  # second run must be a no-op
    conn = sqlite3.connect(str(path))
    n = conn.execute("SELECT COUNT(*) FROM enrichment_attempts").fetchone()[0]
    assert n == 3
    assert 'field' in _cols(conn)
    conn.close()


def test_fresh_db_has_field_schema(tmp_path):
    path = tmp_path / 'fresh_claims.db'
    ensure_claims_db(path)
    conn = sqlite3.connect(str(path))
    assert 'field' in _cols(conn)
    assert 'idx_attempts_tried' in _indexes(conn)
    conn.close()
