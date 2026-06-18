"""
JATS/HTML markup stripping for paper titles.

CrossRef and OpenAlex serve titles carrying inline JATS markup -- italic
(<i>/<em>) around species names, small-caps (<scp>) and superscript (<sup>)
typography, sometimes pretty-printed with newlines, and frequently double- or
triple-escaped (&lt;i&gt;, &amp;#39;). None of it belongs in a bibliographic
title field.

clean_title() flattens it and is applied at the single daemon choke point --
PaperRecord construction (cache/records.py) -- so every producer's titles are
clean the moment a record is built, regardless of which source it came from.
title_keywords() salvages the marked-up named entities (species/gene/strain
names) as keyword candidates so the information the markup carried is not lost.
"""
import html
import re
from typing import List, Set

_TITLE_TAG_RE = re.compile(r'</?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>')
_TITLE_WS_RE = re.compile(r'\s+')

# Only these tag NAMES are stripped. An allowlist (not "any <word>") is
# deliberate: some sources mangle markup into reversed brackets like
# ">i<Bacillus thuringiensis>/i<" (the angle brackets swapped), which a greedy
# "strip any <...>" would read as a <Bacillus thuringiensis> tag and silently
# delete the species name. Restricting to real JATS/HTML formatting tags leaves
# any other angle-bracketed text -- content, not markup -- untouched.
_TITLE_STRIP_TAGS = frozenset({
    'i', 'em', 'italic', 'b', 'strong', 'bold', 'scp', 'sc', 'smallcaps',
    'sup', 'sub', 'u', 'tt', 'span', 'roman', 'sans-serif', 'monospace',
    'overline', 'underline', 'strike', 's', 'br', 'p', 'mml',
})

# Italic/emphasis wrap phrase-level entities; the source often omits the spaces
# around the tag because the styling supplied the visual break ("of<i>Spodoptera
# frugiperda</i>(..."). Replacing these tags with a space keeps the words apart.
# Small-caps/superscript instead style runs *inside* a word ("<scp>C</scp>ry1F",
# "<sup>13</sup>C") and must collapse to nothing.
_TITLE_SPACE_TAGS = frozenset({'i', 'em', 'italic', 'br', 'p'})

# Tags whose inner text is worth keeping as a keyword. Both italic and small-caps
# are used for whole species names in this corpus, so harvest from both and let
# _is_entity_keyword() reject the typographic fragments.
_KEYWORD_TAGS = ('i', 'em', 'italic', 'scp', 'sc')


def _has_markup(text: str) -> bool:
    """Fast precheck: a title with none of these characters cannot carry tags
    or entities, so clean_title/title_keywords can return immediately. Keeps the
    per-record cost in the daemon to one scan of a short string for the (clean)
    common case."""
    return '<' in text or '&' in text or '\n' in text


def _strip_known_tags(text: str) -> str:
    """Remove only allowlisted formatting tags; italic/emphasis collapse to a
    space, everything else to nothing. Unknown <...> spans are left as-is."""
    def repl(m):
        name = m.group(1).lower()
        if name not in _TITLE_STRIP_TAGS:
            return m.group(0)
        return ' ' if name in _TITLE_SPACE_TAGS else ''
    return _TITLE_TAG_RE.sub(repl, text)


def _unescape_stable(text: str) -> str:
    """html.unescape until it stops changing. CrossRef double-escapes
    (&lt;i&gt; -> <i>) and occasionally triple-escapes (&amp;#39; -> &#39; ->
    '), so a single pass is not enough."""
    for _ in range(4):
        u = html.unescape(text)
        if u == text:
            return text
        text = u
    return text


def clean_title(title):
    """Strip JATS/HTML markup, decode entities, and collapse whitespace in a
    title. Idempotent -- a clean title passes through unchanged. Returns the
    input unchanged if falsy (None/'') or free of any markup markers."""
    if not title or not _has_markup(title):
        return title
    t = _unescape_stable(title)
    t = _strip_known_tags(t)
    t = _TITLE_WS_RE.sub(' ', t)
    # The italic-as-space rule can leave a space before closing punctuation or
    # after an open paren ("( Spodoptera frugiperda )"); tidy those.
    t = re.sub(r'\s+([),.;:])', r'\1', t)
    t = re.sub(r'(\()\s+', r'\1', t)
    return t.strip()


def _is_entity_keyword(s: str) -> bool:
    """Keep marked-up spans that look like real named entities; reject the
    single letters / short all-caps / bare numbers that small-caps and
    superscript styling produce inside words."""
    if len(s) < 3 or ',' in s or ';' in s:
        return False                      # too short, or unsafe for .bib/.ris
    if ' ' in s:
        return True                       # multi-word: 'Spodoptera frugiperda'
    if s.isdigit():
        return False                      # bare superscript number: '13'
    # Single token. A lowercase letter marks a genus/strain name
    # ('Wolbachia', 'kurstaki', 'Vip3Aa', 'Cry1Ab'). Failing that, a digit
    # marks an all-caps gene/strain identifier ('CYP321A9', 'S93'). Pure
    # all-caps letters are abbreviations the markup happened to wrap ('ABC',
    # 'GS', 'FAW') -- drop those.
    return any(c.islower() for c in s) or any(c.isdigit() for c in s)


def title_keywords(title) -> List[str]:
    """Extract marked-up named entities from a JATS/HTML title as keyword
    candidates. De-duplicated case-insensitively, first-seen order preserved.
    Returns [] for a falsy or markup-free title."""
    if not title or not _has_markup(title):
        return []
    t = _unescape_stable(title)
    out: List[str] = []
    seen: Set[str] = set()
    for tag in _KEYWORD_TAGS:
        rx = re.compile(rf'<{tag}\b[^>]*>(.*?)</{tag}>', re.I | re.S)
        for m in rx.finditer(t):
            inner = _TITLE_WS_RE.sub(' ', _strip_known_tags(m.group(1))).strip()
            if not _is_entity_keyword(inner):
                continue
            key = inner.lower()
            if key not in seen:
                seen.add(key)
                out.append(inner)
    return out
