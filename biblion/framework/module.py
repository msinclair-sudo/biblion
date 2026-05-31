"""
v3 module contract.

Every pipeline phase is a subclass of Module that declares its inputs,
outputs, and resource requirements as class attributes, and implements
two methods:

    validate(ctx) -> ValidationResult   # cheap precondition check (DB only)
    run(ctx)      -> ModuleResult       # the actual work

The orchestrator uses the class attributes to build a dependency DAG
and to enforce resource locking. The implementation never has to think
about scheduling, dependency resolution, or lock management.
"""
from dataclasses import dataclass, field
from typing import Literal, Optional


# ---------------------------------------------------------------------------
# Return types
# ---------------------------------------------------------------------------

Status = Literal['success', 'partial', 'failed', 'noop']


@dataclass
class ModuleResult:
    """Return value from Module.run()."""
    status:  Status
    message: str = ''
    stats:   dict = field(default_factory=dict)


@dataclass
class ValidationResult:
    """Return value from Module.validate()."""
    ok:       bool
    missing:  list[str] = field(default_factory=list)   # which `requires` items aren't met
    message:  str       = ''


# ---------------------------------------------------------------------------
# Module base
# ---------------------------------------------------------------------------

class Module:
    """
    Base class for v3 pipeline modules.

    Subclasses set the contract attributes and override validate() / run().
    The orchestrator never instantiates two modules whose `resources` sets
    overlap concurrently.

    Contract attributes
    -------------------
    name:        Unique identifier (snake_case, used as primary key in DB)
    description: One-line human-readable summary
    requires:    Data preconditions, expressed as "table.column" or
                 "cache:queue" strings. The orchestrator checks at least
                 one non-null value / cache entry exists.
    produces:    Data postconditions, same syntax. Used to build DAG edges
                 (module A depends on B if A.requires ∩ B.produces ≠ ∅).
                 In the v3 cache architecture, producer modules typically
                 declare `produces = {'cache:papers'}` etc., and only the
                 merge writer declares `produces = {'papers.*'}`.
    eventually:  Documentation-only set listing the v3 DB columns this
                 module's contributions will end up populating, once merge
                 has consumed the cache. Used by qc to verify coverage.
    resources:   Named exclusive resources (e.g. 'openalex_api'). Only one
                 module holding a given resource runs at a time. The merge
                 writer holds 'db_writer'; producers do NOT — they push
                 to the cache and never touch the DB directly.

    Example
    -------
        class MetadataBackfill(Module):
            name = 'metadata_backfill'
            description = 'Fill paper metadata from OpenAlex by DOI'
            requires = {'papers.doi'}
            produces = {'papers.abstract', 'papers.authors', 'papers.venue'}
            resources = {'openalex_api', 'db_writer'}

            def validate(self, ctx):
                n = ctx.connect().execute(
                    "SELECT 1 FROM papers WHERE doi IS NOT NULL LIMIT 1"
                ).fetchone()
                return ValidationResult(
                    ok=bool(n),
                    missing=[] if n else ['papers.doi'],
                )

            def run(self, ctx):
                ...
                return ModuleResult(status='success', stats={'updated': n})
    """

    # ---- contract (override in subclass) ----
    name:        str       = ''
    description: str       = ''
    requires:    set[str]  = set()
    produces:    set[str]  = set()
    eventually:  set[str]  = set()
    resources:   set[str]  = set()

    # ---- methods (override in subclass) ----

    def validate(self, ctx) -> ValidationResult:
        """
        Cheap precondition check. Default implementation assumes preconditions
        are met (override if your module has runtime requirements beyond
        what `requires` covers, e.g. API key presence).
        """
        return ValidationResult(ok=True)

    def run(self, ctx) -> ModuleResult:
        raise NotImplementedError(f"{type(self).__name__}.run() not implemented")

    # ---- introspection helpers used by the orchestrator ----

    def __repr__(self) -> str:
        return f"<Module {self.name!r}>"

    @classmethod
    def contract(cls) -> dict:
        """Return the declared contract as a serialisable dict."""
        return {
            'name':        cls.name,
            'description': cls.description,
            'requires':    sorted(cls.requires),
            'produces':    sorted(cls.produces),
            'eventually':  sorted(cls.eventually),
            'resources':   sorted(cls.resources),
        }
