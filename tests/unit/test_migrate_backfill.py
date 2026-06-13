"""
Tests for the one-time `biblion migrate` backfill
(db._backfill_promoted_columns): copying fields prior .bib imports left in
field_observations into the promoted first-class columns + identifiers table.
"""
import pytest

from biblion.db import _backfill_promoted_columns, _split_pages


pytestmark = pytest.mark.unit


def _obs(db_conn, pid, field, value, source='bib:old'):
    db_conn.execute(
        "INSERT INTO field_observations "
        "(paper_id, field, value, raw_value, source, observed_at) "
        "VALUES (?,?,?,?,?,datetime('now'))",
        (pid, field, value, value, source))


class TestSplitPages:
    @pytest.mark.parametrize('raw,expected', [
        ('100-120', ('100', '120')),
        ('100--120', ('100', '120')),
        ('100–120', ('100', '120')),
        ('e12345', ('e12345', None)),
        ('', (None, None)),
    ])
    def test_split(self, raw, expected):
        assert _split_pages(raw) == expected


class TestBackfill:
    def test_scalar_columns_backfilled(self, db_conn, insert_paper):
        pid = insert_paper(doi='10.1/a', title='X')
        _obs(db_conn, pid, 'volume', '12')
        _obs(db_conn, pid, 'number', '3')        # bib 'number' -> issue
        _obs(db_conn, pid, 'publisher', 'Springer')
        _obs(db_conn, pid, 'edition', '2')
        db_conn.commit()

        _backfill_promoted_columns(db_conn)

        row = db_conn.execute(
            "SELECT volume, issue, publisher, edition FROM papers "
            "WHERE id = ?", (pid,)).fetchone()
        assert row['volume'] == '12'
        assert row['issue'] == '3'
        assert row['publisher'] == 'Springer'
        assert row['edition'] == '2'

    def test_pages_split_into_columns(self, db_conn, insert_paper):
        pid = insert_paper(doi='10.1/b', title='Y')
        _obs(db_conn, pid, 'pages', '100–120')
        db_conn.commit()
        _backfill_promoted_columns(db_conn)
        row = db_conn.execute(
            "SELECT first_page, last_page FROM papers WHERE id = ?",
            (pid,)).fetchone()
        assert row['first_page'] == '100' and row['last_page'] == '120'

    def test_editor_parsed_into_editors_json(self, db_conn, insert_paper):
        import json
        pid = insert_paper(doi='10.1/c', title='Z')
        _obs(db_conn, pid, 'editor', 'Ng, Pat and Roe, Sam')
        db_conn.commit()
        _backfill_promoted_columns(db_conn)
        row = db_conn.execute(
            "SELECT editors FROM papers WHERE id = ?", (pid,)).fetchone()
        assert json.loads(row['editors']) == ['Ng, Pat', 'Roe, Sam']

    def test_identifiers_backfilled(self, db_conn, insert_paper):
        pid = insert_paper(doi='10.1/d', title='W')
        _obs(db_conn, pid, 'isbn', '978-0-00-000000-0')
        _obs(db_conn, pid, 'issn', '1234-5678')
        db_conn.commit()
        _backfill_promoted_columns(db_conn)
        rows = dict(db_conn.execute(
            "SELECT scheme, value FROM identifiers WHERE paper_id = ?",
            (pid,)).fetchall())
        assert rows == {'isbn': '978-0-00-000000-0', 'issn': '1234-5678'}

    def test_month_from_publication_date(self, db_conn, insert_paper):
        pid = insert_paper(doi='10.1/e', title='M', publication_date='2024-07-15')
        db_conn.commit()
        _backfill_promoted_columns(db_conn)
        row = db_conn.execute(
            "SELECT month FROM papers WHERE id = ?", (pid,)).fetchone()
        assert row['month'] == '07'

    def test_idempotent_rerun(self, db_conn, insert_paper):
        pid = insert_paper(doi='10.1/f', title='I')
        _obs(db_conn, pid, 'volume', '9')
        _obs(db_conn, pid, 'isbn', '111')
        db_conn.commit()
        first = _backfill_promoted_columns(db_conn)
        second = _backfill_promoted_columns(db_conn)
        assert first['volume'] >= 1 and first['id_isbn'] >= 1
        # Second pass changes nothing (guarded WHERE NULL / INSERT OR IGNORE).
        assert second['volume'] == 0
        assert second.get('id_isbn', 0) == 0
        # No duplicate identifier rows.
        n = db_conn.execute(
            "SELECT COUNT(*) FROM identifiers WHERE paper_id = ?",
            (pid,)).fetchone()[0]
        assert n == 1

    def test_does_not_overwrite_existing_column(self, db_conn, insert_paper):
        pid = insert_paper(doi='10.1/g', title='G', volume='EXISTING')
        _obs(db_conn, pid, 'volume', 'FROM_OBS')
        db_conn.commit()
        _backfill_promoted_columns(db_conn)
        row = db_conn.execute(
            "SELECT volume FROM papers WHERE id = ?", (pid,)).fetchone()
        assert row['volume'] == 'EXISTING'
