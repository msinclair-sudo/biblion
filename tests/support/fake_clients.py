"""
Stand-in API clients for tests.

Each class mirrors the public surface of a real client (the methods the
producer modules actually call) but returns canned data injected at
construction time. No network access happens. Producers swap in the fake
via simple monkeypatch in tests.

Adding a new field to a real client? Add a matching method here, default
its behavior to "return canned data or empty", and add an attribute to
let tests inject specific responses.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional


# ---------------------------------------------------------------------------
# OpenAlex
# ---------------------------------------------------------------------------

@dataclass
class FakeOpenAlexClient:
    """
    Drop-in replacement for biblion.clients.openalex.OpenAlexClient.

    Methods covered:
        fetch_batch_by_doi(dois)        → dict[doi, work_record]
        fetch_batch_by_oa_id(ids)       → dict[oa_id, work_record]
        search_works(query, ...)        → iterator of works
        breaker_open / breaker_status() / daily_budget

    Tests set `.by_doi` / `.by_oa_id` / `.searches` to inject what each
    call returns. Anything not listed returns empty (the producer treats
    as "miss").
    """
    by_doi:    dict[str, dict] = field(default_factory=dict)
    by_oa_id:  dict[str, dict] = field(default_factory=dict)
    searches:  dict[str, list[dict]] = field(default_factory=dict)
    citers:    dict[str, list[dict]] = field(default_factory=dict)  # oa_id -> [{oa_id,doi}]
    daily_budget: int = 9_500
    breaker_open: bool = False
    _calls_today: int = 0

    def cites_of(self, oa_id: str, per_page: int = 200):
        key = (oa_id or '').rsplit('/', 1)[-1].upper()
        self._calls_today += 1
        for c in self.citers.get(key, []):
            yield c

    def fetch_batch_by_doi(self, dois: Iterable[str], select: str = '') -> dict:
        out = {}
        for d in dois:
            if d in self.by_doi:
                out[d] = self.by_doi[d]
                self._calls_today += 1
        return out

    def fetch_batch_by_oa_id(self, ids: Iterable[str], select: str = '') -> dict:
        out = {}
        for i in ids:
            if i in self.by_oa_id:
                out[i] = self.by_oa_id[i]
                self._calls_today += 1
        return out

    def search_works(self, query: str, per_page: int = 25, **_):
        return self.searches.get(query, [])

    def breaker_status(self) -> dict:
        return {
            'open': self.breaker_open,
            'open_for_s': 60 if self.breaker_open else 0,
            'calls_today': self._calls_today,
            'consecutive_429': 0,
        }


# ---------------------------------------------------------------------------
# Semantic Scholar
# ---------------------------------------------------------------------------

@dataclass
class FakeS2Client:
    """Drop-in replacement for clients.semanticscholar.SemanticScholarClient."""
    by_doi:    dict[str, dict] = field(default_factory=dict)
    by_s2_id:  dict[str, dict] = field(default_factory=dict)
    searches:  dict[str, list[dict]] = field(default_factory=dict)
    api_key:   str = 'test-key'
    breaker_open: bool = False
    _calls_today: int = 0

    def fetch_batch_by_doi(self, dois: Iterable[str], fields: str = '') -> dict:
        out = {}
        for d in dois:
            if d in self.by_doi:
                out[d] = self.by_doi[d]
                self._calls_today += 1
        return out

    def fetch_batch_by_id(self, ids: list[str], fields: str = '') -> Optional[list[Optional[dict]]]:
        # The real client returns a list parallel to `ids`; the bulk helpers
        # in producers wrap this in fetch_batch_by_doi etc. Tests typically
        # use fetch_batch_by_doi; this overload is here for symmetry.
        if not ids:
            return []
        return [self.by_s2_id.get(i.replace('DOI:', '').lower()) for i in ids]

    def search_by_title(self, title: str, year=None, top_k: int = 3,
                        fields: str = '') -> Optional[list[dict]]:
        self._calls_today += 1
        return self.searches.get(title, [])[:top_k]

    def breaker_status(self) -> dict:
        return {
            'open': self.breaker_open,
            'open_for_s': 60 if self.breaker_open else 0,
            'calls_today': self._calls_today,
            'consecutive_429': 0,
            'authenticated': True,
        }


# ---------------------------------------------------------------------------
# NCBI eSummary
# ---------------------------------------------------------------------------

@dataclass
class FakeNcbiClient:
    """Drop-in replacement for clients.ncbi.NcbiClient.

    Tests set:
      .by_pmid    → summary_by_pmid lookups (PMID → {doi, pmcid})
      .abstracts  → efetch lookups (PMID → {abstract, title, year, doi})
      .doi_to_pmid→ esearch lookups (DOI → PMID)
    Anything not present is treated as "PubMed has no record".
    """
    by_pmid:    dict[str, dict] = field(default_factory=dict)
    abstracts:  dict[str, dict] = field(default_factory=dict)
    doi_to_pmid: dict[str, str] = field(default_factory=dict)
    api_key: str = 'test-key'
    _calls: int = 0

    def summary_by_pmid(self, ids: Iterable[str]) -> dict:
        out = {}
        for pmid in ids:
            self._calls += 1
            if pmid in self.by_pmid:
                out[pmid] = self.by_pmid[pmid]
        return out

    def pmids_for_dois(self, dois: Iterable[str]) -> dict:
        out = {}
        for doi in dois:
            self._calls += 1
            if doi in self.doi_to_pmid:
                out[doi] = self.doi_to_pmid[doi]
        return out

    def fetch_abstracts_by_pmid(self, ids: Iterable[str]) -> dict:
        out = {}
        for pmid in ids:
            self._calls += 1
            if pmid in self.abstracts:
                out[pmid] = self.abstracts[pmid]
        return out

    def status(self) -> dict:
        return {'authenticated': True, 'interval_s': 0.0, 'calls': self._calls}


# ---------------------------------------------------------------------------
# Canned data builders — for ergonomic test setup
# ---------------------------------------------------------------------------

def oa_work(*, doi=None, title='Test paper', year=2024, venue='Test J',
            authors=None, abstract=None, oa_id=None, referenced_works=()):
    """Build an OpenAlex 'work' dict matching what the producer expects."""
    return {
        'id': oa_id or f'https://openalex.org/W{abs(hash(doi or title)) % 10_000_000}',
        'doi': f'https://doi.org/{doi}' if doi else None,
        'title': title,
        'publication_year': year,
        'primary_location': {'source': {'display_name': venue}} if venue else None,
        'authorships': [{'author': {'display_name': n}} for n in (authors or [])],
        'abstract_inverted_index': _abstract_to_inverted(abstract) if abstract else None,
        'cited_by_count': 0,
        'referenced_works': list(referenced_works),
        'type': 'journal-article',
    }


def s2_work(*, doi=None, s2_id='abc', title='Test paper', year=2024,
            venue='Test J', authors=None, abstract=None,
            references=()):
    """Build an S2 paper dict matching what the producer expects."""
    return {
        'paperId': s2_id,
        'externalIds': {'DOI': doi} if doi else {},
        'title': title,
        'year': year,
        'venue': venue,
        'authors': [{'authorId': str(i), 'name': n}
                    for i, n in enumerate(authors or [])],
        'abstract': abstract,
        'publicationTypes': ['JournalArticle'],
        'citationCount': 0,
        'referenceCount': len(references),
        'references': [{'paperId': r, 'externalIds': {}} for r in references],
    }


def ncbi_record(*, pmid='12345', doi=None, pmcid=None):
    """Build a fake NCBI eSummary record."""
    article_ids = [{'idtype': 'pubmed', 'value': pmid}]
    if doi:
        article_ids.append({'idtype': 'doi', 'value': doi})
    if pmcid:
        article_ids.append({'idtype': 'pmc', 'value': pmcid})
    return {
        'doi':   doi,
        'pmcid': pmcid,
    }


def _abstract_to_inverted(text: str) -> dict:
    """Convert plain text to OpenAlex's inverted-index format."""
    words = text.split()
    out: dict[str, list[int]] = {}
    for i, w in enumerate(words):
        out.setdefault(w, []).append(i)
    return out
