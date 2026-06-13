"""
Tests for the BibTeX / BibLaTeX importer.

Mirrors test_import_ris.py:
  1. Pure parser helpers (parse_bib, _clean_value, field extractors,
     bib_entry_to_paper) — no I/O, fast.
  2. record_bib_fields() against a fresh DB — every unmapped bib field lands
     as its own named field_observations row.
"""
import json
import sqlite3

import pytest

from biblion.modules.import_bib import (
    ImportBib,
    _clean_value,
    _extract_authors,
    _extract_doi,
    _extract_editors,
    _extract_identifiers,
    _extract_pages,
    _extract_pub_type,
    _extract_venue,
    _extract_year,
    bib_entry_to_paper,
    parse_bib,
    record_bib_fields,
)


pytestmark = pytest.mark.unit


SAMPLE = r"""
@string{nat = {Nature}}

@article{smith2024thing,
  title        = {On a {{Thing}}},
  author       = {Smith, Jane and Doe, Alan},
  journaltitle = {Journal of Things},
  date         = {2024},
  doi          = {10.1234/abcd},
  url          = {https://doi.org/10.1234/abcd},
  publisher    = {Springer},
  volume       = {12},
  number       = {3},
  pages        = {100--120},
  issn         = {1234-5678},
  language     = {english},
  month        = {jul},
  keywords     = {one, two},
  abstract     = {A short abstract.}
}

@incollection{lee2020chap,
  title     = {A Chapter},
  author    = {Lee, Kim},
  editor    = {Ng, Pat and Roe, Sam},
  booktitle = {Big Handbook of Stuff},
  series    = {Handbooks},
  edition   = {2},
  year      = {2020},
  doi       = {10.5678/xyz},
  isbn      = {978-0-00-000000-0}
}
"""


# ---------------------------------------------------------------------------
# parse_bib
# ---------------------------------------------------------------------------

class TestParseBib:
    def test_skips_string_and_parses_two_entries(self):
        entries = list(parse_bib(SAMPLE))
        assert len(entries) == 2
        assert entries[0].entry_type == 'article'
        assert entries[1].entry_type == 'incollection'

    def test_captures_citekey(self):
        e = next(parse_bib(SAMPLE))
        assert e.citekey == 'smith2024thing'

    def test_first_write_wins_per_field(self):
        text = "@article{k, title = {first}, title = {second}}"
        e = next(parse_bib(text))
        assert e.fields['title'] == 'first'

    def test_nested_braces_balanced(self):
        e = next(parse_bib(SAMPLE))
        # {{Thing}} braces stripped, value intact
        assert e.fields['title'] == 'On a Thing'

    def test_quoted_value(self):
        text = '@article{k, title = "Quoted, with comma", year = {2001}}'
        e = next(parse_bib(text))
        assert e.fields['title'] == 'Quoted, with comma'
        assert e.fields['year'] == '2001'

    def test_bare_value(self):
        text = "@article{k, year = 1999, month = jan}"
        e = next(parse_bib(text))
        assert e.fields['year'] == '1999'
        assert e.fields['month'] == 'jan'


class TestCleanValue:
    def test_strips_grouping_braces(self):
        assert _clean_value('On a {{Thing}}') == 'On a Thing'

    def test_accent_inner_brace(self):
        assert _clean_value(r"Andr{\'{e}}") == 'André'

    def test_accent_plain(self):
        assert _clean_value(r"Andr\'e") == 'André'

    def test_collapses_whitespace(self):
        assert _clean_value('a   b\n  c') == 'a b c'


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------

class TestExtractors:
    def setup_method(self):
        self.article, self.chapter = list(parse_bib(SAMPLE))

    def test_doi(self):
        assert _extract_doi(self.article) == '10.1234/abcd'

    def test_doi_falls_back_to_url(self):
        text = "@article{k, url = {https://doi.org/10.1093/zz}}"
        assert _extract_doi(next(parse_bib(text))) == '10.1093/zz'

    def test_year_from_date(self):
        assert _extract_year(self.article) == 2024

    def test_year_from_year_field(self):
        assert _extract_year(self.chapter) == 2020

    def test_venue_journaltitle(self):
        assert _extract_venue(self.article) == 'Journal of Things'

    def test_venue_is_none_for_chapter(self):
        # booktitle is no longer collapsed into venue — it has its own column.
        assert _extract_venue(self.chapter) is None

    def test_authors_split_on_and(self):
        assert json.loads(_extract_authors(self.article)) == [
            'Smith, Jane', 'Doe, Alan']

    def test_authors_does_not_fall_back_to_editor(self):
        # An edited volume's editors must not masquerade as authors.
        text = "@book{k, editor = {Ng, Pat}, title = {X}}"
        assert _extract_authors(next(parse_bib(text))) is None

    def test_editors_split_on_and(self):
        assert json.loads(_extract_editors(self.chapter)) == [
            'Ng, Pat', 'Roe, Sam']

    def test_pages_split(self):
        assert _extract_pages(self.article) == ('100', '120')

    def test_pages_single(self):
        text = "@article{k, pages = {e12345}}"
        assert _extract_pages(next(parse_bib(text))) == ('e12345', None)

    def test_identifiers_isbn_issn(self):
        assert _extract_identifiers(self.article) == {'issn': ['1234-5678']}
        assert _extract_identifiers(self.chapter) == {
            'isbn': ['978-0-00-000000-0']}

    def test_identifiers_arxiv_by_eprinttype(self):
        text = ("@article{k, eprint = {2401.00001}, "
                "eprinttype = {arXiv}}")
        assert _extract_identifiers(next(parse_bib(text))) == {
            'arxiv': ['2401.00001']}

    def test_pub_type_mapping(self):
        assert _extract_pub_type(self.article) == 'article'
        assert _extract_pub_type(self.chapter) == 'book-chapter'

    def test_pub_type_passthrough(self):
        text = "@dataset{k, title = {x}}"
        assert _extract_pub_type(next(parse_bib(text))) == 'dataset'


# ---------------------------------------------------------------------------
# bib_entry_to_paper
# ---------------------------------------------------------------------------

class TestBibEntryToPaper:
    def test_full_record(self):
        e = next(parse_bib(SAMPLE))
        pr = bib_entry_to_paper(e, source='bib:test.bib')
        assert pr.source == 'bib:test.bib'
        assert pr.doi == '10.1234/abcd'
        assert pr.title == 'On a Thing'
        assert pr.year == 2024
        assert pr.venue == 'Journal of Things'
        assert pr.pub_type == 'article'
        assert pr.citekey == 'smith2024thing'
        assert json.loads(pr.authors_json) == ['Smith, Jane', 'Doe, Alan']
        # Extended fields.
        assert pr.volume == '12'
        assert pr.issue == '3'
        assert pr.first_page == '100'
        assert pr.last_page == '120'
        assert pr.publisher == 'Springer'
        assert pr.language == 'english'
        assert pr.month == 'jul'
        assert pr.extra_identifiers == {'issn': ['1234-5678']}

    def test_chapter_extended_fields(self):
        e = list(parse_bib(SAMPLE))[1]
        pr = bib_entry_to_paper(e, source='bib:test.bib')
        assert pr.venue is None                 # not collapsed from booktitle
        assert pr.booktitle == 'Big Handbook of Stuff'
        assert pr.series == 'Handbooks'
        assert pr.edition == '2'
        assert json.loads(pr.editors_json) == ['Ng, Pat', 'Roe, Sam']
        assert pr.extra_identifiers == {'isbn': ['978-0-00-000000-0']}

    def test_raw_payload_preserves_all_fields(self):
        e = next(parse_bib(SAMPLE))
        pr = bib_entry_to_paper(e, source='bib:test.bib')
        raw = json.loads(pr.raw)
        assert raw['citekey'] == 'smith2024thing'
        assert raw['entry_type'] == 'article'
        assert raw['fields']['publisher'] == 'Springer'
        assert raw['fields']['keywords'] == 'one, two'

    def test_record_without_identifier(self):
        text = "@article{k, title = {Mystery paper}, date = {2020}}"
        pr = bib_entry_to_paper(next(parse_bib(text)), source='bib:x.bib')
        assert pr is not None
        assert pr.doi is None
        assert not pr.has_identifier()


# ---------------------------------------------------------------------------
# record_bib_fields — UPDATE against the temp DB
# ---------------------------------------------------------------------------

class TestRecordBibFields:
    def test_unmapped_fields_become_named_observations(
            self, tmp_db_path, insert_paper):
        pid = insert_paper(doi='10.1234/abcd', title='On a Thing')
        entries = [{
            'citekey': 'smith2024thing',
            'ident': {'doi': '10.1234/abcd'},
            'fields': {
                'title': 'On a Thing',         # mapped -> skipped
                'doi': '10.1234/abcd',          # mapped -> skipped
                'publisher': 'Springer',        # promoted column -> skipped
                'editor': 'Ng, Pat',            # promoted column -> skipped
                'isbn': '978-0-00-000000-0',    # identifiers table -> skipped
                'keywords': 'one, two',         # long tail -> kept in EAV
                'note': 'see also X',           # long tail -> kept in EAV
            },
        }]
        written = record_bib_fields(tmp_db_path, entries, 'bib:test.bib')
        assert written == 2

        conn = sqlite3.connect(str(tmp_db_path))
        try:
            rows = dict(conn.execute(
                "SELECT field, value FROM field_observations "
                "WHERE paper_id = ? AND source = 'bib:test.bib'", (pid,),
            ).fetchall())
        finally:
            conn.close()
        assert rows == {
            'keywords': 'one, two',
            'note': 'see also X',
        }

    def test_resolves_by_citekey_when_no_identifier(
            self, tmp_db_path, insert_paper):
        pid = insert_paper(citekey='lee2020chap', title='A Chapter')
        entries = [{
            'citekey': 'lee2020chap',
            'ident': {},
            'fields': {'note': 'an editor note'},   # long-tail field, kept in EAV
        }]
        written = record_bib_fields(tmp_db_path, entries, 'bib:x.bib')
        assert written == 1
        conn = sqlite3.connect(str(tmp_db_path))
        try:
            row = conn.execute(
                "SELECT value FROM field_observations "
                "WHERE paper_id = ? AND field = 'note'", (pid,),
            ).fetchone()
        finally:
            conn.close()
        assert row[0] == 'an editor note'

    def test_unresolvable_entry_skipped(self, tmp_db_path):
        entries = [{'citekey': 'ghost', 'ident': {'doi': '10.0/none'},
                    'fields': {'publisher': 'X'}}]
        assert record_bib_fields(tmp_db_path, entries, 'bib:x.bib') == 0
