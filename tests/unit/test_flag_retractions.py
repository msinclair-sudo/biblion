"""
Tests for the flag_retractions sweep (OpenAlex is_retracted -> editorial_status
+ editorial_status_at), with the OpenAlex client mocked (no network).
"""
import sqlite3

import pytest

from biblion.modules import flag_retractions
from biblion.modules.flag_retractions import sweep_retractions


pytestmark = pytest.mark.unit


class _FakeOA:
    """Returns canned works: 10.1/ret retracted, 10.2/ok clean."""
    _WORKS = {
        '10.1/ret': {'is_retracted': True},
        '10.2/ok':  {'is_retracted': False},
    }

    def fetch_batch_by_doi(self, dois, select=None):
        out = {}
        for d in dois:
            key = (d or '').strip().lower()
            if key in self._WORKS:
                out[key] = self._WORKS[key]
        return out

    def status(self):
        return {'calls_today': 1}


@pytest.fixture
def _mock_oa(monkeypatch):
    monkeypatch.setattr(flag_retractions, 'OpenAlexClient', lambda: _FakeOA())


def _status(db_path, doi):
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT editorial_status, editorial_status_at FROM papers "
            "WHERE doi = ?", (doi,)).fetchone()
    finally:
        conn.close()


class TestSweep:
    def test_flags_retracted_only(self, tmp_db_path, insert_paper, _mock_oa):
        insert_paper(doi='10.1/ret', title='Bad')
        insert_paper(doi='10.2/ok', title='Good')
        stats = sweep_retractions(tmp_db_path)
        assert stats['checked'] == 2
        assert stats['newly_flagged'] == 1

        ret = _status(tmp_db_path, '10.1/ret')
        assert ret['editorial_status'] == 'retracted'
        assert ret['editorial_status_at'] is not None

        ok = _status(tmp_db_path, '10.2/ok')
        assert ok['editorial_status'] is None
        assert ok['editorial_status_at'] is None

    def test_records_provenance_observation(self, tmp_db_path, insert_paper, _mock_oa):
        pid = insert_paper(doi='10.1/ret', title='Bad')
        sweep_retractions(tmp_db_path)
        conn = sqlite3.connect(str(tmp_db_path))
        try:
            row = conn.execute(
                "SELECT value, source FROM field_observations "
                "WHERE paper_id = ? AND field = 'editorial_status'", (pid,)
            ).fetchone()
        finally:
            conn.close()
        assert row is not None
        assert row[0] == 'retracted'
        assert row[1] == 'oa_retraction_sweep'

    def test_idempotent_timestamp_preserved(self, tmp_db_path, insert_paper, _mock_oa):
        insert_paper(doi='10.1/ret', title='Bad')
        sweep_retractions(tmp_db_path)
        first = _status(tmp_db_path, '10.1/ret')['editorial_status_at']
        stats2 = sweep_retractions(tmp_db_path)
        assert stats2['newly_flagged'] == 0           # already flagged
        again = _status(tmp_db_path, '10.1/ret')['editorial_status_at']
        assert again == first                          # timestamp not bumped

    def test_limit_caps_scan(self, tmp_db_path, insert_paper, _mock_oa):
        insert_paper(doi='10.1/ret', title='Bad')
        insert_paper(doi='10.2/ok', title='Good')
        stats = sweep_retractions(tmp_db_path, limit=1)
        assert stats['checked'] == 1
