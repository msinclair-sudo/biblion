"""
Tests for the one-time observation backfill (biblion/merge/backfill.py).

The backfill mines existing papers + field_conflicts (no API calls), rebuilds
field_observations, and re-resolves. These tests use a temp main DB only (no
Redis) and seed papers/field_conflicts directly.
"""
import json
import sqlite3

import pytest

from biblion.db import init_db, get_connection
from biblion.merge.backfill import run_backfill, INCUMBENT_SOURCE


pytestmark = pytest.mark.unit


@pytest.fixture
def db(tmp_path):
    """A fresh main DB (no Redis needed) with the resolution substrate seeded."""
    path = tmp_path / 'bf.db'
    conn = get_connection(path)
    init_db(conn)
    conn.commit()
    yield conn
    conn.close()


def _paper(conn, **cols):
    cols.setdefault('created_at', '2026-01-01')
    keys = ', '.join(cols)
    qs = ', '.join('?' for _ in cols)
    cur = conn.execute(f"INSERT INTO papers ({keys}) VALUES ({qs})",
                       list(cols.values()))
    conn.commit()
    return cur.lastrowid


def _conflict(conn, paper_id, field, proposed, source):
    conn.execute(
        "INSERT INTO field_conflicts "
        "(paper_id, field, existing_value, proposed_value, proposed_source, "
        " discovered_at) VALUES (?, ?, NULL, ?, ?, '2026-01-01')",
        (paper_id, field, proposed, source))
    conn.commit()


# ---------------------------------------------------------------------------
# Dry-run vs apply
# ---------------------------------------------------------------------------

class TestDryRunVsApply:
    def test_dry_run_writes_nothing(self, db):
        pid = _paper(db, doi='10.1/a', year=2020)
        _conflict(db, pid, 'year', '2021', 'openalex')
        before = db.execute("SELECT year FROM papers WHERE id=?", (pid,)).fetchone()[0]
        nobs_before = db.execute("SELECT COUNT(*) FROM field_observations").fetchone()[0]

        stats = run_backfill(db, apply=False)

        assert db.execute("SELECT year FROM papers WHERE id=?", (pid,)).fetchone()[0] == before
        assert db.execute("SELECT COUNT(*) FROM field_observations").fetchone()[0] == nobs_before
        assert stats.observations_written == 0
        assert stats.fields_reresolved >= 1

    def test_apply_writes_observations_and_updates(self, db):
        # Use venue (a normal authoritative-after-canon field that IS applied);
        # year/identifiers are gated off by default and tested separately.
        # incumbent 'Jour Phycol' (source unknown -> _incumbent, least trusted);
        # openalex's distinct string wins on trust at apply.
        pid = _paper(db, doi='10.1/a', venue='Jour Phycol')
        _conflict(db, pid, 'venue', 'Journal of Phycology', 'openalex')

        run_backfill(db, apply=True)

        assert db.execute(
            "SELECT venue FROM papers WHERE id=?", (pid,)).fetchone()[0] \
            == 'Journal of Phycology'
        obs = db.execute(
            "SELECT source FROM field_observations "
            "WHERE paper_id=? AND field='venue'", (pid,)
        ).fetchall()
        sources = {r[0] for r in obs}
        assert INCUMBENT_SOURCE in sources
        assert 'openalex' in sources


# ---------------------------------------------------------------------------
# Authors — completeness merge + mis-association skip + order ambiguity
# ---------------------------------------------------------------------------

class TestAuthorsBackfill:
    def test_completeness_merge_applied(self, db):
        pid = _paper(db, doi='10.1/a',
                     authors=json.dumps(['G. Dwivedi', 'A. Kumar']))
        _conflict(db, pid, 'authors',
                  json.dumps(['Gaurav Dwivedi', 'Ajit Kumar']), 'openalex')

        run_backfill(db, apply=True)
        got = json.loads(db.execute(
            "SELECT authors FROM papers WHERE id=?", (pid,)).fetchone()[0])
        assert 'Gaurav Dwivedi' in got
        assert 'Ajit Kumar' in got

    def test_misassociated_authors_skipped(self, db):
        # conflict value shares zero tokens with incumbent -> dropped, incumbent kept.
        pid = _paper(db, doi='10.1/a',
                     authors=json.dumps(['Wang Hui', 'Zhou Wenjun']))
        _conflict(db, pid, 'authors',
                  json.dumps(['Maria Morenilla', 'Fernando Irueste']), 'oa_works_doi')

        run_backfill(db, apply=True)
        got = json.loads(db.execute(
            "SELECT authors FROM papers WHERE id=?", (pid,)).fetchone()[0])
        assert 'Maria Morenilla' not in ' '.join(got)
        assert 'Wang Hui' in got

    def test_order_ambiguous_keeps_incumbent(self, db):
        pid = _paper(db, doi='10.1/a', authors=json.dumps(['Chang Haixing']))
        _conflict(db, pid, 'authors', json.dumps(['Haixing Chang']), 's2_batch')

        stats = run_backfill(db, apply=True)
        got = json.loads(db.execute(
            "SELECT authors FROM papers WHERE id=?", (pid,)).fetchone()[0])
        assert got == ['Chang Haixing']            # incumbent kept, not reordered
        assert stats.conflicts_remaining >= 1      # flagged, not cleared


# ---------------------------------------------------------------------------
# Identifier safety
# ---------------------------------------------------------------------------

class TestIdentifierSafety:
    def test_identifiers_not_applied_by_default(self, db):
        pid = _paper(db, doi='10.1/a', s2_id='S1')
        _conflict(db, pid, 's2_id', 'S2', 'openalex')

        run_backfill(db, apply=True)                # no apply_identifiers
        # s2_id must be unchanged (identifier conflicts are the resolver's job).
        assert db.execute("SELECT s2_id FROM papers WHERE id=?", (pid,)).fetchone()[0] == 'S1'

    def test_identifiers_applied_when_opted_in(self, db):
        pid = _paper(db, doi='10.1/a', s2_id='S1')
        _conflict(db, pid, 's2_id', 'S2', 'openalex')

        run_backfill(db, apply=True, apply_identifiers=True)
        # With opt-in, the higher-trust openalex value wins over the _incumbent.
        assert db.execute("SELECT s2_id FROM papers WHERE id=?", (pid,)).fetchone()[0] == 'S2'


class TestVersionFieldSafety:
    def test_year_not_applied_by_default(self, db):
        # A year conflict is usually preprint-vs-VoR; must not be auto-applied
        # before preprint/VoR detection exists.
        pid = _paper(db, doi='10.1/a', year=2020)
        _conflict(db, pid, 'year', '2019', 'openalex')

        run_backfill(db, apply=True)                # no apply_version_fields
        assert db.execute("SELECT year FROM papers WHERE id=?", (pid,)).fetchone()[0] == 2020

    def test_year_applied_when_opted_in(self, db):
        pid = _paper(db, doi='10.1/a', year=2020)
        _conflict(db, pid, 'year', '2019', 'openalex')

        run_backfill(db, apply=True, apply_version_fields=True)
        assert db.execute("SELECT year FROM papers WHERE id=?", (pid,)).fetchone()[0] == 2019

    def test_year_observation_recorded_even_when_not_applied(self, db):
        # The observation is still captured for the audit trail / later VoR pass.
        pid = _paper(db, doi='10.1/a', year=2020)
        _conflict(db, pid, 'year', '2019', 'openalex')

        run_backfill(db, apply=True)
        n = db.execute(
            "SELECT COUNT(*) FROM field_observations WHERE paper_id=? AND field='year'",
            (pid,)).fetchone()[0]
        assert n >= 1


# ---------------------------------------------------------------------------
# Idempotence
# ---------------------------------------------------------------------------

class TestIdempotence:
    def test_apply_twice_is_stable(self, db):
        pid = _paper(db, doi='10.1/a', year=2020)
        _conflict(db, pid, 'year', '2021', 'openalex')

        run_backfill(db, apply=True)
        first = db.execute("SELECT year FROM papers WHERE id=?", (pid,)).fetchone()[0]
        nobs1 = db.execute("SELECT COUNT(*) FROM field_observations").fetchone()[0]

        run_backfill(db, apply=True)
        second = db.execute("SELECT year FROM papers WHERE id=?", (pid,)).fetchone()[0]
        nobs2 = db.execute("SELECT COUNT(*) FROM field_observations").fetchone()[0]

        assert first == second
        assert nobs1 == nobs2          # upsert PK -> no duplicate observations
