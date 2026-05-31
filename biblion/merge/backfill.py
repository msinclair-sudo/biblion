"""
One-time backfill: synthesize `field_observations` from data already on disk
(the incumbent value in `papers` + the loser value in `field_conflicts`), then
re-resolve each affected field. NO API calls — it only mines what the old
first-write-wins writer already captured.

Why this works at all: the old writer kept the FIRST value in `papers` and
logged every later disagreeing value to `field_conflicts(proposed_value,
proposed_source)`. So for a conflicted field we have two values on disk — they
just were never reconciled. This pass turns each into an Observation and runs
the new class-based resolve().

The honest limit (documented in conflict_resolution_discussion.md): we know the
*loser's* source (`proposed_source`) but NOT the source that produced the
incumbent value in `papers`. For representational fields (authors, venue,
pub_type, title) that doesn't matter — resolution there is by canonicalization
/ completeness, not trust. For authoritative fields (year, ids, dates) we can
recover the candidate values but the incumbent's source is unknown, so we tag
it with the '_incumbent' bucket which sorts as least-trusted; a real re-call is
the only way to get perfect source attribution there. This pass is therefore
*fully correct* for authors and the other representational fields, and
*best-effort* for authoritative ones.

Idempotent: re-running re-derives the same observations (ON CONFLICT upsert) and
re-resolves to the same values.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field as dc_field
from datetime import datetime, timezone

from ..db import _source_bucket
from .resolve import Observation, resolve, canonicalize
from .writer import _RESOLVED_FIELDS, _COALESCE_FIELDS


# Source tag for the value already sitting in papers, whose true source the old
# schema never recorded. Not in source_trust, so it resolves to the unknown
# rank (worse than every known source) — a non-preprint known source will beat
# it, which is the safe default.
INCUMBENT_SOURCE = '_incumbent'


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class BackfillStats:
    papers_scanned:        int = 0
    observations_written:  int = 0
    fields_reresolved:     int = 0
    values_changed:        int = 0
    conflicts_cleared:     int = 0     # conflict rows that no longer represent
                                       # a genuine disagreement post-resolution
    conflicts_remaining:   int = 0
    by_field_changed:      dict = dc_field(default_factory=dict)


# Fields we can meaningfully backfill: the resolved set, minus pure identifiers
# where a "conflict" usually means two genuinely different IDs (handled by the
# multi-hit resolver, not field resolution). We still backfill identifier
# observations so the audit trail exists, but value changes there are reported
# separately and never auto-applied unless --apply-identifiers is set.
_IDENTIFIER_FIELDS = ('doi', 's2_id', 'oa_id', 'pubmed_id', 'pubmed_central_id')

# Version-sensitive fields: a year/date "conflict" is most often the preprint-
# vs-version-of-record gap (the preprint carries an earlier year). Resolving
# these by source trust BEFORE preprint/VoR detection exists would blindly pick
# a year on shaky grounds. So, like identifiers, we record their observations
# for the audit trail but do NOT overwrite papers until that detection lands
# (gated behind --apply-version-fields).
_VERSION_SENSITIVE_FIELDS = ('year', 'publication_date')

_BACKFILL_FIELDS = tuple(f for f in _RESOLVED_FIELDS)


def _papers_columns(conn) -> set:
    return {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}


def _iter_conflicted(conn):
    """Yield (paper_id, field, [(value, source), ...]) for every paper/field
    that has at least one logged conflict, pairing the incumbent papers value
    with each logged loser value."""
    cols = _papers_columns(conn)
    rows = conn.execute(
        "SELECT DISTINCT paper_id, field FROM field_conflicts "
        "WHERE field IN ({}) ".format(
            ','.join('?' for _ in _BACKFILL_FIELDS)
        ),
        _BACKFILL_FIELDS,
    ).fetchall()
    for r in rows:
        pid, fld = r['paper_id'], r['field']
        if fld not in cols:
            continue
        incumbent = conn.execute(
            f"SELECT {fld} AS v FROM papers WHERE id = ?", (pid,)
        ).fetchone()
        if incumbent is None:
            continue
        losers = conn.execute(
            "SELECT proposed_value, proposed_source FROM field_conflicts "
            "WHERE paper_id = ? AND field = ?", (pid, fld),
        ).fetchall()
        candidates = []
        if incumbent['v'] is not None:
            candidates.append((incumbent['v'], INCUMBENT_SOURCE))
        for lo in losers:
            if lo['proposed_value'] is not None:
                candidates.append((lo['proposed_value'], lo['proposed_source']))
        if candidates:
            yield pid, fld, candidates


def _to_observations(field, candidates) -> list:
    """Build resolve.Observation list from (value, raw_source) candidates.

    `proposed_value` in field_conflicts was stored via str(), so an authors
    value is a JSON string and a year is its decimal string — both round-trip
    through canonicalize() the same way the live writer's raw values do.
    """
    obs = []
    for raw, raw_source in candidates:
        canon = canonicalize(field, raw)
        obs.append(Observation(
            value=canon,
            raw=str(raw),
            source=_source_bucket(raw_source) if raw_source != INCUMBENT_SOURCE
                   else INCUMBENT_SOURCE,
            pub_type_hint=None,     # not recoverable from the conflict log
        ))
    return obs


def run_backfill(conn, *, apply: bool = False,
                 apply_identifiers: bool = False,
                 apply_version_fields: bool = False) -> BackfillStats:
    """Backfill observations + re-resolve from existing papers/field_conflicts.

    apply=False (default) is a DRY RUN: it computes what would change and
    returns stats, writing nothing. apply=True writes the synthesized
    observations and updates papers with re-resolved values.

    Identifier fields are never auto-applied unless apply_identifiers=True,
    because an identifier "conflict" is more often two distinct works (the
    multi-hit resolver's job) than a representational variant.

    Version-sensitive fields (year, publication_date) are never auto-applied
    unless apply_version_fields=True, because a year conflict is usually the
    preprint-vs-version-of-record gap and should be arbitrated by the (not yet
    built) preprint/VoR detection, not by blind source trust.
    """
    stats = BackfillStats()
    ts = _now()
    seen_papers = set()

    for pid, fld, candidates in _iter_conflicted(conn):
        seen_papers.add(pid)
        obs = _to_observations(fld, candidates)
        if not obs:
            continue

        if apply:
            for o in obs:
                src = o.source
                conn.execute("""
                    INSERT INTO field_observations
                        (paper_id, field, value, raw_value, source,
                         pub_type_hint, observed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(paper_id, field, source) DO UPDATE SET
                        value = excluded.value,
                        raw_value = excluded.raw_value,
                        observed_at = excluded.observed_at
                """, (pid, fld, o.value, o.raw, src, None, ts))
                stats.observations_written += 1

        res = resolve(fld, obs)
        stats.fields_reresolved += 1

        current = conn.execute(
            f"SELECT {fld} AS v FROM papers WHERE id = ?", (pid,)
        ).fetchone()['v']

        # Compare canonical forms so e.g. a re-canonicalized pub_type that only
        # differs cosmetically doesn't read as a change.
        new_val = res.value
        changed = _values_differ(fld, current, new_val)

        is_identifier = fld in _IDENTIFIER_FIELDS
        is_version_sensitive = fld in _VERSION_SENSITIVE_FIELDS
        will_write = apply
        if is_identifier and not apply_identifiers:
            will_write = False
        if is_version_sensitive and not apply_version_fields:
            will_write = False

        if changed:
            stats.values_changed += 1
            stats.by_field_changed[fld] = stats.by_field_changed.get(fld, 0) + 1
            if will_write and new_val is not None:
                conn.execute(
                    f"UPDATE papers SET {fld} = ?, updated_at = ? WHERE id = ?",
                    (new_val, ts, pid),
                )

        if res.conflict is None:
            stats.conflicts_cleared += 1
        else:
            stats.conflicts_remaining += 1

    stats.papers_scanned = len(seen_papers)
    if apply:
        conn.commit()
    return stats


def _values_differ(field, a, b) -> bool:
    if a is None and b is None:
        return False
    if a is None or b is None:
        return True
    if field == 'authors':
        # Compare as parsed lists so formatting-only diffs don't count.
        try:
            return json.loads(canonicalize('authors', a)) != \
                   json.loads(canonicalize('authors', b))
        except Exception:
            return str(a) != str(b)
    ca = canonicalize(field, a)
    cb = canonicalize(field, b)
    return str(ca) != str(cb)
