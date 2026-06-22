"""
The enrich supervisor defaults to the new design; BIBLION_LEGACY_ENRICH=1 and the
per-feature env flags override. A directly-constructed MergeWriter stays legacy
(so unit tests are unaffected); the supervisor injects the new mode.
"""
import pytest

pytestmark = pytest.mark.unit


class TestEffectiveDispatch:
    def test_default_dispatches_enrich_producers_plus_seed_hop(self, monkeypatch):
        # Default = the standard enrich producers that have a handler, PLUS the
        # bounded seeds-only S2 hop (for refs+cites). NOT every handler.
        monkeypatch.delenv('BIBLION_DISPATCH_ENDPOINTS', raising=False)
        monkeypatch.delenv('BIBLION_LEGACY_ENRICH', raising=False)
        from biblion.__main__ import _effective_dispatch, ENRICH_PRODUCERS
        from biblion.enrich.handlers import HANDLERS
        expected = {e for e in ENRICH_PRODUCERS if e in HANDLERS}
        expected.add('expand_papers_s2_seeds')
        assert _effective_dispatch() == expected
        # Cascade-prone / non-enrich endpoints must NOT be in the default set.
        assert 'expand_papers_s2' not in expected      # broad hop (hops ghosts)
        assert 'enrich_stubs_oa' not in expected
        assert 'expand_papers_s2_seeds' in expected     # bounded seed hop IS in

    def test_legacy_disables_dispatch(self, monkeypatch):
        monkeypatch.setenv('BIBLION_LEGACY_ENRICH', '1')
        monkeypatch.delenv('BIBLION_DISPATCH_ENDPOINTS', raising=False)
        from biblion.__main__ import _effective_dispatch
        assert _effective_dispatch() == set()

    def test_explicit_narrows(self, monkeypatch):
        monkeypatch.delenv('BIBLION_LEGACY_ENRICH', raising=False)
        monkeypatch.setenv('BIBLION_DISPATCH_ENDPOINTS', 'enrich_biblio_crossref')
        from biblion.__main__ import _effective_dispatch
        assert _effective_dispatch() == {'enrich_biblio_crossref'}


class TestWriterDefaultsLegacyWhenDirect:
    def test_unset_env_is_legacy(self, monkeypatch, tmp_db_path):
        monkeypatch.delenv('BIBLION_PURE_WRITER', raising=False)
        monkeypatch.delenv('BIBLION_ALIAS_DEDUP', raising=False)
        monkeypatch.delenv('BIBLION_LEGACY_ENRICH', raising=False)
        from biblion.merge.writer import MergeWriter
        w = MergeWriter(tmp_db_path, None, served_modules=[])   # cache unused in __init__
        try:
            assert w._pure_writer is False
            assert w._alias_dedup is False
        finally:
            w.close()

    def test_env_enables_new_modes(self, monkeypatch, tmp_db_path):
        monkeypatch.setenv('BIBLION_PURE_WRITER', '1')
        monkeypatch.setenv('BIBLION_ALIAS_DEDUP', '1')
        from biblion.merge.writer import MergeWriter
        w = MergeWriter(tmp_db_path, None, served_modules=[])
        try:
            assert w._pure_writer is True
            assert w._alias_dedup is True
        finally:
            w.close()
