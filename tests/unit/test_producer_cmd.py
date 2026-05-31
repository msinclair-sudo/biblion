"""Regression guard for the producer subprocess command string.

The `enrich` / `advanced daemon` / `advanced start` supervisors spawn each
producer as `python -m biblion advanced run <target> --loop`. During the
citgraphv3 -> biblion rename, `run` moved under `advanced`, but the spawn
sites still emitted a bare top-level `run` -- so every producer subprocess
died with argparse exit code 2 and the supervisor crash-looped it.

These tests pin the argv shape AND prove the CLI parser accepts it, so a
future rename that moves/renames the subcommand fails here instead of in a
live `enrich` run.
"""
import pytest

from biblion.__main__ import _producer_cmd, _build_parser


def test_producer_cmd_uses_advanced_run():
    cmd = _producer_cmd('/tmp/x.db', 'redis://localhost:6379/0',
                        'enrich_metadata_oa')
    # `advanced` must immediately precede `run` -- a bare top-level `run`
    # is the exact bug this guards against.
    assert 'advanced' in cmd
    assert cmd[cmd.index('advanced') + 1] == 'run'
    assert cmd.index('advanced') < cmd.index('enrich_metadata_oa')
    assert cmd[-1] == '--loop'


def test_producer_cmd_forwards_db_redis_and_target():
    cmd = _producer_cmd('/tmp/corpus.db', 'redis://localhost:6379/15',
                        'resolve_dois_s2')
    assert cmd[:4] == ['python', '-u', '-m', 'biblion']
    assert '--db' in cmd and cmd[cmd.index('--db') + 1] == '/tmp/corpus.db'
    assert cmd[cmd.index('--redis-url') + 1] == 'redis://localhost:6379/15'
    assert 'resolve_dois_s2' in cmd


def test_producer_cmd_force_flag_optional():
    assert '--force' not in _producer_cmd('/tmp/x.db', 'r', 'm')
    assert '--force' in _producer_cmd('/tmp/x.db', 'r', 'm', force=True)


@pytest.mark.parametrize('target', [
    'enrich_metadata_oa', 'enrich_metadata_s2',
    'resolve_dois_oa', 'resolve_dois_s2',
])
def test_spawned_argv_is_accepted_by_the_cli_parser(target):
    """The argv the supervisor spawns must actually parse.

    This is the assertion that would have caught the original bug: the old
    bare-`run` argv raised SystemExit(2) here. We drop the leading
    `python -u -m biblion` wrapper and feed the rest to biblion's own parser.
    """
    cmd = _producer_cmd('/tmp/x.db', 'redis://localhost:6379/0', target)
    argv = cmd[4:]   # strip 'python', '-u', '-m', 'biblion'
    args = _build_parser().parse_args(argv)
    assert args.cmd == 'advanced'
    assert args.advanced_cmd == 'run'
    assert args.target == target
    assert args.loop is True
