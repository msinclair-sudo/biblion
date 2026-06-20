"""
Merge writer — the only process that writes to v3's papers / citations tables.

Loop per cycle:

  1. Drain `resolved:papers` first (these have already been deduplicated by
     the resolver; they are guaranteed single-hit).
  2. Pop a batch of N records from `staged:papers`.
  3. In ONE SQL query, look up every identifier present in the batch.
  4. Classify each record as:
        new          → INSERT new row
        single_hit   → COALESCE update on the matched row, log any field conflicts
        multi_hit    → park to `parked:papers` and signal the resolver
  5. Repeat for `staged:citations` (endpoints resolved via the just-updated
     identifier index; unresolvable edges go to pending_citations).

Designed so each cycle is bounded and resumable. SIGINT halts after the
current cycle commits.
"""
import logging
import os
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..cache import CacheClient, PaperRecord, CitationRecord
from ..db    import get_connection, init_db, get_db_path, _source_bucket
from .resolve import (
    Observation, resolve, canonicalize, _canon_pub_type, _canon_editorial,
)


DEFAULT_BATCH_SIZE = 1000

# Page cache for the writer's PERSISTENT main-DB connection. SQLite's page cache
# is per-connection, so the writer keeps ONE connection alive across cycles
# (rather than reopening per cycle with a cold cache) and gives it a large cache
# so the hot index/working set stays in RAM. Citation processing is read-heavy
# (_batch_lookup probes papers/identifiers per edge); on a slow networked/9P
# mount a cold cache pins the writer on read I/O. Only the writer (one process)
# gets this — producers keep get_connection's modest default. Override via env.
_WRITER_CACHE_MB = int(os.environ.get('BIBLION_WRITER_CACHE_MB', '1024'))

_log = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Lookup result
# ---------------------------------------------------------------------------

@dataclass
class LookupHit:
    paper_id:   int
    matched_on: str           # 'doi', 's2_id', or 'oa_id'


def _batch_lookup(conn: sqlite3.Connection,
                  records: list[PaperRecord]) -> list[list[LookupHit]]:
    """
    For each record in `records`, find every existing papers.id that
    matches on any of its identifiers.

    Implementation: build a VALUES probe table inline, JOIN against papers
    on each identifier column with proper indexes. One round-trip.

    Returns a list parallel to `records`; each element is the list of
    paper_ids that matched (0, 1, or 2+).
    """
    n = len(records)
    if n == 0:
        return []

    # Build the probe rows. Each record contributes (idx, doi, s2_id, oa_id).
    probe_rows = []
    for i, rec in enumerate(records):
        probe_rows.append((i, rec.doi, rec.s2_id, rec.oa_id))

    # Build VALUES clause and parameter list
    placeholders = ', '.join(['(?, ?, ?, ?)'] * n)
    params = [v for row in probe_rows for v in row]

    sql = f"""
    WITH probe(cache_idx, doi, s2_id, oa_id) AS (
        VALUES {placeholders}
    )
    SELECT
        probe.cache_idx,
        p.id        AS paper_id,
        CASE
            WHEN p.doi   IS NOT NULL AND p.doi   = probe.doi   THEN 'doi'
            WHEN p.s2_id IS NOT NULL AND p.s2_id = probe.s2_id THEN 's2_id'
            WHEN p.oa_id IS NOT NULL AND p.oa_id = probe.oa_id THEN 'oa_id'
        END         AS matched_on
    FROM probe
    JOIN papers p ON
            (probe.doi   IS NOT NULL AND p.doi   = probe.doi)
         OR (probe.s2_id IS NOT NULL AND p.s2_id = probe.s2_id)
         OR (probe.oa_id IS NOT NULL AND p.oa_id = probe.oa_id)
    """
    rows = conn.execute(sql, params).fetchall()

    hits: list[list[LookupHit]] = [[] for _ in range(n)]
    seen: list[set[int]] = [set() for _ in range(n)]
    for r in rows:
        i = r['cache_idx']
        pid = r['paper_id']
        if pid in seen[i]:
            continue                # same paper matched on multiple columns — count once
        seen[i].add(pid)
        hits[i].append(LookupHit(paper_id=pid, matched_on=r['matched_on']))
    return hits


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------

# Fields that flow through the observation/resolve path. Identifiers
# (doi/s2_id/oa_id) are resolved here too — authoritative class. abstract /
# s2_fields_of_study are NOT resolved per-class: abstract is effectively
# "longest wins" and fields_of_study is additive; both keep their prior
# COALESCE/longest behavior and are NOT recorded as observations (they have no
# meaningful cross-source conflict to resolve and would bloat the table).
_RESOLVED_FIELDS = (
    'doi', 's2_id', 'oa_id',
    'title', 'year', 'authors', 'venue', 'pub_type',
    'publication_date', 'is_open_access',
    'pubmed_id', 'pubmed_central_id',
    # Extended bibliographic fields. 'editors' gets author-list treatment in
    # resolve(); the rest are authoritative scalars (Crossref-wins).
    'editors', 'volume', 'issue', 'first_page', 'last_page',
    'publisher', 'booktitle', 'series', 'edition', 'language', 'month',
    'editorial_status',
)
# Plain COALESCE/first-write-wins fields (not class-resolved, not observed).
_COALESCE_FIELDS = ('abstract', 's2_fields_of_study', 'influential_cit_count',
                    'citekey')


def _rec_value(rec: PaperRecord, col: str):
    """Look up the cache-record value for a target column."""
    if col == 'authors':
        return rec.authors_json
    if col == 'editors':
        return rec.editors_json
    return getattr(rec, col, None)


def _record_observation(conn, paper_id, field, rec, ts) -> None:
    """Write one (paper, field, source) observation row. Latest-per-source:
    a re-observation from the same source overwrites the prior one."""
    raw = _rec_value(rec, field)
    if raw is None:
        return
    canon = canonicalize(field, raw)
    # `value` is TEXT; canonicalize returns the canonical-format JSON string for
    # authors, a string for representational fields, or the scalar itself for
    # authoritative fields (year is int, identifiers are str). SQLite stores the
    # scalar fine; resolve() compares them as-is.
    conn.execute("""
        INSERT INTO field_observations
            (paper_id, field, value, raw_value, source, pub_type_hint, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(paper_id, field, source) DO UPDATE SET
            value = excluded.value,
            raw_value = excluded.raw_value,
            pub_type_hint = excluded.pub_type_hint,
            observed_at = excluded.observed_at
    """, (
        paper_id, field, canon, str(raw),
        rec.source, _canon_pub_type(rec.pub_type), ts,
    ))


def _load_observations(conn, paper_id, field) -> list:
    """Read all observations of (paper_id, field) as resolve.Observation."""
    rows = conn.execute(
        "SELECT value, raw_value, source, pub_type_hint "
        "FROM field_observations WHERE paper_id = ? AND field = ?",
        (paper_id, field),
    ).fetchall()
    out = []
    for r in rows:
        out.append(Observation(
            value=r['value'], raw=r['raw_value'],
            source=_source_bucket(r['source']),
            pub_type_hint=r['pub_type_hint'],
        ))
    return out


def _insert_new(conn: sqlite3.Connection, rec: PaperRecord, ts: str) -> int:
    """Insert a new papers row from a cache record. Returns the new paper id."""
    is_stub = 1 if not (rec.title or rec.abstract or rec.year) else 0
    is_oa = (1 if rec.is_open_access else 0) if rec.is_open_access is not None else None
    cur = conn.execute("""
        INSERT INTO papers
            (doi, s2_id, oa_id, title, year, venue, authors, abstract, pub_type,
             publication_date, is_open_access, influential_cit_count,
             s2_fields_of_study, pubmed_id, pubmed_central_id, citekey,
             editors, volume, issue, first_page, last_page, publisher,
             booktitle, series, edition, language, month, editorial_status,
             editorial_status_at, is_stub, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        rec.doi, rec.s2_id, rec.oa_id,
        rec.title, rec.year, rec.venue, rec.authors_json, rec.abstract,
        _canon_pub_type(rec.pub_type),
        rec.publication_date, is_oa, rec.influential_cit_count,
        rec.s2_fields_of_study, rec.pubmed_id, rec.pubmed_central_id, rec.citekey,
        rec.editors_json, rec.volume, rec.issue, rec.first_page, rec.last_page,
        rec.publisher, rec.booktitle, rec.series, rec.edition, rec.language,
        rec.month, _canon_editorial(rec.editorial_status),
        # timestamp the status the moment we first record a non-null one
        (ts if _canon_editorial(rec.editorial_status) else None),
        is_stub, ts, ts,
    ))
    new_id = cur.lastrowid
    # Record this record's observations for every resolved field, so a later
    # source's observation resolves against this one rather than blind-merging.
    for field in _RESOLVED_FIELDS:
        _record_observation(conn, new_id, field, rec, ts)
    _write_citation_counts(conn, new_id, rec, ts)
    _write_identifiers(conn, new_id, rec)
    return new_id


def _apply_single_hit(conn: sqlite3.Connection, paper_id: int,
                      rec: PaperRecord, ts: str) -> int:
    """
    Observation-driven resolution. Record this record's observations, then
    recompute each resolved field's canonical value from ALL observations via
    its resolution class (see merge.resolve). Returns the number of genuine
    post-resolution conflicts logged.

    Resolved fields (identifiers, title, year, venue, authors, pub_type,
    dates, is_open_access) go through resolve(); abstract / s2_fields_of_study
    / influential_cit_count keep plain COALESCE first-write-wins (no
    meaningful cross-source conflict to arbitrate).
    """
    existing = conn.execute(
        "SELECT doi, s2_id, oa_id, abstract, "
        "       s2_fields_of_study, influential_cit_count, citekey, "
        "       editorial_status "
        "FROM papers WHERE id = ?", (paper_id,)
    ).fetchone()
    if existing is None:
        # Shouldn't happen — lookup just told us this id exists
        return 0

    conflicts = 0
    updates: dict = {}

    # 1. Record observations for every resolved field present on this record,
    #    then resolve each from the full observation set.
    for field in _RESOLVED_FIELDS:
        if _rec_value(rec, field) is None:
            continue
        _record_observation(conn, paper_id, field, rec, ts)

    for field in _RESOLVED_FIELDS:
        obs = _load_observations(conn, paper_id, field)
        if not obs:
            continue
        res = resolve(field, obs)
        val = res.value
        if field == 'is_open_access' and isinstance(val, bool):
            val = 1 if val else 0
        updates[field] = val
        if res.conflict is not None:
            _log_conflict(conn, paper_id, field,
                          res.conflict.winner_value,
                          res.conflict.loser_value,
                          res.conflict.loser_source, ts)
            conflicts += 1

    # Stamp editorial_status_at when the resolved status FIRST becomes non-null
    # or changes (e.g. a severity upgrade). Unchanged status preserves the
    # original detection time.
    if updates.get('editorial_status') and \
            updates['editorial_status'] != existing['editorial_status']:
        updates['editorial_status_at'] = ts

    # 2. Plain COALESCE fields — fill NULLs; abstract prefers the longer value
    #    (replaces the old _OVERWRITE_POLICIES 'prefer_longer' for s2 bulk).
    for col in _COALESCE_FIELDS:
        prop = _rec_value(rec, col)
        if prop is None:
            continue
        ex = existing[col]
        if ex is None:
            updates[col] = prop
        elif col == 'abstract' and len(str(prop)) > len(str(ex)):
            updates[col] = prop

    if updates:
        set_parts, params = [], []
        for col, val in updates.items():
            set_parts.append(f"{col} = ?")
            params.append(val)
        set_parts.append("is_stub = 0")              # touched implies enriched
        set_parts.append("updated_at = ?"); params.append(ts)
        params.append(paper_id)
        sql = f"UPDATE papers SET {', '.join(set_parts)} WHERE id = ?"
        conn.execute(sql, params)

    _write_citation_counts(conn, paper_id, rec, ts)
    _write_identifiers(conn, paper_id, rec)
    return conflicts


def _write_identifiers(conn: sqlite3.Connection, paper_id: int,
                       rec: PaperRecord) -> None:
    """Route a record's scheme-keyed secondary identifiers into the
    identifiers table. extra_identifiers is {scheme: [values]} (a bare string
    is accepted too). INSERT OR IGNORE on (paper_id, scheme, value), so the
    same (paper, scheme, value) from a second source is a silent no-op."""
    extra = getattr(rec, 'extra_identifiers', None)
    if not extra:
        return
    for scheme, values in extra.items():
        if not scheme or not values:
            continue
        if isinstance(values, str):
            values = [values]
        for v in values:
            if v is None or v == '':
                continue
            conn.execute(
                "INSERT OR IGNORE INTO identifiers "
                "(paper_id, scheme, value, source) VALUES (?, ?, ?, ?)",
                (paper_id, str(scheme), str(v), rec.source),
            )


def _write_citation_counts(conn: sqlite3.Connection, paper_id: int,
                           rec: PaperRecord, ts: str) -> None:
    """Route per-source counts into citation_counts if any are present."""
    if rec.cit_count is None and rec.ref_count is None:
        return
    # Determine source bucket — anything starting with 'oa_' → 'openalex', etc.
    src = 'openalex' if rec.source.startswith('oa_') else \
          's2'       if rec.source.startswith('s2_') else \
          rec.source
    conn.execute("""
        INSERT INTO citation_counts (paper_id, source, cit_count, ref_count, fetched_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(paper_id, source) DO UPDATE SET
            cit_count  = COALESCE(excluded.cit_count, citation_counts.cit_count),
            ref_count  = COALESCE(excluded.ref_count, citation_counts.ref_count),
            fetched_at = excluded.fetched_at
    """, (paper_id, src, rec.cit_count, rec.ref_count, ts))


def _log_conflict(conn: sqlite3.Connection, paper_id: int, field: str,
                  existing, proposed, source: str, ts: str) -> None:
    conn.execute("""
        INSERT INTO field_conflicts
            (paper_id, field, existing_value, proposed_value, proposed_source, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (paper_id, field, str(existing), str(proposed), source, ts))


# ---------------------------------------------------------------------------
# Main merge cycle
# ---------------------------------------------------------------------------

@dataclass
class MergeStats:
    cycles:          int = 0
    paper_batches:   int = 0
    papers_seen:     int = 0
    new_papers:      int = 0
    updated_papers:  int = 0
    parked_papers:   int = 0
    conflicts:       int = 0
    citations_seen:  int = 0
    new_citations:   int = 0
    pending_citations: int = 0
    # Claim-flow telemetry (rolled up across all services).
    claim_requests_served: int = 0
    claim_rows_granted:    int = 0
    result_marks_applied:  int = 0
    # Pending-resolution telemetry (actions applied from the sidecar
    # pending_resolver process — see merge/pending_resolver.py).
    promote_actions_applied: int = 0
    promotions_already_done: int = 0
    # DOI backfills from resolve_pending_dois: oa_id->doi stamps applied to
    # pending_citations endpoints (counts pending ROWS updated, both sides).
    pending_dois_backfilled: int = 0
    # A promote action whose endpoint paper vanished between when the
    # pending_resolver resolved it and when we applied it — the Resolver merged
    # that duplicate away. Left pending for the next sweep to re-resolve onto the
    # surviving (canonical) paper. Expected churn, not an error.
    promotions_stale_endpoint: int = 0
    # Defensive counters — non-zero indicates a real problem the supervisor
    # should surface.
    commit_failures:   int = 0


class MergeWriter:
    """
    Single-writer merge process. Construct once, call run_cycle() in a loop.

    Also acts as the sole writer to the claims DB: it serves ClaimRequests
    from producers (running each module's candidate SQL and pushing
    ClaimGrants back) and applies ResultMarks. This eliminates multi-
    producer write-lock contention that previously throttled producers.
    """

    def __init__(self, db_path: Path, cache: CacheClient,
                 batch_size: int = DEFAULT_BATCH_SIZE,
                 served_modules: Optional[list[str]] = None):
        self.db_path    = db_path
        self.cache      = cache
        self.batch_size = batch_size
        self.stats      = MergeStats()
        # List of module names whose ClaimRequest queues we drain. Default
        # to every entry in the CANDIDATE_QUERIES registry — but tests and
        # specialised invocations can pass a narrower subset.
        if served_modules is None:
            from ..framework.claims import CANDIDATE_QUERIES
            served_modules = list(CANDIDATE_QUERIES.keys())
        self.served_modules = served_modules
        # Run init_db ONCE at construction. The migration is idempotent but
        # the PRAGMA table_info() + per-cycle no-op ALTERs added meaningful
        # overhead at 1000 cycles/min. Subsequent connections inherit the
        # already-created schema.
        conn = get_connection(self.db_path)
        try:
            init_db(conn)
            conn.commit()
        finally:
            conn.close()
        # ONE persistent main-DB connection reused across cycles. SQLite's page
        # cache is per-connection; reopening per cycle (the old behaviour) meant
        # a COLD cache every ~0.5s, so every endpoint lookup hit the disk — on a
        # large DB on a 9P/networked mount that pins the writer on read I/O. A
        # warm, large cache keeps the working set in RAM. Writer-only, so it
        # doesn't multiply across producer processes.
        self._conn = get_connection(self.db_path)
        self._conn.execute(f"PRAGMA cache_size = {-_WRITER_CACHE_MB * 1024}")
        # Persistent claims-DB connection (main DB ATTACHed as main_v3) for the
        # claim flow — same cold-cache-per-cycle problem as above: serving a
        # claim runs each module's candidate query against the ATTACHed papers
        # table, and reopening per cycle re-read it from disk every time.
        self._claims_conn = None

    # Max promote actions applied per cycle. Each action is two cheap
    # indexed writes (INSERT citations + DELETE pending) so this can be
    # generous.
    PROMOTE_BATCH = 5000

    def close(self) -> None:
        """Close the persistent connections. Idempotent; safe to call on GC."""
        for attr in ('_conn', '_claims_conn'):
            conn = getattr(self, attr, None)
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
                setattr(self, attr, None)

    def __del__(self):
        # Defensive: ensure the persistent connection is released even when a
        # caller (e.g. a test) doesn't call close(), so we don't leak it / trip
        # the "unclosed database" ResourceWarning.
        self.close()

    def run_cycle(self) -> int:
        """
        Run one merge cycle.

        Order:
          1. Drain `resolved:papers` (guaranteed single-hit).
          2. Process one batch from `staged:papers`.
          3. Process one batch from `staged:citations`.
          4. Apply any promote actions emitted by the pending_resolver
             sidecar (each action is INSERT citations + DELETE pending).
          5. Serve any pending ClaimRequests + apply any ResultMarks for
             each registered module's service.

        Returns the total number of records processed in this cycle.
        """
        conn = self._conn          # persistent — warm page cache across cycles
        self.stats.cycles += 1
        processed = 0

        try:
            # 1. drain resolved papers — these are guaranteed single-hit by construction,
            #    so we can route them through the same single-hit path.
            from ..cache.client import KEY_RESOLVED_PAPERS
            resolved = self.cache.pop_papers_batch(self.batch_size, key=KEY_RESOLVED_PAPERS)
            if resolved:
                processed += self._process_paper_batch(conn, resolved)

            # 2. staged papers
            papers = self.cache.pop_papers_batch(self.batch_size)
            if papers:
                processed += self._process_paper_batch(conn, papers)

            # 3. staged citations
            citations = self.cache.pop_citations_batch(self.batch_size)
            if citations:
                processed += self._process_citation_batch(conn, citations)

            # 4. promote actions from the pending_resolver sidecar
            processed += self._apply_promote_actions(conn)

            # 4b. DOI backfills from resolve_pending_dois — stamp resolved OA
            #     DOIs onto pending endpoints so cross-source halves unify.
            processed += self._apply_doi_backfills(conn)

            # Commit. A failure here (disk full, WAL corruption) means the
            # work we just did didn't make it to the DB — we MUST surface
            # that, not silently advance the cycle counter. The supervisor
            # will restart us and the source records remain in Redis for
            # retry.
            try:
                conn.commit()
            except sqlite3.OperationalError as e:
                _log.exception("MergeWriter.run_cycle commit failed: %s", e)
                self.stats.commit_failures += 1
                try:
                    conn.rollback()
                except Exception:
                    pass
                raise
        except Exception:
            # Persistent connection: roll back any partial transaction so the
            # next cycle starts clean. (The old per-cycle conn.close() discarded
            # it implicitly; now we hold the connection open, so we must.) The
            # supervisor restarts us on the re-raised error.
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        # NOTE: do NOT close `conn` here — it's the persistent self._conn whose
        # warm page cache is the whole point. It's closed in close()/on exit.

        # 5. serve claim flow — uses its own connection (claims DB sidecar)
        processed += self._serve_claim_flow()

        return processed

    # -------------------------------------------------------- claim flow

    def _serve_claim_flow(self) -> int:
        """
        Drain ClaimRequests → run candidate SQL → push ClaimGrants.
        Drain ResultMarks → bulk_mark.

        All claims-DB writes happen serially in this method, so there's no
        contention to fight. Producers see the lock for ~10ms instead of
        timing out at 30s under concurrent load.
        """
        from ..framework.claims import (
            CANDIDATE_QUERIES, claim_candidates, bulk_mark,
        )
        from ..cache.records import ClaimGrant

        processed = 0
        # Open the claims-DB connection once per cycle so we amortise the
        # ATTACH cost. This is the ONLY writer to that DB now. The
        # try/finally ensures wconn is closed on any exception path — a
        # Redis disconnect during push_claim_grant or an unforeseen DB
        # error would otherwise leak the connection.
        wconn = None
        try:
            for module_name in self.served_modules:
                spec = CANDIDATE_QUERIES.get(module_name)
                if spec is None:
                    continue
                service = spec['service']

                # First, drain all pending requests for this module (typically
                # only one — but if producers piled up while we were busy,
                # serve them in arrival order).
                while True:
                    req = self.cache.pop_claim_request(module_name)
                    if req is None:
                        break
                    if wconn is None:
                        wconn = self._connect_claims()
                    try:
                        rows = claim_candidates(
                            wconn, service,
                            candidate_sql=spec['candidate_sql'],
                            order_by=spec['order_by'],
                            limit=req.batch_size,
                            fields=spec.get('fields', ('_all',)),
                        )
                    except sqlite3.OperationalError:
                        # Shouldn't happen — we're the only writer — but if
                        # something exotic (CHECK constraint, disk full) hits,
                        # give the producer an empty grant so it can retry.
                        rows = []
                    grant = ClaimGrant(
                        service=module_name,
                        rows=[dict(r) for r in rows],
                    )
                    self.cache.push_claim_grant(grant)
                    self.stats.claim_requests_served += 1
                    self.stats.claim_rows_granted += len(rows)
                    processed += 1

                # Now drain all marks for the same module — one DB transaction
                # per mark via bulk_mark's internal handling.
                while True:
                    mark = self.cache.pop_result_mark(module_name)
                    if mark is None:
                        break
                    if wconn is None:
                        wconn = self._connect_claims()
                    try:
                        bulk_mark(
                            wconn, service,
                            succeeded=mark.succeeded,
                            failed=mark.failed,
                        )
                        self.stats.result_marks_applied += 1
                    except sqlite3.OperationalError:
                        # Same as above — drop the mark and let the claim
                        # expire naturally rather than block the cycle.
                        pass
                    processed += 1
        except Exception:
            # The persistent claims connection may hold a half-open transaction
            # after an unexpected error (Redis disconnect mid-serve, etc.); reset
            # it so the next cycle starts clean. Closed for good in close().
            self._reset_claims_conn()
            raise
        return processed

    def _reset_claims_conn(self) -> None:
        c = getattr(self, '_claims_conn', None)
        if c is not None:
            try: c.close()
            except Exception: pass
            self._claims_conn = None

    def _connect_claims(self) -> sqlite3.Connection:
        """Persistent claims-DB connection (main DB ATTACHed as main_v3), reused
        across cycles so the candidate queries' page cache stays warm. The big
        cache is set on the ATTACHed main schema (where candidate SQL reads the
        papers/identifiers it scans), not the small claims DB."""
        if self._claims_conn is None:
            from ..db import get_claims_connection
            c = get_claims_connection(main_db_path=self.db_path)
            try:
                c.execute(f"PRAGMA main_v3.cache_size = {-_WRITER_CACHE_MB * 1024}")
            except sqlite3.OperationalError:
                pass   # attach alias differs / unsupported — fall back to default
            self._claims_conn = c
        return self._claims_conn

    def _apply_promote_actions(self, conn: sqlite3.Connection) -> int:
        """
        Apply a batch of promotion actions emitted by the pending_resolver
        sidecar. Each action is one INSERT into citations + one DELETE
        from pending_citations.

        Both are cheap indexed writes. The whole batch runs in the same
        cycle's transaction (whichever conn we were called with).

        Idempotent: if the writer's own citation processing already
        promoted the same edge (via a fresh CitationRecord that arrived
        between when the resolver scanned and when this runs), the
        INSERT OR IGNORE silently noops and the DELETE just removes the
        now-stale pending row.

        Returns the number of actions applied.
        """
        actions = self.cache.pop_promote_citation_batch(self.PROMOTE_BATCH)
        if not actions:
            return 0
        ts = _now()
        for a in actions:
            # An endpoint can disappear between resolution and apply: the
            # Resolver merges a duplicate paper and DELETEs the loser, so
            # citing_id/cited_id may no longer exist -> citations' FK to
            # papers(id) fails. (OR IGNORE suppresses PK/UNIQUE conflicts but
            # NOT foreign-key violations.) This is common churn once ghost
            # stubs are materialized en masse, so catch it per-action: skip the
            # insert AND leave the pending row in place so the next sweep
            # re-resolves it onto the surviving canonical paper. Without this
            # the whole writer cycle aborts (exit 1) and every producer stalls.
            try:
                cur = conn.execute("""
                    INSERT OR IGNORE INTO citations
                        (citing_id, cited_id, provenance, discovered)
                    VALUES (?, ?, ?, ?)
                """, (a.citing_id, a.cited_id, a.provenance, ts))
            except sqlite3.IntegrityError:
                self.stats.promotions_stale_endpoint += 1
                continue            # keep pending row for re-resolution
            if cur.rowcount:
                self.stats.new_citations += 1
            else:
                self.stats.promotions_already_done += 1
            conn.execute(
                "DELETE FROM pending_citations WHERE id = ?",
                (a.pending_id,),
            )
        self.stats.promote_actions_applied += len(actions)
        return len(actions)

    DOI_BACKFILL_BATCH = 5000

    def _apply_doi_backfills(self, conn: sqlite3.Connection) -> int:
        """Stamp resolved OpenAlex DOIs onto pending_citations endpoints.

        resolve_pending_dois pushes (oa_id -> doi) pairs; we write the DOI into
        every pending row that knows the work only by its oa_id, on BOTH the
        citing and cited sides. Once stamped, an oa-id-only endpoint and a
        doi-bearing one (from S2) share a DOI, so materialize_ghost_stubs and the
        pending_resolver group them as one paper — making the ghost-degree count
        true. `AND ... IS NULL` keeps it idempotent and never clobbers a DOI we
        already have. Returns the number of pending rows updated.
        """
        backfills = self.cache.pop_pending_doi_backfill_batch(self.DOI_BACKFILL_BATCH)
        if not backfills:
            return 0
        updated = 0
        for b in backfills:
            if not (b.oa_id and b.doi):
                continue
            cur = conn.execute(
                "UPDATE pending_citations SET cited_doi = ? "
                "WHERE cited_oa_id = ? AND cited_doi IS NULL",
                (b.doi, b.oa_id))
            updated += cur.rowcount
            cur = conn.execute(
                "UPDATE pending_citations SET citing_doi = ? "
                "WHERE citing_oa_id = ? AND citing_doi IS NULL",
                (b.doi, b.oa_id))
            updated += cur.rowcount
        self.stats.pending_dois_backfilled += updated
        return updated

    # -------------------------------------------------------- paper processing

    def _process_paper_batch(self, conn: sqlite3.Connection,
                             records: list[PaperRecord]) -> int:
        """
        Process one batch with two safeguards against in-batch duplicates:

        1. Pre-batch lookup tells us which records already match existing rows.
        2. We track identifiers inserted *during this batch* so a later record
           with overlapping identifiers gets routed to single-hit rather than
           triggering a UNIQUE constraint violation.
        """
        self.stats.paper_batches += 1
        self.stats.papers_seen   += len(records)
        ts = _now()

        pre_hits = _batch_lookup(conn, records)

        # Identifier → paper_id index we maintain across the batch
        in_batch: dict[tuple[str, str], int] = {}   # (col, value) -> paper_id

        for rec, rec_hits in zip(records, pre_hits):
            # Augment the pre-batch hits with anything we inserted in this batch
            extra_hits = []
            for col, val in (('doi', rec.doi), ('s2_id', rec.s2_id), ('oa_id', rec.oa_id)):
                if val and (col, val) in in_batch:
                    pid = in_batch[(col, val)]
                    if not any(h.paper_id == pid for h in rec_hits):
                        extra_hits.append(LookupHit(paper_id=pid, matched_on=col))
            effective = rec_hits + extra_hits

            n = len(effective)
            if n == 0:
                new_id = _insert_new(conn, rec, ts)
                self.stats.new_papers += 1
                # Track this row's identifiers so later records in the batch
                # see it as a hit
                for col, val in (('doi', rec.doi), ('s2_id', rec.s2_id), ('oa_id', rec.oa_id)):
                    if val:
                        in_batch[(col, val)] = new_id
            elif n == 1:
                paper_id = effective[0].paper_id
                c = _apply_single_hit(conn, paper_id, rec, ts)
                self.stats.updated_papers += 1
                self.stats.conflicts      += c
                # Re-index in case this rec brought new identifiers
                for col, val in (('doi', rec.doi), ('s2_id', rec.s2_id), ('oa_id', rec.oa_id)):
                    if val:
                        in_batch[(col, val)] = paper_id
            else:
                self.cache.park_paper(rec)
                self.stats.parked_papers += 1
        return len(records)

    # ----------------------------------------------------- citation processing

    def _process_citation_batch(self, conn: sqlite3.Connection,
                                records: list[CitationRecord]) -> int:
        self.stats.citations_seen += len(records)
        ts = _now()

        # Build a single batched lookup of every identifier appearing in any
        # endpoint of any record. We then resolve both endpoints per record
        # from the resulting map.
        all_probes: list[tuple[Optional[str], Optional[str], Optional[str]]] = []
        for rec in records:
            all_probes.append((rec.citing_doi, rec.citing_s2_id, rec.citing_oa_id))
            all_probes.append((rec.cited_doi,  rec.cited_s2_id,  rec.cited_oa_id))

        # Reuse _batch_lookup by wrapping probes in faux PaperRecord
        faux = [PaperRecord(source='_cit', doi=d, s2_id=s, oa_id=o)
                for d, s, o in all_probes]
        hits = _batch_lookup(conn, faux)

        for i, rec in enumerate(records):
            citing_hits = hits[2 * i]
            cited_hits  = hits[2 * i + 1]
            citing_id = citing_hits[0].paper_id if len(citing_hits) == 1 else None
            cited_id  = cited_hits[0].paper_id  if len(cited_hits)  == 1 else None

            if citing_id and cited_id and citing_id != cited_id:
                cur = conn.execute("""
                    INSERT OR IGNORE INTO citations
                        (citing_id, cited_id, provenance, discovered)
                    VALUES (?, ?, ?, ?)
                """, (citing_id, cited_id, rec.source, ts))
                if cur.rowcount:
                    self.stats.new_citations += 1
            else:
                # One or both endpoints not yet in papers — park for later retry
                conn.execute("""
                    INSERT INTO pending_citations
                        (citing_doi, citing_s2_id, citing_oa_id,
                         cited_doi,  cited_s2_id,  cited_oa_id,
                         provenance, discovered_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    rec.citing_doi, rec.citing_s2_id, rec.citing_oa_id,
                    rec.cited_doi,  rec.cited_s2_id,  rec.cited_oa_id,
                    rec.source, ts,
                ))
                self.stats.pending_citations += 1
        return len(records)


# ---------------------------------------------------------------------------
# CLI entry — `python -m biblion.merge.writer`
# ---------------------------------------------------------------------------

def _check_candidate_query_indexes(db_path: Path,
                                   served_modules: list[str]) -> None:
    """
    Walk every served module's candidate SQL through EXPLAIN QUERY PLAN
    and warn if any does a full-table scan on `papers`.

    The intent is to catch a freshly-added producer module whose
    candidate predicate has no supporting index. Without this check, the
    writer would silently take ~100s/cycle on a 2M-row table and the
    operator would wonder why nothing's happening.

    Non-fatal — just prints a warning. The pipeline still works, it's
    just dramatically slower.
    """
    from ..framework.claims import CANDIDATE_QUERIES
    from ..db import get_claims_connection

    try:
        conn = get_claims_connection(main_db_path=db_path)
    except Exception as e:
        print(f"[merge] index check skipped (claims DB unavailable: {e})")
        return

    try:
        warned = 0
        for module_name in served_modules:
            spec = CANDIDATE_QUERIES.get(module_name)
            if spec is None:
                continue
            # Wrap the candidate SQL the same way claim_candidates does.
            probe_sql = f"""
                EXPLAIN QUERY PLAN
                WITH base AS ({spec['candidate_sql']})
                SELECT b.id FROM base b
                {spec['order_by']}
                LIMIT 1
            """
            try:
                plan = conn.execute(probe_sql).fetchall()
            except Exception:
                continue
            plan_text = ' '.join(r['detail'] if 'detail' in r.keys()
                                 else str(r) for r in plan)
            # SQLite reports either "SCAN papers" or "SCAN p" for a full
            # table scan; an indexed plan says "SEARCH ... USING INDEX"
            # or "SCAN ... USING INDEX".
            if ('USING INDEX' not in plan_text.upper()):
                print(f"[merge] WARNING: '{module_name}' candidate query does a "
                      f"full table scan on papers. Add a partial index "
                      f"matching its WHERE predicate, otherwise each claim "
                      f"batch will take ~100s on a large corpus.")
                warned += 1
        if warned == 0:
            print(f"[merge] candidate-query indexes look healthy "
                  f"({len(served_modules)} modules checked)")
    finally:
        conn.close()


def main():
    import argparse, time
    from ..runtime import ShutdownFlag

    p = argparse.ArgumentParser(description='Run the v3 merge writer as a daemon.')
    p.add_argument('--db', type=Path, default=None)
    p.add_argument('--redis-url', default='redis://localhost:6379/0')
    p.add_argument('--batch-size', type=int, default=DEFAULT_BATCH_SIZE)
    p.add_argument('--idle-sleep', type=float, default=1.0,
                   help='Seconds to sleep when both staged queues are empty')
    args = p.parse_args()
    db_path = args.db or get_db_path()

    cache  = CacheClient(url=args.redis_url)
    writer = MergeWriter(db_path, cache, batch_size=args.batch_size)
    flag   = ShutdownFlag.install(name='merge-writer')

    print(f"[merge] writing to {args.db}")
    print(f"[merge] redis @ {args.redis_url}  batch={args.batch_size} "
          f"cache={_WRITER_CACHE_MB}MB")
    _check_candidate_query_indexes(args.db, writer.served_modules)
    try:
        while not flag.requested:
            n = writer.run_cycle()
            if n == 0:
                time.sleep(args.idle_sleep)
            elif writer.stats.cycles % 50 == 0:
                print(f"[merge] cycles={writer.stats.cycles}  "
                      f"new={writer.stats.new_papers}  "
                      f"upd={writer.stats.updated_papers}  "
                      f"parked={writer.stats.parked_papers}  "
                      f"cits={writer.stats.new_citations}  "
                      f"pending={writer.stats.pending_citations}  "
                      f"promoted={writer.stats.promote_actions_applied}  "
                      f"conflicts={writer.stats.conflicts}")
    finally:
        writer.close()
    print(f"\n[merge] shutdown. final stats: {writer.stats}")


if __name__ == '__main__':
    main()
