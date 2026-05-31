"""
Declarative, class-based field resolution.

The merge writer records every field it observes into `field_observations`
(one row per paper/field/source), then asks this module for the canonical
value. Resolution keys on a field's *class* and a source *trust ordering* —
never on `(field, source)` identity — so adding a source is one row in
`source_trust` and adding a field is one row in `field_class`, not a new code
path. See docs/conflict_resolution_discussion.md.

Three classes:

  representational  same fact, different encoding. Canonicalize (case +
                    whitespace + punctuation folded), then compare. Cosmetic
                    differences collapse; a genuine post-canonicalization
                    difference is settled by trust. (authors / venue /
                    pub_type / title)
  authoritative     single correct value from a rankable source. Apply the
                    "prefer version-of-record over preprint" rule FIRST, then
                    argmin by trust rank. (identifiers / year /
                    publication_date / is_open_access)
  observational     no single truth — kept multi-valued elsewhere
                    (citation_counts). resolve() raises if asked to collapse
                    one, as a guard.

A `Conflict` is reported ONLY when resolution cannot pick a confident winner —
i.e. two equal-trust sources still disagree, or an author name's order is
genuinely ambiguous. A divergence that trust (or canonicalization) settles is
resolved, not a conflict.

Everything here is pure: inputs in, (value, conflict) out, no DB access. The
writer supplies the loaded field_class / source_trust maps (falling back to
the module defaults below when a DB wasn't seeded, e.g. a bare test).
"""
from __future__ import annotations

import json
import re
import unicodedata
from typing import Iterable, NamedTuple, Optional


# Defaults mirror db._FIELD_CLASS_SEED / _SOURCE_TRUST_SEED so the resolver is
# usable without a DB round-trip. The DB copy wins when provided.
DEFAULT_FIELD_CLASS = {
    'authors': 'representational',
    'venue': 'representational',
    'pub_type': 'representational',
    'title': 'representational',
    'doi': 'authoritative',
    's2_id': 'authoritative',
    'oa_id': 'authoritative',
    'pubmed_id': 'authoritative',
    'pubmed_central_id': 'authoritative',
    'year': 'authoritative',
    'publication_date': 'authoritative',
    'is_open_access': 'authoritative',
    'influential_cit_count': 'observational',
}

DEFAULT_SOURCE_TRUST = {
    'crossref': 1, 'openalex': 2, 's2': 3, 'ncbi': 4, 'seed': 5,
}

# Trust rank for an unknown bucket — worse than every seeded source so a
# surprise source never silently outranks a known one.
_UNKNOWN_RANK = 999


class Observation(NamedTuple):
    """One source's view of one field. `value` is the canonical form, `raw`
    the as-observed string, `source` the trust BUCKET (already mapped), and
    `pub_type_hint` the observing record's pub_type (for the VoR rule)."""
    value: object
    raw: Optional[str]
    source: str
    pub_type_hint: Optional[str] = None


class Conflict(NamedTuple):
    """A genuine UNRESOLVED disagreement worth logging — emitted only when no
    confident winner could be picked (equal-trust tie, or order-ambiguous
    authors). `loser_*` identify a representative rejected observation."""
    field: str
    winner_value: object
    loser_value: object
    loser_source: str


class Resolution(NamedTuple):
    value: object
    conflict: Optional['Conflict']


# ---------------------------------------------------------------------------
# Canonicalization (the representational comparison key)
# ---------------------------------------------------------------------------

_WS = re.compile(r'\s+')
_DIACRITIC = re.compile(r'[̀-ͯ]')


def _canon_pub_type(v) -> Optional[str]:
    """lowercase, strip punctuation/space. Collapses 'journal-article' vs
    'JournalArticle' vs 'journal article'. (Moved here from merge.writer; the
    writer imports it from this module.)"""
    if v is None:
        return None
    s = str(v).strip().lower()
    return s.replace('-', '').replace('_', '').replace(' ', '')


def _canon_ws(v) -> Optional[str]:
    """Trim, collapse whitespace, casefold — the COMPARISON key for
    title/venue, so 'PROCESS BIOCHEMISTRY' and 'Process Biochemistry' (case +
    whitespace only) compare equal and don't register as a conflict. The
    resolver keeps a nicely-cased display string separately; this is for
    equality only."""
    if v is None:
        return None
    return _WS.sub(' ', str(v).strip()).casefold()


def canonicalize(field: str, value):
    """Return the canonical COMPARISON key for a field.

    title/venue fold case + whitespace; pub_type strips punctuation/case;
    authors -> canonical JSON list; authoritative fields are their own key
    (identity). For representational fields this is a comparison key — the
    resolver keeps a separate, nicely-cased display string (see
    _resolve_representational); pub_type has no meaningful display variant so
    its canonical form is also what gets stored.
    """
    if value is None:
        return None
    if field == 'pub_type':
        return _canon_pub_type(value)
    if field == 'authors':
        return _canon_authors_single(value)
    if field in ('title', 'venue'):
        # NOTE: venue identity is ultimately ISSN-keyed (later step); this is
        # the cheap string canon that stops cosmetic conflicts from logging.
        return _canon_ws(value)
    return value


# ---------------------------------------------------------------------------
# Author parsing + token-set merge
# ---------------------------------------------------------------------------
#
# Decided rules (docs/conflict_resolution_discussion.md, 2026-05-31 + refinement):
#   match           : order-INDEPENDENT, initial-compatible token-set match.
#                     {h,chang} ~ {haixing,chang} ~ {chang,haixing} = same person.
#   keep            : the fullest observed STRING verbatim (most full-word
#                     tokens, then length). We do NOT reformat or reorder it.
#   order ambiguity : a name of >=2 full words (no comma/initial anchor) seen in
#                     DIFFERENT orders across sources -> order unknowable. Emit a
#                     conflict, keep incumbent, store variants. Do NOT guess.
#   contradiction   : token sets that don't match (different given name) ->
#                     different people; keep BOTH.
#   mis-association : a list sharing ZERO tokens with the incumbent is upstream
#                     corruption -> skip it (don't merge).
#   surname/order   : NOT inferred from other sources or the DB (collisions +
#                     cultural order differences). Venue-based resolution later.


def _norm_token(tok: str) -> str:
    """Lowercase, strip punctuation/diacritics; keep letters/digits only."""
    t = unicodedata.normalize('NFKD', str(tok))
    t = _DIACRITIC.sub('', t)
    t = t.lower().strip().strip('.').strip()
    return re.sub(r'[^\w]', '', t)


def _name_tokens(raw: str) -> tuple:
    """Tokenize one author string into normalized tokens, order preserved.
    A comma is just a separator here (order handled elsewhere)."""
    if raw is None:
        return ()
    parts = re.split(r'[\s,.]+', str(raw).strip())
    return tuple(t for t in (_norm_token(p) for p in parts) if t)


def _is_initial(tok: str) -> bool:
    return len(tok) == 1


class _Author(NamedTuple):
    """One observed author: verbatim display string + normalized token set
    (for matching) + count of full-word (non-initial) tokens."""
    raw: str
    tokens: frozenset
    full_words: int
    ntokens: int


def parse_name(raw: str) -> Optional['_Author']:
    """Parse one author string into an _Author (verbatim raw + token set)."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    toks = _name_tokens(s)
    if not toks:
        return None
    full = sum(1 for t in toks if not _is_initial(t))
    return _Author(raw=s, tokens=frozenset(toks), full_words=full,
                   ntokens=len(toks))


def _same_person(a: '_Author', b: '_Author') -> bool:
    """Order-independent, initial-compatible token-set match.

    Same person if every token of the smaller set finds a partner in the
    larger that is either equal or an initial of the other's first letter
    (greedy one-to-one). 'Chang Haixing' ~ 'Haixing Chang' ~ 'H. Chang';
    'Chang Wenjuan' is NOT 'Chang Haixing'."""
    if not a.tokens or not b.tokens:
        return False
    small, large = (a, b) if a.ntokens <= b.ntokens else (b, a)
    large_tokens = list(large.tokens)
    used = [False] * len(large_tokens)
    for t in small.tokens:
        hit = None
        for i, lt in enumerate(large_tokens):           # exact match first
            if not used[i] and lt == t:
                hit = i
                break
        if hit is None:                                  # then initial-compatible
            for i, lt in enumerate(large_tokens):
                if used[i]:
                    continue
                if lt[:1] == t[:1] and (_is_initial(lt) or _is_initial(t)):
                    hit = i
                    break
        if hit is None:
            return False
        used[hit] = True
    return True


def _fuller(a: '_Author', b: '_Author') -> '_Author':
    """Pick the fuller display string: most full-word tokens, then length."""
    return a if (a.full_words, len(a.raw)) >= (b.full_words, len(b.raw)) else b


def _order_ambiguous(a: '_Author', b: '_Author') -> bool:
    """True if two matched names differ only in ORDER and the order is
    genuinely unknowable: both >=2 full words (no initial anchor), same token
    set, presented in a different sequence."""
    if a.full_words < 2 or b.full_words < 2:
        return False
    at, bt = _name_tokens(a.raw), _name_tokens(b.raw)
    if frozenset(at) != frozenset(bt):
        return False
    return at != bt


def _coerce_author_list(value) -> Optional[list]:
    """Parse an authors observation (JSON string or python list) into _Author."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            raw_list = json.loads(value)
        except (ValueError, TypeError):
            raw_list = [value]
    else:
        raw_list = value
    if not isinstance(raw_list, list):
        return None
    out = []
    for item in raw_list:
        a = parse_name(item if isinstance(item, str) else str(item))
        if a is not None:
            out.append(a)
    return out


def _canon_authors_single(value) -> Optional[str]:
    """Canonicalize ONE author-list observation to a stable JSON string.

    Per the 'keep verbatim' decision we do not reformat names; this just
    re-serializes the parsed display strings so equal lists compare equal
    regardless of source whitespace/JSON spacing."""
    names = _coerce_author_list(value)
    if names is None:
        return None
    return json.dumps([a.raw for a in names], separators=(',', ':'))


def _author_tokens(names: list) -> frozenset:
    """Union of all tokens across a name list — used to detect a list entirely
    unrelated to the incumbent (upstream mis-association)."""
    out = set()
    for a in names:
        out |= set(a.tokens)
    return frozenset(out)


def resolve_authors(observations: Iterable[Observation]) -> Resolution:
    """Resolve an authors field from per-source observations.

    1. Parse each observation into a list of _Author.
    2. Drop any list sharing ZERO tokens with the longest list (upstream
       mis-association — not an observation of this paper).
    3. Use the longest surviving list as base; fold each other list in by
       order-independent token-set matching, keeping the fuller display string
       per matched author and appending genuinely new authors.
    4. If any matched pair is order-ambiguous (>=2 full words, same tokens,
       different sequence), record a conflict and keep the INCUMBENT list
       verbatim rather than guessing order.
    """
    lists = []
    for ob in observations:
        names = _coerce_author_list(ob.raw if ob.raw is not None else ob.value)
        if names:
            lists.append(names)
    if not lists:
        return Resolution(None, None)

    lists.sort(key=len, reverse=True)        # longest first = base / reference
    base_names = lists[0]
    base_tokens = _author_tokens(base_names)

    others = []
    for other in lists[1:]:
        ot = _author_tokens(other)
        if base_tokens and ot and not (base_tokens & ot):
            continue                          # mis-association — skip
        others.append(other)

    result = list(base_names)
    ambiguous = False
    for other in others:
        for inc in other:
            matched = None
            for i, cur in enumerate(result):
                if _same_person(cur, inc):
                    matched = i
                    break
            if matched is None:
                result.append(inc)            # distinct person
                continue
            if _order_ambiguous(result[matched], inc):
                ambiguous = True
                continue                      # keep incumbent string, don't reorder
            result[matched] = _fuller(result[matched], inc)

    value = json.dumps([a.raw for a in result], separators=(',', ':'))
    conflict = None
    if ambiguous:
        value = json.dumps([a.raw for a in base_names], separators=(',', ':'))
        conflict = Conflict('authors', value, None, 'order_ambiguous')
    return Resolution(value, conflict)


# ---------------------------------------------------------------------------
# The resolver
# ---------------------------------------------------------------------------

def _trust_rank(source_bucket: str, trust: dict) -> int:
    return trust.get(source_bucket, _UNKNOWN_RANK)


def _is_preprint(pub_type_hint: Optional[str]) -> bool:
    return _canon_pub_type(pub_type_hint) == 'preprint'


def resolve(field: str,
            observations: Iterable[Observation],
            field_class: Optional[dict] = None,
            source_trust: Optional[dict] = None) -> Resolution:
    """Resolve the canonical value of `field` from its observations.

    Returns Resolution(value, conflict). `conflict` is non-None ONLY when a
    confident winner could not be picked: equal-trust authoritative/
    representational disagreement, or order-ambiguous authors.
    """
    field_class = field_class or DEFAULT_FIELD_CLASS
    source_trust = source_trust or DEFAULT_SOURCE_TRUST
    obs = [o for o in observations if o.value is not None or o.raw is not None]
    if not obs:
        return Resolution(None, None)

    klass = field_class.get(field, 'authoritative')

    if klass == 'observational':
        raise ValueError(
            f"resolve() called on observational field {field!r}; "
            f"observational values are kept multi-valued, not collapsed."
        )

    if field == 'authors':
        return resolve_authors(obs)

    if klass == 'representational':
        return _resolve_representational(field, obs, source_trust)

    return _resolve_authoritative(field, obs, source_trust)


def _resolve_representational(field, obs, source_trust) -> Resolution:
    """Canonicalize all; if they agree after canonicalization, done.

    If canonical keys genuinely differ, trust ordering decides the winner — a
    confident pick, NOT a conflict. A conflict is reported ONLY when the top
    two are equal-trust and still differ.

    For pub_type the canonical key IS the stored value (no display variant).
    For title/venue the stored value is the best display string (most-trusted
    source; tie-break to the longer string, preserving the unabbreviated form).
    """
    use_canon_as_value = (field == 'pub_type')

    def _display(o):
        if use_canon_as_value:
            return canonicalize(field, o.value if o.value is not None else o.raw)
        v = o.raw if o.raw is not None else o.value
        return None if v is None else str(v)

    canon = [(canonicalize(field, o.value if o.value is not None else o.raw),
              _display(o), o)
             for o in obs]
    canon = [(c, d, o) for c, d, o in canon if c is not None]
    if not canon:
        return Resolution(None, None)

    distinct_keys = {c for c, _, _ in canon}
    if len(distinct_keys) <= 1:
        # Same value up to canonicalization. Resolved — keep the best display.
        return Resolution(_best_display(canon, source_trust), None)

    ranked = sorted(canon, key=lambda cdo: _trust_rank(cdo[2].source, source_trust))
    winner_key, winner_display, winner_ob = ranked[0]
    winner_rank = _trust_rank(winner_ob.source, source_trust)

    conflict = None
    for c, d, o in ranked[1:]:
        if c == winner_key:
            continue
        if _trust_rank(o.source, source_trust) == winner_rank:
            conflict = Conflict(field, winner_display, d, o.source)
        break   # first differing value decides; lower-trust loss is not a conflict
    return Resolution(winner_display, conflict)


def _best_display(canon, source_trust) -> str:
    """Among (key, display, obs) sharing a comparison key, pick the display
    string from the most-trusted source; tie-break to the longer string (keeps
    the unabbreviated/proper-cased form)."""
    ranked = sorted(
        canon,
        key=lambda cdo: (_trust_rank(cdo[2].source, source_trust),
                         -len(cdo[1] or '')),
    )
    return ranked[0][1]


def _resolve_authoritative(field, obs, source_trust) -> Resolution:
    """VoR rule first, then trust argmin. Conflict iff equally-top-ranked
    same-role observations disagree."""
    # 1. Version-of-record preference: if any non-preprint observation exists,
    #    restrict to non-preprints. (Today pub_type_hint is the record's own
    #    pub_type; later it reflects the work-version role.)
    non_preprint = [o for o in obs if not _is_preprint(o.pub_type_hint)]
    pool = non_preprint if non_preprint else obs

    # 2. argmin by trust rank.
    pool = sorted(pool, key=lambda o: _trust_rank(o.source, source_trust))
    winner = pool[0]
    winner_rank = _trust_rank(winner.source, source_trust)

    # 3. Conflict only if another observation is equally trusted but differs.
    conflict = None
    for o in pool[1:]:
        if o.value == winner.value:
            continue
        if _trust_rank(o.source, source_trust) == winner_rank:
            conflict = Conflict(field, winner.value, o.value, o.source)
        break   # first differing value decides; lower-trust loss is not a conflict
    return Resolution(winner.value, conflict)
