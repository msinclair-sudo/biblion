"""Smoke tests for the live `enrich` dashboard renderable.

These don't drive a real terminal; they assert _rich_dashboard builds a
valid Rich renderable from a QC snapshot and that it renders without error
at small and large console sizes (the overflow case is handled by Rich's
Live vertical_overflow='crop', exercised separately).
"""
from rich.console import Console

from biblion.__main__ import _rich_dashboard
from pathlib import Path


def _snap():
    return {
        'core': {
            'papers': 1000, 'with_doi': 950, 'with_oa': 60, 'with_s2': 990,
            'with_title': 1000, 'with_abstract': 600, 'with_year': 980,
            'with_venue': 820, 'with_authors': 999, 'seeds': 300, 'stubs': 700,
            'rejected': 0, 'retracted': 0, 'edges': 42, 'cit_count_rows': 1100,
            'pending_edges': 5000, 'conflicts': 17,
            # per-population coverage: seeds well-covered, stubs DOI-only.
            'seed_doi': 300, 'seed_oa': 40, 'seed_s2': 300, 'seed_title': 300,
            'seed_year': 295, 'seed_venue': 280, 'seed_authors': 299,
            'seed_abstract': 250,
            'stub_doi': 690, 'stub_oa': 20, 'stub_s2': 700,
        },
        'conflicts_by_field': [('authors', 10), ('year', 7)],
        'module_health': [
            {'module': 'enrich_metadata_oa', 'status': 'running',
             'last': '2026-05-30T08:00:00', 'message': 'ok',
             'counts': {'success': 3, 'noop': 5, 'orphaned': 2}},
            {'module': 'resolve_dois_s2', 'status': 'noop',
             'last': '2026-05-30T07:59:00', 'message': '',
             'counts': {'noop': 4}},
        ],
        'attempts': [('oa', 'succeeded', 65), ('oa', 'claimed', 5),
                     ('s2_live', 'succeeded', 300)],
    }


def _render(width, height, **kw):
    r = _rich_dashboard(_snap(), Path('/tmp/x.db'), uptime_s=90,
                        recent_errors=kw.get('errs', []),
                        log_dir=Path('/tmp/logs'), n_producers=4,
                        live_modules=kw.get('live_modules'))
    c = Console(width=width, height=height, force_terminal=True)
    with c.capture() as cap:
        c.print(r)
    return cap.get()


def test_renders_at_normal_size():
    out = _render(140, 60)
    assert 'biblion enrich' in out
    assert 'papers' in out                         # coverage-table row label
    # Corpus coverage is a seed-vs-stub table (not summed together).
    assert 'Corpus coverage' in out
    assert 'seeds' in out and 'stubs' in out      # the two count columns
    assert '300' in out and '700' in out          # papers row: seeds / stubs
    assert 'Graph' in out                          # 'Graph & flags'
    assert 'Conflicts' in out
    assert 'Enrichment attempts' in out
    # With no live_modules, the qc-history health table renders.
    assert 'Module health' in out
    # Conflict-by-field rows
    assert 'authors' in out
    # Graph stats
    assert 'pending edges' in out and 'cit_count rows' in out


def test_live_module_health_reflects_process_and_work():
    """The live health table derives status from process+work, not module_runs.
    A working module is labelled 'working' with its per-tick delta; an idle one
    'idle'; a dead one 'down'."""
    live = [
        # OA mid-batch: settled nothing THIS tick but has in-flight claims ->
        # must still read 'working', not 'idle'.
        {'module': 'enrich_metadata_oa', 'status': 'working', 'did': 0,
         'in_flight': 100, 'settled': 809, 'restarts': 0},
        {'module': 'resolve_dois_s2', 'status': 'idle', 'did': 0,
         'in_flight': 0, 'settled': 1224, 'restarts': 1},
        {'module': 'enrich_metadata_s2', 'status': 'down', 'did': 0,
         'in_flight': 0, 'settled': 1224, 'restarts': 3},
    ]
    out = _render(140, 60, live_modules=live)
    assert 'Module health' in out
    assert 'working' in out and 'idle' in out and 'down' in out
    assert 'in-flight' in out
    assert '100' in out                  # in-flight claim count shown
    # All three modules appear exactly once.
    for m in ('enrich_metadata_oa', 'resolve_dois_s2', 'enrich_metadata_s2'):
        assert out.count(m) == 1


def test_renders_in_short_window_without_error():
    # Rich crops internally; we only assert it produces output and doesn't raise.
    out = _render(80, 10)
    assert out.strip()


def test_error_count_surfaces():
    out = _render(100, 40, errs=[(1.0, 'enrich_metadata_oa exit 2 (#3)')])
    assert 'errors(10m): 1' in out
    assert 'last error' in out


# ---------------------------------------------------------------------------
# Live layout (daemons + pipeline + services) — the new dashboard
# ---------------------------------------------------------------------------

def _render_live(width, height):
    daemons = [
        {'role': 'writer', 'status': 'working', 'age': 1, 'restarts': 0,
         'stats': {'cycles': 41000, 'new_papers': 9000,
                   'updated_papers': 1200, 'new_citations': 30000}},
        {'role': 'compute', 'status': 'working', 'age': 0, 'restarts': 0,
         'stats': {'passes': 800, 'paper_jobs': 9000, 'edge_jobs': 30000}},
        {'role': 'dispatcher', 'status': 'working', 'age': 2, 'restarts': 1,
         'stats': {'dispatched': 1200, 'succeeded': 1100, 'failed': 40}},
        {'role': 'pending_resolver', 'status': 'stale', 'age': 47,
         'restarts': 0, 'stats': {'cycles': 12000, 'rows_scanned': 1200000,
                                  'actions_pushed': 90000}},
    ]
    pipeline = [
        {'stage': 'staged', 'depth': 1240, 'delta': 200,
         'owner': 'dispatcher', 'owner_status': 'working'},
        {'stage': 'write', 'depth': 310, 'delta': -90,
         'owner': 'compute', 'owner_status': 'working'},
        {'stage': 'promote', 'depth': 4000, 'delta': 0,
         'owner': 'pending_resolver', 'owner_status': 'stale'},
    ]
    services = [
        {'service': 'oa', 'in_flight': 100, 'settled': 12400,
         'did': 50, 'active': True},
        {'service': 's2_live', 'in_flight': 0, 'settled': 8200,
         'did': 0, 'active': False},
    ]
    producers = [
        {'module': 'resolve_pending_dois', 'status': 'idle', 'did': 0,
         'in_flight': 0, 'settled': 0, 'restarts': 0},
        {'module': 'materialize_ghost_stubs', 'status': 'working', 'did': 3,
         'in_flight': 0, 'settled': 12, 'restarts': 0},
    ]
    r = _rich_dashboard(_snap(), Path('/tmp/x.db'), uptime_s=90,
                        recent_errors=[], log_dir=Path('/tmp/logs'),
                        n_producers=2, daemons=daemons, pipeline=pipeline,
                        services=services, live_modules=producers)
    c = Console(width=width, height=height, force_terminal=True)
    with c.capture() as cap:
        c.print(r)
    return cap.get()


def test_live_layout_shows_daemons_pipeline_services():
    out = _render_live(160, 70)
    # Workers panel: every daemon role once, with the two distinct statuses.
    assert 'Workers' in out
    for role in ('writer', 'compute', 'dispatcher', 'pending_resolver'):
        assert role in out
    assert 'working' in out and 'stale' in out
    assert 'daemons:' in out and 'stale' in out          # header summary
    # Residual producers folded into the Workers panel (no separate panel).
    assert 'resolve_pending_dois' in out
    # Pipeline hero with a stage + depth.
    assert 'Pipeline' in out
    assert 'staged' in out and '1,240' in out
    # Merged Services panel: in-flight + cumulative succeeded together.
    assert 'Services' in out
    assert 'oa' in out and '100' in out and 'succeeded' in out
    # Corpus coverage as a seed-vs-stub table.
    assert 'Corpus coverage' in out
    assert 'seeds' in out and 'stubs' in out and 'Conflicts' in out


def test_live_layout_short_window_does_not_raise():
    # Rich crops internally; assert non-empty output without error.
    out = _render_live(80, 12)
    assert out.strip()
