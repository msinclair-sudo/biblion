"""
Tests for the typed cache records (PaperRecord, CitationRecord,
ClaimRequest, ClaimGrant, ResultMark, PromoteCitationAction).

These records are the JSON contract between every worker. If they
silently break, half the daemon stops working.
"""
import pytest

from biblion.cache.records import (
    PaperRecord, CitationRecord,
    ClaimRequest, ClaimGrant, ResultMark,
    PromoteCitationAction,
)


pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# PaperRecord
# ---------------------------------------------------------------------------

class TestPaperRecord:
    def test_round_trip_keeps_all_fields(self):
        r = PaperRecord(source='t', doi='10.1/a', s2_id='s',
                        title='Title', year=2024, abstract='abs',
                        pubmed_id='123')
        r2 = PaperRecord.from_json(r.to_json())
        assert r2.doi == '10.1/a'
        assert r2.s2_id == 's'
        assert r2.title == 'Title'
        assert r2.year == 2024
        assert r2.abstract == 'abs'
        assert r2.pubmed_id == '123'

    def test_from_json_drops_unknown_keys(self):
        """Producers from a future schema may add fields; old readers
        must not crash on unknown keys."""
        payload = '{"source": "t", "doi": "10.1/a", "some_future_field": 42}'
        r = PaperRecord.from_json(payload)
        assert r.doi == '10.1/a'

    def test_from_json_defaults_missing_new_fields_to_none(self):
        """A record from a previous schema (no s2_fields_of_study) must
        deserialise with that field as None, not raise."""
        payload = '{"source": "t", "doi": "10.1/a"}'
        r = PaperRecord.from_json(payload)
        assert r.s2_fields_of_study is None
        assert r.pubmed_id is None

    def test_has_identifier_true_when_doi_set(self):
        assert PaperRecord(source='t', doi='10.1/a').has_identifier()

    def test_has_identifier_false_when_no_ids(self):
        assert not PaperRecord(source='t', title='only title').has_identifier()

    def test_identifiers_excludes_none(self):
        r = PaperRecord(source='t', doi='10.1/a', s2_id=None, oa_id='W1')
        ids = r.identifiers()
        assert 'doi' in ids and 'oa_id' in ids
        assert 's2_id' not in ids


# ---------------------------------------------------------------------------
# CitationRecord
# ---------------------------------------------------------------------------

class TestCitationRecord:
    def test_round_trip(self):
        c = CitationRecord(
            source='t', citing_doi='10.1/a', cited_doi='10.1/b',
        )
        c2 = CitationRecord.from_json(c.to_json())
        assert c2.citing_doi == '10.1/a'
        assert c2.cited_doi == '10.1/b'

    def test_endpoint_id_helpers(self):
        c = CitationRecord(
            source='t', citing_doi='10.1/a', cited_oa_id='W1',
        )
        assert c.citing_identifiers() == {'doi': '10.1/a'}
        assert c.cited_identifiers() == {'oa_id': 'W1'}


# ---------------------------------------------------------------------------
# Claim flow records
# ---------------------------------------------------------------------------

class TestClaimFlowRecords:
    def test_claim_request_round_trip(self):
        r = ClaimRequest(service='enrich_oa', batch_size=50)
        r2 = ClaimRequest.from_json(r.to_json())
        assert r2.service == 'enrich_oa'
        assert r2.batch_size == 50
        assert r2.requested_at  # default factory populated

    def test_claim_grant_carries_arbitrary_row_columns(self):
        """The grant carries whatever columns the candidate SQL selected;
        the schema is essentially open-ended."""
        rows = [{'id': 1, 'doi': '10.1/a', 'title_len': 42}]
        g = ClaimGrant(service='x', rows=rows)
        g2 = ClaimGrant.from_json(g.to_json())
        assert g2.rows == rows

    def test_result_mark_round_trip(self):
        m = ResultMark(service='x',
                       succeeded=[[1, 'abstract'], [2, 'venue']],
                       failed=[[3, 'abstract']])
        m2 = ResultMark.from_json(m.to_json())
        assert m2.succeeded == [[1, 'abstract'], [2, 'venue']]
        assert m2.failed == [[3, 'abstract']]

    def test_result_mark_legacy_wire_format(self):
        # Legacy producers may still emit succeeded_ids/failed_ids; from_json
        # maps each id to field '_all' for back-compat across an upgrade.
        import json
        legacy = json.dumps({'service': 'x', 'succeeded_ids': [1, 2],
                             'failed_ids': [3], 'marked_at': 't'})
        m = ResultMark.from_json(legacy)
        assert m.succeeded == [[1, '_all'], [2, '_all']]
        assert m.failed == [[3, '_all']]


# ---------------------------------------------------------------------------
# PromoteCitationAction
# ---------------------------------------------------------------------------

class TestPromoteCitationAction:
    def test_round_trip(self):
        a = PromoteCitationAction(
            pending_id=42, citing_id=10, cited_id=20,
            provenance='pending_resolver',
        )
        a2 = PromoteCitationAction.from_json(a.to_json())
        assert a2.pending_id == 42
        assert a2.citing_id == 10
        assert a2.cited_id == 20
        assert a2.provenance == 'pending_resolver'
