"""
Unit test for NcbiClient._parse_efetch_xml — the bibliographic fields now
harvested from PubMed efetch XML (journal/volume/issue/pages/authors/ISSN).
"""
import pytest

from biblion.clients.ncbi import _parse_efetch_xml


pytestmark = pytest.mark.unit


SAMPLE_XML = """<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>39000001</PMID>
      <Article>
        <Journal>
          <ISSN>1234-5678</ISSN>
          <JournalIssue>
            <Volume>12</Volume>
            <Issue>3</Issue>
            <PubDate><Year>2024</Year></PubDate>
          </JournalIssue>
          <Title>Journal of Things</Title>
        </Journal>
        <ArticleTitle>On a Thing</ArticleTitle>
        <Pagination><MedlinePgn>100-20</MedlinePgn></Pagination>
        <Abstract><AbstractText>A short abstract.</AbstractText></Abstract>
        <AuthorList>
          <Author><LastName>Smith</LastName><ForeName>Jane</ForeName></Author>
          <Author><LastName>Doe</LastName><Initials>A</Initials></Author>
          <Author><CollectiveName>The Study Group</CollectiveName></Author>
        </AuthorList>
      </Article>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="doi">10.1234/abcd</ArticleId>
        <ArticleId IdType="pmc">PMC12345</ArticleId>
      </ArticleIdList>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>
"""


class TestParseEfetchXml:
    def setup_method(self):
        self.rec = _parse_efetch_xml(SAMPLE_XML)['39000001']

    def test_core_fields(self):
        assert self.rec['title'] == 'On a Thing'
        assert self.rec['year'] == 2024
        assert self.rec['doi'] == '10.1234/abcd'
        assert self.rec['pmcid'] == 'PMC12345'

    def test_journal_and_numbers(self):
        assert self.rec['venue'] == 'Journal of Things'
        assert self.rec['volume'] == '12'
        assert self.rec['issue'] == '3'
        assert self.rec['issn'] == '1234-5678'

    def test_pages(self):
        # PubMed abbreviates the end page ("100-20"); we keep both parts as-is.
        assert self.rec['first_page'] == '100'
        assert self.rec['last_page'] == '20'

    def test_authors_lastname_forename_and_collective(self):
        assert self.rec['authors'] == [
            'Smith, Jane', 'Doe, A', 'The Study Group']
