"""
Tests for the DAG orchestrator framework.

Covers Module contract enforcement, dependency edges, cycle detection,
topological ordering, and producer-uniqueness rules.
"""
import pytest

from biblion.framework import (
    Module, ModuleResult,
    Orchestrator, ContractError,
)


pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# Lightweight test modules
# ---------------------------------------------------------------------------

class _A(Module):
    name = 'a'; description = 'produces alpha'
    produces = {'t.alpha'}
    def run(self, ctx): return ModuleResult(status='success')

class _B(Module):
    name = 'b'; description = 'consumes alpha, produces beta'
    requires = {'t.alpha'}; produces = {'t.beta'}
    def run(self, ctx): return ModuleResult(status='success')

class _C(Module):
    name = 'c'; description = 'consumes beta'
    requires = {'t.beta'}; produces = {'t.gamma'}
    def run(self, ctx): return ModuleResult(status='success', stats={'n': 42})


# ---------------------------------------------------------------------------
# DAG construction
# ---------------------------------------------------------------------------

class TestDagConstruction:
    def test_simple_chain(self, tmp_db_path):
        o = Orchestrator(db_path=tmp_db_path)
        o.register_all([_A(), _B(), _C()])
        edges = o.plan()
        assert edges['a'] == set()
        assert edges['b'] == {'a'}
        assert edges['c'] == {'b'}

    def test_topological_order_for_target(self, tmp_db_path):
        o = Orchestrator(db_path=tmp_db_path)
        o.register_all([_C(), _A(), _B()])  # registered out of order
        o.plan()
        assert o._execution_order('c') == ['a', 'b', 'c']

    def test_unknown_target_raises(self, tmp_db_path):
        o = Orchestrator(db_path=tmp_db_path)
        o.register(_A())
        o.plan()
        with pytest.raises(ContractError):
            o.run('nope')

    def test_cycle_detected(self, tmp_db_path):
        class X(Module):
            name = 'x'; requires = {'t.y'}; produces = {'t.x'}
            def run(self, ctx): return ModuleResult(status='success')
        class Y(Module):
            name = 'y'; requires = {'t.x'}; produces = {'t.y'}
            def run(self, ctx): return ModuleResult(status='success')
        o = Orchestrator(db_path=tmp_db_path)
        o.register_all([X(), Y()])
        with pytest.raises(ContractError, match='[Cc]ycle'):
            o.plan()

    def test_duplicate_db_producer_rejected(self, tmp_db_path):
        class P1(Module):
            name = 'p1'; produces = {'t.foo'}
            def run(self, ctx): return ModuleResult(status='success')
        class P2(Module):
            name = 'p2'; produces = {'t.foo'}
            def run(self, ctx): return ModuleResult(status='success')
        o = Orchestrator(db_path=tmp_db_path)
        o.register_all([P1(), P2()])
        with pytest.raises(ContractError, match='Two modules claim to produce'):
            o.plan()

    def test_multiple_cache_producers_allowed(self, tmp_db_path):
        """Many modules legitimately push into the shared staged:papers
        queue — this should NOT be flagged as a duplicate."""
        class P1(Module):
            name = 'p1'; produces = {'cache:papers'}
            def run(self, ctx): return ModuleResult(status='success')
        class P2(Module):
            name = 'p2'; produces = {'cache:papers'}
            def run(self, ctx): return ModuleResult(status='success')
        o = Orchestrator(db_path=tmp_db_path)
        o.register_all([P1(), P2()])
        o.plan()  # should not raise

    def test_cache_require_with_no_producer_raises(self, tmp_db_path):
        class Needs(Module):
            name = 'needs'; requires = {'cache:papers'}
            def run(self, ctx): return ModuleResult(status='success')
        o = Orchestrator(db_path=tmp_db_path)
        o.register(Needs())
        with pytest.raises(ContractError):
            o.plan()

    def test_db_require_with_no_producer_is_soft(self, tmp_db_path):
        """papers.X requires without a producer is OK — validate() will
        check at runtime."""
        class Needs(Module):
            name = 'needs'; requires = {'papers.title'}
            def run(self, ctx): return ModuleResult(status='success')
        o = Orchestrator(db_path=tmp_db_path)
        o.register(Needs())
        o.plan()  # should NOT raise

    def test_eventually_creates_dag_edges(self, tmp_db_path):
        class Producer(Module):
            name = 'producer'
            produces   = {'cache:papers'}
            eventually = {'papers.doi'}
            def run(self, ctx): return ModuleResult(status='success')
        class Consumer(Module):
            name = 'consumer'
            requires = {'papers.doi'}
            def run(self, ctx): return ModuleResult(status='success')
        o = Orchestrator(db_path=tmp_db_path)
        o.register_all([Consumer(), Producer()])
        edges = o.plan()
        assert edges['consumer'] == {'producer'}
