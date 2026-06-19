"""Unit tests for `biblion sql` — run SQL directly against the DB.

Read-only by default (PRAGMA query_only), with a --write opt-in. Covers the
three output formats, the read-only guard, the write path, and stdin input.
No Redis needed: `sql` is in the _NO_REDIS set.
"""
import io
import json

import pytest

from biblion.__main__ import main
from biblion.db import get_connection, init_db


@pytest.fixture
def db(tmp_path):
    """A tiny DB with two papers."""
    path = tmp_path / 'b.db'
    conn = get_connection(path)
    init_db(conn)
    conn.execute(
        "INSERT INTO papers (id, title, created_at) VALUES (1, 'Alpha', 'now')")
    conn.execute(
        "INSERT INTO papers (id, title, created_at) VALUES (2, 'Beta', 'now')")
    conn.commit()
    conn.close()
    return path


def test_table_output(db, capsys):
    rc = main(['--db', str(db), 'sql', 'SELECT id, title FROM papers ORDER BY id'])
    assert rc == 0
    out = capsys.readouterr().out
    assert 'Alpha' in out and 'Beta' in out
    assert 'id' in out and 'title' in out


def test_json_output(db, capsys):
    rc = main(['--db', str(db), 'sql', 'SELECT id, title FROM papers ORDER BY id',
               '--format', 'json'])
    assert rc == 0
    rows = json.loads(capsys.readouterr().out)
    assert rows == [{'id': 1, 'title': 'Alpha'}, {'id': 2, 'title': 'Beta'}]


def test_csv_output(db, capsys):
    rc = main(['--db', str(db), 'sql', 'SELECT id, title FROM papers ORDER BY id',
               '--format', 'csv'])
    assert rc == 0
    lines = [l for l in capsys.readouterr().out.splitlines() if l]
    assert lines[0] == 'id,title'
    assert lines[1] == '1,Alpha'
    assert len(lines) == 3   # header + 2 rows


def test_readonly_blocks_writes(db, capsys):
    rc = main(['--db', str(db), 'sql', "UPDATE papers SET title = 'X' WHERE id = 1"])
    assert rc == 1
    assert 'readonly' in capsys.readouterr().out.lower()
    # The row is untouched.
    conn = get_connection(db)
    assert conn.execute("SELECT title FROM papers WHERE id = 1").fetchone()[0] == 'Alpha'
    conn.close()


def test_write_flag_allows_writes(db, capsys):
    rc = main(['--db', str(db), 'sql', '--write',
               "UPDATE papers SET title = 'X' WHERE id = 1"])
    assert rc == 0
    conn = get_connection(db)
    assert conn.execute("SELECT title FROM papers WHERE id = 1").fetchone()[0] == 'X'
    conn.close()


def test_empty_sql_errors(db, capsys):
    rc = main(['--db', str(db), 'sql', '   '])
    assert rc == 2


def test_stdin_input(db, capsys, monkeypatch):
    monkeypatch.setattr('sys.stdin', io.StringIO('SELECT COUNT(*) AS n FROM papers'))
    rc = main(['--db', str(db), 'sql', '--format', 'json'])
    assert rc == 0
    assert json.loads(capsys.readouterr().out) == [{'n': 2}]
