"""
v3 orchestrator.

Responsibilities:

  1. Register modules and build the dependency DAG from their
     `requires` / `produces` contracts.

  2. Detect contract violations early:
       - cycles
       - dangling `requires` (no module produces this data)
       - duplicate names

  3. For a requested target, compute the topological order of all
     prerequisite modules, then run them in sequence.

  4. Enforce strict precondition checks: before each module runs,
     call its validate() against the live DB. Refuse to proceed if
     the contract is not satisfied (override with force=True).

  5. Enforce resource locking: never run two modules whose `resources`
     sets overlap concurrently. (Initial implementation is sequential;
     parallel execution within resource constraints is a later upgrade.)

  6. Persist every invocation in module_runs.
"""
import traceback
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Optional

from . import state
from .context import Context
from .module import Module, ModuleResult, ValidationResult
from ..clients.ratelimit import DailyLimitReached
from ..runtime import ShutdownFlag
from ..cache import CacheClient


# ---------------------------------------------------------------------------
# Custom exceptions — orchestrator-level errors, not module-level
# ---------------------------------------------------------------------------

class ContractError(Exception):
    """Raised during plan() when the registered modules cannot form a valid DAG."""


class PreconditionError(Exception):
    """Raised during run() when a module's validate() returns ok=False."""


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class Orchestrator:
    """
    Build, validate, and execute a DAG of v3 Modules.

    Usage
    -----
        orch = Orchestrator(db_path=Path('biblion.db'))
        orch.register(SeedExpansion())
        orch.register(BuildGraph())
        orch.register(MetadataBackfill())
        orch.plan()                       # validate the DAG
        orch.show()                       # print the planned execution order
        orch.run('metadata_backfill')     # runs target + all prerequisites
    """

    def __init__(self, db_path: Path, work_dir: Optional[Path] = None,
                 config: Optional[dict] = None,
                 cache: Optional[CacheClient] = None,
                 merge_after_producers: bool = True):
        self.db_path  = Path(db_path)
        self.work_dir = Path(work_dir) if work_dir else self.db_path.parent
        self.config   = config or {}
        self.cache    = cache                 # may be None for in-process tests
        self.merge_after_producers = merge_after_producers
        self.modules: dict[str, Module] = {}

        # Built by plan(); cleared if a new module is registered.
        self._edges: Optional[dict[str, set[str]]] = None   # name -> prereq names

        # Process-wide resource locks. Only relevant for parallel execution;
        # the current sequential runner uses this for visibility/diagnostics
        # but enforcement is implicit in the topological sort.
        self._held_resources: dict[str, str] = {}

    # ---------------------------------------------------------------- register

    def register(self, module: Module) -> None:
        if not module.name:
            raise ContractError(f"Module {type(module).__name__} has empty 'name'")
        if module.name in self.modules:
            raise ContractError(f"Duplicate module name: {module.name!r}")
        self.modules[module.name] = module
        self._edges = None    # invalidate plan

    def register_all(self, modules: Iterable[Module]) -> None:
        for m in modules:
            self.register(m)

    # -------------------------------------------------------------------- plan

    def plan(self) -> dict[str, set[str]]:
        """
        Build and validate the DAG. Returns a dict mapping each module name
        to the set of module names it depends on.

        Raises ContractError on:
          - cycles
          - dangling requires (a needed data item is produced by no module)
          - duplicate producers for SQL outputs (e.g. 'papers.abstract')

        Multiple producers ARE allowed for outputs prefixed with 'cache:'
        — by design, many producer modules push records into shared cache
        queues, and the merge writer reconciles.
        """
        # Map: data_item -> list of module names that produce it.
        #
        # `produces` is the immediate, direct output (typically 'cache:*').
        # `eventually` is the downstream DB column that will be populated by
        #   the merge writer once it consumes this module's cache pushes.
        # The DAG considers both: a module that requires 'papers.doi' will
        # depend on every module whose `eventually` includes 'papers.doi'.
        producers: dict[str, list[str]] = defaultdict(list)
        for m in self.modules.values():
            for item in m.produces:
                # Cache items may have many producers; DB items may not (but
                # the v3 design rarely puts DB items in `produces` — they go
                # in `eventually`).
                if not item.startswith('cache:'):
                    existing = [p for p in producers[item] if p != m.name]
                    if existing:
                        raise ContractError(
                            f"Two modules claim to produce {item!r}: "
                            f"{existing[0]!r} and {m.name!r}"
                        )
                producers[item].append(m.name)
            for item in m.eventually:
                # `eventually` is descriptive, not exclusive — many modules
                # may eventually populate the same DB column.
                producers[item].append(m.name)

        # Build edges: m_name -> {prereq names}.
        #
        # Two flavours of `requires`:
        #   cache:*   — must have a producer in the DAG. Used for hard runtime
        #               ordering (e.g. merge consumes cache:papers).
        #   table.col — soft runtime preconditions checked by each module's
        #               validate() against the live DB. They contribute edges
        #               only when some other module in this registry produces
        #               them; otherwise it's assumed an out-of-DAG actor
        #               (the merge writer applying a previous run) populated
        #               them, and strict mode will catch a missing precondition
        #               at execution time.
        edges: dict[str, set[str]] = defaultdict(set)
        for m in self.modules.values():
            for item in m.requires:
                if item not in producers:
                    if item.startswith('cache:'):
                        raise ContractError(
                            f"Module {m.name!r} requires {item!r} but no module produces it"
                        )
                    continue   # DB-column requires: verified at runtime by validate()
                for prereq in producers[item]:
                    if prereq != m.name:
                        edges[m.name].add(prereq)

        # Cycle detection via DFS
        WHITE, GREY, BLACK = 0, 1, 2
        colour = {n: WHITE for n in self.modules}

        def visit(n: str, stack: list[str]):
            colour[n] = GREY
            for prereq in edges[n]:
                if colour[prereq] == GREY:
                    cycle = ' -> '.join(stack[stack.index(prereq):] + [prereq])
                    raise ContractError(f"Cycle detected: {cycle}")
                if colour[prereq] == WHITE:
                    visit(prereq, stack + [prereq])
            colour[n] = BLACK

        for n in self.modules:
            if colour[n] == WHITE:
                visit(n, [n])

        self._edges = dict(edges)
        return self._edges

    # -------------------------------------------------------------------- show

    def show(self, target: Optional[str] = None) -> None:
        """Print the DAG (or just the slice needed for `target`)."""
        if self._edges is None:
            self.plan()
        names = self._execution_order(target) if target else list(self.modules)
        print(f"Execution order ({len(names)} module{'s' if len(names) != 1 else ''}):")
        for i, n in enumerate(names, 1):
            m = self.modules[n]
            deps = ', '.join(sorted(self._edges.get(n, []))) or '—'
            res  = ', '.join(sorted(m.resources)) or '—'
            print(f"  {i:2d}. {n:<30s} deps: {deps}")
            print(f"      resources: {res}")
            print(f"      {m.description}")

    # --------------------------------------------------------------------- run

    def run(self, target: str, *, force: bool = False, dry_run: bool = False,
            skip_prereqs: bool = False) -> None:
        """
        Execute `target` and every module it transitively depends on.

        Strict mode (default): each module's validate() must return ok=True
        before the orchestrator will run it. Use force=True to skip the check.

        skip_prereqs=True runs ONLY the target module. Used by daemon mode
        where each producer runs in its own subprocess and the DAG cascade
        would multiply contention.
        """
        if self._edges is None:
            self.plan()
        if target not in self.modules:
            raise ContractError(f"Unknown module: {target!r}")

        order = [target] if skip_prereqs else self._execution_order(target)

        # Ensure the run-state table exists, and reap any 'running' rows
        # left behind by SIGKILL'd previous invocations.
        conn = self._db_connect()
        state.init(conn)
        reaped = state.reap_orphans(conn)
        conn.close()
        if reaped:
            print(f"[Orchestrator] reaped {reaped} orphan 'running' row(s) from previous runs")

        shutdown = ShutdownFlag.install(name='biblion')

        for name in order:
            if shutdown.requested:
                print(f"\n[Orchestrator] Shutdown — stopping before {name!r}")
                return

            m = self.modules[name]
            ctx = Context(
                db_path  = self.db_path,
                work_dir = self.work_dir,
                shutdown = shutdown,
                cache    = self.cache,
                config   = self.config,
            )

            print(f"\n{'='*60}")
            print(f"  {m.name}  —  {m.description}")
            print(f"{'='*60}")

            # ---- precondition check ----
            # Daemon mode (skip_prereqs=True) skips validate entirely:
            # producers in loop mode handle "no work yet" via their idle-loop
            # logic. Failing validate here would crash the subprocess and the
            # supervisor would crash-loop until work appeared.
            if not skip_prereqs:
                v: ValidationResult = m.validate(ctx)
                if not v.ok and not force:
                    raise PreconditionError(
                        f"{m.name!r} preconditions not met: "
                        f"missing={v.missing}  message={v.message!r}\n"
                        f"Use force=True to override."
                    )

            if dry_run:
                print(f"  [DRY RUN] would execute {m.name}")
                continue

            # ---- record + run + record ----
            run_conn = self._db_connect()
            state.start(run_conn, ctx.run_id, m.name)
            run_conn.close()

            try:
                result: ModuleResult = m.run(ctx)
            except DailyLimitReached as e:
                # An API engine hit its rates.config daily cap mid-run. Stop
                # this module gracefully (noop, not failed) and move on; the
                # counter resets at UTC midnight. BaseException, so producers'
                # per-batch `except Exception` let it reach here.
                run_conn = self._db_connect()
                state.finish(
                    run_conn, ctx.run_id, status='noop',
                    message=f"{e.engine} daily API limit reached — stopped for the day")
                run_conn.close()
                print(f"  → noop: {e.engine} daily API limit reached — "
                      f"stopping {m.name!r} for the day")
                continue
            except Exception:
                err = traceback.format_exc()
                run_conn = self._db_connect()
                state.finish(run_conn, ctx.run_id,
                             status='failed', error=err)
                run_conn.close()
                print(f"\n[Orchestrator] {m.name!r} FAILED")
                raise

            run_conn = self._db_connect()
            state.finish(
                run_conn, ctx.run_id,
                status=result.status,
                message=result.message,
                stats=result.stats,
            )
            run_conn.close()
            print(f"  → {result.status}: {result.message}")

            # Drain the cache after a producer module so subsequent modules
            # see the merged data when they check preconditions.
            if self.merge_after_producers and self.cache is not None:
                self._drain_cache()

    def _drain_cache(self) -> None:
        """Run merge cycles until staged queues are empty (resolver in parallel
        as needed). Bounded by self.merge_max_cycles_per_drain to avoid
        runaway loops if producers are still pushing concurrently — but in
        the sequential orchestrator only the just-finished module produced,
        so the queue will empty in finitely many cycles."""
        # Lazy import — keeps the merge package optional in unit tests
        from ..merge import MergeWriter, Resolver
        writer   = MergeWriter(self.db_path, self.cache)
        resolver = Resolver(self.db_path, self.cache)

        max_idle_cycles = 3
        idle = 0
        cycles = 0
        while idle < max_idle_cycles and cycles < 10_000:
            cycles += 1
            n_merge    = writer.run_cycle()
            n_resolve  = resolver.run_cycle()
            if n_merge + n_resolve == 0:
                idle += 1
            else:
                idle = 0
        if writer.stats.papers_seen or writer.stats.citations_seen:
            print(f"  [merge] cycles={cycles}  "
                  f"papers seen={writer.stats.papers_seen} "
                  f"(new={writer.stats.new_papers}, "
                  f"upd={writer.stats.updated_papers}, "
                  f"parked={writer.stats.parked_papers})  "
                  f"citations seen={writer.stats.citations_seen} "
                  f"(new={writer.stats.new_citations}, "
                  f"pending={writer.stats.pending_citations})  "
                  f"conflicts={writer.stats.conflicts}  "
                  f"resolver merged={resolver.merged}")

    # --------------------------------------------------------------- internals

    def _execution_order(self, target: str) -> list[str]:
        """Topological order of `target` and all its prerequisites."""
        if self._edges is None:
            self.plan()

        visited: set[str] = set()
        order:   list[str] = []

        def visit(n: str):
            if n in visited:
                return
            visited.add(n)
            for prereq in self._edges.get(n, ()):
                visit(prereq)
            order.append(n)

        visit(target)
        return order

    def _db_connect(self):
        import sqlite3
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn
