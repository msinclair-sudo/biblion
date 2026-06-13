"""
Tests for the claims framework's validation + ordering helpers.

These cover the recently-added _validate_order_by and the candidate-query
registry consistency. Failing here means a future producer could trigger
SQL injection or a missing-key crash.
"""
import pytest

from biblion.framework.claims import (
    CANDIDATE_QUERIES, _validate_order_by,
)
from biblion.db import ENRICHMENT_FIELDS, ENRICHMENT_FIELD_ALL


pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# Order-by validator
# ---------------------------------------------------------------------------

class TestOrderByValidator:
    @pytest.mark.parametrize('clause', [
        'ORDER BY b.id ASC',
        'ORDER BY b.is_seed DESC, b.id ASC',
        'ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC',
        'ORDER BY LENGTH(b.title) DESC, b.id ASC',
        'order by b.id',     # case insensitive
        '  ORDER BY b.id  ', # whitespace tolerated
    ])
    def test_valid_clauses_pass(self, clause):
        _validate_order_by(clause)  # raises on bad

    @pytest.mark.parametrize('clause', [
        '',                                              # empty
        'b.id ASC',                                      # missing ORDER BY
        "ORDER BY b.id; DROP TABLE papers",              # injection attempt
        'ORDER BY b.id ASC, (SELECT 1)',                 # subselect
        'ORDER BY p.id',                                 # uses p. not b.
        'ORDER BY "b"."id"',                             # quoted identifier
        'ORDER BY b.id COLLATE NOCASE',                  # COLLATE not allowed
    ])
    def test_invalid_clauses_rejected(self, clause):
        with pytest.raises(ValueError, match='order_by'):
            _validate_order_by(clause)


# ---------------------------------------------------------------------------
# CANDIDATE_QUERIES registry consistency
# ---------------------------------------------------------------------------

class TestRegistryConsistency:
    def test_every_entry_has_required_keys(self):
        for name, spec in CANDIDATE_QUERIES.items():
            assert 'service' in spec, f'{name}: missing "service"'
            assert 'candidate_sql' in spec, f'{name}: missing "candidate_sql"'
            assert 'order_by' in spec, f'{name}: missing "order_by"'

    def test_every_candidate_sql_selects_id(self):
        for name, spec in CANDIDATE_QUERIES.items():
            sql = spec['candidate_sql'].lower()
            assert 'as id' in sql or 'p.id as id' in sql, (
                f'{name}: candidate_sql must SELECT p.id AS id'
            )

    def test_every_order_by_validates(self):
        """If this ever fires, a CANDIDATE_QUERIES entry was added with
        an order_by clause that the validator rejects — the writer will
        crash on first use."""
        for name, spec in CANDIDATE_QUERIES.items():
            _validate_order_by(spec['order_by'])

    def test_every_entry_has_valid_fields(self):
        """Each entry's `fields` must be a non-empty tuple drawn from the
        known metadata fields plus the '_all' sentinel."""
        allowed = set(ENRICHMENT_FIELDS) | {ENRICHMENT_FIELD_ALL}
        for name, spec in CANDIDATE_QUERIES.items():
            fields = spec.get('fields', (ENRICHMENT_FIELD_ALL,))
            assert isinstance(fields, tuple) and fields, f'{name}: bad fields'
            for f in fields:
                assert f in allowed, f'{name}: unknown field {f!r}'

    def test_candidate_sql_emits_need_columns(self):
        """The candidate_sql must SELECT a `need_<field>` column for each
        field it claims — claim_candidates reads these flags to decide
        eligibility and which fields to claim."""
        for name, spec in CANDIDATE_QUERIES.items():
            sql = spec['candidate_sql'].lower()
            for f in spec.get('fields', (ENRICHMENT_FIELD_ALL,)):
                assert f'need_{f}' in sql, (
                    f'{name}: candidate_sql missing need_{f} column'
                )

    def test_no_orphan_services(self):
        """Every distinct `service` should appear in at least one module.

        (Smoke test for naming drift — if someone renames a service in
        one place but not another, claims won't share budget.)"""
        services = {spec['service'] for spec in CANDIDATE_QUERIES.values()}
        # Known services as of writing
        known = {'oa', 's2_live', 'ncbi', 'ncbi_pmid', 's2_hop', 'oa_incoming',
                 'crossref'}
        unknown = services - known
        if unknown:
            pytest.fail(
                f'Unknown services in CANDIDATE_QUERIES: {unknown}. '
                f'Either expected (update test) or naming drift.'
            )


# ---------------------------------------------------------------------------
# release_all_claims (shutdown cleanup)
# ---------------------------------------------------------------------------

class TestReleaseAllClaims:
    def test_frees_only_claimed_rows(self, tmp_db_path, claims_conn):
        from biblion.framework.claims import release_all_claims
        claims_conn.executemany(
            "INSERT INTO enrichment_attempts "
            "(paper_id, service, field, status, claimed_at) VALUES (?,?,?,?,?)",
            [(1, 'oa', 'abstract', 'claimed', 't'),
             (2, 's2_live', '_all', 'claimed', 't'),
             (3, 'oa', 'abstract', 'succeeded', 't'),
             (4, 'ncbi', 'title', 'failed', 't')])
        claims_conn.commit()

        freed = release_all_claims(claims_conn)
        assert freed == 2          # only the two 'claimed' rows
        rows = dict(claims_conn.execute(
            "SELECT status, COUNT(*) FROM enrichment_attempts "
            "GROUP BY status").fetchall())
        assert 'claimed' not in rows          # all claims gone
        assert rows.get('succeeded') == 1      # success preserved
        assert rows.get('failed') == 1         # failed (with its cooldown) kept
