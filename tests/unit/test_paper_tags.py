"""The paper_tags table — schema presence, idempotency, and PK dedup.

paper_tags stores user-applied tags (network_toy / CLI). It lives in db._SCHEMA
so init_db creates it and snapshots copy it; the merge writer never touches it.
"""
import sqlite3

import pytest

from biblion import db

pytestmark = pytest.mark.unit


def test_init_db_creates_paper_tags_and_is_idempotent(db_conn):
    cols = {r['name'] for r in db_conn.execute("PRAGMA table_info(paper_tags)")}
    assert {'paper_id', 'tag', 'added_at', 'added_by'} <= cols
    # Re-running init_db must not error (CREATE TABLE IF NOT EXISTS).
    db.init_db(db_conn)


def test_pk_dedups_via_insert_or_ignore(db_conn, insert_paper):
    pid = insert_paper(doi='10.1/x', title='T', year=2020)
    db_conn.execute(
        "INSERT OR IGNORE INTO paper_tags (paper_id, tag, added_at, added_by) "
        "VALUES (?, 'x', datetime('now'), 'cli')", (pid,))
    dup = db_conn.execute(
        "INSERT OR IGNORE INTO paper_tags (paper_id, tag, added_at, added_by) "
        "VALUES (?, 'x', datetime('now'), 'cli')", (pid,))
    assert dup.rowcount == 0                      # PK (paper_id, tag) collision
    rows = db_conn.execute("SELECT paper_id, tag FROM paper_tags").fetchall()
    assert [(r['paper_id'], r['tag']) for r in rows] == [(pid, 'x')]
