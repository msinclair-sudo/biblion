"""
Solver — turns WorkItems + the endpoint catalogue into routing decisions.

Gate 1 (greedy max-coverage): per paper, choose a minimal set of eligible
endpoints covering all its (service, field) needs, preferring the endpoint that
settles the most still-uncovered needs in one call. Because needs are
service-keyed, each need maps to a definite endpoint; greedy only collapses the
case where two endpoints of the SAME service settle the same (service, field)
(e.g. resolve_dois_s2 vs resolve_dois_via_s2id) — it picks one, never drops a
need.

Gate 2 (provider/budget): cap how many provider calls each round can spend.
`budgets` maps provider -> remaining calls (None = unlimited). Over-budget papers
are deferred (dropped from this round's decisions) and logged, never silently
swallowed.

A RouteDecision is (endpoint_name, [paper_ids]).
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict

_log = logging.getLogger(__name__)


def _tie_key(ep):
    """Deterministic tie-break among endpoints covering equal need counts:
    prefer the larger batch (cheaper per paper), then the name for stability."""
    return (ep.batch, ep.name)


def cover_one(item, catalogue) -> list:
    """Gate 1 for a single item: return the endpoint names that cover its needs.

    Greedy set-cover over service-keyed needs. Every need is coverable by
    construction (it came from an endpoint whose precondition holds), so this
    terminates with full coverage.
    """
    needs = set(item.needs)
    if not needs:
        return []
    cands = [ep for ep in catalogue.values()
             if ep.precond(item.cols) and (ep.settles & needs)]
    chosen: list[str] = []
    while needs:
        best = None
        best_gain = 0
        for ep in cands:
            gain = len(ep.settles & needs)
            if gain == 0:
                continue
            if (gain > best_gain or
                    (gain == best_gain and best is not None
                     and _tie_key(ep) > _tie_key(best))):
                best, best_gain = ep, gain
        if best is None:
            # No (in-catalogue) endpoint can cover the leftover needs. With a
            # filtered catalogue (the dispatcher solves over only its endpoints)
            # this is expected — e.g. a ghost's broad-hop need has no dispatched
            # endpoint. Debug, not warning.
            _log.debug("solver: uncovered needs for paper=%s: %s",
                       item.paper_id, sorted(needs))
            break
        chosen.append(best.name)
        needs -= best.settles
    return chosen


def _apply_budget(routed, catalogue, budgets) -> list:
    """Gate 2: cap per-provider calls. Returns the final RouteDecision list."""
    if not budgets:
        return [(name, pids) for name, pids in routed.items() if pids]

    out: list = []
    used_calls: dict[str, int] = defaultdict(int)
    # Deterministic order so budget is spent predictably across endpoints.
    for name in sorted(routed):
        pids = routed[name]
        if not pids:
            continue
        ep = catalogue[name]
        remaining = budgets.get(ep.provider)
        if remaining is None:
            out.append((name, pids))
            continue
        avail_calls = max(0, remaining - used_calls[ep.provider])
        avail_papers = avail_calls * ep.batch
        if avail_papers <= 0:
            _log.info("solver: %s deferred — %s budget exhausted (%d papers)",
                      name, ep.provider, len(pids))
            continue
        take = pids[:avail_papers]
        out.append((name, take))
        used_calls[ep.provider] += math.ceil(len(take) / ep.batch)
        if len(take) < len(pids):
            _log.info("solver: %s capped %d/%d by %s budget",
                      name, len(take), len(pids), ep.provider)
    return out


def solve(items, catalogue, budgets=None) -> list:
    """Route a batch of WorkItems. Returns [(endpoint_name, [paper_ids]), ...]."""
    routed: dict[str, list] = defaultdict(list)
    for item in items:
        for ep_name in cover_one(item, catalogue):
            routed[ep_name].append(item.paper_id)
    return _apply_budget(routed, catalogue, budgets)
