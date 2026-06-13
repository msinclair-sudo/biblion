"""
Tests for the rates.config loader (biblion.config._load_rates / rate_for).
"""
import json

import pytest

from biblion import config


pytestmark = pytest.mark.unit


def test_packaged_default_loads():
    # Run from a dir with no ./rates.config → the packaged biblion/rates.config
    # is used. (pytest's rootdir has no rates.config at the top level.)
    rates = config._load_rates()
    assert rates['openalex']['daily'] == 9500
    assert rates['s2']['rps'] == 5.0
    assert rates['ncbi']['rps'] == 8.0


def test_cwd_override_wins(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'rates.config').write_text(json.dumps({
        '_comment': 'ignored',
        's2': {'rps': 99, 'daily': 7},
    }))
    rates = config._load_rates()
    assert rates['s2'] == {'rps': 99.0, 'daily': 7}
    # Engines absent from the override keep their built-in defaults.
    assert rates['openalex']['daily'] == 9500


def test_comment_key_ignored(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'rates.config').write_text(json.dumps({
        '_comment': 'hello', 'ncbi': {'rps': 3},
    }))
    rates = config._load_rates()
    assert '_comment' not in rates
    assert rates['ncbi']['rps'] == 3.0
    # Partial entry: daily falls back to the built-in default (0).
    assert rates['ncbi']['daily'] == 0


def test_malformed_json_falls_back_to_defaults(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'rates.config').write_text('{ not valid json')
    rates = config._load_rates()
    assert rates['openalex']['daily'] == 9500   # defaults intact


def test_rate_for_unknown_engine_fallback(monkeypatch):
    monkeypatch.setattr(config, 'RATES', config._load_rates())
    r = config.rate_for('does_not_exist')
    assert r['rps'] > 0 and r['daily'] == 0


def test_rate_for_known_engine():
    monkeypatch_rates = config._load_rates()
    assert monkeypatch_rates['crossref']['rps'] == 5.0
