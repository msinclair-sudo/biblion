"""
Per-(paper, service) claim coordination for cross-service producers.

Architecture (changed 2026-05-29):
  - All claims-DB writes happen in the merge writer process. Producers
    don't touch the DB; they push ClaimRequest into Redis, the writer
    runs the candidate SQL + records claims + pushes ClaimGrant back.
  - This eliminates the multi-producer write-lock contention that was
    making each producer sleep ~90% of the time on "database is locked".

OA and S2 producers run in parallel. They must not both spend API budget on
the same paper. The shared `enrichment_attempts` table arbitrates:

    status='claimed'    a service is currently working; others skip
    status='succeeded'  data was found; no service needs to try again
    status='failed'     service tried and came back empty; OTHER services may try

Stuck 'claimed' rows expire after a configurable window (default 30 min) and
become available to any service again — crash-safe by construction.

Candidate SQL registry
----------------------
Each producer module is associated with one entry in CANDIDATE_QUERIES,
keyed by the module's `name`. The writer uses this registry to translate
a ClaimRequest (which carries the module name) into the right SQL.

The 'service' field on each entry is the budget-pool identifier shared
with `enrichment_attempts.service` — multiple modules can share a service
(e.g. all three OA producers use service='oa') so a paper marked
succeeded by one is skipped by the others.

Adding a new producer module — checklist
----------------------------------------
1. Create `biblion/modules/<name>.py` with `name`, `validate`, `run`.
2. In run(), use `request_claim(ctx.cache, self.name, batch_size, ...)`
   and `report_marks(ctx.cache, self.name, succeeded_ids, failed_ids)`.
   Do NOT touch the claims DB directly.
3. Register the class in `modules/__init__.py:ALL_MODULES`.
4. Add an entry to CANDIDATE_QUERIES below, keyed by the module's name.
   - `service` should match other producers in the same budget pool, or
     be a new string if this producer has its own API budget.
   - `candidate_sql` MUST select `p.id AS id`. Aliasing other columns
     for the producer's use is fine.
   - `order_by` must reference `b.<col>` (the CTE alias), not `p.<col>`.
5. Add a supporting partial index in `db.py:_SCHEMA` if the predicate
   doesn't already match `idx_papers_needs_metadata` or
   `idx_papers_needs_doi`. The writer prints a startup warning if a
   candidate query does a full scan, so you'll notice if you forget.
"""
import re
import sqlite3
import time
from datetime import datetime, timezone


_DEFAULT_EXPIRY_MIN = 60   # was 30; bumped to give the writer more headroom
                            # to drain ResultMarks under transient slowness.
                            # The reaper is conservative — a producer's late
                            # mark always overrides a reaped 'failed' status,
                            # so this only affects when other services can
                            # poach an in-flight paper. 60 min keeps the
                            # poach risk low while tolerating writer hiccups.


# Strict allow-list for `order_by` strings passed to claim_candidates().
# claim_candidates builds its SQL with f-string interpolation, so the
# `order_by` clause is concatenated raw. Today every caller comes from the
# hardcoded CANDIDATE_QUERIES registry, but defensively we reject any
# string that doesn't match the narrow shape we actually use:
#   ORDER BY <expr>[, <expr>]*
# where <expr> is one of:
#   b.<col>            [ASC|DESC]
#   LENGTH(b.<col>)    [ASC|DESC]
# Column names are restricted to lowercase + underscore so we can't be
# tricked into pulling in punctuation or quoted identifiers.
_ORDER_BY_RE = re.compile(
    r'^\s*ORDER\s+BY\s+'
    r'(?:LENGTH\(b\.[a-z_]+\)|b\.[a-z_]+)'
    r'(?:\s+(?:ASC|DESC))?'
    r'(?:\s*,\s*(?:LENGTH\(b\.[a-z_]+\)|b\.[a-z_]+)(?:\s+(?:ASC|DESC))?)*'
    r'\s*$',
    re.IGNORECASE,
)


def _validate_order_by(order_by: str) -> None:
    """Raise ValueError if `order_by` doesn't match the safe shape."""
    if not _ORDER_BY_RE.match(order_by or ''):
        raise ValueError(
            f"claim_candidates: order_by failed validation: {order_by!r}. "
            f"Must be 'ORDER BY b.<col>[ ASC|DESC][, ...]'."
        )


def _ts() -> str:
    return datetime.now(timezone.utc).isoformat()


def _retry_cutoff_iso(retry_days: int | None = None) -> str:
    """ISO timestamp before which a 'failed' per-field attempt is retriable."""
    if retry_days is None:
        from ..config import ENRICH_RETRY_DAYS
        retry_days = ENRICH_RETRY_DAYS
    cutoff = datetime.now(timezone.utc).timestamp() - (retry_days * 86400)
    return datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()


def _build_eligibility(service: str, fields: tuple, retry_iso: str):
    """Build the per-field eligibility WHERE term + its params.

    A field is eligible if it's wanted-NULL on the paper (b.need_<field>) AND
    this service hasn't tried it, or its 'failed' attempt is old enough to
    retry. Shared by claim_candidates and count_remaining so they agree on
    exactly what 'claimable' means.
    """
    for f in fields:
        if not re.fullmatch(r'[a-z_]+', f):
            raise ValueError(f"bad field name {f!r}")
    terms, params = [], []
    for f in fields:
        terms.append(
            f"(b.need_{f} = 1 AND NOT EXISTS ("
            "  SELECT 1 FROM enrichment_attempts ea"
            "  WHERE ea.paper_id = b.id AND ea.service = ? AND ea.field = ?"
            "    AND (ea.status = 'succeeded'"
            "         OR ea.status = 'claimed'"
            "         OR (ea.status = 'failed' AND ea.finished_at > ?))"
            "))"
        )
        params += [service, f, retry_iso]
    return " OR ".join(terms), params


def count_remaining(conn: sqlite3.Connection, service: str,
                    candidate_sql: str, fields: tuple = ('_all',),
                    retry_days: int | None = None) -> int:
    """Count papers `service` could still claim — work remaining, no claiming.

    Same eligibility predicate as claim_candidates, minus the cross-service
    fresh-claim filter (that just defers, it doesn't reduce total work). Used
    by the dashboard so the user can see 'work left' and tell done from stalled.
    """
    retry_iso = _retry_cutoff_iso(retry_days)
    eligibility, params = _build_eligibility(service, fields, retry_iso)
    sql = f"""
        WITH base AS ({candidate_sql})
        SELECT COUNT(*) FROM base b WHERE ({eligibility})
    """
    return conn.execute(sql, params).fetchone()[0]


def claim_candidates(
    conn: sqlite3.Connection,
    service: str,
    candidate_sql: str,
    order_by: str,
    limit: int,
    fields: tuple = ('_all',),
    expiry_min: int = _DEFAULT_EXPIRY_MIN,
    retry_days: int | None = None,
) -> list[sqlite3.Row]:
    """
    Atomically claim up to `limit` candidates, tracked per (paper, service,
    field). A paper is eligible for `service` when it has at least one wanted
    field that is:
      - still missing on the papers table (the candidate_sql emits a
        `need_<field>` boolean column per field for this), AND
      - not already tried by THIS service recently — never tried, or last
        'failed' more than `retry_days` ago (upstream sources backfill over
        time, so failures are retriable on a timestamp). A 'succeeded' field
        is never retried.

    The old "some other service already succeeded" rule is intentionally
    gone: the papers table's `field IS NULL` is the source of truth for "still
    needed", so services fill fields independently and additively.

    Papers with a FRESH claim from another service (any field) are skipped to
    avoid two services double-spending on the same paper at once.

    Inserts one 'claimed' row per (paper, claimed-field) in a single
    transaction. The caller later reports per-field outcomes via report_marks.

    `candidate_sql` is wrapped in `WITH base AS (...)`; it MUST select `id` and
    a `need_<field>` column for each field in `fields`. `order_by` references
    `b.<col>`.
    """
    _validate_order_by(order_by)

    cutoff = datetime.now(timezone.utc).timestamp() - (expiry_min * 60)
    cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()
    retry_iso = _retry_cutoff_iso(retry_days)

    eligibility, field_params = _build_eligibility(service, fields, retry_iso)

    full_sql = f"""
        WITH base AS (
            {candidate_sql}
        )
        SELECT b.*
        FROM base b
        WHERE ({eligibility})
          AND NOT EXISTS (
            -- some other service has a fresh (non-stuck) claim on this paper
            SELECT 1 FROM enrichment_attempts ea
            WHERE ea.paper_id  = b.id
              AND ea.service   != ?
              AND ea.status    = 'claimed'
              AND ea.claimed_at > ?
        )
        {order_by}
        LIMIT ?
    """

    # Retry the BEGIN IMMEDIATE on transient SQLITE_BUSY: with multiple
    # producers contending for the claims DB's single write lock, several
    # may try to start a write transaction at the exact same moment. The
    # connection's busy_timeout already covers most contention, but the
    # initial BEGIN IMMEDIATE can occasionally race past it. Retry a few
    # times with exponential backoff before giving up.
    last_err = None
    for attempt in range(5):
        try:
            conn.execute("BEGIN IMMEDIATE")
            break
        except sqlite3.OperationalError as e:
            if 'locked' not in str(e).lower():
                raise
            last_err = e
            time.sleep(0.25 * (2 ** attempt))      # 0.25, 0.5, 1, 2, 4 = 7.75s total
    else:
        # Give up after 5 retries — caller will sleep and try again
        raise last_err  # pragma: no cover

    try:
        # Sweep stuck claims belonging to OUR service back to 'failed' so the
        # paper can be re-attempted later. 'failed' (not delete) keeps the
        # audit trail; finished_at drives the retry-after-N-days eligibility.
        conn.execute("""
            UPDATE enrichment_attempts
            SET status='failed', finished_at=?
            WHERE service = ?
              AND status  = 'claimed'
              AND claimed_at <= ?
        """, (_ts(), service, cutoff_iso))

        rows = conn.execute(
            full_sql, (*field_params, service, cutoff_iso, limit)
        ).fetchall()
        if rows:
            now = _ts()
            # Claim only the (paper, field) pairs that are individually
            # eligible: the field is wanted-NULL AND this service hasn't
            # already succeeded / recently failed / currently claimed it.
            # (Mirrors the row-level eligibility predicate above, per field —
            # otherwise we'd re-claim a field the service already settled.)
            claim_rows = []
            for r in rows:
                for f in fields:
                    if not r[f'need_{f}']:
                        continue
                    prior = conn.execute(
                        "SELECT status, finished_at FROM enrichment_attempts "
                        "WHERE paper_id=? AND service=? AND field=?",
                        (r['id'], service, f),
                    ).fetchone()
                    if prior is not None:
                        status, fin = prior['status'], prior['finished_at']
                        if status in ('succeeded', 'claimed'):
                            continue
                        if status == 'failed' and (fin or '') > retry_iso:
                            continue  # failed too recently to retry
                    claim_rows.append((r['id'], service, f, now))
            conn.executemany(
                "INSERT OR REPLACE INTO enrichment_attempts "
                "(paper_id, service, field, status, claimed_at) "
                "VALUES (?, ?, ?, 'claimed', ?)",
                claim_rows,
            )
        conn.commit()
        return rows
    except Exception:
        conn.rollback()
        raise


def mark_succeeded(conn: sqlite3.Connection, paper_id: int, service: str,
                   field: str = '_all') -> None:
    conn.execute("""
        UPDATE enrichment_attempts
        SET status='succeeded', finished_at=?
        WHERE paper_id=? AND service=? AND field=?
    """, (_ts(), paper_id, service, field))


def mark_failed(conn: sqlite3.Connection, paper_id: int, service: str,
                field: str = '_all') -> None:
    conn.execute("""
        UPDATE enrichment_attempts
        SET status='failed', finished_at=?
        WHERE paper_id=? AND service=? AND field=?
    """, (_ts(), paper_id, service, field))


def bulk_mark(
    conn: sqlite3.Connection,
    service: str,
    succeeded: list,
    failed: list,
) -> None:
    """
    Apply many per-field mark_succeeded/mark_failed in a single transaction.

    `succeeded` / `failed` are lists of (paper_id, field) pairs. Producers
    buffer per-(paper, field) outcomes in memory during the API loop, then
    call this once per batch. This shrinks the producer's lock-holding time
    on the claims DB from "duration of N API requests" to "one fast UPDATE
    transaction."

    Each pair updates the matching claimed row inserted by claim_candidates;
    a pair for a field that was never claimed is a harmless no-op UPDATE.

    Retries on SQLITE_BUSY just like claim_candidates: with N producers all
    flushing mark batches concurrently, the BEGIN IMMEDIATE may race.
    """
    if not succeeded and not failed:
        return

    ts = _ts()

    last_err = None
    for attempt in range(5):
        try:
            conn.execute("BEGIN IMMEDIATE")
            break
        except sqlite3.OperationalError as e:
            if 'locked' not in str(e).lower():
                raise
            last_err = e
            time.sleep(0.25 * (2 ** attempt))
    else:
        raise last_err  # pragma: no cover

    try:
        if succeeded:
            conn.executemany(
                "UPDATE enrichment_attempts "
                "SET status='succeeded', finished_at=? "
                "WHERE paper_id=? AND service=? AND field=?",
                [(ts, pid, service, fld) for pid, fld in succeeded],
            )
        if failed:
            conn.executemany(
                "UPDATE enrichment_attempts "
                "SET status='failed', finished_at=? "
                "WHERE paper_id=? AND service=? AND field=?",
                [(ts, pid, service, fld) for pid, fld in failed],
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def release_claims(conn: sqlite3.Connection, service: str) -> int:
    """
    Drop every in-flight ('claimed') row for this service.

    Used when a producer hits its daily budget and gives up so the other
    service can take the same candidates immediately. Returns the count freed.
    """
    # Retry on SQLITE_BUSY: with 4 concurrent producers contending for the
    # claims DB write lock, a transient lock collision is normal.
    last_err = None
    for attempt in range(5):
        try:
            cur = conn.execute(
                "DELETE FROM enrichment_attempts WHERE service=? AND status='claimed'",
                (service,),
            )
            conn.commit()
            return cur.rowcount
        except sqlite3.OperationalError as e:
            if 'locked' not in str(e).lower():
                raise
            last_err = e
            time.sleep(0.25 * (2 ** attempt))
    raise last_err


def release_all_claims(conn: sqlite3.Connection) -> int:
    """Drop every in-flight ('claimed') row across all services.

    Called on supervised-run shutdown so a producer's claims don't sit
    'claimed' (blocking re-claim until the 60-min stale-claim sweep) when the
    run ends — whether via Ctrl-C, clean completion, or a mid-batch crash. The
    papers were never completed, so deleting (vs. marking failed) keeps them
    fully eligible next run without imposing the failed-retry cooldown.
    """
    last_err = None
    for attempt in range(5):
        try:
            cur = conn.execute(
                "DELETE FROM enrichment_attempts WHERE status='claimed'")
            conn.commit()
            return cur.rowcount
        except sqlite3.OperationalError as e:
            if 'locked' not in str(e).lower():
                raise
            last_err = e
            time.sleep(0.25 * (2 ** attempt))
    raise last_err


def attempt_counts(conn: sqlite3.Connection) -> dict:
    """Diagnostic snapshot for qc / monitoring."""
    rows = conn.execute("""
        SELECT service, status, COUNT(*) AS n
        FROM enrichment_attempts
        GROUP BY service, status
    """).fetchall()
    return {(r['service'], r['status']): r['n'] for r in rows}


# ---------------------------------------------------------------------------
# Candidate-query registry — the writer reads these when serving claims.
# ---------------------------------------------------------------------------
#
# Each entry is keyed by the requesting module's name (so the writer can
# look it up from a ClaimRequest). `service` is the budget-pool ID shared
# with enrichment_attempts.
#
# Why hardcoded vs. module-supplied: the writer is a separate process from
# the producers. SQL travelling through Redis would be both ugly and a
# subtle attack surface. Hardcoding centralises the queries so we can also
# review/optimize them as a set.
#
# Shape:
#   'module_name': {
#       'service':       <enrichment_attempts.service value>,
#       'candidate_sql': <SELECT with `p.id AS id` and any extras>,
#       'order_by':      <ORDER BY clause referencing `b.<col>`>,
#   }


# ---------------------------------------------------------------------------
# Producer-side helper: request → wait for grant → return rows.
# ---------------------------------------------------------------------------


def request_claim(
    cache,
    module_name: str,
    batch_size: int,
    timeout_s: float = 30.0,
) -> list[dict]:
    """
    Producer-side blocking request for a batch of candidates.

    Pushes a ClaimRequest into the writer's queue, then blocks on the
    matching ClaimGrant queue for up to `timeout_s` seconds. Returns the
    rows the writer claimed for us, or an empty list on timeout / empty
    grant.

    Producers never touch the claims DB themselves — this function (plus
    `report_marks` below) is the entire API surface.
    """
    from ..cache.records import ClaimRequest
    req = ClaimRequest(service=module_name, batch_size=batch_size)
    cache.push_claim_request(req)
    grant = cache.pop_claim_grant(module_name, timeout=timeout_s)
    if grant is None:
        return []
    return grant.rows


def report_marks(
    cache,
    module_name: str,
    succeeded: list,
    failed: list,
) -> None:
    """Producer-side: report per-(paper, field) outcomes for a batch.

    `succeeded` / `failed` are lists of (paper_id, field) pairs. Field-less
    services pass (paper_id, '_all').
    """
    if not (succeeded or failed):
        return
    from ..cache.records import ResultMark
    cache.push_result_mark(ResultMark(
        service=module_name,
        succeeded=[list(x) for x in succeeded],
        failed=[list(x) for x in failed],
    ))


CANDIDATE_QUERIES: dict[str, dict] = {
    'enrich_metadata_oa': {
        'service': 'oa',
        'fields': ('abstract', 'authors', 'venue', 'year', 'pub_type'),
        # is_seed = 1 is the LEAF-BOUND anchor. Enriching a paper's metadata here
        # also pulls its referenced_works (refs) → new pending endpoints → new
        # ghosts → unbounded BFS. We only ever want that 1-hop expansion from the
        # SEEDS. is_seed never flips, unlike is_stub (writer flips is_stub→0 on
        # any touch, so a DOI-bearing ghost would otherwise become a ref-fetch
        # target and cascade). Ghosts stay identifier-only leaves.
        'candidate_sql': """
            SELECT p.id AS id, p.doi AS doi,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count,
                   (p.abstract IS NULL) AS need_abstract,
                   (p.authors  IS NULL) AS need_authors,
                   (p.venue    IS NULL) AS need_venue,
                   (p.year     IS NULL) AS need_year,
                   (p.pub_type IS NULL) AS need_pub_type
            FROM papers p
            WHERE p.doi IS NOT NULL
              AND p.is_rejected = 0
              AND p.is_seed = 1
              AND (p.abstract IS NULL OR p.authors IS NULL
                   OR p.venue IS NULL OR p.year IS NULL OR p.pub_type IS NULL)
        """,
        'order_by': "ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC",
    },
    'enrich_metadata_s2': {
        'service': 's2_live',
        'fields': ('abstract', 'authors', 'venue', 'year', 'pub_type'),
        # is_seed = 1 — see enrich_metadata_oa: only seeds expand (refs+citers
        # come along); ghosts stay leaves regardless of the is_stub flip.
        'candidate_sql': """
            SELECT p.id AS id, p.doi AS doi,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count,
                   (p.abstract IS NULL) AS need_abstract,
                   (p.authors  IS NULL) AS need_authors,
                   (p.venue    IS NULL) AS need_venue,
                   (p.year     IS NULL) AS need_year,
                   (p.pub_type IS NULL) AS need_pub_type
            FROM papers p
            WHERE p.doi IS NOT NULL
              AND p.is_rejected = 0
              AND p.is_seed = 1
              AND (p.abstract IS NULL OR p.authors IS NULL
                   OR p.venue IS NULL OR p.year IS NULL OR p.pub_type IS NULL)
        """,
        'order_by': "ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC",
    },
    'enrich_metadata_ncbi': {
        'service': 'ncbi',
        'fields': ('abstract', 'title', 'year'),
        'candidate_sql': """
            SELECT p.id AS id, p.pubmed_id AS pubmed_id, p.doi AS doi,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count,
                   (p.abstract IS NULL) AS need_abstract,
                   (p.title    IS NULL) AS need_title,
                   (p.year     IS NULL) AS need_year
            FROM papers p
            WHERE (p.pubmed_id IS NOT NULL OR p.doi IS NOT NULL)
              AND p.is_rejected = 0
              AND (p.abstract IS NULL OR p.title IS NULL OR p.year IS NULL)
        """,
        'order_by': "ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC",
    },
    'enrich_biblio_crossref': {
        'service': 'crossref',
        'fields': ('volume', 'first_page', 'publisher'),
        # Papers with a DOI still missing the publisher-deposited detail OA/S2
        # rarely carry. Backed by idx_papers_needs_biblio (db._SCHEMA).
        'candidate_sql': """
            SELECT p.id AS id, p.doi AS doi,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count,
                   (p.volume     IS NULL) AS need_volume,
                   (p.first_page IS NULL) AS need_first_page,
                   (p.publisher  IS NULL) AS need_publisher
            FROM papers p
            WHERE p.doi IS NOT NULL
              AND p.is_rejected = 0
              AND (p.volume IS NULL OR p.first_page IS NULL
                   OR p.publisher IS NULL)
        """,
        'order_by': "ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC",
    },
    'enrich_stubs_oa': {
        'service': 'oa',
        'fields': ('_all',),
        'candidate_sql': """
            SELECT p.id AS id, p.oa_id AS oa_id, 1 AS need__all,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count
            FROM papers p
            WHERE p.oa_id IS NOT NULL
              AND p.is_rejected = 0
              AND p.title IS NULL
        """,
        'order_by': "ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC",
    },
    'resolve_dois_oa': {
        'service': 'oa',
        'fields': ('_all',),
        'candidate_sql': """
            SELECT p.id AS id, p.title AS title, p.year AS year, 1 AS need__all,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count,
                   LENGTH(p.title) AS title_len
            FROM papers p
            WHERE p.doi IS NULL
              AND p.title IS NOT NULL
              AND p.is_rejected = 0
        """,
        'order_by': (
            "ORDER BY b.is_seed DESC, b.discovery_count DESC, "
            "b.title_len DESC, b.id ASC"
        ),
    },
    'resolve_dois_s2': {
        'service': 's2_live',
        'fields': ('_all',),
        'candidate_sql': """
            SELECT p.id AS id, p.title AS title, p.year AS year, 1 AS need__all,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count,
                   LENGTH(p.title) AS title_len
            FROM papers p
            WHERE p.doi IS NULL
              AND p.title IS NOT NULL
              AND p.is_rejected = 0
        """,
        'order_by': (
            "ORDER BY b.is_seed DESC, b.discovery_count DESC, "
            "b.title_len DESC, b.id ASC"
        ),
    },
    'resolve_dois_via_pmid': {
        'service': 'ncbi_pmid',
        'fields': ('_all',),
        'candidate_sql': """
            SELECT p.id AS id, p.pubmed_id AS pubmed_id, p.s2_id AS s2_id,
                   1 AS need__all,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count
            FROM papers p
            WHERE p.pubmed_id IS NOT NULL
              AND p.doi IS NULL
              AND p.is_rejected = 0
        """,
        'order_by': "ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC",
    },
    'resolve_dois_via_s2id': {
        'service': 's2_live',
        'fields': ('_all',),
        'candidate_sql': """
            SELECT p.id AS id, p.s2_id AS s2_id, 1 AS need__all,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count
            FROM papers p
            WHERE p.s2_id IS NOT NULL
              AND p.doi IS NULL
              AND p.is_rejected = 0
        """,
        'order_by': "ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC",
    },
    # Citation hop (S2 references + citations). The default candidate set
    # is "every paper in the corpus with at least one identifier" — the
    # service='s2_hop' tracking prevents re-hopping. For one-off targeted
    # runs the producer bypasses this entirely and iterates a user-supplied
    # identifier list.
    'expand_papers_s2': {
        'service': 's2_hop',
        'fields': ('_all',),
        'candidate_sql': """
            SELECT p.id AS id, p.doi AS doi, p.s2_id AS s2_id, 1 AS need__all,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count
            FROM papers p
            WHERE (p.doi IS NOT NULL OR p.s2_id IS NOT NULL)
              AND p.is_rejected = 0
        """,
        'order_by': "ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC",
    },
    # Incoming citations via OpenAlex cites: filter — who cites each paper we
    # have an oa_id for. Own service 'oa_incoming' so it tracks independently
    # of metadata enrichment. Edge-only (no stub metadata).
    'expand_incoming_oa': {
        'service': 'oa_incoming',
        'fields': ('cites',),
        # is_seed = 1: fetch incoming citations (who-cites-this) ONLY for seeds.
        # Doing it for every non-stub paper crawled the whole graph; anchoring on
        # is_seed (which never flips, unlike is_stub) keeps it to a 1-hop fan-in
        # around the seeds.
        'candidate_sql': """
            SELECT p.id AS id, p.oa_id AS oa_id, 1 AS need_cites,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count
            FROM papers p
            WHERE p.oa_id IS NOT NULL
              AND p.is_rejected = 0
              AND p.is_seed = 1
        """,
        'order_by': "ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC",
    },
    # Seeds-only variant of the hop (CLI: `biblion hop --seeds`). Same service
    # 's2_hop' as expand_papers_s2 so hop-tracking is SHARED — a seed already
    # hopped by either variant won't be re-claimed. The producer requests this
    # entry's name only when seeds_only is set.
    'expand_papers_s2_seeds': {
        'service': 's2_hop',
        'fields': ('_all',),
        'candidate_sql': """
            SELECT p.id AS id, p.doi AS doi, p.s2_id AS s2_id, 1 AS need__all,
                   p.is_seed AS is_seed, p.discovery_count AS discovery_count
            FROM papers p
            WHERE (p.doi IS NOT NULL OR p.s2_id IS NOT NULL)
              AND p.is_rejected = 0
              AND p.is_seed = 1
        """,
        'order_by': "ORDER BY b.is_seed DESC, b.discovery_count DESC, b.id ASC",
    },
}
