"""
Tests for JATS/HTML title cleaning and keyword salvage
(biblion/titles.py: clean_title / title_keywords).

Cases are drawn from real CrossRef/OpenAlex titles seen in the fallworm
dataset: raw inline markup, pretty-printed JATS with newlines, double- and
triple-escaped tags, and small-caps/superscript styling *inside* words.
"""
import pytest

from biblion.titles import clean_title, title_keywords
from biblion.cache.records import PaperRecord

pytestmark = pytest.mark.unit


class TestPaperRecordCleansTitle:
    """The daemon choke point: every producer builds a PaperRecord, so titles
    must be flattened at construction and survive a JSON round-trip clean."""

    def test_title_cleaned_on_construction(self):
        rec = PaperRecord(source='test', doi='10.1/x',
                          title='Effect of <i>Spodoptera frugiperda</i> on maize')
        assert rec.title == 'Effect of Spodoptera frugiperda on maize'

    def test_double_escaped_cleaned_on_construction(self):
        rec = PaperRecord(source='test', doi='10.1/x',
                          title='From &lt;i&gt;Bacillus thuringiensis&lt;/i&gt; assays')
        assert rec.title == 'From Bacillus thuringiensis assays'

    def test_none_title_untouched(self):
        rec = PaperRecord(source='test', doi='10.1/x', title=None)
        assert rec.title is None

    def test_from_json_also_cleans(self):
        # a record serialised before the fix existed still cleans on reload
        dirty = '{"source":"s2","doi":"10.1/x","title":"Gut of <i>S. frugiperda</i>"}'
        rec = PaperRecord.from_json(dirty)
        assert rec.title == 'Gut of S. frugiperda'


class TestCleanTitle:
    def test_passthrough_clean_title_unchanged(self):
        t = "Gut bacteria of the fall armyworm promote host resistance"
        assert clean_title(t) == t

    def test_idempotent(self):
        raw = "Midgut microbiota and the <i>Spodoptera frugiperda</i> toxicity"
        once = clean_title(raw)
        assert clean_title(once) == once

    @pytest.mark.parametrize("value", [None, ""])
    def test_falsy_passthrough(self, value):
        assert clean_title(value) == value

    def test_strips_italic_keeps_text(self):
        assert clean_title("Comparison of <i>Spodoptera frugiperda</i> strains") == \
            "Comparison of Spodoptera frugiperda strains"

    def test_italic_pads_when_source_omits_spaces(self):
        # the italic tag was the only separator between words
        assert clean_title("Gut microbiota of<i>Spodoptera frugiperda</i>(J.E. Smith)") == \
            "Gut microbiota of Spodoptera frugiperda (J.E. Smith)"

    def test_small_caps_collapse_without_space(self):
        # <scp> styles a run *inside* a word -- must not introduce a space
        assert clean_title("<scp>C</scp>ry<scp>1F</scp>-resistant fall armyworm") == \
            "Cry1F-resistant fall armyworm"

    def test_superscript_collapses_without_space(self):
        assert clean_title("Probing Using <sup>13</sup>C-Glucose") == \
            "Probing Using 13C-Glucose"

    def test_collapses_pretty_printed_newlines(self):
        raw = ("The larval gut of\n                    <scp>\n"
               "                      <i>Spodoptera frugiperda</i>\n"
               "                    </scp>\n                    harbours bacteria")
        assert clean_title(raw) == \
            "The larval gut of Spodoptera frugiperda harbours bacteria"

    def test_double_escaped_tags(self):
        raw = ("Susceptibility From &lt;I&gt;Bacillus thuringiensis&lt;/I&gt; "
               "in &lt;I&gt;Spodoptera frugiperda&lt;/I&gt;")
        assert clean_title(raw) == \
            "Susceptibility From Bacillus thuringiensis in Spodoptera frugiperda"

    def test_triple_escaped_apostrophe(self):
        assert clean_title("Farmers&amp;#39; knowledge of biological control") == \
            "Farmers' knowledge of biological control"

    def test_genuine_ampersand_entity(self):
        assert clean_title("Biology &amp; control of fall armyworm") == \
            "Biology & control of fall armyworm"

    def test_unknown_angle_bracket_content_preserved(self):
        # not a formatting tag -- must not be stripped as one
        t = "Study of <Bacillus thuringiensis> strains"
        assert clean_title(t) == t

    def test_reversed_bracket_markup_does_not_eat_content(self):
        # source corruption: brackets swapped (">i<Bt>/i<"). The species names
        # must survive even though the markup is unrecoverable.
        cleaned = clean_title("milho &gt;i&lt;Bt&gt;/i&lt; "
                              "(&gt;i&lt;Bacillus thuringiensis&gt;/i&lt;)")
        assert "Bt" in cleaned
        assert "Bacillus thuringiensis" in cleaned


class TestTitleKeywords:
    def test_no_markup_returns_empty(self):
        assert title_keywords("Gut bacteria of the fall armyworm") == []

    @pytest.mark.parametrize("value", [None, ""])
    def test_falsy_returns_empty(self, value):
        assert title_keywords(value) == []

    def test_extracts_species_from_italic(self):
        kws = title_keywords("Effect of <i>Bacillus thuringiensis</i> on "
                             "<i>Spodoptera frugiperda</i> larvae")
        assert kws == ["Bacillus thuringiensis", "Spodoptera frugiperda"]

    def test_dedupes_case_insensitively(self):
        kws = title_keywords("<i>Spodoptera frugiperda</i> and "
                             "<i>Spodoptera Frugiperda</i> again")
        assert kws == ["Spodoptera frugiperda"]

    def test_extracts_from_double_escaped(self):
        assert title_keywords("Report of &lt;i&gt;Tetrastichus howardi&lt;/i&gt;") == \
            ["Tetrastichus howardi"]

    def test_extracts_species_wrapped_in_small_caps(self):
        assert title_keywords("Cold acclimation in <scp>Spodoptera frugiperda</scp>") == \
            ["Spodoptera frugiperda"]

    def test_rejects_typographic_fragments(self):
        # single letters / short all-caps / numbers are styling, not entities
        kws = title_keywords("<scp>C</scp>ry1F and <scp>ABC</scp> transporter "
                             "using <sup>13</sup>C")
        assert kws == []

    def test_keeps_single_token_genus_and_gene(self):
        kws = title_keywords("<i>Wolbachia</i> and gene <i>CYP321A9</i> in "
                             "<i>Vip3Aa</i> resistance")
        assert kws == ["Wolbachia", "CYP321A9", "Vip3Aa"]

    def test_nested_tags_yield_single_entity(self):
        assert title_keywords("<scp><i>Spodoptera frugiperda</i></scp> study") == \
            ["Spodoptera frugiperda"]
