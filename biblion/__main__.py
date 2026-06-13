"""
biblion CLI entry.

Primary commands
----------------
    init     Create a biblion database at the given path and scaffold a .env.
    import   Ingest papers from a RIS (.ris) reference list.
    search   Run boolean-keyword Semantic Scholar search ingestion.
    hop      Citation hop via Semantic Scholar.
    enrich   Run merge writer + resolver + the standard enrichment producers.
    qc       Coverage / conflict-log snapshot.

Advanced (power-user surface)
-----------------------------
    advanced list | plan | run | start | daemon | bulk

Common options
--------------
    --db PATH             SQLite path (env: BIBLION_DB; required unless set)
    --redis-url URL       Redis URL for the cache (default redis://localhost:6379/0)
"""
import argparse
import sys
from pathlib import Path

from .cache import CacheClient
from .db import get_db_path, get_logs_dir, get_connection, init_db
from .framework import Orchestrator
from .modules import ALL_MODULES


class _LogMux:
    """One central log file per run; every subprocess's output is line-tagged
    with its source label and merged into it.

    Replaces the old one-file-per-module-per-restart sprawl. Each spawned
    process gets a dedicated OS pipe whose read end a daemon thread drains,
    prefixing every line with ``[label]`` before appending to the shared file
    under a lock (so lines never interleave mid-line). The write end is handed
    to subprocess.Popen(stdout=..., stderr=STDOUT).
    """

    def __init__(self, path: Path):
        import threading
        self.path = path
        self._fh = open(path, 'ab', buffering=0)
        self._lock = threading.Lock()
        self._threads: list = []
        self._wfds: list[int] = []

    def pipe(self, label: str) -> int:
        """Return a write fd for a subprocess; tee its lines into the log."""
        import os
        import threading
        r, w = os.pipe()
        self._wfds.append(w)
        prefix = f"[{label}] ".encode()

        def _drain():
            with os.fdopen(r, 'rb', buffering=0) as rf:
                for raw in rf:                       # iterates per line
                    line = raw if raw.endswith(b'\n') else raw + b'\n'
                    with self._lock:
                        self._fh.write(prefix + line)
        t = threading.Thread(target=_drain, daemon=True)
        t.start()
        self._threads.append(t)
        return w

    def note(self, text: str) -> None:
        """Write a supervisor-level line (e.g. spawn/restart) to the log."""
        with self._lock:
            self._fh.write(f"[supervisor] {text}\n".encode())

    def close(self) -> None:
        import os
        for w in self._wfds:
            try: os.close(w)
            except OSError: pass
        for t in self._threads:
            t.join(timeout=2)
        try: self._fh.close()
        except OSError: pass


# Default producer set for `biblion enrich`. This is the workhorse pipeline:
# resolves missing DOIs and pulls metadata from both OpenAlex and Semantic
# Scholar in parallel. Reorder here if you want a different set or order.
ENRICH_PRODUCERS = (
    'enrich_metadata_oa',
    'enrich_metadata_s2',
    'enrich_metadata_ncbi',
    'enrich_biblio_crossref',
    'expand_incoming_oa',
    'resolve_dois_oa',
    'resolve_dois_s2',
)


def _producer_cmd(db, redis_url: str, target: str, force: bool = False) -> list[str]:
    """Build the argv that supervises one looping producer in a subprocess.

    Single source of truth for both the initial-spawn and crash-restart paths.
    `run` lives under `advanced` (it is not a top-level command), so the argv
    MUST be `... advanced run <target> --loop`; a bare `run` makes argparse
    reject the subprocess with exit code 2 and the supervisor crash-loops it.
    Covered by tests/unit/test_producer_cmd.py.
    """
    cmd = [
        'python', '-u', '-m', 'biblion',
        '--db', str(db),
        '--redis-url', redis_url,
        'advanced', 'run', target, '--loop',
    ]
    if force:
        cmd.append('--force')
    return cmd


# ---------------------------------------------------------------------------
# Friendly CLI helpers
# ---------------------------------------------------------------------------

class RedisUnreachableError(SystemExit):
    """Raised when the cache can't reach Redis. Friendly message; exits code 2."""

    def __init__(self, url: str) -> None:
        super().__init__(
            f"biblion: cannot reach Redis at {url}.\n"
            "  biblion needs a running Redis server for its producer cache.\n"
            "  Start one (e.g. `redis-server`) or point --redis-url / the\n"
            "  --redis-url default at a reachable instance, then retry."
        )


def _require_redis(args) -> None:
    """Fail fast with an actionable message if Redis isn't reachable.

    Without this, the first cache operation deep inside a command surfaces a
    raw redis-py ConnectionError traceback — opaque to a first-time user whose
    only mistake was not starting redis-server.
    """
    if not CacheClient(url=args.redis_url).ping():
        raise RedisUnreachableError(args.redis_url)


def cmd_init(args) -> int:
    """Create a biblion database at the given path and scaffold a .env."""
    db_path = Path(args.db_path).expanduser().resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # init_db is idempotent — safe even if the file already exists.
    import os
    os.environ['BIBLION_DB'] = str(db_path)
    from .db import ensure_claims_db
    with get_connection(db_path) as conn:
        init_db(conn)
    ensure_claims_db()
    print(f"Initialized biblion database at {db_path}")

    env_path = Path(args.env_file).expanduser().resolve() if args.env_file \
               else Path.cwd() / '.env'
    if env_path.exists():
        print(f".env already exists at {env_path} (not overwritten).")
    else:
        env_path.write_text(
            "# biblion configuration. Lines without values use defaults.\n"
            f"BIBLION_DB={db_path}\n"
            "# Optional API keys (free-tier limits apply without them):\n"
            "OpenAlex_api=\n"
            "OPENALEX_MAILTO=\n"
            "semantic_scholar_key=\n"
            "ENTREZ_api=\n"
            "ENTREZ_EMAIL=\n"
        )
        print(f"Wrote .env scaffold to {env_path}")

    # Auto-register the new DB as a named project and make it current, so
    # subsequent commands work without --db. --name overrides the derived name
    # (filename stem); --no-register opts out.
    if not getattr(args, 'no_register', False):
        from . import projects
        try:
            chosen = projects.auto_register_on_init(
                db_path, name=getattr(args, 'name', None))
            print(f"Registered project '{chosen}' and set it current "
                  f"(use `biblion project list` to see all).")
        except projects.ProjectError as e:
            print(f"[warn] could not register project: {e}")

    print("\nNext: edit the .env to add API keys, then try `biblion qc`.")
    return 0


def cmd_project(args) -> int:
    """Manage the named-project registry (add / use / list / remove / current)."""
    from . import projects
    sub = args.project_cmd

    if sub in (None, 'list'):
        projs, current = projects.list_projects()
        if not projs:
            print("No projects registered. Add one with "
                  "`biblion project add <name> <path>`.")
            return 0
        width = max(len(n) for n in projs)
        print("Registered projects (* = current):")
        for name in sorted(projs):
            mark = '*' if name == current else ' '
            print(f"  {mark} {name:<{width}}  {projs[name]}")
        return 0

    if sub == 'current':
        projs, current = projects.list_projects()
        if not current:
            print("No current project set.")
            return 1
        print(f"{current}\t{projs.get(current, '(path unknown)')}")
        return 0

    if sub == 'add':
        try:
            path = projects.add(args.name, args.path,
                                set_current=args.use, overwrite=args.force)
        except projects.ProjectError as e:
            print(f"biblion: {e}")
            return 2
        suffix = " (now current)" if (args.use or
                  projects.list_projects()[1] == args.name) else ""
        print(f"Registered '{args.name}' -> {path}{suffix}")
        return 0

    if sub == 'use':
        try:
            path = projects.use(args.name)
        except projects.ProjectError as e:
            print(f"biblion: {e}")
            return 2
        print(f"Current project: {args.name} -> {path}")
        return 0

    if sub == 'remove':
        try:
            projects.remove(args.name)
        except projects.ProjectError as e:
            print(f"biblion: {e}")
            return 2
        print(f"Removed project '{args.name}' (database file left in place).")
        return 0

    print(f"biblion: unknown project subcommand {sub!r}")
    return 2


def cmd_enrich(args) -> int:
    """Run the standard enrichment daemon. Thin shim over cmd_daemon."""
    args.targets = list(ENRICH_PRODUCERS)
    args.force = getattr(args, 'force', False)
    args.log_dir = getattr(args, 'log_dir', None)
    return cmd_daemon(args)


# ---------------------------------------------------------------------------
# Merge-daemon context manager — used by `search` and `hop` so first-time
# users don't have to start the writer / resolver / pending_resolver
# themselves. If the merge daemons are already running externally, this
# detects them and runs `body()` without spawning a second set.
# ---------------------------------------------------------------------------

from contextlib import contextmanager


@contextmanager
def _ensure_merge_daemons(args):
    """Spawn writer + resolver + pending_resolver around the body, then drain
    the cache and tear them down. No-op if they're already running."""
    import os, signal, subprocess, time
    existing = subprocess.run(
        ['pgrep', '-f', f'biblion.merge.(writer|resolver|pending_resolver).*--db {args.db}'],
        capture_output=True, text=True,
    )
    if existing.stdout.strip():
        # Someone else is supervising; assume they'll drain.
        print("[biblion] merge daemons already running; using them.")
        yield
        return

    log_dir = getattr(args, 'log_dir', None) or get_logs_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime('%Y%m%d_%H%M%S')

    env = {**os.environ, 'BIBLION_DB': str(args.db), 'PYTHONUNBUFFERED': '1'}
    mux = _LogMux(log_dir / f'biblion_{ts}.log')

    def _spawn(label, cmd):
        w = mux.pipe(label)
        p = subprocess.Popen(cmd, stdout=w, stderr=subprocess.STDOUT,
                             env=env, preexec_fn=os.setsid)
        os.close(w)   # parent drops its copy; the child holds the write end
        print(f"  [{label:<22}] pid={p.pid}")
        return p

    from .db import ensure_claims_db
    ensure_claims_db()

    print(f"[biblion] starting merge daemons (log → {mux.path})")
    writer = _spawn('merge writer',
        ['python', '-u', '-m', 'biblion.merge.writer',
         '--db', str(args.db), '--redis-url', args.redis_url])
    resolver = _spawn('resolver',
        ['python', '-u', '-m', 'biblion.merge.resolver',
         '--db', str(args.db), '--redis-url', args.redis_url])
    pending = _spawn('pending resolver',
        ['python', '-u', '-m', 'biblion.merge.pending_resolver',
         '--db', str(args.db), '--redis-url', args.redis_url])

    time.sleep(1)
    for nm, p in (('writer', writer), ('resolver', resolver),
                  ('pending', pending)):
        if p.poll() is not None:
            print(f"[ERROR] {nm} died immediately (exit {p.returncode})")
            raise SystemExit(1)

    try:
        yield
        # Drain whatever the producer pushed
        print("\n[biblion] draining cache...")
        cache = CacheClient(url=args.redis_url)
        idle_target, idle_count = 5, 0
        while idle_count < idle_target:
            lens = cache.lengths()
            total = (lens['staged_papers'] + lens['staged_citations']
                     + lens['parked_papers'] + lens['resolved_papers']
                     + lens.get('promote_citations', 0))
            idle_count = idle_count + 1 if total == 0 else 0
            print(f"  [drain] queues: {lens}  (idle {idle_count}/{idle_target})")
            time.sleep(1)
            if writer.poll() is not None:
                break
    finally:
        for name, p in (('pending', pending), ('resolver', resolver),
                        ('writer', writer)):
            if p.poll() is None:
                try: os.killpg(p.pid, signal.SIGTERM)
                except (ProcessLookupError, OSError): pass
                try: p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    try: os.killpg(p.pid, signal.SIGKILL)
                    except (ProcessLookupError, OSError): pass
                    p.wait()
        # In-process producer is done; free any claims it left in-flight.
        try:
            from .db import get_claims_connection
            from .framework.claims import release_all_claims
            cconn = get_claims_connection(main_db_path=args.db)
            freed = release_all_claims(cconn)
            cconn.close()
            if freed:
                print(f"[biblion] released {freed} in-flight claim(s)")
        except Exception:
            pass
        mux.close()


# ---------------------------------------------------------------------------
# Subcommand implementations
# ---------------------------------------------------------------------------

def _orchestrator(args) -> Orchestrator:
    cache = CacheClient(url=args.redis_url) if args.redis_url else None
    o = Orchestrator(db_path=args.db, cache=cache)
    o.register_all([cls() for cls in ALL_MODULES])
    o.plan()
    return o


def cmd_list(args) -> int:
    o = _orchestrator(args)
    print(f"Registered modules ({len(ALL_MODULES)}):\n")
    for cls in ALL_MODULES:
        c = cls.contract()
        req  = ', '.join(c['requires'])    or '—'
        prod = ', '.join(c['produces'])    or '—'
        evnt = ', '.join(c['eventually'])  or '—'
        res  = ', '.join(c['resources'])   or '—'
        print(f"  {c['name']}")
        print(f"    {c['description']}")
        print(f"    requires   : {req}")
        print(f"    produces   : {prod}")
        print(f"    eventually : {evnt}")
        print(f"    resources  : {res}")
        print()
    return 0


def cmd_plan(args) -> int:
    o = _orchestrator(args)
    o.show(args.target)
    return 0


def cmd_run(args) -> int:
    # Optional per-module limits/config
    config = {
        'loop':    getattr(args, 'loop', False),
        'verbose': getattr(args, 'verbose', False),
    }
    if args.limit is not None:
        # Both OA and S2 producer modules read these keys
        config['resolve_dois_limit']    = args.limit
        config['enrich_metadata_limit'] = args.limit
    if getattr(args, 'min_degree', None) is not None:
        config['ghost_min_degree'] = args.min_degree

    cache = CacheClient(url=args.redis_url) if args.redis_url else None
    o = Orchestrator(db_path=args.db, cache=cache, config=config,
                     merge_after_producers=False)
    o.register_all([cls() for cls in ALL_MODULES])
    o.plan()
    # In --loop mode (daemon supervises everything), each producer runs
    # ONLY itself. Other producers handle their own prereqs in parallel.
    skip_prereqs = getattr(args, 'loop', False)
    o.run(args.target, force=args.force, dry_run=args.dry_run,
          skip_prereqs=skip_prereqs)
    return 0


def _live_conflicts_by_field(conn) -> list:
    """Recompute conflicts that are STILL unresolved under current rules.

    field_conflicts is an append-only audit log, so its row count overstates
    reality after re-resolution/backfill. Instead, re-resolve every
    (paper, field) group with more than one distinct observation and count only
    those whose resolve() still reports a conflict. Returns
    [(field, count), ...] sorted desc, top 10.
    """
    from .merge.resolve import resolve, Observation
    from .db import _source_bucket

    rows = conn.execute("""
        SELECT paper_id, field, value, raw_value, source, pub_type_hint
        FROM field_observations
        WHERE (paper_id, field) IN (
            SELECT paper_id, field FROM field_observations
            GROUP BY paper_id, field HAVING COUNT(DISTINCT source) > 1
        )
        ORDER BY paper_id, field
    """).fetchall()

    by_group: dict = {}
    for r in rows:
        by_group.setdefault((r['paper_id'], r['field']), []).append(
            Observation(value=r['value'], raw=r['raw_value'],
                        source=_source_bucket(r['source']),
                        pub_type_hint=r['pub_type_hint'])
        )

    from .merge.backfill import _VERSION_SENSITIVE_FIELDS

    counts: dict = {}
    for (pid, field), obs in by_group.items():
        # Version-sensitive fields (year, publication_date) are deliberately
        # NOT resolved-and-applied yet — a year disagreement is usually the
        # preprint-vs-VoR gap, pending that detection. So ANY disagreement
        # among distinct values counts as a live (unresolved) conflict, not
        # just an equal-trust tie. Counting only resolve()'s conflict here
        # would falsely report them as resolved (trust would "pick" a value we
        # have chosen not to commit).
        if field in _VERSION_SENSITIVE_FIELDS:
            distinct = {o.value for o in obs if o.value is not None}
            if len(distinct) > 1:
                counts[field] = counts.get(field, 0) + 1
            continue
        try:
            res = resolve(field, obs)
        except ValueError:
            continue                       # observational field — never conflicts
        if res.conflict is not None:
            counts[field] = counts.get(field, 0) + 1

    return sorted(counts.items(), key=lambda kv: -kv[1])[:10]


def _qc_snapshot(db_path) -> dict:
    """Gather all QC metrics for a DB into a plain dict.

    Shared by the one-shot `qc` command and the live `enrich` dashboard so
    both report identical numbers. Opens its own short-lived connections and
    closes them — safe to call repeatedly on a tick while writers are active
    (reads see WAL-committed state).
    """
    conn = get_connection(db_path)
    init_db(conn)
    snap: dict = {}
    snap['core'] = dict(conn.execute("""
        SELECT
            (SELECT COUNT(*) FROM papers)                              AS papers,
            (SELECT COUNT(*) FROM papers WHERE doi      IS NOT NULL)   AS with_doi,
            (SELECT COUNT(*) FROM papers WHERE oa_id    IS NOT NULL)   AS with_oa,
            (SELECT COUNT(*) FROM papers WHERE s2_id    IS NOT NULL)   AS with_s2,
            (SELECT COUNT(*) FROM papers WHERE title    IS NOT NULL)   AS with_title,
            (SELECT COUNT(*) FROM papers WHERE abstract IS NOT NULL)   AS with_abstract,
            (SELECT COUNT(*) FROM papers WHERE year     IS NOT NULL)   AS with_year,
            (SELECT COUNT(*) FROM papers WHERE venue    IS NOT NULL)   AS with_venue,
            (SELECT COUNT(*) FROM papers WHERE authors  IS NOT NULL)   AS with_authors,
            (SELECT COUNT(*) FROM papers WHERE is_seed     = 1)        AS seeds,
            (SELECT COUNT(*) FROM papers WHERE is_stub     = 1)        AS stubs,
            (SELECT COUNT(*) FROM papers WHERE is_rejected = 1)        AS rejected,
            (SELECT COUNT(*) FROM papers WHERE editorial_status = 'retracted') AS retracted,
            (SELECT COUNT(*) FROM papers WHERE editorial_status IS NOT NULL)   AS flagged,
            (SELECT COUNT(*) FROM citations)                           AS edges,
            (SELECT COUNT(*) FROM citation_counts)                     AS cit_count_rows,
            (SELECT COUNT(*) FROM pending_citations)                   AS pending_edges,
            (SELECT COUNT(*) FROM field_observations)                  AS observations,
            (SELECT COUNT(*) FROM field_conflicts)                     AS conflict_log
    """).fetchone())
    # LIVE conflicts: re-resolve every (paper, field) that has >1 distinct
    # observation and count only those that STILL conflict under current rules.
    # field_conflicts is an immutable audit log (every disagreement ever seen),
    # so counting its rows overstates reality after a re-resolution/backfill.
    # We recompute from field_observations instead.
    live_by_field = _live_conflicts_by_field(conn)
    snap['conflicts_by_field'] = live_by_field
    # Renderers read core['conflicts'] — make it the LIVE count, not the log size.
    snap['core']['conflicts'] = sum(n for _, n in live_by_field)
    # Keep the raw audit-log size visible separately (full history).
    snap['core']['conflict_log'] = snap['core'].get('conflict_log', 0)
    # Per-module health — one row per module: its latest status + lifetime
    # outcome counts. The live dashboard shows this instead of a run log so a
    # module appears exactly once regardless of how many times it restarted.
    latest = {
        r['module_name']: (r['status'], r['started_at'], r['message'])
        for r in conn.execute("""
            SELECT module_name, status, started_at, message FROM module_runs
            WHERE rowid IN (
                SELECT MAX(rowid) FROM module_runs GROUP BY module_name
            )
        """).fetchall()
    }
    counts: dict = {}
    for r in conn.execute("""
        SELECT module_name, status, COUNT(*) AS n
        FROM module_runs GROUP BY module_name, status
    """).fetchall():
        counts.setdefault(r['module_name'], {})[r['status']] = r['n']
    snap['module_health'] = [
        {
            'module': name,
            'status': latest[name][0],
            'last': latest[name][1],
            'message': latest[name][2],
            'counts': counts.get(name, {}),
        }
        for name in sorted(latest)
    ]
    conn.close()

    snap['attempts'] = []
    # Per-service cumulative count of SETTLED attempts (succeeded+failed). The
    # live dashboard diffs this across ticks to tell whether a service is
    # actively completing work ('working') vs. idle. It is the live-activity
    # signal that module_runs.status can't provide for looping producers.
    snap['settled_by_service'] = {}
    try:
        from .db import get_claims_connection
        cconn = get_claims_connection(main_db_path=db_path)
        snap['attempts'] = [
            (r['service'], r['status'], r['n'])
            for r in cconn.execute("""
                SELECT service, status, COUNT(*) AS n
                FROM enrichment_attempts
                GROUP BY service, status ORDER BY service, status
            """).fetchall()
        ]
        snap['settled_by_service'] = {
            r['service']: r['n'] for r in cconn.execute("""
                SELECT service, COUNT(*) AS n FROM enrichment_attempts
                WHERE status IN ('succeeded', 'failed')
                GROUP BY service
            """).fetchall()
        }
        # In-flight claims = a producer holds these and is mid-batch right now.
        # The strongest "actively working" signal: it stays positive for the
        # whole API round-trip, not just the instant a batch flushes.
        snap['claimed_by_service'] = {
            r['service']: r['n'] for r in cconn.execute("""
                SELECT service, COUNT(*) AS n FROM enrichment_attempts
                WHERE status = 'claimed' GROUP BY service
            """).fetchall()
        }
        # Remaining claimable candidates per MODULE — work left to do. Lets the
        # dashboard tell "done" (0 remaining everywhere) from "stalled".
        from .framework.claims import CANDIDATE_QUERIES, count_remaining
        remaining: dict = {}
        for mod, spec in CANDIDATE_QUERIES.items():
            try:
                remaining[mod] = count_remaining(
                    cconn, spec['service'], spec['candidate_sql'],
                    spec.get('fields', ('_all',)))
            except Exception:
                remaining[mod] = None
        snap['remaining_by_module'] = remaining
        cconn.close()
    except Exception as e:
        snap['attempts_error'] = str(e)
    return snap


def _render_qc(snap: dict, db_path, header_extra: str = '') -> list[str]:
    """Format a QC snapshot into printable lines (shared one-shot + live)."""
    core = snap['core']
    total = core['papers'] or 1
    out: list[str] = []
    out.append("=" * 60)
    out.append(f"  v3 QC — {db_path}{header_extra}")
    out.append("=" * 60)

    def line(label, count):
        pct = count / total * 100 if total else 0
        out.append(f"  {label:18s} {count:>14,}   ({pct:5.1f}%)")

    out.append("\n  Identifiers")
    line('papers',        core['papers'])
    line('with DOI',      core['with_doi'])
    line('with OA ID',    core['with_oa'])
    line('with S2 ID',    core['with_s2'])

    out.append("\n  Metadata")
    line('with title',    core['with_title'])
    line('with year',     core['with_year'])
    line('with venue',    core['with_venue'])
    line('with authors',  core['with_authors'])
    line('with abstract', core['with_abstract'])

    out.append("\n  Flags")
    line('seeds',         core['seeds'])
    line('stubs',         core['stubs'])
    line('rejected',      core['rejected'])
    line('retracted',     core['retracted'])
    line('flagged (any notice)', core['flagged'])

    out.append("\n  Graph")
    out.append(f"  {'edges':18s} {core['edges']:>14,}")
    out.append(f"  {'pending edges':18s} {core['pending_edges']:>14,}")
    out.append(f"  {'cit_count rows':18s} {core['cit_count_rows']:>14,}")

    out.append("\n  Conflicts")
    out.append(f"  {'total':18s} {core['conflicts']:>14,}")
    if core['conflicts'] and snap['conflicts_by_field']:
        out.append("    by field:")
        for f, n in snap['conflicts_by_field']:
            out.append(f"      {f:14s}  {n:>10,}")

    out.append("\n  Enrichment attempts (by service × status)")
    if 'attempts_error' in snap:
        out.append(f"    (claims DB unavailable: {snap['attempts_error']})")
    elif snap['attempts']:
        by_service: dict[str, dict[str, int]] = {}
        for svc, status, n in snap['attempts']:
            by_service.setdefault(svc, {})[status] = n
        out.append(f"    {'service':15s}  {'claimed':>10s}  {'succeeded':>10s}  "
                   f"{'failed':>10s}  {'total':>10s}")
        for svc, by_status in sorted(by_service.items()):
            tot = sum(by_status.values())
            out.append(f"    {svc:15s}  "
                       f"{by_status.get('claimed', 0):>10,}  "
                       f"{by_status.get('succeeded', 0):>10,}  "
                       f"{by_status.get('failed', 0):>10,}  "
                       f"{tot:>10,}")
    else:
        out.append("    (no attempts recorded yet)")

    return out


def cmd_qc(args) -> int:
    """Coverage stats and conflict-log summary."""
    print('\n'.join(_render_qc(_qc_snapshot(args.db), args.db)))
    return 0


def cmd_backup(args) -> int:
    """Copy the DB to --backup using SQLite's online backup API.

    Safe to run while the DB is in use (WAL mode): the backup API takes a
    consistent snapshot without blocking writers for the whole copy. Also
    backs up the claims sidecar alongside, as <backup>_claims.db, unless
    --no-claims is given.
    """
    import sqlite3
    src_path = Path(args.db).expanduser()
    dst_path = Path(args.backup).expanduser()
    if dst_path.exists() and not args.force:
        print(f"[backup] {dst_path} exists; pass --force to overwrite.")
        return 2
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    def _copy(src_file: Path, dst_file: Path) -> None:
        src = sqlite3.connect(f"file:{src_file}?mode=ro", uri=True)
        try:
            dst = sqlite3.connect(str(dst_file))
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()

    _copy(src_path, dst_path)
    print(f"[backup] {src_path} -> {dst_path}")

    if not args.no_claims:
        claims_src = src_path.with_name(src_path.stem + '_claims.db')
        if claims_src.exists():
            claims_dst = dst_path.with_name(dst_path.stem + '_claims.db')
            _copy(claims_src, claims_dst)
            print(f"[backup] {claims_src} -> {claims_dst}")
        else:
            print(f"[backup] no claims sidecar at {claims_src} (skipped)")
    return 0


def cmd_backfill_observations(args) -> int:
    """Synthesize field_observations from existing papers + field_conflicts and
    re-resolve, WITHOUT any API calls. Dry-run by default; --apply to write.

    Mines what the old first-write-wins writer already captured (incumbent
    value in papers + logged loser in field_conflicts). Fully correct for
    representational fields (authors/venue/pub_type/title); best-effort for
    authoritative ones (the incumbent's source was never recorded). See
    biblion/merge/backfill.py.
    """
    from .merge.backfill import run_backfill

    conn = get_connection(args.db)
    try:
        init_db(conn)        # ensure field_observations/class/trust exist
        stats = run_backfill(
            conn, apply=args.apply,
            apply_identifiers=args.apply_identifiers,
            apply_version_fields=args.apply_version_fields,
        )
    finally:
        conn.close()

    mode = "APPLIED" if args.apply else "DRY RUN (nothing written)"
    print(f"[backfill] {mode}")
    print(f"  papers scanned       {stats.papers_scanned:>8,}")
    print(f"  fields re-resolved   {stats.fields_reresolved:>8,}")
    if args.apply:
        print(f"  observations written {stats.observations_written:>8,}")
    print(f"  values that change   {stats.values_changed:>8,}")
    print(f"  conflicts cleared    {stats.conflicts_cleared:>8,}")
    print(f"  conflicts remaining  {stats.conflicts_remaining:>8,}")
    if stats.by_field_changed:
        from .merge.backfill import _IDENTIFIER_FIELDS, _VERSION_SENSITIVE_FIELDS
        print("  changes by field:")
        for fld, n in sorted(stats.by_field_changed.items(),
                             key=lambda x: -x[1]):
            note = ''
            if fld in _IDENTIFIER_FIELDS and not args.apply_identifiers:
                note = '  (NOT applied — needs --apply-identifiers)'
            elif fld in _VERSION_SENSITIVE_FIELDS and not args.apply_version_fields:
                note = '  (NOT applied — needs --apply-version-fields)'
            print(f"    {fld:20s} {n:>6,}{note}")
    if not args.apply:
        print("\n  Re-run with --apply to write observations and update papers.")
    return 0


def cmd_migrate(args) -> int:
    """Apply schema migrations and backfill the promoted bibliographic columns.

    `init_db` adds any missing columns / the identifiers table idempotently
    (cheap when up to date). Then `_backfill_promoted_columns` copies fields
    that prior .bib imports left in field_observations (publisher, volume,
    pages, editor, isbn, ...) into the new first-class columns. Every write is
    guarded, so re-running is a no-op. No API calls, no Redis."""
    from .db import _backfill_promoted_columns

    conn = get_connection(args.db)
    try:
        init_db(conn)                       # idempotent column/table migration
        counts = _backfill_promoted_columns(conn)
    finally:
        conn.close()

    print("[biblion migrate] schema up to date; backfill complete")
    labels = {
        'volume': 'volume', 'issue': 'issue', 'publisher': 'publisher',
        'edition': 'edition', 'language': 'language', 'series': 'series',
        'booktitle': 'booktitle', 'pages': 'pages -> first/last',
        'editors': 'editors (from editor)', 'month': 'month',
        'id_isbn': 'identifiers: isbn', 'id_issn': 'identifiers: issn',
    }
    total = sum(counts.values())
    for key, label in labels.items():
        n = counts.get(key, 0)
        if n:
            print(f"  {label:<26} {n:>8,}")
    if total == 0:
        print("  (nothing to backfill — already migrated or no .bib imports)")
    return 0


def cmd_flag_retractions(args) -> int:
    """Sweep DOI'd papers against OpenAlex and flag editorial status
    (retracted), stamping editorial_status_at. One-shot; bypasses the
    claim flow so the existing back catalogue gets flagged. No Redis needed."""
    from .modules.flag_retractions import sweep_retractions

    stats = sweep_retractions(args.db, limit=args.limit, verbose=args.verbose)
    print("\n[biblion flag-retractions] summary:")
    print(f"  checked           {stats['checked']:>8,}")
    print(f"  flagged (total)   {stats['flagged']:>8,}")
    print(f"  newly flagged     {stats['newly_flagged']:>8,}")
    return 0


def cmd_export(args) -> int:
    """Serialise papers out to BibTeX (.bib) or RIS (.ris). Read-only; needs an
    explicit selector so a 2M-row graph is never dumped by accident."""
    from .modules import export as export_mod

    # Resolve format: explicit --format wins, else infer from the extension.
    out = Path(args.out).expanduser()
    fmt = args.format
    if fmt is None:
        fmt = 'ris' if out.suffix.lower() == '.ris' else 'bib'

    # Build the WHERE clause from exactly one selector.
    selectors = [bool(args.seeds), bool(args.all), args.year is not None,
                 bool(args.ids)]
    if sum(selectors) != 1:
        print("[biblion export] choose exactly one selector: "
              "--seeds | --all | --year YEAR | --ids ID,ID,...")
        return 2

    if args.seeds:
        where, params = "is_seed = 1", ()
    elif args.all:
        where, params = "1 = 1", ()
    elif args.year is not None:
        where, params = "year = ?", (args.year,)
    else:
        id_list = [s.strip() for s in args.ids.split(',') if s.strip()]
        if not id_list:
            print("[biblion export] --ids was empty")
            return 2
        ph = ','.join('?' * len(id_list))
        where, params = f"id IN ({ph})", tuple(id_list)

    conn = get_connection(args.db)
    try:
        init_db(conn)        # ensure the extended columns exist before reading
        # Redacted (retracted/withdrawn) papers are dropped by default;
        # --include-redacted keeps them.
        n = export_mod.export(conn, out, fmt, where, params,
                              include_redacted=args.include_redacted)
    finally:
        conn.close()

    print(f"[biblion export] wrote {n} entries to {out} ({fmt})")
    return 0


def _rich_dashboard(snap: dict, db_path, *, uptime_s: int,
                    recent_errors: list, log_dir, n_producers: int,
                    live_modules: list | None = None):
    """Build a Rich renderable for the live `enrich` dashboard.

    Returns a Rich Group of tables. Rich's Live(screen=True, vertical_overflow)
    crops this to the terminal automatically, so we render the FULL data and
    let the library handle a window too short to show all of it — no manual
    height clamping, no scroll garble. Importing rich here (not at module top)
    keeps it off the import path for non-live commands.
    """
    from rich.table import Table
    from rich.columns import Columns
    from rich.console import Group
    from rich.text import Text

    core = snap['core']
    total = core['papers'] or 1

    def pct(n):
        return f"{n / total * 100:5.1f}%"

    n_err = len(recent_errors)
    head = Text.assemble(
        ("biblion enrich ", "bold cyan"),
        (f"— live  ·  {n_producers} producers  ·  ", "dim"),
        (f"uptime {uptime_s // 3600:d}h{(uptime_s % 3600) // 60:02d}m"
         f"{uptime_s % 60:02d}s", "white"),
        ("   ·   ", "dim"),
        (f"errors(10m): {n_err}", "bold red" if n_err else "green"),
        ("   (Ctrl-C to stop)", "dim"),
    )

    # Count-style sections rendered as compact labelled grids, then laid out
    # side by side so the full stat set fits without a tall single column.
    def grid(title, rows, *, show_pct=True):
        g = Table.grid(padding=(0, 1))
        g.add_column(justify="left")
        g.add_column(justify="right")
        if show_pct:
            g.add_column(justify="right", style="dim")
        for label, count in rows:
            cells = [label, f"{count:,}"]
            if show_pct:
                cells.append(f"({pct(count)})")
            g.add_row(*cells)
        return Group(Text(title, style="bold"), g)

    identifiers = grid("Identifiers", [
        ("papers", core['papers']), ("with DOI", core['with_doi']),
        ("with OA ID", core['with_oa']), ("with S2 ID", core['with_s2']),
    ])
    metadata = grid("Metadata", [
        ("with title", core['with_title']), ("with year", core['with_year']),
        ("with venue", core['with_venue']), ("with authors", core['with_authors']),
        ("with abstract", core['with_abstract']),
    ])
    flags = grid("Flags", [
        ("seeds", core['seeds']), ("stubs", core['stubs']),
        ("rejected", core['rejected']),
    ])
    graph = grid("Graph", [
        ("edges", core['edges']), ("pending edges", core['pending_edges']),
        ("cit_count rows", core['cit_count_rows']),
    ], show_pct=False)

    # Conflicts: total plus the per-field breakdown.
    conf_rows = [("live total", core['conflicts']),
                 ("audit log", core.get('conflict_log', 0))]
    conf_rows += [(f"  {f}", n) for f, n in snap.get('conflicts_by_field', [])]
    conflicts = grid("Conflicts", conf_rows, show_pct=False)

    blocks = [head, "",
              Columns([identifiers, metadata, flags, graph, conflicts],
                      padding=(0, 3), equal=False, expand=False)]

    blocks.append("")
    if 'attempts_error' in snap:
        blocks.append(Text(f"Enrichment attempts: claims DB unavailable: "
                           f"{snap['attempts_error']}", style="red"))
    elif snap.get('attempts'):
        by_service: dict[str, dict[str, int]] = {}
        for svc, status, n in snap['attempts']:
            by_service.setdefault(svc, {})[status] = n
        att = Table(title="Enrichment attempts (by service × status)",
                    title_justify="left", title_style="bold", expand=False)
        att.add_column("service")
        att.add_column("claimed", justify="right", style="yellow")
        att.add_column("succeeded", justify="right", style="green")
        att.add_column("failed", justify="right", style="red")
        att.add_column("total", justify="right")
        for svc, bs in sorted(by_service.items()):
            tot = sum(bs.values())
            att.add_row(svc, f"{bs.get('claimed', 0):,}",
                        f"{bs.get('succeeded', 0):,}",
                        f"{bs.get('failed', 0):,}", f"{tot:,}")
        blocks.append(att)
    else:
        blocks.append(Text("Enrichment attempts: (none recorded yet)", style="dim"))

    if live_modules is not None:
        # Live view: status derived from the supervisor's ground truth — is the
        # process alive, and did its service settle any attempts since the last
        # tick. module_runs.status is unreliable for looping producers (they
        # sit in 'running' for minutes, then show 'orphaned' after a restart),
        # so we ignore it here.
        health = Table(title="Module health", title_justify="left",
                       title_style="bold", expand=False)
        health.add_column("module")
        health.add_column("status")
        health.add_column("remaining", justify="right")
        health.add_column("in-flight", justify="right")
        health.add_column("did (5s)", justify="right")
        health.add_column("settled", justify="right", style="green")
        health.add_column("restarts", justify="right")
        live_style = {'working': 'bold green', 'idle': 'yellow',
                      'down': 'bold red', 'done': 'green', 'starting': 'cyan'}
        for m in live_modules:
            left = m.get('remaining')
            left_txt = (Text("?", style='dim') if left is None else
                        Text(f"{left:,}", style='dim' if left == 0 else 'bold'))
            inflight = m.get('in_flight', 0)
            inflight_txt = Text(f"{inflight:,}" if inflight else "0",
                                style='yellow' if inflight else 'dim')
            did = m.get('did', 0)
            did_txt = Text(f"+{did:,}" if did else "0",
                           style='green' if did else 'dim')
            r = m.get('restarts', 0)
            r_txt = Text(f"{r:,}", style='red' if r else 'dim')
            health.add_row(
                m['module'],
                Text(m['status'], style=live_style.get(m['status'], '')),
                left_txt, inflight_txt, did_txt, f"{m.get('settled', 0):,}", r_txt)
        blocks += ["", health]
        # Overall completion banner: every producer parked with no work left.
        if all((m.get('remaining') == 0) for m in live_modules):
            blocks.append(Text(
                "all producers caught up — no claimable work remaining "
                "(failed fields retry after the cooldown; run `qc` for totals)",
                style="bold green"))
    elif snap.get('module_health'):
        # One-shot qc render (no live supervisor): summarise module_runs
        # history. Lifetime failed+orphaned counts shown as 'crashes'.
        health = Table(title="Module health (from run history)",
                       title_justify="left", title_style="bold", expand=False)
        health.add_column("module")
        health.add_column("last status")
        health.add_column("ok", justify="right", style="green")
        health.add_column("idle", justify="right", style="dim")
        health.add_column("crashes", justify="right")
        health.add_column("last activity")
        status_style = {'running': 'cyan', 'success': 'green',
                        'failed': 'red', 'noop': 'dim', 'orphaned': 'yellow'}
        for h in snap['module_health']:
            c = h['counts']
            crashes = c.get('failed', 0) + c.get('orphaned', 0)
            ok = c.get('success', 0)
            idle = c.get('noop', 0)
            crash_txt = Text(f"{crashes:,}", style='red' if crashes else 'dim')
            health.add_row(
                h['module'],
                Text(h['status'] or '?',
                     style=status_style.get(h['status'], '')),
                f"{ok:,}", f"{idle:,}", crash_txt, (h['last'] or '')[:19])
        blocks += ["", health]

    if recent_errors:
        last_ts, last_msg = recent_errors[-1]
        blocks += ["", Text(f"last error: {last_msg}", style="red")]
    blocks += ["", Text(f"logs: {log_dir}/", style="dim")]
    return Group(*blocks)


def cmd_start(args) -> int:
    """
    Spawn the merge writer + resolver as background subprocesses, then run
    the producer target in the foreground. On producer finish (success,
    crash, or Ctrl-C):

      1. Drain whatever is still in Redis through the merge writer.
      2. Send SIGTERM to both daemons; wait up to 10s for clean exit.
      3. Report final cache lengths + module_runs status.
    """
    import os
    import signal
    import subprocess
    import time

    log_dir = args.log_dir or get_logs_dir()
    log_dir.mkdir(parents=True, exist_ok=True)

    ts = time.strftime('%Y%m%d_%H%M%S')
    mux = _LogMux(log_dir / f'biblion_{ts}.log')

    common_env = {
        **os.environ,
        'BIBLION_DB': str(args.db),
        'PYTHONUNBUFFERED': '1',
    }

    def _spawn_daemon(name: str, module: str) -> subprocess.Popen:
        w = mux.pipe(name)
        p = subprocess.Popen(
            ['python', '-u', '-m', module,
             '--db',        str(args.db),
             '--redis-url', args.redis_url],
            stdout=w, stderr=subprocess.STDOUT,
            env=common_env,
            # New process group so a Ctrl-C in the foreground doesn't kill them
            # before we get to drain the cache.
            preexec_fn=os.setsid,
        )
        os.close(w)
        print(f"  [{name}] pid={p.pid}")
        return p

    # Refuse to start if previous daemons are still running — otherwise we'd
    # end up with two writers pulling from the same Redis queue.
    existing = subprocess.run(
        ['pgrep', '-f', f'biblion.merge.(writer|resolver|pending_resolver).*--db {args.db}'],
        capture_output=True, text=True,
    )
    if existing.stdout.strip():
        print(f"\n[ERROR] Existing v3 merge daemons found (PIDs: {existing.stdout.strip().split()})")
        print(  "        Kill them first:   kill -9 " + existing.stdout.strip().replace('\n', ' '))
        return 1

    print(f"\nStarting v3 daemons (log → {mux.path})...")
    writer   = _spawn_daemon('writer',   'biblion.merge.writer')
    resolver = _spawn_daemon('resolver', 'biblion.merge.resolver')

    # Give daemons a moment to connect to Redis and report ready.
    time.sleep(1)
    for name, p in (('writer', writer), ('resolver', resolver)):
        if p.poll() is not None:
            print(f"\n[ERROR] {name} died immediately (exit {p.returncode}). "
                  f"Check {log_dir}/. Aborting.")
            # Clean up the other one if it survived
            for name2, p2 in (('writer', writer), ('resolver', resolver)):
                if p2.poll() is None:
                    os.killpg(p2.pid, signal.SIGTERM)
            return 1

    # Now run the producer in-process. We turn off the orchestrator's
    # post-module merge drain because the writer subprocess is already
    # doing that work continuously.
    cache = CacheClient(url=args.redis_url)
    o = Orchestrator(
        db_path=args.db, cache=cache,
        merge_after_producers=False,
        config={
            'resolve_dois_limit':    args.limit,
            'enrich_metadata_limit': args.limit,
        } if args.limit else {},
    )
    o.register_all([cls() for cls in ALL_MODULES])
    o.plan()

    print(f"\nRunning producer: {args.target}")
    print("(Ctrl-C once for graceful drain, twice to abort)")
    print("=" * 60)
    producer_error = None
    try:
        o.run(args.target, force=args.force)
    except KeyboardInterrupt:
        print("\n[start] Ctrl-C — producer interrupted, draining cache then stopping daemons.")
    except Exception as e:
        producer_error = e
        print(f"\n[start] Producer failed: {e}")

    # Drain phase: wait for the writer to chew through whatever the producer
    # left in Redis. Poll cache lengths until they stay 0 for several seconds.
    print("\n[start] Draining cache...")
    idle_target = 5    # need this many consecutive idle samples before declaring done
    idle_count  = 0
    last_summary = 0.0
    while idle_count < idle_target:
        lens = cache.lengths()
        total = (lens['staged_papers'] + lens['staged_citations']
                 + lens['parked_papers'] + lens['resolved_papers'])
        if total == 0:
            idle_count += 1
        else:
            idle_count = 0
        # Print a status line at most once per 5s
        now = time.time()
        if now - last_summary > 5.0 or total == 0:
            print(f"  [drain] queues: {lens}  (idle {idle_count}/{idle_target})")
            last_summary = now
        time.sleep(1)
        # If the writer died, bail
        if writer.poll() is not None:
            print(f"  [drain] writer died (exit {writer.returncode}) before drain completed.")
            break

    print("\n[start] Drain complete. Stopping daemons...")
    for name, p in (('resolver', resolver), ('writer', writer)):
        if p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                p.wait(timeout=10)
                print(f"  [{name}] exited cleanly")
            except subprocess.TimeoutExpired:
                print(f"  [{name}] did not exit in 10s — SIGKILL")
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
        else:
            print(f"  [{name}] already exited (code {p.returncode})")

    # Free any claims the in-process producer left in-flight.
    try:
        from .db import get_claims_connection
        from .framework.claims import release_all_claims
        cconn = get_claims_connection(main_db_path=args.db)
        freed = release_all_claims(cconn)
        cconn.close()
        if freed:
            print(f"[start] released {freed} in-flight claim(s)")
    except Exception:
        pass

    # Final QC summary
    mux.close()
    print("\n[start] Final state:")
    print(f"  cache: {cache.lengths()}")
    print(f"  log: {mux.path}")

    if producer_error:
        raise producer_error
    return 0


# ---------------------------------------------------------------------------
# cmd_search: boolean-keyword S2 search ingestion
# ---------------------------------------------------------------------------

def cmd_import(args) -> int:
    """Ingest a RIS (.ris) or BibTeX (.bib) reference file. Auto-spawns merge
    daemons, pushes records into the cache, drains, and marks the imported
    papers as seeds. Both formats share the same backend; the file extension
    selects the native parser."""
    from .framework.context import Context
    from .runtime import ShutdownFlag

    src = Path(args.src).expanduser().resolve()
    if not src.exists():
        print(f"[biblion import] file not found: {src}")
        return 1

    suffix = src.suffix.lower()
    if suffix == '.ris':
        from .modules.import_ris import ImportRis, mark_seeds
        module = ImportRis()
        config = {'ris_file': str(src)}
    elif suffix in ('.bib', '.bibtex'):
        from .modules.import_bib import ImportBib, mark_seeds, record_bib_fields
        module = ImportBib()
        config = {'bib_file': str(src)}
    else:
        print(f"[biblion import] unsupported file type: {suffix!r}. "
              f"Supported: .ris, .bib")
        return 1

    config['no_resolve'] = bool(args.no_resolve)
    config['verbose']    = bool(args.verbose)

    with _ensure_merge_daemons(args):
        cache = CacheClient(url=args.redis_url)
        shutdown = ShutdownFlag.install(name='biblion-import')
        ctx = Context(
            db_path  = args.db,
            work_dir = args.db.parent,
            shutdown = shutdown,
            cache    = cache,
            config   = config,
        )
        v = module.validate(ctx)
        if not v.ok:
            print(f"[biblion import] validation failed: {v.message}")
            return 1

        result = module.run(ctx)
        if result.status != 'success':
            print(f"[biblion import] failed: {result.message}")
            return 1

        pushed_ids   = result.stats.pop('_seed_ids', {})
        bib_entries  = result.stats.pop('_bib_entries', None)
        bib_source   = result.stats.pop('_source', None)

    # Cache has drained. Now flag the imported rows as seeds.
    touched = mark_seeds(args.db, pushed_ids)

    # For .bib: re-home every (unmapped) bib field as its own named
    # observation row so nothing the file carried is dropped.
    obs_written = None
    if bib_entries is not None:
        obs_written = record_bib_fields(args.db, bib_entries, bib_source)

    print("\n[biblion import] summary:")
    for k, v in result.stats.items():
        print(f"  {k:<22} {v}")
    print(f"  marked is_seed=1       {touched}")
    if obs_written is not None:
        print(f"  bib field rows         {obs_written}")
    return 0


def cmd_search(args) -> int:
    """Run the search_s2_factorial module against a searches/*.json file.

    Auto-spawns the merge writer/resolver/pending_resolver around the
    search and tears them down when finished. If merge daemons are
    already running, attaches to them instead.
    """
    config = {
        'search_file': str(args.search_file),
        'search_mode': args.mode,
        'sub_limit':   args.sub_limit,
        'year_min':    args.year_min,
        'year_max':    args.year_max,
        'verbose':     args.verbose,
    }
    with _ensure_merge_daemons(args):
        cache = CacheClient(url=args.redis_url) if args.redis_url else None
        o = Orchestrator(db_path=args.db, cache=cache, config=config,
                         merge_after_producers=False)
        o.register_all([cls() for cls in ALL_MODULES])
        o.plan()
        o.run('search_s2_factorial', force=args.force, skip_prereqs=True)
    return 0


# ---------------------------------------------------------------------------
# cmd_hop: S2 citation hop, optionally targeted
# ---------------------------------------------------------------------------

def cmd_hop(args) -> int:
    """Run expand_papers_s2.

    Three modes implied by argument shape:
      - no targets: act like a one-shot loop=False producer (claim flow)
      - targets: bypass claim flow, hop just those IDs
    """
    # Collect targets from both --target (repeatable) and --targets-file
    targets: list[str] = list(args.target or [])
    if args.targets_file:
        with open(args.targets_file, encoding='utf-8') as f:
            for line in f:
                t = line.strip()
                if t:
                    targets.append(t)

    config: dict = {
        'verbose': args.verbose,
        'loop':    False,        # one-shot when invoked via `hop`
    }
    if args.limit is not None:
        config['hop_limit'] = args.limit
    if targets:
        config['hop_targets'] = targets
    elif getattr(args, 'seeds', False):
        # Seeds-only claim-flow hop. Explicit targets take precedence (they
        # bypass the claim flow entirely), so only honour --seeds when none
        # were given.
        config['seeds_only'] = True

    with _ensure_merge_daemons(args):
        cache = CacheClient(url=args.redis_url) if args.redis_url else None
        o = Orchestrator(db_path=args.db, cache=cache, config=config,
                         merge_after_producers=False)
        o.register_all([cls() for cls in ALL_MODULES])
        o.plan()
        o.run('expand_papers_s2', force=args.force, skip_prereqs=True)
    return 0


# ---------------------------------------------------------------------------
# cmd_bulk: one-shot stream of S2 bulk datasets
# ---------------------------------------------------------------------------

# Maps friendly target → registered module name. Lets `bulk all` run the
# full chain in dependency order without the user having to remember names.
_BULK_TARGETS = {
    'paper_ids':  'bulk_paper_ids',
    'abstracts':  'bulk_abstracts',
    'papers':     'bulk_papers',
}
_BULK_FULL_CHAIN = ('bulk_paper_ids', 'bulk_abstracts', 'bulk_papers')


def cmd_bulk(args) -> int:
    """
    Stream S2 bulk dataset(s) through the merge cache.

    Shape mirrors `start`: spawn merge writer + resolver, run the bulk
    module(s) in the foreground (one-shot, NOT looping), drain Redis,
    stop daemons.

    Targets:
        paper_ids       Build the corpusid → pid scratch map.
        abstracts       Stream abstracts (needs the map).
        papers          Stream papers metadata (needs the map).
        all             Run paper_ids → abstracts → papers in sequence.
    """
    import os
    import signal
    import subprocess
    import time

    # Resolve targets
    if args.target == 'all':
        targets = list(_BULK_FULL_CHAIN)
    elif args.target in _BULK_TARGETS:
        targets = [_BULK_TARGETS[args.target]]
    elif args.target in _BULK_FULL_CHAIN:
        targets = [args.target]
    else:
        print(f"[ERROR] Unknown bulk target {args.target!r}. "
              f"Valid: paper_ids, abstracts, papers, all")
        return 1

    log_dir = args.log_dir or get_logs_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime('%Y%m%d_%H%M%S')
    mux = _LogMux(log_dir / f'biblion_{ts}.log')

    common_env = {
        **os.environ,
        'BIBLION_DB': str(args.db),
        'PYTHONUNBUFFERED': '1',
    }

    def _spawn(label: str, cmd: list[str]) -> subprocess.Popen:
        w = mux.pipe(label)
        p = subprocess.Popen(
            cmd, stdout=w, stderr=subprocess.STDOUT,
            env=common_env, preexec_fn=os.setsid,
        )
        os.close(w)
        mux.note(f"spawned {label} pid={p.pid}")
        print(f"  [{label}] pid={p.pid}")
        return p

    # Bulk requires the live daemon to be stopped — pushing into the same
    # Redis queues from two places is fine in theory, but the live producers
    # also touch the claims DB and we don't want either side waiting.
    existing = subprocess.run(
        ['pgrep', '-f', f'biblion.merge.(writer|resolver|pending_resolver).*--db {args.db}'],
        capture_output=True, text=True,
    )
    if existing.stdout.strip():
        print(f"\n[ERROR] Existing v3 merge daemons found (PIDs: "
              f"{existing.stdout.strip().split()})")
        print(  "        Stop the live daemon before running bulk:")
        print(  "          tsp -k 0 ; pkill -9 -f biblion")
        return 1

    # Bulk doesn't use the claims DB but we initialise it so the merge
    # writer can record stats consistently.
    from .db import ensure_claims_db, get_claims_db_path
    ensure_claims_db()
    print(f"Claims DB: {get_claims_db_path()}")

    print(f"\nStarting merge daemons (log → {mux.path})...")
    writer = _spawn('merge writer',
        ['python', '-u', '-m', 'biblion.merge.writer',
         '--db', str(args.db), '--redis-url', args.redis_url])
    resolver = _spawn('resolver',
        ['python', '-u', '-m', 'biblion.merge.resolver',
         '--db', str(args.db), '--redis-url', args.redis_url])

    time.sleep(1)
    for nm, p in (('writer', writer), ('resolver', resolver)):
        if p.poll() is not None:
            print(f"[ERROR] {nm} died immediately (exit {p.returncode}); aborting")
            return 1

    # Build the in-process orchestrator for the bulk targets. No loop, no
    # post-producer drain (the writer subprocess is draining live).
    config = {}
    if args.release:
        config['bulk_release_id'] = args.release
    if args.verbose:
        config['verbose'] = True

    cache = CacheClient(url=args.redis_url)
    o = Orchestrator(
        db_path=args.db, cache=cache,
        merge_after_producers=False,
        config=config,
    )
    o.register_all([cls() for cls in ALL_MODULES])
    o.plan()

    producer_error = None
    try:
        for tgt in targets:
            print(f"\n{'#' * 60}")
            print(f"#  bulk: {tgt}")
            print(f"{'#' * 60}")
            o.run(tgt, force=args.force, skip_prereqs=True)
    except KeyboardInterrupt:
        print("\n[bulk] Ctrl-C — stopping streaming, draining cache, "
              "then stopping daemons.")
    except Exception as e:
        producer_error = e
        print(f"\n[bulk] Producer failed: {e}")

    # Drain
    print("\n[bulk] Draining cache...")
    idle_target, idle_count = 5, 0
    last_summary = 0.0
    while idle_count < idle_target:
        lens = cache.lengths()
        total = (lens['staged_papers'] + lens['staged_citations']
                 + lens['parked_papers'] + lens['resolved_papers'])
        idle_count = idle_count + 1 if total == 0 else 0
        now = time.time()
        if now - last_summary > 5.0 or total == 0:
            print(f"  [drain] queues: {lens}  (idle {idle_count}/{idle_target})")
            last_summary = now
        time.sleep(1)
        if writer.poll() is not None:
            print(f"  [drain] writer died (exit {writer.returncode}) "
                  f"before drain completed.")
            break

    print("\n[bulk] Drain complete. Stopping daemons...")
    for name, p in (('resolver', resolver), ('writer', writer)):
        if p.poll() is None:
            try: os.killpg(p.pid, signal.SIGTERM)
            except (ProcessLookupError, OSError): pass
            try:
                p.wait(timeout=10)
                print(f"  [{name}] exited cleanly")
            except subprocess.TimeoutExpired:
                print(f"  [{name}] did not exit in 10s — SIGKILL")
                try: os.killpg(p.pid, signal.SIGKILL)
                except (ProcessLookupError, OSError): pass
                p.wait()
        else:
            print(f"  [{name}] already exited (code {p.returncode})")

    mux.close()
    print(f"\n[bulk] Final cache: {cache.lengths()}")
    print(f"[bulk] log: {mux.path}")

    if producer_error:
        raise producer_error
    return 0


# ---------------------------------------------------------------------------
# cmd_daemon: long-running supervisor for OA + S2 producers in parallel
# ---------------------------------------------------------------------------

def cmd_daemon(args) -> int:
    """
    Spawn merge writer + resolver + N producers, supervise them all
    indefinitely. Set-and-forget mode for long jobs.

    Each producer runs in its own subprocess via `python -m biblion
    advanced run <target> --loop`.
    Producers loop on empty / pause on budget-exhaustion / resume on reset.
    Supervisor restarts any subprocess that crashes.

    Ctrl-C once: signal everyone to shut down gracefully (then drain cache,
                 stop daemons, exit).
    Ctrl-C twice: SIGKILL everything immediately.
    """
    import os
    import signal
    import subprocess
    import time

    log_dir = args.log_dir or get_logs_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime('%Y%m%d_%H%M%S')

    common_env = {
        **os.environ,
        'BIBLION_DB': str(args.db),
        'PYTHONUNBUFFERED': '1',
    }
    mux = _LogMux(log_dir / f'biblion_{ts}.log')

    # Set once the live dashboard owns the screen; suppresses per-spawn banner
    # lines so restarts don't scroll the in-place panel. Spawns are still
    # logged to file and surfaced in the panel (Recent runs + error counter).
    live_active = {'on': False}

    def _spawn(label: str, cmd: list[str]) -> subprocess.Popen:
        # All subprocess output merges into the one central log, line-tagged
        # with `label`. Restarts reuse the same file (no per-restart sprawl).
        w = mux.pipe(label)
        p = subprocess.Popen(
            cmd, stdout=w, stderr=subprocess.STDOUT,
            env=common_env, preexec_fn=os.setsid,
        )
        os.close(w)
        mux.note(f"spawned {label} pid={p.pid}")
        if not live_active['on']:
            print(f"  [{label:<22}] pid={p.pid}")
        return p

    # Refuse to start with orphans
    existing = subprocess.run(
        ['pgrep', '-f', f'biblion.merge.(writer|resolver|pending_resolver).*--db {args.db}'],
        capture_output=True, text=True,
    )
    if existing.stdout.strip():
        print(f"\n[ERROR] Existing v3 merge daemons found (PIDs: {existing.stdout.strip().split()})")
        print(  "        Kill them first:   kill -9 " + existing.stdout.strip().replace('\n', ' '))
        return 1

    # One-time claims-DB schema setup BEFORE any producers start. Doing it
    # here avoids 4 producer processes racing on CREATE TABLE / WAL setup
    # the moment they start.
    from .db import ensure_claims_db, get_claims_db_path
    ensure_claims_db()
    print(f"Claims DB: {get_claims_db_path()}")

    print(f"\nStarting v3 daemon (log → {mux.path})...")
    writer = _spawn('merge writer',
        ['python', '-u', '-m', 'biblion.merge.writer',
         '--db', str(args.db), '--redis-url', args.redis_url])
    resolver = _spawn('resolver',
        ['python', '-u', '-m', 'biblion.merge.resolver',
         '--db', str(args.db), '--redis-url', args.redis_url])
    pending = _spawn('pending resolver',
        ['python', '-u', '-m', 'biblion.merge.pending_resolver',
         '--db', str(args.db), '--redis-url', args.redis_url])

    time.sleep(1)
    for nm, p in (('writer', writer), ('resolver', resolver),
                  ('pending_resolver', pending)):
        if p.poll() is not None:
            print(f"[ERROR] {nm} died immediately (exit {p.returncode}); aborting")
            return 1

    # Spawn producers with a stagger so they don't all hit the claims DB
    # write lock in the same millisecond.
    producers: dict[str, subprocess.Popen] = {}
    for target in args.targets:
        cmd = _producer_cmd(args.db, args.redis_url, target, args.force)
        producers[target] = _spawn(target, cmd)
        time.sleep(2)        # 2s stagger between producer spawns

    print(f"\nSupervising {len(producers)} producer(s). Ctrl-C once to stop, twice to kill.")

    # Supervise: poll every few seconds, restart crashes, exit on SIGINT.
    def _kill_all():
        for label, p in [('resolver', resolver), ('writer', writer)] + list(producers.items()):
            if p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                except (ProcessLookupError, OSError):
                    pass

    shutting_down = False
    # Track per-subprocess crash count to detect crash-loop conditions
    crash_count: dict[str, int] = {n: 0 for n in producers}
    crash_count['_writer']    = 0
    crash_count['_resolver']  = 0
    crash_count['_pending']   = 0

    # A producer that exits 0 (no claimable work) is "parked": not a crash,
    # not respawned immediately. We recheck it for work on a slow heartbeat so
    # work that appears later (hop adds stubs, retry cooldown elapses) is still
    # picked up. monotonic timestamp of when each module was parked, or None.
    _parked_at: dict[str, float | None] = {n: None for n in producers}
    PARK_RECHECK_S = 60

    # Live dashboard state. Subprocess crashes are NOT printed inline (that
    # would scroll the screen and fight the refreshing QC panel); instead each
    # crash appends a monotonic timestamp here and the panel shows a rolling
    # count over the last 10 minutes plus where to look. monotonic() is fine —
    # it's not the wall-clock new Date() the workflow runtime forbids.
    error_events: list[tuple[float, str]] = []
    ERROR_WINDOW_S = 600
    started_mono = time.monotonic()
    live = sys.stdout.isatty()

    def _record_error(label: str, returncode, crash_n: int) -> None:
        error_events.append((time.monotonic(),
                             f"{label} exit {returncode} (#{crash_n})"))

    def _recent_errors() -> list[tuple[float, str]]:
        cutoff = time.monotonic() - ERROR_WINDOW_S
        return [e for e in error_events if e[0] >= cutoff]

    # Map each producer module -> its enrichment service, so we can attribute
    # settled-attempt activity to the module. Modules sharing a service (e.g.
    # enrich_metadata_oa + resolve_dois_oa both = 'oa') will share the service
    # delta; that's acceptable for a liveness signal.
    from .framework.claims import CANDIDATE_QUERIES
    _mod_service = {
        n: CANDIDATE_QUERIES.get(n, {}).get('service') for n in producers
    }
    _prev_settled: dict[str, int] = {}      # service -> settled count last tick
    _last_active: dict[str, float] = {}     # service -> monotonic of last activity
    # A module is 'working' if it has in-flight claims OR settled work within
    # this window. Producers settle in slow bursts (OA flushes a 50-DOI batch
    # roughly every ~2 min), so a single-tick "did it settle just now" check
    # would read 'idle' for almost the whole batch. The window smooths that.
    ACTIVE_WINDOW_S = 150

    def _live_modules(snap):
        """Build the per-module live-health rows from process + work state."""
        settled = snap.get('settled_by_service', {})
        claimed = snap.get('claimed_by_service', {})
        remaining = snap.get('remaining_by_module', {})
        now = time.monotonic()
        out = []
        for name in producers:
            p = producers.get(name)
            alive = p is not None and p.poll() is None
            svc = _mod_service.get(name)
            cur = settled.get(svc, 0)
            did = max(0, cur - _prev_settled.get(svc, cur))
            in_flight = claimed.get(svc, 0)
            left = remaining.get(name)
            parked = _parked_at.get(name) is not None
            # Refresh the per-service activity clock on any sign of work.
            if did > 0 or in_flight > 0:
                _last_active[svc] = now
            recently_active = (now - _last_active.get(svc, 0.0)) <= ACTIVE_WINDOW_S
            if alive and (in_flight > 0 or recently_active):
                status = 'working'
            elif left == 0:
                # No claimable work — finished this pass (parked or just idle).
                status = 'done'
            elif not alive and not parked:
                # Dead process that did NOT exit clean and still has work: a
                # genuine crash that hasn't respawned yet.
                status = 'down'
            else:
                # Alive-but-no-work, or parked waiting for the slow recheck.
                status = 'idle'
            out.append({
                'module': name, 'status': status, 'did': did,
                'in_flight': in_flight, 'settled': cur, 'remaining': left,
                'restarts': crash_count.get(name, 0),
            })
        _prev_settled.update(settled)
        return out

    # Live dashboard via Rich. Rich's Live(screen=True) owns the alternate
    # screen and crops a too-tall renderable to the window automatically
    # (vertical_overflow='crop'), so we never overflow/scroll regardless of
    # window size, and it reflows on resize. If Rich is somehow unavailable
    # we degrade to a plain periodic reprint rather than crash.
    _rich_live = None
    if live:
        try:
            from rich.live import Live as _RichLive
            from rich.console import Console as _RichConsole
            _console = _RichConsole()
            _rich_live = _RichLive(console=_console, screen=True,
                                   auto_refresh=False, vertical_overflow='crop')
        except Exception:
            _rich_live = None

    def _renderable():
        snap = _qc_snapshot(args.db)
        return _rich_dashboard(
            snap, args.db,
            uptime_s=int(time.monotonic() - started_mono),
            recent_errors=_recent_errors(), log_dir=log_dir,
            n_producers=len(producers), live_modules=_live_modules(snap))

    def _draw() -> None:
        if _rich_live is not None:
            _rich_live.update(_renderable(), refresh=True)
        elif live:
            # Fallback: Rich missing but we have a TTY — minimal reprint.
            recent = _recent_errors()
            core = _qc_snapshot(args.db)['core']
            sys.stdout.write(
                f"\rpapers {core['papers']:,}  edges {core['edges']:,}  "
                f"pending {core['pending_edges']:,}  errors(10m) {len(recent)}   ")
            sys.stdout.flush()

    if _rich_live is not None:
        _rich_live.start()
        live_active['on'] = True
    _draw()

    try:
        while True:
            time.sleep(5)

            # Check producers; restart if any crashed (with exponential backoff
            # so a misconfigured module can't crash-loop the supervisor).
            for name, p in list(producers.items()):
                if p.poll() is None or shutting_down:
                    continue
                rc = p.returncode
                if rc == 0:
                    # Clean exit = the producer ran out of claimable work
                    # (noop). This is NOT a crash. Park it and recheck on a
                    # slow heartbeat — new work can appear (hop adds stubs, or
                    # a failed field's retry cooldown elapses on a long run).
                    # Don't count it as an error/restart.
                    if _parked_at.get(name) is None:
                        _parked_at[name] = time.monotonic()
                    if time.monotonic() - _parked_at[name] < PARK_RECHECK_S:
                        continue
                    _parked_at[name] = time.monotonic()
                    cmd = _producer_cmd(args.db, args.redis_url, name, args.force)
                    producers[name] = _spawn(name, cmd)
                else:
                    # Nonzero exit = genuine crash. Count it, back off, restart.
                    _parked_at[name] = None
                    crash_count[name] += 1
                    c = crash_count[name]
                    wait = min(2 ** min(c, 6), 60)
                    _record_error(name, rc, c)
                    time.sleep(wait)
                    cmd = _producer_cmd(args.db, args.redis_url, name, args.force)
                    producers[name] = _spawn(name, cmd)

            # Writer + resolver: restart with backoff instead of hard-aborting.
            # The cache can buffer for the seconds it takes to bring them back.
            if writer.poll() is not None and not shutting_down:
                crash_count['_writer'] += 1
                c = crash_count['_writer']
                wait = min(2 ** min(c, 6), 60)
                _record_error('merge writer', writer.returncode, c)
                time.sleep(wait)
                writer = _spawn('merge writer', [
                    'python', '-u', '-m', 'biblion.merge.writer',
                    '--db', str(args.db), '--redis-url', args.redis_url,
                ])

            if resolver.poll() is not None and not shutting_down:
                crash_count['_resolver'] += 1
                c = crash_count['_resolver']
                wait = min(2 ** min(c, 6), 60)
                _record_error('resolver', resolver.returncode, c)
                time.sleep(wait)
                resolver = _spawn('resolver', [
                    'python', '-u', '-m', 'biblion.merge.resolver',
                    '--db', str(args.db), '--redis-url', args.redis_url,
                ])

            if pending.poll() is not None and not shutting_down:
                crash_count['_pending'] += 1
                c = crash_count['_pending']
                wait = min(2 ** min(c, 6), 60)
                _record_error('pending_resolver', pending.returncode, c)
                time.sleep(wait)
                pending = _spawn('pending resolver', [
                    'python', '-u', '-m', 'biblion.merge.pending_resolver',
                    '--db', str(args.db), '--redis-url', args.redis_url,
                ])

            # Refresh the live QC panel at the end of every poll tick.
            _draw()
    except KeyboardInterrupt:
        shutting_down = True
    finally:
        # Always restore the terminal before any shutdown output, whether we
        # exit via Ctrl-C or an unexpected error. Rich's stop() leaves the
        # alternate screen and restores the cursor.
        if _rich_live is not None:
            _rich_live.stop()
        live_active['on'] = False
    print("\n[supervisor] Ctrl-C — signalling SIGTERM to all subprocesses.")

    # Send SIGTERM to producers + pending_resolver first so they stop
    # pushing new work into the cache.
    for name, p in producers.items():
        if p.poll() is None:
            try: os.killpg(p.pid, signal.SIGTERM)
            except (ProcessLookupError, OSError): pass
    if pending.poll() is None:
        try: os.killpg(pending.pid, signal.SIGTERM)
        except (ProcessLookupError, OSError): pass
    # Wait briefly
    for name, p in list(producers.items()) + [('pending_resolver', pending)]:
        try: p.wait(timeout=20)
        except subprocess.TimeoutExpired:
            print(f"  [{name}] did not exit in 20s — SIGKILL")
            try: os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, OSError): pass
            p.wait()

    # Producers are dead — free any claims they held in-flight so they don't
    # sit 'claimed' (blocking re-claim until the 60-min sweep) for next run.
    try:
        from .db import get_claims_connection
        from .framework.claims import release_all_claims
        cconn = get_claims_connection(main_db_path=args.db)
        freed = release_all_claims(cconn)
        cconn.close()
        if freed:
            print(f"[supervisor] released {freed} in-flight claim(s)")
    except Exception as e:
        print(f"[supervisor] claim release skipped: {e}")

    # Now drain Redis through the writer
    print("\n[supervisor] Producers stopped, draining cache...")
    cache = CacheClient(url=args.redis_url)
    idle_target, idle_count = 5, 0
    while idle_count < idle_target:
        lens = cache.lengths()
        total = (lens['staged_papers'] + lens['staged_citations']
                 + lens['parked_papers'] + lens['resolved_papers']
                 + lens.get('promote_citations', 0))
        idle_count = idle_count + 1 if total == 0 else 0
        print(f"  [drain] queues: {lens}  (idle {idle_count}/{idle_target})")
        time.sleep(1)
        if writer.poll() is not None:
            break

    # Stop the daemons
    for name, p in (('resolver', resolver), ('writer', writer)):
        if p.poll() is None:
            try: os.killpg(p.pid, signal.SIGTERM)
            except (ProcessLookupError, OSError): pass
            try: p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try: os.killpg(p.pid, signal.SIGKILL)
                except (ProcessLookupError, OSError): pass
                p.wait()
            print(f"  [{name}] stopped (code {p.returncode})")

    print(f"\n[supervisor] Final cache: {cache.lengths()}")
    mux.close()
    print(f"[supervisor] log: {mux.path}")
    # Alt-screen is gone; leave the final coverage numbers in scrollback.
    print('\n'.join(_render_qc(_qc_snapshot(args.db), args.db)))
    return 0


def cmd_snapshot(args) -> int:
    """Snapshot the DB into a read-only network-toy bundle (+ node set).

    Read-only on the live DB (online-backup copy); writes alongside it by
    default so a project at data/<name>/<name>.db gets data/<name>/
    <name>_snapshot.db. No Redis.
    """
    from . import snapshot as snapshot_mod
    try:
        snapshot_mod.run_snapshot(Path(args.db), dataset=args.dataset,
                                  out_dir=args.out)
    except (FileNotFoundError, ValueError) as e:
        print(f"[biblion snapshot] {e}")
        return 2
    return 0


def cmd_embedding(args) -> int:
    """Embed the snapshot node set with SPECTER2 (needs the 'embed' extra)."""
    from . import embed as embed_mod
    try:
        embed_mod.run_embed(Path(args.db), dataset=args.dataset, out_dir=args.out,
                            batch=args.batch, max_length=args.max_length,
                            device=args.device, normalize=not args.no_normalize,
                            domain=args.domain)
    except FileNotFoundError as e:
        print(f"[biblion embedding] {e}")
        return 2
    return 0


# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------

def _add_common_args(p: argparse.ArgumentParser) -> None:
    p.add_argument('--db', type=Path, default=None,
                   help='SQLite path (env: BIBLION_DB; required unless set)')
    p.add_argument('--redis-url', default='redis://localhost:6379/0',
                   help='Redis URL for the cache')


def _add_advanced_subcommands(sub) -> None:
    """The full power-user surface; nested under `biblion advanced`."""
    sub.add_parser('list', help='Show registered modules + contracts')

    sbf = sub.add_parser('backfill-observations',
        help='Rebuild field_observations from existing papers + field_conflicts '
             'and re-resolve (no API calls). Dry-run unless --apply.')
    sbf.add_argument('--apply', action='store_true',
        help='Write observations and update papers (default: dry run)')
    sbf.add_argument('--apply-identifiers', action='store_true',
        help='Also apply re-resolved identifier fields (off by default — '
             'identifier conflicts are usually distinct works, not variants)')
    sbf.add_argument('--apply-version-fields', action='store_true',
        help='Also apply re-resolved year/publication_date (off by default — '
             'a year conflict is usually preprint-vs-VoR and needs the '
             'preprint/VoR detection, not blind source trust)')

    sp = sub.add_parser('plan', help='Show execution order for a target')
    sp.add_argument('target')

    sr = sub.add_parser('run', help='Run a module + prerequisites')
    sr.add_argument('target')
    sr.add_argument('--force',   action='store_true')
    sr.add_argument('--dry-run', action='store_true')
    sr.add_argument('--limit', type=int, default=None)
    sr.add_argument('--loop', action='store_true')
    sr.add_argument('--verbose', action='store_true')
    sr.add_argument('--min-degree', type=int, default=None,
        help='materialize_ghost_stubs: min in-corpus degree to keep a ghost (default 2)')

    ss = sub.add_parser('start',
        help='Spawn merge daemons, run producer, drain, stop — one shot')
    ss.add_argument('target')
    ss.add_argument('--force', action='store_true')
    ss.add_argument('--limit', type=int, default=None)
    ss.add_argument('--log-dir', type=Path, default=None)

    sd = sub.add_parser('daemon',
        help='Supervise merge writer + resolver + N looping producers')
    sd.add_argument('targets', nargs='+')
    sd.add_argument('--force', action='store_true')
    sd.add_argument('--log-dir', type=Path, default=None)

    sb = sub.add_parser('bulk',
        help='Stream S2 bulk datasets through the merge cache (one-shot)')
    sb.add_argument('target',
        choices=['paper_ids', 'abstracts', 'papers', 'all',
                 'bulk_paper_ids', 'bulk_abstracts', 'bulk_papers'])
    sb.add_argument('--release', default=None)
    sb.add_argument('--force', action='store_true')
    sb.add_argument('--verbose', action='store_true')
    sb.add_argument('--log-dir', type=Path, default=None)

    # ---- network-toy bundle (snapshot -> embedding) ---------------------
    ssn = sub.add_parser('snapshot',
        help='Build the network-toy read snapshot + node set from the DB')
    ssn.add_argument('--dataset', default=None,
        help='Logical dataset name (default: DB filename stem)')
    ssn.add_argument('--out', type=Path, default=None,
        help='Output dir (default: alongside the DB)')

    sem = sub.add_parser('embedding',
        help='Embed the snapshot node set with SPECTER2 -> embeddings.npy '
             "(needs the optional 'embed' extra)")
    sem.add_argument('--dataset', default=None,
        help='Logical dataset name (default: DB filename stem)')
    sem.add_argument('--out', type=Path, default=None,
        help='Output dir (default: alongside the DB, where snapshot wrote)')
    sem.add_argument('--batch', type=int, default=32)
    sem.add_argument('--max-length', type=int, default=512)
    sem.add_argument('--device', default=None, help='cuda / cpu (default: auto)')
    sem.add_argument('--no-normalize', action='store_true',
        help='Skip abbreviation expansion entirely (use for other domains)')
    from .text_normalization import DOMAIN_MAPS
    sem.add_argument('--domain', default='soil', choices=sorted(DOMAIN_MAPS),
        help='Abbreviation dictionary domain (default: soil)')


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog='biblion',
        description='biblion — citation graph pipeline',
    )
    _add_common_args(p)
    sub = p.add_subparsers(dest='cmd', required=True, metavar='COMMAND')

    # ---- primary user surface -------------------------------------------

    si = sub.add_parser('init',
        help='Create a biblion database and write a .env scaffold')
    si.add_argument('db_path', type=str,
        help='Path to create the SQLite database at')
    si.add_argument('--env-file', type=Path, default=None,
        help='Where to write the .env scaffold (default: ./.env)')
    si.add_argument('--name', type=str, default=None,
        help='Project name to register (default: DB filename stem)')
    si.add_argument('--no-register', action='store_true',
        help="Don't register the new DB as a named project")

    # Named-project registry: switch between databases without --db.
    spj = sub.add_parser('project',
        help='Manage named projects (add / use / list / remove / current)')
    pjsub = spj.add_subparsers(dest='project_cmd', metavar='SUBCMD')
    pj_add = pjsub.add_parser('add', help='Register a name -> database path')
    pj_add.add_argument('name')
    pj_add.add_argument('path')
    pj_add.add_argument('--use', action='store_true',
        help='Also set this project as current')
    pj_add.add_argument('--force', action='store_true',
        help='Repoint an existing name to a new path')
    pj_use = pjsub.add_parser('use', help='Set the current project')
    pj_use.add_argument('name')
    pjsub.add_parser('list', help='List registered projects (default)')
    pjsub.add_parser('current', help='Print the current project name + path')
    pj_rm = pjsub.add_parser('remove',
        help='Unregister a project (keeps the DB file)')
    pj_rm.add_argument('name')

    # `biblion use <name>` — shortcut for `biblion project use <name>`.
    su = sub.add_parser('use', help='Shortcut for `project use <name>`')
    su.add_argument('name')

    sim = sub.add_parser('import',
        help='Ingest papers from a RIS (.ris) or BibTeX (.bib) reference file')
    sim.add_argument('src', type=str,
        help='Path to a .ris or .bib file (e.g. exported from Zotero / EndNote)')
    sim.add_argument('--no-resolve', action='store_true',
        help="Don't try OpenAlex title-search for records without identifiers")
    sim.add_argument('--verbose', action='store_true',
        help='Per-record progress logging')

    sx = sub.add_parser('search',
        help='Run boolean-keyword Semantic Scholar search ingestion')
    sx.add_argument('search_file', type=Path,
        help='Path to a searches/*.json with {queries: [{id, title, query}]}')
    sx.add_argument('--mode', choices=['simplify', 'expand'], default='simplify',
        help='simplify: one query per top-level. expand: Cartesian AND/OR.')
    sx.add_argument('--sub-limit', type=int, default=100,
        help='Max papers per sub-query (default 100)')
    sx.add_argument('--year-min', type=int, default=None)
    sx.add_argument('--year-max', type=int, default=None)
    sx.add_argument('--force', action='store_true')
    sx.add_argument('--verbose', action='store_true')

    sh = sub.add_parser('hop',
        help='Semantic Scholar citation hop')
    sh.add_argument('--target', action='append', default=[],
        help='Identifier (DOI:..., bare DOI, W12345, or 40-char S2 sha). '
             'Repeatable. If omitted, hops every eligible paper.')
    sh.add_argument('--targets-file', type=Path, default=None,
        help='File with one identifier per line')
    sh.add_argument('--seeds', action='store_true',
        help='Hop only seed papers (is_seed=1). Ignored if --target/'
             '--targets-file is given.')
    sh.add_argument('--limit', type=int, default=None,
        help='Stop after N seeds hopped')
    sh.add_argument('--force', action='store_true')
    sh.add_argument('--verbose', action='store_true')

    se = sub.add_parser('enrich',
        help='Run merge writer + resolver + standard enrichment producers')
    se.add_argument('--force', action='store_true')
    se.add_argument('--log-dir', type=Path, default=None)

    sub.add_parser('qc', help='Coverage / conflict-log summary')

    sub.add_parser('migrate',
        help='Apply schema migrations and backfill promoted bibliographic '
             'columns from field_observations (idempotent; no API/Redis)')

    sfr = sub.add_parser('flag-retractions',
        help='Sweep DOI papers against OpenAlex and flag editorial_status '
             '(retracted), timestamped. One-shot; no Redis required.')
    sfr.add_argument('--limit', type=int, default=None,
        help='Only check the first N DOI papers (default: all)')
    sfr.add_argument('--verbose', action='store_true')

    sex = sub.add_parser('export',
        help='Serialise papers to a .bib or .ris file (read-only)')
    sex.add_argument('out', type=str, help='Destination .bib / .ris path')
    sex.add_argument('--format', choices=['bib', 'ris'], default=None,
        help='Output format (default: inferred from the file extension)')
    sex.add_argument('--seeds', action='store_true',
        help='Export only seed papers (is_seed=1)')
    sex.add_argument('--all', action='store_true',
        help='Export every paper in the DB')
    sex.add_argument('--year', type=int, default=None,
        help='Export papers from a single publication year')
    sex.add_argument('--ids', type=str, default=None,
        help='Comma-separated papers.id list to export')
    sex.add_argument('--include-redacted', action='store_true',
        help='Include retracted/withdrawn papers (excluded by default)')

    sbk = sub.add_parser('backup',
        help='Snapshot the DB (+ claims sidecar) to a file (safe while running)')
    sbk.add_argument('--backup', required=True, type=Path,
        help='Destination path for the backup copy')
    sbk.add_argument('--no-claims', action='store_true',
        help='Skip backing up the _claims.db sidecar')
    sbk.add_argument('--force', action='store_true',
        help='Overwrite the destination if it exists')

    # ---- advanced (nested, less prominent) ------------------------------

    sa = sub.add_parser('advanced',
        help='Lower-level subcommands (list, plan, run, start, daemon, bulk)')
    asub = sa.add_subparsers(dest='advanced_cmd', required=True, metavar='SUBCMD')
    _add_advanced_subcommands(asub)

    return p


_ADVANCED_DISPATCH = {
    'list':   'cmd_list',
    'plan':   'cmd_plan',
    'run':    'cmd_run',
    'start':  'cmd_start',
    'daemon': 'cmd_daemon',
    'bulk':   'cmd_bulk',
    'backfill-observations': 'cmd_backfill_observations',
    'snapshot':  'cmd_snapshot',
    'embedding': 'cmd_embedding',
}


def main(argv: list[str] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    # Registry commands manage the project list and don't need a resolved DB.
    # `use <name>` is a shortcut for `project use <name>`.
    if args.cmd == 'use':
        args.project_cmd = 'use'
        return cmd_project(args)
    if args.cmd == 'project':
        return cmd_project(args)

    # Most commands need a DB path. `init` is special — it creates one.
    if args.cmd != 'init':
        if args.db is None:
            # Resolution precedence: --db (already in args.db) > current
            # registered project > $BIBLION_DB. The project you `use` is
            # authoritative: a leftover BIBLION_DB can no longer silently
            # shadow it (a stale/inaccessible env value used to crash the
            # command — e.g. mkdir of a logs dir under a dead path). When no
            # project is current, BIBLION_DB is the fallback (or
            # DatabaseLocationError if it too is unset).
            from . import projects as _projects
            current = _projects.current_path()
            if current is not None:
                args.db = current
            else:
                args.db = get_db_path()   # $BIBLION_DB or DatabaseLocationError

        # Propagate the resolved DB back into the environment so EVERY path
        # helper derives from the same database: get_logs_dir(),
        # get_claims_db_path(), and any get_db_path() call downstream. Without
        # this, a stale BIBLION_DB leaks into the logs/claims paths even though
        # args.db points elsewhere — that mismatch was the real bug behind the
        # "Permission denied .../logs" crash.
        import os
        os.environ['BIBLION_DB'] = str(args.db)

        # Stash the Redis URL so the shared rate limiter (and any client
        # constructed deep inside a producer, which never sees args) can reach
        # the same Redis this command uses.
        if getattr(args, 'redis_url', None):
            os.environ.setdefault('BIBLION_REDIS_URL', args.redis_url)

        # Derive a per-DB Redis namespace and stash it in the env so every
        # subprocess (writer, resolver, pending_resolver, producers) sees
        # the same prefix and shares state with this command. Other
        # biblion instances on different DBs get different namespaces and
        # so don't see each other's queues, even on a shared Redis db=0.
        from .cache import namespace_for_db
        os.environ.setdefault('BIBLION_REDIS_NAMESPACE',
                               namespace_for_db(args.db))

    # Commands that touch the producer cache fail fast with a clear message if
    # Redis is down. `init` and `qc` never touch Redis; the read-only advanced
    # commands `list` / `plan` don't either.
    _NO_REDIS = {'init', 'qc', 'backup', 'migrate', 'export', 'flag-retractions'}
    _NO_REDIS_ADVANCED = {'list', 'plan', 'backfill-observations',
                          'snapshot', 'embedding'}
    needs_redis = args.cmd not in _NO_REDIS and not (
        args.cmd == 'advanced' and args.advanced_cmd in _NO_REDIS_ADVANCED)
    if needs_redis:
        _require_redis(args)

    dispatch = {
        'init':   cmd_init,
        'import': cmd_import,
        'search': cmd_search,
        'hop':    cmd_hop,
        'enrich': cmd_enrich,
        'qc':     cmd_qc,
        'backup': cmd_backup,
        'migrate': cmd_migrate,
        'flag-retractions': cmd_flag_retractions,
        'export': cmd_export,
    }
    if args.cmd == 'advanced':
        fn_name = _ADVANCED_DISPATCH[args.advanced_cmd]
        return globals()[fn_name](args)
    return dispatch[args.cmd](args)


if __name__ == '__main__':
    sys.exit(main())
