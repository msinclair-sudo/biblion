"""
Regression tests for query-plan health.

Every CANDIDATE_QUERIES entry must have a supporting index — without
one, the writer's claim cycle takes minutes per batch. If a future
producer is added without a matching index, this test will fail
immediately with a clear error.

Similarly, the merge writer's hot lookups (citation resolution,
paper merge) must use indexes — failing here means a schema change
silently broke an index.
"""
import sqlite3

import pytest

from biblion.db import ensure_claims_db, get_claims_connection, init_db
from biblion.framework.claims import CANDIDATE_QUERIES


pytestmark = pytest.mark.perf


def _planner_uses_index(conn: sqlite3.Connection, sql: str,
                        params: tuple = ()) -> tuple[bool, str]:
    """Run EXPLAIN QUERY PLAN. Returns (uses_index, plan_text).

    SQLite reports various "uses an index" forms:
        SEARCH ... USING INDEX <name>
        SEARCH ... USING COVERING INDEX <name>
        SCAN ... USING INDEX <name>
    All of these are good. A plain "SCAN <table>" with no USING clause
    is a full table scan and bad.
    """
    rows = conn.execute('EXPLAIN QUERY PLAN ' + sql, params).fetchall()
    plan_text = '\n'.join(
        ' '.join(str(v) for v in tuple(r)) for r in rows
    )
    upper = plan_text.upper()
    uses_index = 'USING INDEX' in upper or 'USING COVERING INDEX' in upper
    return (uses_index, plan_text)


# ---------------------------------------------------------------------------
# Candidate-query indexes
# ---------------------------------------------------------------------------

class TestCandidateQueryIndexes:
    @pytest.mark.parametrize(
        'module_name', list(CANDIDATE_QUERIES.keys()),
    )
    def test_candidate_sql_uses_an_index(
        self, module_name, tmp_db_path, claims_db_path,
    ):
        """For every registered module, EXPLAIN must show 'USING INDEX'.

        Without this, claim_candidates degrades to a full scan of the
        papers table inside a write transaction — the stall we hit when
        we first launched the new architecture.
        """
        spec = CANDIDATE_QUERIES[module_name]
        conn = get_claims_connection(
            claims_db_path=claims_db_path, main_db_path=tmp_db_path,
        )
        try:
            wrapped = f"""
                WITH base AS ({spec['candidate_sql']})
                SELECT b.id FROM base b
                {spec['order_by']}
                LIMIT 1
            """
            uses_index, plan = _planner_uses_index(conn, wrapped)
            if not uses_index:
                pytest.fail(
                    f"Module {module_name!r} candidate_sql does a full "
                    f"papers scan. Add a partial index in db.py:_SCHEMA "
                    f"matching its WHERE clause.\n\nPlan:\n{plan}"
                )
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# Claim-candidates' NOT EXISTS subquery (the bug that caused the stall)
# ---------------------------------------------------------------------------

class TestClaimCandidatesNotExists:
    def test_per_field_tried_subquery_uses_index(
        self, tmp_db_path, claims_db_path,
    ):
        """The per-field 'this service already tried (recently)' NOT EXISTS
        subquery in claim_candidates MUST seek idx_attempts_tried on
        (paper_id, service, field). Without it the writer scans the table
        once per candidate × field — the stall the old index guarded against.

        Indirect probe: write the same NOT EXISTS shape directly and assert
        the planner uses idx_attempts_tried.
        """
        conn = get_claims_connection(
            claims_db_path=claims_db_path, main_db_path=tmp_db_path,
        )
        try:
            sql = """
                SELECT 1 FROM enrichment_attempts ea
                WHERE ea.paper_id = ? AND ea.service = ? AND ea.field = ?
                  AND (ea.status = 'succeeded'
                       OR ea.status = 'claimed'
                       OR (ea.status = 'failed' AND ea.finished_at > ?))
            """
            uses_index, plan = _planner_uses_index(
                conn, sql, (1, 'oa', 'abstract', 't'))
            assert uses_index, plan
            # Either the explicit idx_attempts_tried or the PK autoindex is
            # fine — both seek (paper_id, service, field) rather than scan.
            assert ('idx_attempts_tried' in plan
                    or 'autoindex' in plan), f'Wrong index used. Plan: {plan}'
            assert 'paper_id=? AND service=? AND field=?' in plan, (
                f'Subquery is not a full 3-col seek. Plan: {plan}'
            )
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# Identifier-lookup indexes used by _batch_lookup
# ---------------------------------------------------------------------------

class TestIdentifierLookupIndexes:
    @pytest.mark.parametrize('column', ['doi', 's2_id', 'oa_id'])
    def test_papers_identifier_lookup_uses_unique_index(
        self, column, tmp_db_path, db_conn,
    ):
        """The merge writer's _batch_lookup does
            papers.<col> = probe.<col>
        for each of doi / s2_id / oa_id. Each lookup must hit a UNIQUE
        partial index — otherwise the OR-join in _batch_lookup degrades."""
        sql = f"SELECT id FROM papers WHERE {column} = ?"
        uses_index, plan = _planner_uses_index(db_conn, sql, ('x',))
        assert uses_index, (
            f"papers.{column} lookup does not use an index!\n{plan}"
        )

    def test_identifiers_scheme_value_lookup(self, db_conn):
        """Finding a paper by a secondary identifier (issn/isbn/arxiv/...)
        must hit idx_identifiers_scheme_value, not scan the table."""
        uses_index, plan = _planner_uses_index(
            db_conn,
            "SELECT paper_id FROM identifiers WHERE scheme = ? AND value = ?",
            ('issn', '1234-5678'),
        )
        assert uses_index, plan

    def test_citations_primary_key_lookup(self, db_conn):
        """citations(citing_id, cited_id) is the PK; writer INSERT OR IGNORE
        depends on it being indexed."""
        uses_index, plan = _planner_uses_index(
            db_conn,
            "SELECT 1 FROM citations WHERE citing_id = ? AND cited_id = ?",
            (1, 2),
        )
        assert uses_index, plan

    def test_pending_citations_id_lookup(self, db_conn):
        """The writer deletes pending rows by id; must be indexed."""
        uses_index, plan = _planner_uses_index(
            db_conn,
            "DELETE FROM pending_citations WHERE id = ?",
            (1,),
        )
        # DELETE plans look slightly different; SEARCH/USING is OK.
        assert uses_index or 'SEARCH' in plan.upper(), plan
