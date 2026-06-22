"""
The endpoint catalogue must be a faithful 1:1 mirror of CANDIDATE_QUERIES:
same modules, same service, same fields, plausible batch sizes. This is what
lets the solver replace the registry without dropping a route.
"""
import pytest

from biblion.enrich.catalogue import CATALOGUE, PROVIDER_OF
from biblion.framework.claims import CANDIDATE_QUERIES


pytestmark = pytest.mark.unit


def test_one_endpoint_per_registry_module():
    assert set(CATALOGUE) == set(CANDIDATE_QUERIES)


def test_service_and_fields_match_registry():
    for name, ep in CATALOGUE.items():
        spec = CANDIDATE_QUERIES[name]
        assert ep.service == spec['service'], name
        assert ep.fields == spec['fields'], name


def test_provider_known_and_batch_positive():
    for name, ep in CATALOGUE.items():
        assert ep.provider == PROVIDER_OF[ep.service], name
        assert ep.batch > 0, name


def test_settles_is_service_keyed():
    ep = CATALOGUE['enrich_metadata_oa']
    assert ep.settles == frozenset(
        ('oa', f) for f in ('abstract', 'authors', 'venue', 'year', 'pub_type'))
