"""
Tests for the BibTeX / RIS exporter (biblion/modules/export.py).

Covers field assembly, entry-type mapping, page recomposition, identifier and
long-tail (EAV) emission, and a DB -> .bib -> parse_bib round trip.
"""
import json

import pytest

from biblion.modules.export import (
    export, paper_to_bibtex, paper_to_ris, _PAPER_COLUMNS,
)
from biblion.modules.import_bib import parse_bib, bib_entry_to_paper


pytestmark = pytest.mark.unit


def _populate(db_conn, insert_paper):
    """Insert two papers (an article + a chapter) with extended fields,
    identifiers, and long-tail observations. Returns nothing."""
    a = insert_paper(
        citekey='smith2024thing', doi='10.1234/abcd', pub_type='article',
        title='On a Thing', year=2024, venue='Journal of Things',
        authors=json.dumps(['Smith, Jane', 'Doe, Alan']),
        volume='12', issue='3', first_page='100', last_page='120',
        publisher='Springer', month='07', language='en',
        abstract='A short abstract.',
    )
    c = insert_paper(
        citekey='lee2020chap', doi='10.5678/xyz', pub_type='book-chapter',
        title='A Chapter', year=2020, booktitle='Big Handbook of Stuff',
        series='Handbooks', edition='2',
        authors=json.dumps(['Lee, Kim']),
        editors=json.dumps(['Ng, Pat', 'Roe, Sam']),
    )
    db_conn.execute(
        "INSERT INTO identifiers (paper_id, scheme, value) VALUES (?,?,?)",
        (a, 'issn', '1234-5678'))
    db_conn.execute(
        "INSERT INTO identifiers (paper_id, scheme, value) VALUES (?,?,?)",
        (c, 'isbn', '978-0-00-000000-0'))
    db_conn.execute(
        "INSERT INTO field_observations "
        "(paper_id, field, value, raw_value, source, observed_at) "
        "VALUES (?,?,?,?,?,datetime('now'))",
        (a, 'keywords', 'one, two', 'one, two', 'bib:t'))
    db_conn.execute(
        "INSERT INTO field_observations "
        "(paper_id, field, value, raw_value, source, observed_at) "
        "VALUES (?,?,?,?,?,datetime('now'))",
        (c, 'note', 'a chapter note', 'a chapter note', 'bib:t'))
    db_conn.commit()


class TestBibtexEmission:
    def _rows(self, db_conn):
        cols = ', '.join(_PAPER_COLUMNS)
        return db_conn.execute(
            f"SELECT {cols} FROM papers ORDER BY id").fetchall()

    def test_article_entry(self, db_conn, insert_paper):
        _populate(db_conn, insert_paper)
        row = self._rows(db_conn)[0]
        out = paper_to_bibtex(row, {1: {'keywords': 'one, two'}},
                              {1: {'issn': ['1234-5678']}}, 'smith2024thing')
        assert out.startswith('@article{smith2024thing,')
        assert 'journaltitle = {Journal of Things}' in out
        assert 'volume      = {12}' in out
        assert 'pages       = {100--120}' in out
        assert 'issn        = {1234-5678}' in out

    def test_chapter_uses_incollection_and_booktitle(self, db_conn, insert_paper):
        _populate(db_conn, insert_paper)
        row = self._rows(db_conn)[1]
        out = paper_to_bibtex(row, {}, {2: {'isbn': ['978-0-00-000000-0']}},
                              'lee2020chap')
        assert out.startswith('@incollection{lee2020chap,')
        assert 'booktitle   = {Big Handbook of Stuff}' in out
        assert 'editor      = {Ng, Pat and Roe, Sam}' in out
        assert 'isbn        = {978-0-00-000000-0}' in out

    def test_ris_emission(self, db_conn, insert_paper):
        _populate(db_conn, insert_paper)
        row = self._rows(db_conn)[0]
        out = paper_to_ris(row, {1: {'keywords': 'one, two'}}, {})
        assert 'TY  - JOUR' in out
        assert 'AU  - Smith, Jane' in out
        assert 'VL  - 12' in out
        assert 'SP  - 100' in out and 'EP  - 120' in out
        assert out.rstrip().endswith('ER  -')


class TestExportRoundTrip:
    def test_bib_round_trip(self, tmp_path, db_conn, insert_paper):
        _populate(db_conn, insert_paper)
        out = tmp_path / 'out.bib'
        n = export(db_conn, out, 'bib', '1=1', ())
        assert n == 2

        entries = {e.citekey: e for e in parse_bib(out.read_text())}
        assert set(entries) == {'smith2024thing', 'lee2020chap'}

        art = bib_entry_to_paper(entries['smith2024thing'], 'bib:rt')
        assert art.doi == '10.1234/abcd'
        assert art.volume == '12'
        assert art.issue == '3'
        assert art.first_page == '100'
        assert art.last_page == '120'
        assert art.publisher == 'Springer'
        assert json.loads(art.authors_json) == ['Smith, Jane', 'Doe, Alan']
        assert art.extra_identifiers == {'issn': ['1234-5678']}

        chap = bib_entry_to_paper(entries['lee2020chap'], 'bib:rt')
        assert chap.booktitle == 'Big Handbook of Stuff'
        assert chap.series == 'Handbooks'
        assert chap.edition == '2'
        assert json.loads(chap.editors_json) == ['Ng, Pat', 'Roe, Sam']
        assert chap.extra_identifiers == {'isbn': ['978-0-00-000000-0']}

    def test_synthesized_citekey_when_missing(self, tmp_path, db_conn, insert_paper):
        insert_paper(doi='10.9/z', pub_type='article', title='Nameless Work',
                     year=2019, authors=json.dumps(['Vega, Ana']))
        out = tmp_path / 'out.bib'
        export(db_conn, out, 'bib', '1=1', ())
        text = out.read_text()
        # surname + year + first title word
        assert '@article{vega2019nameless,' in text


class TestRedactionExclusion:
    def _seed(self, insert_paper):
        insert_paper(doi='10.1/ok',   pub_type='article', title='GoodPaper',  year=2020)
        insert_paper(doi='10.2/ret',  pub_type='article', title='BadPaper',   year=2020,
                     editorial_status='retracted')
        insert_paper(doi='10.3/wd',   pub_type='article', title='GonePaper',  year=2020,
                     editorial_status='withdrawn')
        insert_paper(doi='10.4/corr', pub_type='article', title='FixedPaper', year=2020,
                     editorial_status='corrected')

    def test_excludes_retracted_and_withdrawn_by_default(
        self, tmp_path, db_conn, insert_paper):
        self._seed(insert_paper)
        out = tmp_path / 'o.bib'
        n = export(db_conn, out, 'bib', '1=1', ())
        text = out.read_text()
        # retracted + withdrawn dropped; valid + corrected kept (corrected is
        # annotated, not removed).
        assert n == 2
        assert 'GoodPaper' in text and 'FixedPaper' in text
        assert 'BadPaper' not in text and 'GonePaper' not in text
        assert 'CORRECTED' in text          # kept paper still annotated

    def test_include_redacted_keeps_all(self, tmp_path, db_conn, insert_paper):
        self._seed(insert_paper)
        out = tmp_path / 'o.bib'
        n = export(db_conn, out, 'bib', '1=1', (), include_redacted=True)
        assert n == 4
        assert 'BadPaper' in out.read_text()

    def test_exclusion_composes_with_selector(self, tmp_path, db_conn, insert_paper):
        self._seed(insert_paper)
        out = tmp_path / 'o.bib'
        # year selector + default redaction filter
        n = export(db_conn, out, 'bib', 'year = ?', (2020,))
        assert n == 2
