"""Citation-retrieval coverage + collect-all pending materialization.

Covers the three feature parts that are testable without Redis/network:
  - the legacy `_all` -> `cites` claims migration for oa_incoming,
  - `materialize_ghost_stubs` default (degree>=1) pulling EVERY pending endpoint
    into the corpus as a stub,
  - the qc coverage definition (refs/cites over the non-stub corpus).
"""
import sqlite3

import pytest

from biblion.db import _migrate_citation_attempt_fields
from biblion.modules.materialize_ghost_stubs import MaterializeGhostStubs

pytestmark = pytest.mark.unit


# ── claims migration ────────────────────────────────────────────────────

def _attempt(conn, pid, service, field, status='succeeded'):
    conn.execute(
        "INSERT OR REPLACE INTO enrichment_attempts "
        "(paper_id, service, field, status, claimed_at, finished_at) "
        "VALUES (?,?,?,?,?,?)",
        (pid, service, field, status, '2020-01-01T00:00:00+00:00',
         '2020-01-01T00:00:00+00:00'))
    conn.commit()


def test_oa_incoming_all_relabelled_to_cites(claims_conn):
    _attempt(claims_conn, 1, 'oa_incoming', '_all', 'succeeded')
    _attempt(claims_conn, 2, 'oa_incoming', '_all', 'failed')
    _attempt(claims_conn, 3, 's2_hop', '_all', 'succeeded')   # must stay '_all'

    _migrate_citation_attempt_fields(claims_conn)

    rows = {(r['paper_id'], r['service'], r['field'], r['status'])
            for r in claims_conn.execute(
                "SELECT paper_id, service, field, status FROM enrichment_attempts")}
    assert (1, 'oa_incoming', 'cites', 'succeeded') in rows
    assert (2, 'oa_incoming', 'cites', 'failed') in rows
    assert (3, 's2_hop', '_all', 'succeeded') in rows         # untouched
    # No oa_incoming '_all' rows remain.
    assert not any(s == 'oa_incoming' and f == '_all' for _, s, f, _ in rows)


def test_migration_idempotent_and_preserves_existing_cites(claims_conn):
    # A post-upgrade run already recorded a real 'cites' attempt; an old '_all'
    # row for the same paper must not clobber it, and re-running is a no-op.
    _attempt(claims_conn, 1, 'oa_incoming', 'cites', 'succeeded')
    _attempt(claims_conn, 1, 'oa_incoming', '_all', 'failed')

    _migrate_citation_attempt_fields(claims_conn)
    _migrate_citation_attempt_fields(claims_conn)   # idempotent

    rows = claims_conn.execute(
        "SELECT field, status FROM enrichment_attempts "
        "WHERE paper_id=1 AND service='oa_incoming'").fetchall()
    assert [(r['field'], r['status']) for r in rows] == [('cites', 'succeeded')]


# ── materialize_ghost_stubs: collect-all (degree>=1) ────────────────────

class _Shutdown:
    requested = False


class _Cache:
    def __init__(self):
        self.pushed = []
        self.backfills = []

    def ping(self):
        return True

    def push_papers(self, batch):
        self.pushed.extend(batch)
        return len(batch)

    def push_pending_doi_backfills(self, batch):
        batch = list(batch)
        self.backfills.extend(batch)
        return len(batch)


class _Ctx:
    def __init__(self, db_path, cache, config=None):
        self._db_path = db_path
        self.cache = cache
        self.config = config or {}
        self.shutdown = _Shutdown()

    def connect(self, readonly=False):
        conn = sqlite3.connect(str(self._db_path))
        conn.row_factory = sqlite3.Row
        return conn


def _seed_two_pendants(insert_paper, insert_pending_citation):
    """Two real in-corpus papers, each citing a DISTINCT external DOI (degree 1)."""
    insert_paper(doi='10.1/a', title='A', abstract='x', is_stub=0)
    insert_paper(doi='10.2/b', title='B', abstract='x', is_stub=0)
    insert_pending_citation(citing_doi='10.1/a', cited_doi='10.9/x', provenance='t')
    insert_pending_citation(citing_doi='10.2/b', cited_doi='10.9/y', provenance='t')


def test_default_drops_degree1_pendants(
        tmp_db_path, db_conn, insert_paper, insert_pending_citation):
    # The network_toy ghost threshold is the DEFAULT (degree>=2): two distinct
    # single-cited endpoints add no inter-paper structure, so neither is
    # materialized. (Their DOIs still get resolved by resolve_pending_dois; only
    # then can a genuinely-shared endpoint cross the threshold.)
    _seed_two_pendants(insert_paper, insert_pending_citation)
    cache = _Cache()
    res = MaterializeGhostStubs().run(_Ctx(tmp_db_path, cache))   # default min_degree=2
    assert cache.pushed == []
    assert res.stats['min_degree'] == 2


def test_min_degree_1_materializes_everything(
        tmp_db_path, db_conn, insert_paper, insert_pending_citation):
    # The explicit collect-all override still works (e.g. one-off backfills).
    _seed_two_pendants(insert_paper, insert_pending_citation)
    cache = _Cache()
    res = MaterializeGhostStubs().run(_Ctx(tmp_db_path, cache, {'ghost_min_degree': 1}))
    assert sorted(r.doi for r in cache.pushed) == ['10.9/x', '10.9/y']
    assert res.stats['stubs_pushed'] == 2


def test_shared_endpoint_is_materialized_once(
        tmp_db_path, db_conn, insert_paper, insert_pending_citation):
    insert_paper(doi='10.1/a', title='A', abstract='x', is_stub=0)
    insert_paper(doi='10.2/b', title='B', abstract='x', is_stub=0)
    # Both cite the SAME external DOI (degree 2).
    insert_pending_citation(citing_doi='10.1/a', cited_doi='10.9/shared', provenance='t')
    insert_pending_citation(citing_doi='10.2/b', cited_doi='10.9/shared', provenance='t')
    cache = _Cache()
    MaterializeGhostStubs().run(_Ctx(tmp_db_path, cache))
    assert [r.doi for r in cache.pushed] == ['10.9/shared']      # one stub, not two


# ── qc coverage definition ──────────────────────────────────────────────

_COVERAGE_SQL = """
    SELECT
      (SELECT COUNT(*) FROM main_v3.papers
         WHERE is_stub=0 AND is_rejected=0
           AND (doi IS NOT NULL OR s2_id IS NOT NULL))         AS refs_eligible,
      (SELECT COUNT(DISTINCT ea.paper_id)
         FROM enrichment_attempts ea
         JOIN main_v3.papers p ON p.id = ea.paper_id
         WHERE p.is_stub=0 AND p.is_rejected=0
           AND ea.status IN ('succeeded','failed')
           AND (ea.field='refs' OR ea.service='s2_hop'))       AS refs_covered
"""


def test_coverage_counts_refs_and_excludes_stubs(
        claims_conn, insert_paper):
    insert_paper(doi='10.1/a', title='A', abstract='x', is_stub=0)   # id 1
    insert_paper(doi='10.2/b', title='B', abstract='x', is_stub=0)   # id 2 (uncovered)
    insert_paper(doi='10.3/g', is_stub=1)                            # id 3 ghost (excluded)
    # Paper 1 covered via explicit refs; a ghost row must not count.
    _attempt(claims_conn, 1, 'oa', 'refs', 'succeeded')
    _attempt(claims_conn, 3, 'oa', 'refs', 'succeeded')              # stub: ignored

    row = claims_conn.execute(_COVERAGE_SQL).fetchone()
    assert row['refs_eligible'] == 2          # ids 1,2; ghost excluded
    assert row['refs_covered'] == 1           # only id 1


def test_coverage_counts_s2_hop_as_refs(claims_conn, insert_paper):
    insert_paper(doi='10.1/a', title='A', abstract='x', is_stub=0)   # id 1
    _attempt(claims_conn, 1, 's2_hop', '_all', 'succeeded')          # legacy hop
    row = claims_conn.execute(_COVERAGE_SQL).fetchone()
    assert row['refs_covered'] == 1           # s2_hop '_all' counts as refs


# ── resolve_pending_dois producer ───────────────────────────────────────

def test_resolve_pending_dois_pushes_backfills(
        tmp_db_path, db_conn, insert_paper, insert_pending_citation, monkeypatch):
    """OA-only pending endpoints get resolved to DOIs and pushed as backfills,
    keyed by the exact stored oa_id so the writer's UPDATE matches."""
    import biblion.modules.resolve_pending_dois as mod
    from tests.support.fake_clients import FakeOpenAlexClient

    insert_paper(doi='10.1/a', title='A', abstract='x', is_stub=0)
    # cited endpoint known only by OA id; one citing endpoint likewise.
    insert_pending_citation(citing_doi='10.1/a', cited_oa_id='W100', provenance='t')
    insert_pending_citation(citing_oa_id='W200', cited_doi='10.1/a', provenance='t')

    fake = FakeOpenAlexClient(by_oa_id={
        'W100': {'id': 'https://openalex.org/W100', 'doi': 'https://doi.org/10.9/x'},
        'W200': {'id': 'https://openalex.org/W200', 'doi': 'https://doi.org/10.9/y'},
    })
    monkeypatch.setattr(mod, 'OpenAlexClient', lambda: fake)

    cache = _Cache()
    res = mod.ResolvePendingDois().run(_Ctx(tmp_db_path, cache))
    got = {(b.oa_id, b.doi) for b in cache.backfills}
    assert got == {('W100', '10.9/x'), ('W200', '10.9/y')}   # normalised DOIs
    assert res.stats['resolved'] == 2


def test_resolve_skips_already_doi_endpoints(
        tmp_db_path, db_conn, insert_paper, insert_pending_citation, monkeypatch):
    """An endpoint that already carries a DOI is not re-resolved."""
    import biblion.modules.resolve_pending_dois as mod
    from tests.support.fake_clients import FakeOpenAlexClient

    insert_paper(doi='10.1/a', title='A', abstract='x', is_stub=0)
    insert_pending_citation(
        citing_doi='10.1/a', cited_oa_id='W100', cited_doi='10.9/known', provenance='t')
    fake = FakeOpenAlexClient(by_oa_id={'W100': {'doi': '10.9/x'}})
    monkeypatch.setattr(mod, 'OpenAlexClient', lambda: fake)

    cache = _Cache()
    mod.ResolvePendingDois().run(_Ctx(tmp_db_path, cache))
    assert cache.backfills == []     # cited_doi already set -> not scanned


def test_backfill_unifies_cross_source_halves_for_degree2(
        tmp_db_path, db_conn, insert_paper, insert_pending_citation):
    """End-to-end of the unification: the SAME external paper cited via an OA id
    by one real paper and via its DOI by another starts as two degree-1 halves
    (materialize at >=2 drops both). After the DOI is stamped onto the oa-id
    half, they share a DOI -> one degree-2 ghost is materialized."""
    insert_paper(doi='10.1/a', title='A', abstract='x', is_stub=0)
    insert_paper(doi='10.2/b', title='B', abstract='x', is_stub=0)
    # paper A cites external P by OA id; paper B cites the same P by DOI.
    insert_pending_citation(citing_doi='10.1/a', cited_oa_id='W_P', provenance='t')
    insert_pending_citation(citing_doi='10.2/b', cited_doi='10.9/p', provenance='t')

    # Before backfill: two separate degree-1 endpoints -> nothing at >=2.
    cache = _Cache()
    MaterializeGhostStubs().run(_Ctx(tmp_db_path, cache))
    assert cache.pushed == []

    # Simulate the writer applying the backfill (stamp 10.9/p onto the oa half).
    db_conn.execute(
        "UPDATE pending_citations SET cited_doi='10.9/p' "
        "WHERE cited_oa_id='W_P' AND cited_doi IS NULL")
    db_conn.commit()

    cache2 = _Cache()
    MaterializeGhostStubs().run(_Ctx(tmp_db_path, cache2))
    assert [r.doi for r in cache2.pushed] == ['10.9/p']   # now one degree-2 ghost
