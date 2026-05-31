"""
Tests for the named-project registry (biblion/projects.py) and its CLI
resolution precedence. No Redis, no DB schema needed — the registry is a plain
JSON config file, pointed at a temp path via $BIBLION_CONFIG.
"""
import json
import os

import pytest

from biblion import projects as P


pytestmark = pytest.mark.unit


@pytest.fixture
def registry(tmp_path, monkeypatch):
    """Isolate the registry to a temp file for each test."""
    cfg = tmp_path / 'projects.json'
    monkeypatch.setenv('BIBLION_CONFIG', str(cfg))
    # Ensure no stray BIBLION_DB leaks in from the environment.
    monkeypatch.delenv('BIBLION_DB', raising=False)
    return cfg


class TestRegistryBasics:
    def test_empty_when_no_file(self, registry):
        projs, current = P.list_projects()
        assert projs == {}
        assert current is None
        assert P.current_path() is None

    def test_add_sets_first_as_current(self, registry):
        P.add('algae', '/tmp/algae.db')
        projs, current = P.list_projects()
        assert current == 'algae'                    # first add becomes current
        assert projs['algae'].endswith('algae.db')

    def test_add_resolves_to_absolute(self, registry, tmp_path):
        rel = tmp_path / 'x.db'
        path = P.add('x', str(rel))
        assert os.path.isabs(str(path))

    def test_second_add_keeps_current(self, registry):
        P.add('a', '/tmp/a.db')
        P.add('b', '/tmp/b.db')
        assert P.list_projects()[1] == 'a'           # current unchanged

    def test_use_switches_current(self, registry):
        P.add('a', '/tmp/a.db')
        P.add('b', '/tmp/b.db')
        P.use('b')
        assert P.list_projects()[1] == 'b'
        assert str(P.current_path()).endswith('b.db')

    def test_use_unknown_raises(self, registry):
        with pytest.raises(P.ProjectError):
            P.use('nope')

    def test_remove_clears_current_if_pointed_there(self, registry):
        P.add('a', '/tmp/a.db')
        P.remove('a')
        projs, current = P.list_projects()
        assert 'a' not in projs
        assert current is None

    def test_remove_unknown_raises(self, registry):
        with pytest.raises(P.ProjectError):
            P.remove('ghost')

    def test_add_duplicate_name_different_path_raises(self, registry):
        P.add('a', '/tmp/a.db')
        with pytest.raises(P.ProjectError):
            P.add('a', '/tmp/other.db')

    def test_add_overwrite_repoints(self, registry):
        P.add('a', '/tmp/a.db')
        P.add('a', '/tmp/other.db', overwrite=True)
        assert str(P.list_projects()[0]['a']).endswith('other.db')

    def test_corrupt_file_is_treated_as_empty(self, registry):
        registry.write_text('{ not valid json')
        projs, current = P.list_projects()
        assert projs == {} and current is None


class TestNameDerivation:
    def test_auto_register_uses_stem(self, registry):
        name = P.auto_register_on_init('/data/microbiome.db')
        assert name == 'microbiome'
        assert P.list_projects()[1] == 'microbiome'   # and becomes current

    def test_auto_register_strips_claims_suffix(self, registry):
        name = P.auto_register_on_init('/data/algae_claims.db')
        assert name == 'algae'

    def test_auto_register_explicit_name(self, registry):
        name = P.auto_register_on_init('/data/x.db', name='myproj')
        assert name == 'myproj'


class TestAtomicWrite:
    def test_save_is_valid_json(self, registry):
        P.add('a', '/tmp/a.db')
        P.use('a')
        data = json.loads(registry.read_text())
        assert data['current'] == 'a'
        assert 'a' in data['projects']
        # no leftover temp file
        assert not registry.with_suffix('.json.tmp').exists()


class TestConfigPath:
    def test_biblion_config_override(self, tmp_path, monkeypatch):
        custom = tmp_path / 'custom.json'
        monkeypatch.setenv('BIBLION_CONFIG', str(custom))
        assert P.config_path() == custom

    def test_xdg_config_home(self, tmp_path, monkeypatch):
        monkeypatch.delenv('BIBLION_CONFIG', raising=False)
        monkeypatch.setenv('XDG_CONFIG_HOME', str(tmp_path))
        assert P.config_path() == tmp_path / 'biblion' / 'projects.json'
