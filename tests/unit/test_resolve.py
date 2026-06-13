"""
Unit tests for the pure resolver (biblion/merge/resolve.py).

No Redis, no DB — these pin the decided resolution rules from
docs/conflict_resolution_discussion.md (2026-05-31).
"""
import json

import pytest

from biblion.merge.resolve import (
    Observation, canonicalize, resolve, resolve_authors, parse_name,
    _canon_pub_type,
)


pytestmark = pytest.mark.unit


def ob(value, source, pub_type=None, raw=None):
    return Observation(value=value, raw=raw if raw is not None else value,
                       source=source, pub_type_hint=pub_type)


# ---------------------------------------------------------------------------
# Canonicalization
# ---------------------------------------------------------------------------

class TestCanonicalize:
    @pytest.mark.parametrize('a,b', [
        ('journal-article', 'JournalArticle'),
        ('journal article', 'journalarticle'),
        ('Journal-Article', 'journal_article'),
    ])
    def test_pub_type_variants_collapse(self, a, b):
        assert _canon_pub_type(a) == _canon_pub_type(b)

    def test_title_canon_key_folds_case_and_whitespace(self):
        # canonicalize is a COMPARISON KEY: case + whitespace folded so cosmetic
        # variants collapse. Display casing is preserved by the resolver, not here.
        assert canonicalize('title', '  Hello   World ') == 'hello world'
        assert canonicalize('title', 'HELLO WORLD') == \
            canonicalize('title', 'Hello World')

    def test_venue_canon_key_folds_case_and_whitespace(self):
        assert canonicalize('venue', 'Journal  of   Phycology') == \
            'journal of phycology'
        assert canonicalize('venue', 'PROCESS BIOCHEMISTRY') == \
            canonicalize('venue', 'Process Biochemistry')

    def test_authoritative_identity(self):
        assert canonicalize('year', 2020) == 2020
        assert canonicalize('doi', '10.1/x') == '10.1/x'


# ---------------------------------------------------------------------------
# Representational resolution
# ---------------------------------------------------------------------------

class TestRepresentational:
    def test_equal_after_canon_no_conflict(self):
        r = resolve('pub_type', [
            ob('journal-article', 's2'),
            ob('JournalArticle', 'openalex'),
        ])
        assert r.value == 'journalarticle'
        assert r.conflict is None

    def test_genuine_divergence_picks_trust_no_conflict(self):
        # Different strings, different trust -> trusted source wins; a confident
        # pick was made, so it is NOT a conflict.
        r = resolve('title', [
            ob('A Study of Algae', 's2'),
            ob('A Study of Seaweed', 'openalex'),
        ])
        assert r.value == 'A Study of Seaweed'   # openalex (rank 2) beats s2 (3)
        assert r.conflict is None

    def test_equal_trust_divergence_is_conflict(self):
        # Genuinely different strings from the SAME trust bucket -> no confident
        # winner -> unresolved conflict.
        r = resolve('title', [
            ob('A Study of Algae', 's2_search'),
            ob('A Study of Seaweed', 's2_batch'),
        ])
        assert r.conflict is not None
        assert r.conflict.field == 'title'


# ---------------------------------------------------------------------------
# Authoritative resolution
# ---------------------------------------------------------------------------

class TestAuthoritative:
    def test_trust_ordering(self):
        r = resolve('year', [
            ob(2019, 'ncbi'),
            ob(2020, 'openalex'),
            ob(2021, 's2'),
        ])
        assert r.value == 2020          # openalex highest-ranked here
        assert r.conflict is None       # lower-ranked disagreement is not a conflict

    def test_crossref_beats_openalex(self):
        r = resolve('venue', [
            ob('J. Phycol.', 'openalex'),
            ob('Journal of Phycology', 'crossref'),
        ], field_class={'venue': 'authoritative'})
        assert r.value == 'Journal of Phycology'

    def test_vor_beats_preprint_regardless_of_source(self):
        # preprint comes from the more-trusted source, but VoR rule wins first.
        r = resolve('year', [
            ob(2019, 'crossref', pub_type='preprint'),
            ob(2020, 's2', pub_type='journal-article'),
        ])
        assert r.value == 2020

    def test_equal_rank_disagreement_is_conflict(self):
        r = resolve('doi', [
            ob('10.1/a', 'openalex'),
            ob('10.1/b', 'openalex'),
        ])
        assert r.conflict is not None

    def test_observational_field_raises(self):
        with pytest.raises(ValueError):
            resolve('influential_cit_count', [ob(5, 's2')])


# ---------------------------------------------------------------------------
# Author parsing
# ---------------------------------------------------------------------------

class TestParseName:
    def test_keeps_raw_verbatim(self):
        n = parse_name('Smith, John')
        assert n.raw == 'Smith, John'
        assert n.tokens == frozenset({'smith', 'john'})
        assert n.full_words == 2

    def test_initial_counts_as_non_full(self):
        n = parse_name('J. Smith')
        assert n.tokens == frozenset({'j', 'smith'})
        assert n.full_words == 1            # 'smith' full, 'j' initial

    def test_glued_initials_split(self):
        n = parse_name('Smith, J.A.')
        assert n.tokens == frozenset({'smith', 'j', 'a'})

    def test_diacritics_normalized_in_tokens(self):
        n = parse_name("Sant'Anna, Celso")
        # comparison tokens are ascii-folded; raw keeps the original
        assert 'celso' in n.tokens
        assert n.raw == "Sant'Anna, Celso"


# ---------------------------------------------------------------------------
# Author completeness merge — the decided rules
# ---------------------------------------------------------------------------

def _authors(r):
    return json.loads(r.value)


class TestResolveAuthors:
    def test_initial_then_full_takes_full(self):
        r = resolve_authors([
            ob(json.dumps(['Smith, J.']), 's2'),
            ob(json.dumps(['Smith, John']), 'openalex'),
        ])
        assert _authors(r) == ['Smith, John']

    def test_full_then_initial_keeps_full(self):
        r = resolve_authors([
            ob(json.dumps(['Smith, John']), 'openalex'),
            ob(json.dumps(['Smith, J.']), 's2'),
        ])
        assert _authors(r) == ['Smith, John']

    def test_middle_initial_added(self):
        r = resolve_authors([
            ob(json.dumps(['Smith, John']), 's2'),
            ob(json.dumps(['Smith, John A.']), 'openalex'),
        ])
        assert _authors(r) == ['Smith, John A.']

    def test_initials_completed_to_full(self):
        r = resolve_authors([
            ob(json.dumps(['Smith, J. A.']), 's2'),
            ob(json.dumps(['Smith, John A.']), 'openalex'),
        ])
        assert _authors(r) == ['Smith, John A.']

    def test_contradicting_initials_kept_both(self):
        r = resolve_authors([
            ob(json.dumps(['Smith, John']), 'openalex'),
            ob(json.dumps(['Smith, R.']), 's2'),
        ])
        got = _authors(r)
        assert 'Smith, John' in got
        assert 'Smith, R.' in got
        assert len(got) == 2

    def test_reorder_aligns_by_family(self):
        r = resolve_authors([
            ob(json.dumps(['Smith, J.', 'Doe, A.']), 's2'),
            ob(json.dumps(['Doe, Anne', 'Smith, John']), 'openalex'),
        ])
        got = _authors(r)
        assert 'Smith, John' in got
        assert 'Doe, Anne' in got
        assert len(got) == 2

    def test_length_mismatch_keeps_longer(self):
        r = resolve_authors([
            ob(json.dumps(['Smith, John', 'Doe, Anne', 'Lee, Kim']), 'openalex'),
            ob(json.dumps(['Smith, J.', 'Doe, A.']), 's2'),
        ])
        got = _authors(r)
        assert len(got) == 3
        assert 'Smith, John' in got and 'Lee, Kim' in got


# ---------------------------------------------------------------------------
# editors — same order-tolerant author-list machinery as authors, dispatched
# via resolve(field='editors').
# ---------------------------------------------------------------------------

class TestResolveEditors:
    def test_editors_canonicalize_like_authors(self):
        # canonicalize routes 'editors' through the author-list canon (JSON).
        key = canonicalize('editors', json.dumps(['Ng, Pat', 'Roe, Sam']))
        assert json.loads(key) == ['Ng, Pat', 'Roe, Sam']

    def test_resolve_editors_merges_initial_to_full(self):
        r = resolve('editors', [
            ob(json.dumps(['Ng, P.']), 's2'),
            ob(json.dumps(['Ng, Pat']), 'openalex'),
        ])
        assert json.loads(r.value) == ['Ng, Pat']

    def test_resolve_editors_keeps_full_list(self):
        # Two editors in one observation, a partial second source: both survive,
        # initials upgraded to full names (same author-list rules as authors).
        r = resolve('editors', [
            ob(json.dumps(['Ng, Pat', 'Roe, Sam']), 'openalex'),
            ob(json.dumps(['Ng, P.']), 's2'),
        ])
        got = json.loads(r.value)
        assert 'Ng, Pat' in got and 'Roe, Sam' in got and len(got) == 2

    def test_editors_conflict_field_name(self):
        # An order-ambiguous editor list reports the conflict under 'editors'.
        r = resolve('editors', [
            ob(json.dumps(['Pat Ng', 'Sam Roe']), 'openalex'),
            ob(json.dumps(['Roe Sam', 'Ng Pat']), 's2'),
        ])
        if r.conflict is not None:
            assert r.conflict.field == 'editors'
