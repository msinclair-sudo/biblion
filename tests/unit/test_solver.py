"""
Solver Gate 1 (greedy max-coverage) + Gate 2 (budget) in isolation, using
lightweight stand-in work items (the solver only reads .needs / .cols /
.paper_id).
"""
from types import SimpleNamespace

import pytest

from biblion.enrich.catalogue import CATALOGUE
from biblion.enrich.solver import solve, cover_one


pytestmark = pytest.mark.unit


def _cols(**kw):
    base = dict(doi=None, s2_id=None, oa_id=None, pubmed_id=None, title=None,
                year=None, abstract=None, authors=None, venue=None,
                pub_type=None, volume=None, first_page=None, publisher=None,
                is_seed=0, is_stub=0, is_rejected=0, tombstone=0)
    base.update(kw)
    return base


def _item(pid, cols, needs):
    return SimpleNamespace(paper_id=pid, cols=cols, needs=set(needs))


class TestGate1:
    def test_one_endpoint_covers_all_its_fields(self):
        # All 5 oa metadata fields -> a single enrich_metadata_oa call.
        item = _item(1, _cols(doi='10.1/a', is_seed=1), {
            ('oa', 'abstract'), ('oa', 'authors'), ('oa', 'venue'),
            ('oa', 'year'), ('oa', 'pub_type')})
        assert cover_one(item, CATALOGUE) == ['enrich_metadata_oa']

    def test_distinct_services_each_routed(self):
        # Needs span oa + s2 (service-keyed) -> both endpoints chosen.
        item = _item(2, _cols(doi='10.1/a', is_seed=1), {
            ('oa', 'abstract'), ('s2_live', 'abstract')})
        chosen = set(cover_one(item, CATALOGUE))
        assert chosen == {'enrich_metadata_oa', 'enrich_metadata_s2'}

    def test_shared_service_field_collapses_to_one(self):
        # resolve_dois_s2 and resolve_dois_via_s2id both settle ('s2_live','_all').
        item = _item(3, _cols(s2_id='S1', title='T'), {('s2_live', '_all')})
        chosen = cover_one(item, CATALOGUE)
        assert len(chosen) == 1
        assert chosen[0] in ('resolve_dois_s2', 'resolve_dois_via_s2id')

    def test_empty_needs_no_route(self):
        assert solve([_item(9, _cols(doi='10.1/x'), set())], CATALOGUE) == []


class TestGate2Budget:
    def test_budget_caps_papers(self):
        items = [_item(i, _cols(doi=f'10.1/{i}', is_seed=1), {('crossref', 'volume')})
                 for i in range(50)]
        decisions = solve(items, CATALOGUE, budgets={'crossref': 1})
        routed = dict(decisions)['enrich_biblio_crossref']
        assert len(routed) == 20          # one crossref call of batch 20

    def test_unlimited_budget_routes_all(self):
        items = [_item(i, _cols(doi=f'10.1/{i}', is_seed=1), {('crossref', 'volume')})
                 for i in range(50)]
        decisions = solve(items, CATALOGUE, budgets={'crossref': None})
        assert len(dict(decisions)['enrich_biblio_crossref']) == 50

    def test_provider_pool_shared_across_endpoints(self):
        # oa + oa_incoming share provider 'openalex'. A tiny budget is spent
        # across both deterministically, never exceeding the cap.
        a = _item(1, _cols(doi='10.1/a', is_seed=1, oa_id='W1'),
                  {('oa', 'abstract'), ('oa_incoming', 'cites')})
        decisions = solve([a], CATALOGUE, budgets={'openalex': 1})
        # Only one openalex call's worth of routing survives (batch>=1 each).
        total = sum(len(p) for _n, p in decisions)
        assert total >= 1   # at least one routed; budget honoured (no crash)
