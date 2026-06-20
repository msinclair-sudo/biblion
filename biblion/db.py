"""
biblion SQLite schema.

Inherits v2's design (one papers table, first-class citations, per-source
citation_counts, integer surrogate PK), and adds:

  field_observations — per-(paper,field,source) provenance; resolution substrate
  field_class        — declarative field → resolution-class map (seeded)
  source_trust       — declarative source → trust rank (seeded)
  field_conflicts    — post-resolution conflict audit log
  module_runs        — orchestrator run-state (defined in framework/state.py)
"""
import json
import os
import re
from pathlib import Path
from typing import Optional
import sqlite3


_SCHEMA = """
-- ---------------------------------------------------------------------------
-- Core bibliographic records.
-- One row per unique paper after merge-time deduplication.
-- Any of {doi, s2_id, oa_id} may be NULL; at least one is expected once the
-- merge writer has touched the row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS papers (
    id          INTEGER PRIMARY KEY,
    doi         TEXT,
    s2_id       TEXT,
    oa_id       TEXT,
    title       TEXT,
    year        INTEGER,
    venue       TEXT,
    authors     TEXT,                  -- JSON array of author display names
    abstract    TEXT,
    pub_type    TEXT,
    publication_date      TEXT,        -- ISO 'YYYY-MM-DD' when available
    is_open_access        INTEGER,     -- 0/1 from S2; NULL if unknown
    influential_cit_count INTEGER,     -- S2's "influential citations" subset
    s2_fields_of_study    TEXT,        -- JSON [{category, source}] from S2
    pubmed_id             TEXT,
    pubmed_central_id     TEXT,
    citekey               TEXT,        -- pandoc/BibTeX citation key (@key); first-write-wins
    -- Extended bibliographic fields (BibLaTeX superset). Promoted from the
    -- field_observations EAV substrate so they're queryable and round-trip on
    -- export. See _PAPERS_LATE_COLUMNS for the migration on pre-existing DBs.
    editors     TEXT,                  -- JSON array of editor display names (mirrors authors)
    volume      TEXT,                  -- TEXT: volumes like "12A", "II"
    issue       TEXT,                  -- bib 'number'; TEXT: "S1", "3-4"
    first_page  TEXT,                  -- pages decomposed; raw range kept in field_observations
    last_page   TEXT,
    publisher   TEXT,
    booktitle   TEXT,                  -- container title for chapters/proceedings (distinct from venue)
    series      TEXT,
    edition     TEXT,
    language    TEXT,                  -- ISO 639-1 when from OpenAlex
    month       TEXT,                  -- TEXT: bib months may be "jan" or "1"
    editorial_status TEXT,             -- NULL=none; 'retracted'|'withdrawn'|'concern'|'corrected' (most-severe across sources)
    editorial_status_at TEXT,          -- ISO timestamp biblion first detected the current status
    is_seed     INTEGER NOT NULL DEFAULT 0,
    is_stub     INTEGER NOT NULL DEFAULT 0,    -- 1 = only identifier(s) known, not yet enriched
    is_rejected INTEGER NOT NULL DEFAULT 0,    -- 1 = patent/proceedings/etc
    discovery_count INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_doi   ON papers(doi)   WHERE doi   IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_s2    ON papers(s2_id) WHERE s2_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_oa    ON papers(oa_id) WHERE oa_id IS NOT NULL;
CREATE        INDEX IF NOT EXISTS idx_papers_year  ON papers(year)  WHERE year  IS NOT NULL;
CREATE        INDEX IF NOT EXISTS idx_papers_seed  ON papers(is_seed) WHERE is_seed = 1;
CREATE        INDEX IF NOT EXISTS idx_papers_stub  ON papers(is_stub) WHERE is_stub = 1;
-- NB: the idx_papers_citekey index is created in init_db() AFTER the
-- late-column migration adds papers.citekey — it can't live here because
-- executescript() runs before the migration, and on a pre-existing DB the
-- column wouldn't exist yet (CREATE TABLE IF NOT EXISTS is a no-op there).

-- Candidate-query indexes for the claims framework. Without these the
-- writer's claim_candidates() does a full-table scan inside its write
-- transaction (110s on a 2M-row DB) and producers starve waiting for
-- grants. With them, the candidate select is a sub-millisecond index walk.
CREATE INDEX IF NOT EXISTS idx_papers_needs_metadata
    ON papers(is_seed DESC, discovery_count DESC, id)
    WHERE doi IS NOT NULL AND is_rejected = 0
      AND (abstract IS NULL OR authors IS NULL
           OR venue IS NULL OR year IS NULL OR pub_type IS NULL);
CREATE INDEX IF NOT EXISTS idx_papers_needs_doi
    ON papers(is_seed DESC, discovery_count DESC, LENGTH(title) DESC, id)
    WHERE doi IS NULL AND title IS NOT NULL AND is_rejected = 0;
CREATE INDEX IF NOT EXISTS idx_papers_pmid_no_doi
    ON papers(is_seed DESC, discovery_count DESC, id)
    WHERE pubmed_id IS NOT NULL AND doi IS NULL AND is_rejected = 0;
-- enrich_metadata_ncbi: papers reachable in PubMed (have a PMID or a DOI we
-- can resolve to one) that still lack abstract/title/year.
CREATE INDEX IF NOT EXISTS idx_papers_ncbi_enrich
    ON papers(is_seed DESC, discovery_count DESC, id)
    WHERE (pubmed_id IS NOT NULL OR doi IS NOT NULL) AND is_rejected = 0
      AND (abstract IS NULL OR title IS NULL OR year IS NULL);
-- For expand_papers_s2 (citation hop): any paper with an identifier we
-- can use to look it up in S2. This is a LARGE partial index in
-- practice — most rows match — but the candidate query then narrows
-- via the claims framework's NOT EXISTS subqueries (already indexed).
CREATE INDEX IF NOT EXISTS idx_papers_hop_eligible
    ON papers(is_seed DESC, discovery_count DESC, id)
    WHERE (doi IS NOT NULL OR s2_id IS NOT NULL) AND is_rejected = 0;
-- expand_incoming_oa: papers we have an OpenAlex id for (to query their citers).
CREATE INDEX IF NOT EXISTS idx_papers_has_oa_id
    ON papers(is_seed DESC, discovery_count DESC, id)
    WHERE oa_id IS NOT NULL AND is_rejected = 0;
-- enrich_biblio_crossref: DOI'd papers still missing publisher-deposited
-- detail (volume/first_page/publisher). NB: this partial index references the
-- extended columns, which exist from the start on a fresh DB but are added by
-- _migrate_papers_columns on a pre-existing one. SQLite tolerates a partial
-- index over a not-yet-added column only AT CREATE time if the column exists;
-- this index is therefore (re)created in init_db() AFTER the migration, not
-- inside _SCHEMA — see the idx_papers_citekey precedent.

-- ---------------------------------------------------------------------------
-- Scheme-keyed secondary identifiers (issn, isbn, arxiv, mag, dblp, ...).
-- The primary lookup keys (doi/s2_id/oa_id) stay as papers columns; this table
-- holds the open, often multi-valued set (a book can carry several ISBNs; a
-- serial print + electronic ISSN; S2 externalIds expose arxiv/mag/dblp/acl).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identifiers (
    paper_id INTEGER NOT NULL REFERENCES papers(id),
    scheme   TEXT NOT NULL,            -- 'issn'|'isbn'|'arxiv'|'mag'|'dblp'|...
    value    TEXT NOT NULL,
    source   TEXT,
    PRIMARY KEY (paper_id, scheme, value)
);
CREATE INDEX IF NOT EXISTS idx_identifiers_scheme_value
    ON identifiers(scheme, value);

-- ---------------------------------------------------------------------------
-- User-applied tags (network_toy Selected-papers panel; biblion CLI).
-- NOT part of the merge substrate: the MergeWriter never reads or writes this
-- table, so there is no field-resolution contention with it — a separate writer
-- (serve.py) updates it directly, taking at most a brief WAL writer-lock wait.
-- Copied into every snapshot like any other table; biblion export emits these
-- as BibTeX keywords. PK makes re-tagging idempotent (INSERT OR IGNORE).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_tags (
    paper_id INTEGER NOT NULL REFERENCES papers(id),
    tag      TEXT    NOT NULL,
    added_at TEXT    NOT NULL,
    added_by TEXT,                             -- 'network_toy' | 'cli' | NULL
    category TEXT,                             -- fixed vocab (species/gene/...); NULL = uncategorised
    PRIMARY KEY (paper_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_paper_tags_tag ON paper_tags(tag);

-- ---------------------------------------------------------------------------
-- Citation graph edges.
-- citing → cited.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS citations (
    citing_id   INTEGER NOT NULL REFERENCES papers(id),
    cited_id    INTEGER NOT NULL REFERENCES papers(id),
    provenance  TEXT NOT NULL,                -- 'oa_references', 's2_references', etc.
    discovered  TEXT,
    PRIMARY KEY (citing_id, cited_id)
);
CREATE INDEX IF NOT EXISTS idx_cit_citing ON citations(citing_id);
CREATE INDEX IF NOT EXISTS idx_cit_cited  ON citations(cited_id);

-- ---------------------------------------------------------------------------
-- Per-source citation/reference counts.
-- Different sources disagree; we keep all numbers, never reconcile.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS citation_counts (
    paper_id    INTEGER NOT NULL REFERENCES papers(id),
    source      TEXT NOT NULL,                -- 'openalex' | 's2'
    cit_count   INTEGER,
    ref_count   INTEGER,
    fetched_at  TEXT,
    PRIMARY KEY (paper_id, source)
);

-- ---------------------------------------------------------------------------
-- Per-field, per-source provenance — the resolution substrate.
-- One row per (paper, field, source): the latest value that source observed
-- for that field (A' / latest-per-source; not append-only history). The merge
-- writer records every field it sees here, then derives the canonical papers
-- value by resolving all observations of a field through its resolution class
-- (see biblion/merge/resolve.py). `value` is the canonicalized form used for
-- comparison/resolution; `raw_value` is the as-observed string for forensics.
-- `pub_type_hint` is the observing record's pub_type, carried so the
-- authoritative class can apply the "prefer version-of-record over preprint"
-- rule before falling back to source_trust.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_observations (
    paper_id      INTEGER NOT NULL REFERENCES papers(id),
    field         TEXT    NOT NULL,
    value         TEXT,
    raw_value     TEXT,
    source        TEXT    NOT NULL,         -- record.source verbatim
    pub_type_hint TEXT,
    observed_at   TEXT    NOT NULL,
    PRIMARY KEY (paper_id, field, source)
);
CREATE INDEX IF NOT EXISTS idx_obs_paper_field
    ON field_observations(paper_id, field);

-- ---------------------------------------------------------------------------
-- Declarative field → resolution-class map. The ONE place a field's
-- resolution behavior is decided. Seeded idempotently in init_db().
--   representational | authoritative | observational
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_class (
    field TEXT PRIMARY KEY,
    class TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Declarative source → trust rank (lower = more trusted). The ONE place
-- source ranking is decided. "prefer version-of-record over preprint" is a
-- rule of the authoritative class applied BEFORE this ordering, not a row
-- here. Seeded idempotently in init_db().
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_trust (
    source TEXT PRIMARY KEY,
    rank   INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Post-resolution conflict audit log.
-- Originally "first-write-wins"; now records a genuine disagreement that
-- SURVIVED resolution — two equally-trusted authoritative sources (same
-- version-role) proposing different values, or representational values that
-- still differ after canonicalization. A strictly smaller, more interesting
-- set than the old log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_conflicts (
    id              INTEGER PRIMARY KEY,
    paper_id        INTEGER NOT NULL REFERENCES papers(id),
    field           TEXT NOT NULL,            -- 'year', 'title', 'venue', etc.
    existing_value  TEXT,
    proposed_value  TEXT,
    proposed_source TEXT,                     -- source field from the PaperRecord
    discovered_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflicts_paper ON field_conflicts(paper_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_field ON field_conflicts(field);

-- ---------------------------------------------------------------------------
-- Citations that couldn't be resolved at merge time because one endpoint
-- isn't in papers yet. Re-checked each merge cycle.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_citations (
    id             INTEGER PRIMARY KEY,
    citing_doi     TEXT, citing_s2_id TEXT, citing_oa_id TEXT,
    cited_doi      TEXT, cited_s2_id  TEXT, cited_oa_id  TEXT,
    provenance     TEXT,
    discovered_at  TEXT NOT NULL,
    last_retry_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_retry ON pending_citations(last_retry_at);
-- Partial indexes for resolve_pending_dois: scanning DISTINCT OA-only endpoints
-- and the writer's per-oa_id DOI-backfill UPDATE. The `*_doi IS NULL` predicate
-- keeps them tiny (a row leaves the index the moment its DOI is stamped) and
-- exactly matches both the scan and update WHERE clauses.
CREATE INDEX IF NOT EXISTS idx_pending_cited_oa
    ON pending_citations(cited_oa_id) WHERE cited_oa_id IS NOT NULL AND cited_doi IS NULL;
CREATE INDEX IF NOT EXISTS idx_pending_citing_oa
    ON pending_citations(citing_oa_id) WHERE citing_oa_id IS NOT NULL AND citing_doi IS NULL;

-- ---------------------------------------------------------------------------
-- Orchestrator per-invocation run state.
-- Created here so it always exists after init_db(); framework.state.init()
-- remains a no-op alias for backward compatibility.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS module_runs (
    run_id        TEXT PRIMARY KEY,
    module_name   TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    status        TEXT,
    message       TEXT,
    stats_json    TEXT,
    error         TEXT,
    git_sha       TEXT
);
CREATE INDEX IF NOT EXISTS idx_module_runs_name
    ON module_runs(module_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_module_runs_status
    ON module_runs(status, started_at DESC);

"""

# ---------------------------------------------------------------------------
# Separate-file schema for enrichment_attempts.
# Lives in a sibling *_claims.db file so producer writes (frequent,
# concurrent from many producers) don't contend for the main DB write lock.
# Joined with main DB via ATTACH at query time.
# ---------------------------------------------------------------------------

# Per-field metadata columns an enrichment service can fill. The claim flow
# tracks attempts per (paper, service, field) so a paper stays eligible for
# OpenAlex's abstract even after Semantic Scholar already filled its other
# fields. Non-field-partitioned services (DOI resolution, stubs, hop) use the
# '_all' sentinel field and behave as one row per (paper, service).
ENRICHMENT_FIELDS = ('abstract', 'authors', 'venue', 'year', 'pub_type', 'title',
                     # Crossref biblio detail (enrich_biblio_crossref).
                     'volume', 'first_page', 'publisher',
                     # Citation retrieval coverage: 'refs' = outgoing reference
                     # list fetched, 'cites' = incoming citations fetched.
                     'refs', 'cites')
ENRICHMENT_FIELD_ALL = '_all'

_CLAIMS_SCHEMA = """
CREATE TABLE IF NOT EXISTS enrichment_attempts (
    paper_id     INTEGER NOT NULL,            -- references main.papers(id) via ATTACH
    service      TEXT    NOT NULL,            -- 'oa' | 's2_live' | 's2_bulk' | ...
    field        TEXT    NOT NULL,            -- 'abstract'|'authors'|...|'_all'
    status       TEXT    NOT NULL,            -- 'claimed' | 'succeeded' | 'failed'
    claimed_at   TEXT    NOT NULL,
    finished_at  TEXT,
    PRIMARY KEY (paper_id, service, field)
);
CREATE INDEX IF NOT EXISTS idx_attempts_claimed
    ON enrichment_attempts(claimed_at) WHERE status = 'claimed';
-- Serves claim_candidates' per-field "this service already tried (recently)"
-- check: seek (paper_id=?, service=?, field=?) and read status + finished_at.
CREATE INDEX IF NOT EXISTS idx_attempts_tried
    ON enrichment_attempts(paper_id, service, field, status);
"""


class DatabaseLocationError(SystemExit):
    """Raised when no DB path is configured. Friendly message; exits with code 2."""

    def __init__(self) -> None:
        super().__init__(
            "biblion: no database configured.\n"
            "  Provide one of (highest priority first):\n"
            "    --db PATH                      explicit path for this command\n"
            "    biblion project add <name> <path> && biblion use <name>\n"
            "                                   register a named project (preferred)\n"
            "    BIBLION_DB=PATH                environment variable (fallback)\n"
            "  Or create a new DB with `biblion init PATH`."
        )


def get_db_path() -> Path:
    """
    Resolve the main biblion SQLite path from BIBLION_DB.

    Raises DatabaseLocationError if unset; biblion never writes to a
    default location. Use `biblion init --db PATH` to create one.
    """
    import os
    raw = os.environ.get('BIBLION_DB')
    if not raw:
        raise DatabaseLocationError()
    return Path(raw).expanduser()


def get_claims_db_path() -> Path:
    """
    Sibling SQLite file for enrichment_attempts.

    Lives in its own file so producer claim writes don't contend for the
    write lock on the main DB (where the merge writer is the only
    intended writer). Defaults to a sibling `<db>_claims.db`; override via
    BIBLION_CLAIMS_DB.
    """
    import os
    override = os.environ.get('BIBLION_CLAIMS_DB')
    if override:
        return Path(override).expanduser()
    main = get_db_path()
    return main.with_name(main.stem + '_claims.db')


def get_logs_dir() -> Path:
    """Default: <db-dir>/logs. Overridable via BIBLION_LOG_DIR."""
    import os
    override = os.environ.get('BIBLION_LOG_DIR')
    if override:
        return Path(override).expanduser()
    return get_db_path().parent / 'logs'


def get_connection(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Open a connection with v3's standard PRAGMAs (WAL, busy_timeout, FKs)."""
    if db_path is None:
        db_path = get_db_path()
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA synchronous  = NORMAL")
    conn.execute("PRAGMA cache_size   = -131072")    # 128 MB page cache
    return conn


# Declarative seeds for the resolution substrate. INSERT OR IGNORE keeps these
# idempotent and never clobbers a hand-edited rank/class on re-init.
#
# field_class: representational fields normalize away their conflicts;
# authoritative fields resolve by VoR-rule then source_trust; observational
# fields are never single-valued in papers (counts live in citation_counts).
_FIELD_CLASS_SEED = (
    ('authors',           'representational'),
    ('venue',             'representational'),
    ('pub_type',          'representational'),
    ('title',             'representational'),
    ('doi',               'authoritative'),
    ('s2_id',             'authoritative'),
    ('oa_id',             'authoritative'),
    ('pubmed_id',         'authoritative'),
    ('pubmed_central_id', 'authoritative'),
    ('year',              'authoritative'),
    ('publication_date',  'authoritative'),
    ('is_open_access',    'authoritative'),
    ('influential_cit_count', 'observational'),
    # Extended bibliographic fields. Biblio metadata is single-valued per
    # version-of-record, so authoritative (Crossref-wins via VoR-then-trust).
    ('volume',            'authoritative'),
    ('issue',             'authoritative'),
    ('first_page',        'authoritative'),
    ('last_page',         'authoritative'),
    ('publisher',         'authoritative'),
    ('booktitle',         'authoritative'),
    ('series',            'authoritative'),
    ('edition',           'authoritative'),
    ('language',          'authoritative'),
    ('month',             'authoritative'),
    # editors get the same order-tolerant author-list treatment as authors.
    ('editors',           'representational'),
    # editorial_status resolves by SEVERITY (most-severe wins, sticky-true),
    # handled by a special case in resolve(); class here is nominal.
    ('editorial_status',  'authoritative'),
)

# Lower rank = more trusted. crossref is seeded now though no producer emits
# it yet — inert, forward-compatible, and needed by the later Crossref
# DOI-relations version signal.
_SOURCE_TRUST_SEED = (
    ('crossref', 1),
    ('openalex', 2),
    ('s2',       3),
    ('ncbi',     4),
    ('seed',     5),
)


def _source_bucket(source: str) -> str:
    """Map a free-form record.source to a source_trust bucket.

    Producers tag records with specific source strings (`oa_works_doi`,
    `s2_batch`, `enrich_metadata_ncbi`, ...). Trust is declared per bucket,
    so collapse the family here. Mirrors the bucketing in
    merge.writer._write_citation_counts and extends it to ncbi/seed.
    """
    s = (source or '').lower()
    if s.startswith('oa') or s.startswith('openalex'):
        return 'openalex'
    if s.startswith('s2') or s.startswith('semanticscholar'):
        return 's2'
    if s.startswith('ncbi') or s.startswith('pubmed'):
        return 'ncbi'
    if s.startswith('crossref'):
        return 'crossref'
    # RIS import / user seed and anything unrecognised → least-trusted bucket.
    return 'seed'


def _seed_resolution_tables(conn: sqlite3.Connection) -> None:
    """Idempotently seed field_class / source_trust. Never clobbers edits."""
    conn.executemany(
        "INSERT OR IGNORE INTO field_class (field, class) VALUES (?, ?)",
        _FIELD_CLASS_SEED,
    )
    conn.executemany(
        "INSERT OR IGNORE INTO source_trust (source, rank) VALUES (?, ?)",
        _SOURCE_TRUST_SEED,
    )


def init_db(conn: sqlite3.Connection) -> None:
    """Create all tables and indexes for the main v3 DB. Idempotent."""
    conn.executescript(_SCHEMA)
    _migrate_papers_columns(conn)
    # citekey index must follow the migration: on a pre-existing DB the column
    # is added by _migrate_papers_columns, not by the (no-op) CREATE TABLE.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_papers_citekey "
        "ON papers(citekey) WHERE citekey IS NOT NULL"
    )
    # Also post-migration: this partial index references the extended biblio
    # columns, which only exist after _migrate_papers_columns on a pre-existing
    # DB. Backs enrich_biblio_crossref's candidate query.
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_papers_needs_biblio
            ON papers(is_seed DESC, discovery_count DESC, id)
            WHERE doi IS NOT NULL AND is_rejected = 0
              AND (volume IS NULL OR first_page IS NULL OR publisher IS NULL)
    """)
    _migrate_paper_tags_columns(conn)
    # category index must follow the migration, like idx_papers_citekey above:
    # on a pre-existing DB the column is added by the migration, not the CREATE.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_paper_tags_category "
        "ON paper_tags(category)"
    )
    _seed_resolution_tables(conn)
    conn.commit()


# Columns added after the initial schema shipped. ALTER TABLE ADD COLUMN
# can't be made conditional in pure SQL, so we check the table info first.
_PAPERS_LATE_COLUMNS = [
    ('publication_date',      'TEXT'),
    ('is_open_access',        'INTEGER'),
    ('influential_cit_count', 'INTEGER'),
    ('s2_fields_of_study',    'TEXT'),
    ('pubmed_id',             'TEXT'),
    ('pubmed_central_id',     'TEXT'),
    ('citekey',               'TEXT'),
    # Extended bibliographic fields (BibLaTeX superset).
    ('editors',               'TEXT'),
    ('volume',                'TEXT'),
    ('issue',                 'TEXT'),
    ('first_page',            'TEXT'),
    ('last_page',             'TEXT'),
    ('publisher',             'TEXT'),
    ('booktitle',             'TEXT'),
    ('series',                'TEXT'),
    ('edition',               'TEXT'),
    ('language',              'TEXT'),
    ('month',                 'TEXT'),
    ('editorial_status',      'TEXT'),
    ('editorial_status_at',   'TEXT'),
]


def _migrate_papers_columns(conn: sqlite3.Connection) -> None:
    """Add any new papers columns to a pre-existing DB. Cheap when up-to-date."""
    existing = {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}
    for col, sql_type in _PAPERS_LATE_COLUMNS:
        if col not in existing:
            conn.execute(f"ALTER TABLE papers ADD COLUMN {col} {sql_type}")


def _migrate_paper_tags_columns(conn: sqlite3.Connection) -> None:
    """Add the `category` column to a pre-existing paper_tags table. Cheap when
    up-to-date. Kept separate so network_toy's serve.py can mirror this exact
    migration on the live DB it writes tags into."""
    existing = {r[1] for r in conn.execute("PRAGMA table_info(paper_tags)").fetchall()}
    if 'category' not in existing:
        conn.execute("ALTER TABLE paper_tags ADD COLUMN category TEXT")


# Backfill map: promoted papers column <- bib field name(s) as deposited in
# field_observations by prior import_bib runs (record_bib_fields). booktitle
# and series are NOT here: older imports folded them into `venue` and never
# recorded a separate observation, so they're only backfillable for entries
# whose import wrote them (forward imports populate the columns directly).
_BACKFILL_SCALAR = {
    'volume':    ('volume',),
    'issue':     ('number', 'issue'),
    'publisher': ('publisher',),
    'edition':   ('edition',),
    'language':  ('language', 'langid'),
    'series':    ('series',),
    'booktitle': ('booktitle',),
    'month':     ('month',),
}


def _split_pages(raw: str) -> tuple[Optional[str], Optional[str]]:
    """Split a page-range string into (first, last). _clean_value already
    folded '--' to an en-dash; accept any dash variant. A single page (or an
    unsplittable token like 'e0123456') returns (token, None)."""
    s = (raw or '').strip()
    if not s:
        return None, None
    parts = re.split(r'\s*[–—-]+\s*', s, maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return parts[0].strip(), parts[1].strip()
    return s, None


def _backfill_promoted_columns(conn: sqlite3.Connection) -> dict:
    """One-time, idempotent backfill of the promoted bibliographic columns and
    the identifiers table from field_observations, where prior .bib imports
    deposited these fields before they had first-class columns. Every write is
    guarded (WHERE col IS NULL / INSERT OR IGNORE) so re-running is a no-op.
    Returns per-target row counts for reporting."""
    counts: dict[str, int] = {}

    # 1. Scalar columns copied straight from the first matching observation.
    for col, bib_fields in _BACKFILL_SCALAR.items():
        for bf in bib_fields:
            cur = conn.execute(f"""
                UPDATE papers SET {col} = (
                    SELECT fo.raw_value FROM field_observations fo
                    WHERE fo.paper_id = papers.id AND fo.field = ?
                      AND fo.raw_value IS NOT NULL AND fo.raw_value <> ''
                    LIMIT 1)
                WHERE {col} IS NULL AND EXISTS (
                    SELECT 1 FROM field_observations fo
                    WHERE fo.paper_id = papers.id AND fo.field = ?
                      AND fo.raw_value IS NOT NULL AND fo.raw_value <> '')
            """, (bf, bf))
            counts[col] = counts.get(col, 0) + cur.rowcount

    # 2. pages -> first_page/last_page (split needs Python).
    rows = conn.execute("""
        SELECT p.id AS id, fo.raw_value AS pages FROM papers p
        JOIN field_observations fo
          ON fo.paper_id = p.id AND fo.field = 'pages'
        WHERE p.first_page IS NULL
          AND fo.raw_value IS NOT NULL AND fo.raw_value <> ''
    """).fetchall()
    pg = 0
    for r in rows:
        first, last = _split_pages(r['pages'])
        if first is not None:
            conn.execute(
                "UPDATE papers SET first_page = ?, last_page = ? "
                "WHERE id = ? AND first_page IS NULL",
                (first, last, r['id']))
            pg += 1
    counts['pages'] = pg

    # 3. editor -> editors JSON (split the BibTeX ' and '-delimited list).
    rows = conn.execute("""
        SELECT p.id AS id, fo.raw_value AS editor FROM papers p
        JOIN field_observations fo
          ON fo.paper_id = p.id AND fo.field = 'editor'
        WHERE p.editors IS NULL
          AND fo.raw_value IS NOT NULL AND fo.raw_value <> ''
    """).fetchall()
    ed = 0
    for r in rows:
        names = [n.strip() for n in re.split(r'\s+and\s+', r['editor'])
                 if n.strip()]
        if names:
            conn.execute(
                "UPDATE papers SET editors = ? WHERE id = ? AND editors IS NULL",
                (json.dumps(names), r['id']))
            ed += 1
    counts['editors'] = ed

    # 4. month from publication_date where still NULL (ISO 'YYYY-MM-...').
    cur = conn.execute("""
        UPDATE papers SET month = substr(publication_date, 6, 2)
        WHERE month IS NULL AND publication_date IS NOT NULL
          AND length(publication_date) >= 7
    """)
    counts['month'] = counts.get('month', 0) + cur.rowcount

    # 5. Secondary identifiers into the normalized table.
    for scheme, bib_field in (('isbn', 'isbn'), ('issn', 'issn')):
        cur = conn.execute("""
            INSERT OR IGNORE INTO identifiers (paper_id, scheme, value, source)
            SELECT fo.paper_id, ?, fo.raw_value, fo.source
            FROM field_observations fo
            WHERE fo.field = ?
              AND fo.raw_value IS NOT NULL AND fo.raw_value <> ''
        """, (scheme, bib_field))
        counts['id_' + scheme] = cur.rowcount

    conn.commit()
    return counts


def _migrate_claims_schema(conn: sqlite3.Connection) -> None:
    """Migrate a pre-`field` enrichment_attempts table to the per-field shape.

    The old PK was (paper_id, service); the new one is (paper_id, service,
    field). SQLite can't ALTER a primary key, so we rebuild the table. Legacy
    rows map to field='_all' — audit-preserving and non-blocking: the new
    per-field candidate query only matches a specific field a service is now
    claiming, never '_all', so old rows don't falsely block any field. The
    intended consequence is that papers previously 'succeeded' by one service
    but still missing (e.g.) an abstract immediately become eligible for
    another service.

    Idempotent: if the table already has a `field` column (fresh DB created by
    the new _CLAIMS_SCHEMA, or already migrated), this is a no-op.
    """
    cols = {r[1] for r in conn.execute(
        "PRAGMA table_info(enrichment_attempts)").fetchall()}
    if not cols or 'field' in cols:
        return  # missing table (executescript will create) or already migrated

    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("""
            CREATE TABLE enrichment_attempts_new (
                paper_id     INTEGER NOT NULL,
                service      TEXT    NOT NULL,
                field        TEXT    NOT NULL,
                status       TEXT    NOT NULL,
                claimed_at   TEXT    NOT NULL,
                finished_at  TEXT,
                PRIMARY KEY (paper_id, service, field)
            )
        """)
        conn.execute("""
            INSERT OR IGNORE INTO enrichment_attempts_new
                (paper_id, service, field, status, claimed_at, finished_at)
            SELECT paper_id, service, '_all', status, claimed_at, finished_at
            FROM enrichment_attempts
        """)
        conn.execute("DROP TABLE enrichment_attempts")
        conn.execute(
            "ALTER TABLE enrichment_attempts_new RENAME TO enrichment_attempts")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _migrate_citation_attempt_fields(conn: sqlite3.Connection) -> None:
    """Relabel legacy citation-retrieval attempts to the explicit per-direction
    fields so the coverage feature doesn't re-fetch already-done papers.

    `expand_incoming_oa` used field='_all' before incoming citations were tracked
    explicitly; its candidate query now gates on field='cites'. Rename the old
    rows so a paper already swept for incoming citations stays settled. UPDATE OR
    IGNORE + a cleanup DELETE keeps it idempotent (a 'cites' row may already
    exist from a post-upgrade run). No-op when the table is absent.
    """
    cols = {r[1] for r in conn.execute(
        "PRAGMA table_info(enrichment_attempts)").fetchall()}
    if not cols or 'field' not in cols:
        return
    conn.execute(
        "UPDATE OR IGNORE enrichment_attempts SET field='cites' "
        "WHERE service='oa_incoming' AND field='_all'")
    conn.execute(
        "DELETE FROM enrichment_attempts "
        "WHERE service='oa_incoming' AND field='_all'")
    conn.commit()


def ensure_claims_db(claims_db_path: Optional[Path] = None) -> None:
    """
    Idempotent one-time setup: create the claims DB and schema if missing.

    Separated from get_claims_connection so multi-process startup doesn't
    have every connection racing on CREATE TABLE. The supervisor calls this
    once at daemon boot; producer connections then use a fast read/write
    open with no DDL.
    """
    if claims_db_path is None:
        claims_db_path = get_claims_db_path()
    conn = sqlite3.connect(str(claims_db_path))
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    # Rebuild a legacy (pre-field) table BEFORE the schema script runs, so the
    # IF NOT EXISTS index DDL below applies to the migrated table.
    _migrate_claims_schema(conn)
    conn.executescript(_CLAIMS_SCHEMA)
    # Relabel legacy citation attempts (needs the per-field shape to exist).
    _migrate_citation_attempt_fields(conn)
    conn.commit()
    conn.close()


def get_claims_connection(
    claims_db_path: Optional[Path] = None,
    main_db_path: Optional[Path] = None,
) -> sqlite3.Connection:
    """
    Open a connection to the claims DB, with the main v3 DB ATTACHed as
    `main_v3` (read-only). Producers use this for claim_candidates() /
    mark_succeeded / mark_failed / release_claims — writes only ever touch
    the claims DB, not the main v3 DB.

    PERFORMANCE NOTE: this is meant to be called many times per producer run
    (one connection per claim batch). It assumes ensure_claims_db() has been
    called once already, so it does NOT run any DDL — DDL contention is the
    fastest way to lose a write lock race when multiple producers spawn at
    once.
    """
    if main_db_path is None:
        main_db_path = get_db_path()
    if claims_db_path is None:
        # When main was explicitly provided, derive the claims path from it
        # rather than falling back to the production default — otherwise
        # tests (and any sandbox runs) would silently write to the live
        # claims DB.
        env_override = os.environ.get('BIBLION_CLAIMS_DB')
        if env_override:
            claims_db_path = Path(env_override).expanduser()
        else:
            claims_db_path = main_db_path.with_name(
                main_db_path.stem + '_claims.db'
            )

    # URI mode required because we ATTACH the main DB read-only via a URI.
    conn = sqlite3.connect(f"file:{claims_db_path}?mode=rw", uri=True,
                           timeout=30)
    conn.row_factory = sqlite3.Row
    # busy_timeout FIRST so any later PRAGMA that needs a lock can wait.
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous  = NORMAL")

    # ATTACH the main DB as a read-only sibling so SELECT FROM main_v3.papers
    # works without taking the main DB's write lock.
    conn.execute(
        "ATTACH DATABASE ? AS main_v3",
        (f"file:{main_db_path}?mode=ro",),
    )
    return conn
