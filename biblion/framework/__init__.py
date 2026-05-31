"""
biblion framework — the orchestration and contract surface.

Public API
----------
    Module                 — base class for pipeline modules
    ModuleResult           — return value from Module.run()
    ValidationResult       — return value from Module.validate()
    Context                — execution context passed to run()
    Orchestrator           — DAG builder and runner
    ContractError          — raised by Orchestrator.plan() on invalid DAG
    PreconditionError      — raised by Orchestrator.run() on failed validate()
    claim_candidates       — cross-service claim coordination (see claims.py)
"""
from .context import Context
from .module import Module, ModuleResult, ValidationResult
from .orchestrator import Orchestrator, ContractError, PreconditionError
from .claims import (
    claim_candidates, mark_succeeded, mark_failed, bulk_mark,
    release_claims, attempt_counts,
)

__all__ = [
    'Module', 'ModuleResult', 'ValidationResult',
    'Context', 'Orchestrator',
    'ContractError', 'PreconditionError',
    'claim_candidates', 'mark_succeeded', 'mark_failed', 'bulk_mark',
    'release_claims', 'attempt_counts',
]
