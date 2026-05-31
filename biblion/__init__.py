"""
biblion — DAG-orchestrated, contract-driven citation graph pipeline.

Each pipeline phase is a Module that declares its inputs, outputs, and
resource requirements as class attributes. An Orchestrator builds a
dependency DAG from those declarations, validates contracts, and runs
modules in topological order with strict precondition checks and
exclusive resource locking.

Self-contained: the framework lives in biblion.framework, the
cache substrate in biblion.cache, the single-writer merge layer in
biblion.merge, and the pipeline modules in biblion.modules.
Use `python -m biblion --help` for the CLI surface.
"""
__version__ = '0.1.0'
