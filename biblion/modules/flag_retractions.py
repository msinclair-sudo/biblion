"""
flag_retractions — sweep existing DOI'd papers for editorial notices and stamp
their status.

Normal enrichment is claim-gated: a paper already 'succeeded' by OpenAlex is
never re-pulled, so the editorial_status field (added later) never lands on the
back catalogue. This is a one-shot, direct sweep — like `biblion migrate` but
with a live OpenAlex lookup — that re-checks `is_retracted` for every DOI'd
paper and writes editorial_status + editorial_status_at.

It records a field_observations row (source 'oa_retraction_sweep', bucketed to
openalex) so the value participates in normal severity resolution later, and
sets papers.editorial_status directly. The timestamp is first-detection:
COALESCE keeps an earlier editorial_status_at if one already exists.

OpenAlex only distinguishes retracted; richer statuses (withdrawn / concern /
corrected) come from Crossref/PubMed via normal enrichment going forward.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..clients.openalex import OpenAlexClient, SELECT_FULL, parse_biblio, normalise_doi


_OA_BATCH = 50


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sweep_retractions(db_path: Path, limit: Optional[int] = None,
                      verbose: bool = False) -> dict:
    """Re-check DOI'd papers against OpenAlex and flag editorial status.
    Returns stats. Writes directly to the main DB (no cache/claim flow)."""
    from ..db import get_connection, init_db

    conn = get_connection(db_path)
    init_db(conn)                       # ensure editorial_status[_at] columns exist
    sql = ("SELECT id, doi FROM papers "
           "WHERE doi IS NOT NULL AND is_rejected = 0 ORDER BY id")
    if limit:
        sql += f" LIMIT {int(limit)}"
    rows = conn.execute(sql).fetchall()

    client = OpenAlexClient()
    ts = _now()
    stats = {'checked': 0, 'flagged': 0, 'newly_flagged': 0, 'batches': 0}

    pairs = [(r['id'], r['doi']) for r in rows]
    print(f"  flag_retractions: checking {len(pairs)} DOI'd papers via OpenAlex")

    for i in range(0, len(pairs), _OA_BATCH):
        chunk = pairs[i:i + _OA_BATCH]
        by_doi = {normalise_doi(d): pid for pid, d in chunk if d}
        try:
            works = client.fetch_batch_by_doi([d for _, d in chunk],
                                              select=SELECT_FULL)
        except Exception as e:
            if verbose:
                print(f"    [batch {stats['batches']+1}] ERROR "
                      f"{type(e).__name__}: {str(e)[:80]}")
            continue
        stats['batches'] += 1

        for doi, work in works.items():
            stats['checked'] += 1
            status = parse_biblio(work).get('editorial_status')
            if not status:
                continue
            pid = by_doi.get(normalise_doi(doi))
            if pid is None:
                continue
            stats['flagged'] += 1
            # Provenance: record an observation so future resolution sees it.
            conn.execute("""
                INSERT INTO field_observations
                    (paper_id, field, value, raw_value, source,
                     pub_type_hint, observed_at)
                VALUES (?, 'editorial_status', ?, ?, 'oa_retraction_sweep', NULL, ?)
                ON CONFLICT(paper_id, field, source) DO UPDATE SET
                    value = excluded.value, raw_value = excluded.raw_value,
                    observed_at = excluded.observed_at
            """, (pid, status, status, ts))
            # Set the column; first-detection timestamp preserved via COALESCE.
            cur = conn.execute("""
                UPDATE papers
                   SET editorial_status = ?,
                       editorial_status_at = COALESCE(editorial_status_at, ?),
                       updated_at = ?
                 WHERE id = ?
                   AND (editorial_status IS NULL OR editorial_status != ?)
            """, (status, ts, ts, pid, status))
            if cur.rowcount:
                stats['newly_flagged'] += 1
                if verbose:
                    print(f"    flagged {status}: paper {pid} ({doi})")

        if stats['batches'] % 10 == 0:
            conn.commit()
            print(f"    [{stats['checked']}/{len(pairs)}] "
                  f"flagged={stats['flagged']} "
                  f"calls={getattr(client, '_calls_today', '?')}")

    conn.commit()
    conn.close()
    return stats
