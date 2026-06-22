"""
Shadow-mode comparators — assert the new enrich path matches the old one
WITHOUT changing production behaviour. Phase 2 ships the needs comparator; later
phases add routing/dedup comparators here.

`sql_needs` is the ground truth: it runs each CANDIDATE_QUERIES entry's per-field
eligibility (the exact predicate claim_candidates / count_remaining use) and maps
hits to (service, field). The Reader must produce the same (service, field) set
per paper. Divergence is logged and counted (shadow:needs_mismatch), never raised
in production.
"""
from __future__ import annotations

import logging
from collections import defaultdict

_log = logging.getLogger(__name__)

NEEDS_MISMATCH_COUNTER = 'shadow:needs_mismatch'
ROUTING_MISMATCH_COUNTER = 'shadow:routing_mismatch'


def sql_needs(conn, paper_ids) -> dict:
    """Ground-truth {paper_id: {(service, field), ...}} from the SQL registry.

    For each module and each of its fields, run the candidate_sql wrapped in the
    same per-field eligibility predicate the claim flow uses, restricted to the
    sample. `FROM papers` in each candidate_sql resolves to the ATTACHed main_v3
    on a get_claims_connection.
    """
    from ..framework.claims import (
        CANDIDATE_QUERIES, _build_eligibility, _retry_cutoff_iso,
    )
    ids = [int(i) for i in paper_ids]
    out: dict[int, set] = {pid: set() for pid in ids}
    if not ids:
        return out
    retry_iso = _retry_cutoff_iso()
    placeholders = ', '.join('?' for _ in ids)
    for spec in CANDIDATE_QUERIES.values():
        service = spec['service']
        for f in spec['fields']:
            term, params = _build_eligibility(service, (f,), retry_iso)
            sql = (f"WITH base AS ({spec['candidate_sql']}) "
                   f"SELECT b.id FROM base b "
                   f"WHERE ({term}) AND b.id IN ({placeholders})")
            for r in conn.execute(sql, [*params, *ids]):
                out.setdefault(r['id'], set()).add((service, f))
    return out


def compare_needs(reader, paper_ids) -> dict:
    """Diff the Reader's needs against sql_needs for the given papers.

    Returns {paper_id: {'reader_only': set, 'sql_only': set}} for mismatches
    only (empty dict == perfect parity).
    """
    items = reader.build_items(paper_ids)
    reader_needs = {it.paper_id: it.needs for it in items}
    truth = sql_needs(reader._conn, paper_ids)
    mismatches: dict[int, dict] = {}
    for pid in set(reader_needs) | set(truth):
        a = reader_needs.get(pid, set())
        b = truth.get(pid, set())
        if a != b:
            mismatches[pid] = {'reader_only': a - b, 'sql_only': b - a}
    return mismatches


def assert_needs_parity(reader, paper_ids, cache=None) -> dict:
    """Shadow check: compare, log + count any mismatch, return the mismatch map.
    Never raises — production observes; tests assert on the return value."""
    mismatches = compare_needs(reader, paper_ids)
    if mismatches and cache is not None:
        cache.incr_counter(NEEDS_MISMATCH_COUNTER, len(mismatches))
    for pid, d in mismatches.items():
        _log.warning("needs mismatch paper=%s reader_only=%s sql_only=%s",
                     pid, sorted(d['reader_only']), sorted(d['sql_only']))
    return mismatches


# ---------------------------------------------------------------------------
# Routing comparator (Phase 3). The solver should cover EXACTLY each paper's
# needs at the (service, field) grain — no need dropped, none invented — and
# never route an endpoint to a paper it isn't eligible for. With finite budgets
# coverage may legitimately fall short (deferral); pass budgets=None to assert
# full-coverage parity.
# ---------------------------------------------------------------------------

def routed_coverage(decisions, catalogue, needs_by_id) -> dict:
    """{paper_id: set((service, field))} the decisions actually settle.

    An endpoint fetches all its fields, but only the ones a paper still NEEDS
    count toward coverage (the rest are no-ops on an already-filled column), so
    coverage is `settles ∩ needs` — never a superset of needs.
    """
    cov: dict[int, set] = defaultdict(set)
    for name, pids in decisions:
        settles = catalogue[name].settles
        for pid in pids:
            cov[pid] |= (settles & needs_by_id.get(pid, frozenset()))
    return cov


def compare_routing(reader, paper_ids, catalogue, budgets=None) -> tuple:
    """Return (decisions, mismatches). mismatches[pid] is set for any paper with
    an uncovered need, or routed to an endpoint it isn't eligible for."""
    from .solver import solve
    items = reader.build_items(paper_ids)
    by_id = {it.paper_id: it for it in items}
    needs_by_id = {pid: it.needs for pid, it in by_id.items()}
    decisions = solve(items, catalogue, budgets)
    cov = routed_coverage(decisions, catalogue, needs_by_id)

    mismatches: dict[int, dict] = {}
    for pid, it in by_id.items():
        uncovered = it.needs - cov.get(pid, set())
        if uncovered:
            mismatches[pid] = {'uncovered': uncovered}
    # Over-route: any endpoint routed to a paper whose needs it can't settle.
    for name, pids in decisions:
        ep = catalogue[name]
        for pid in pids:
            it = by_id.get(pid)
            if it is None:
                continue
            if not (ep.precond(it.cols) and (ep.settles & it.needs)):
                mismatches.setdefault(pid, {}).setdefault(
                    'ineligible_endpoints', set()).add(name)
    return decisions, mismatches


def assert_routing_parity(reader, paper_ids, catalogue, cache=None) -> dict:
    """Shadow check with unlimited budget: log + count any routing mismatch."""
    _decisions, mismatches = compare_routing(
        reader, paper_ids, catalogue, budgets=None)
    if mismatches and cache is not None:
        cache.incr_counter(ROUTING_MISMATCH_COUNTER, len(mismatches))
    for pid, d in mismatches.items():
        _log.warning("routing mismatch paper=%s %s", pid, d)
    return mismatches
