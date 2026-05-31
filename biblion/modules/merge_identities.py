"""
merge_identities — sweep existing duplicate rows in papers.

Why this module exists:
  The merge writer detects multi-hits only when a NEW cache record
  matches two existing rows. Pre-existing duplicates — e.g. rows that
  arrived from v2 migration where dedup wasn't done — are invisible to
  the runtime path. This module finds them via SQL and injects
  synthetic PaperRecords that carry the union of identifiers from each
  duplicate cluster, so the standard multi-hit → resolver path consumes
  them.

Detection strategy:
  For each identifier column (doi, s2_id, oa_id) we already enforce
  UNIQUE so cross-column orphans are the only case. A duplicate cluster
  is a connected component in the graph where:
      nodes = rows in papers
      edges = "row A has identifier X, row B has identifier Y, and some
              other row C in the corpus has both X and Y"
  In practice clusters tend to be tiny (2-3 rows) and arise from one
  source recording a paper by S2 ID while another recorded it by DOI.

This first cut handles the common case: pairs of rows that *would*
be merged if any one cache record carried both of their identifiers.
We scan citations + citation_counts + any cross-references to enumerate
those pairs, then push a synthetic record for each.

The harder N>2 case (e.g. row 1 has DOI, row 2 has S2, row 3 has OA,
all the same paper, no single source ever carried all three) requires
either upstream enrichment or a manual identifier-linkage table; out
of scope for v1 of this module.
"""
from datetime import datetime, timezone
from typing import Iterator

from ..cache.records import PaperRecord
from ..db import get_connection, init_db
from ..framework import Module, ModuleResult, ValidationResult


def _find_pair_clusters(conn) -> Iterator[tuple[int, int]]:
    """
    Yield (row_a_id, row_b_id) for every pair of papers that should merge.

    Heuristic: two rows are dup candidates when one row has identifier X
    that another row references via *its* known identifiers — e.g. the
    citing/cited columns in citations occasionally point to a paper by
    one ID that the target row knows by another. In v3 this won't happen
    by construction, but the v2 migration may have left such state.

    For the initial implementation we focus on a simpler signal: rows
    that have the same `title` AND `year` but DIFFERENT identifier
    columns populated (one has only DOI, the other only OA, etc).
    Conservative threshold — exact-match title + year is rare enough
    that false positives are unlikely.
    """
    sql = """
    SELECT a.id AS a_id, b.id AS b_id
    FROM papers a
    JOIN papers b
      ON  a.id < b.id
      AND a.title = b.title
      AND a.year IS NOT NULL
      AND a.year = b.year
    WHERE
        -- At least one identifier disagrees in a "filling NULL with value" way
        ((a.doi   IS NULL) <> (b.doi   IS NULL))
     OR ((a.s2_id IS NULL) <> (b.s2_id IS NULL))
     OR ((a.oa_id IS NULL) <> (b.oa_id IS NULL))
    """
    for row in conn.execute(sql):
        yield row['a_id'], row['b_id']


class MergeIdentities(Module):
    name        = 'merge_identities'
    description = 'Sweep papers for pairs sharing title+year but differing on identifiers'

    requires    = {'papers.title'}
    produces    = {'cache:papers'}             # synthetic union records
    eventually  = {'papers.id'}                # rows are deleted/merged
    resources   = set()                        # no API; pure DB read + cache push

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'],
                                    message='Redis cache unavailable')
        conn = ctx.connect(readonly=True)
        try:
            n = conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        finally:
            conn.close()
        if n == 0:
            return ValidationResult(ok=False, missing=['papers'],
                                    message='papers table is empty')
        return ValidationResult(ok=True)

    def run(self, ctx):
        conn = ctx.connect(readonly=True)
        try:
            pushed = 0
            for a_id, b_id in _find_pair_clusters(conn):
                row_a = conn.execute(
                    "SELECT doi, s2_id, oa_id, title, year FROM papers WHERE id = ?",
                    (a_id,),
                ).fetchone()
                row_b = conn.execute(
                    "SELECT doi, s2_id, oa_id FROM papers WHERE id = ?",
                    (b_id,),
                ).fetchone()
                if row_a is None or row_b is None:
                    continue   # already merged in a previous push this run

                rec = PaperRecord(
                    source = 'merge_identities_sweep',
                    doi    = row_a['doi']   or row_b['doi'],
                    s2_id  = row_a['s2_id'] or row_b['s2_id'],
                    oa_id  = row_a['oa_id'] or row_b['oa_id'],
                    title  = row_a['title'],
                    year   = row_a['year'],
                )
                # Sanity: synthetic record must carry at least 2 identifiers,
                # otherwise it can't possibly multi-hit.
                if sum(1 for v in (rec.doi, rec.s2_id, rec.oa_id) if v) < 2:
                    continue
                ctx.cache.push_paper(rec)
                pushed += 1
        finally:
            conn.close()

        return ModuleResult(
            status='success' if pushed else 'noop',
            message=f'pushed {pushed} synthetic union records to cache',
            stats={'synthetic_records': pushed},
        )
