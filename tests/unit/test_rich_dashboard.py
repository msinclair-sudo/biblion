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
            'with_venue': 820, 'with_authors': 999, 'seeds': 0, 'stubs': 0,
            'rejected': 0, 'edges': 42, 'cit_count_rows': 1100,
            'pending_edges': 5000, 'conflicts': 17,
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
    assert 'papers' in out and '1,000' in out
    # Every section from the full QC report must be present.
    assert 'Identifiers' in out
    assert 'Metadata' in out
    assert 'Flags' in out
    assert 'Graph' in out
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
