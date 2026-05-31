"""
Two CacheClients with different namespaces must not see each other's
data, even when pointed at the same Redis URL. This is what lets two
biblion instances run concurrently against different databases on a
single shared Redis server.
"""
import pytest

from biblion.cache import CacheClient, namespace_for_db
from biblion.cache.records import PaperRecord
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


def _make_paper(doi: str, source: str) -> PaperRecord:
    return PaperRecord(source=source, doi=doi)


class TestNamespaceFromDbPath:
    def test_same_path_same_namespace(self, tmp_path):
        p = tmp_path / 'a.db'
        assert namespace_for_db(p) == namespace_for_db(p)

    def test_different_paths_different_namespaces(self, tmp_path):
        a = tmp_path / 'a.db'
        b = tmp_path / 'b.db'
        assert namespace_for_db(a) != namespace_for_db(b)

    def test_namespace_is_short_and_safe(self, tmp_path):
        ns = namespace_for_db(tmp_path / 'x.db')
        assert ns.startswith('bib_')
        assert len(ns) <= 20
        # No characters that would break a Redis key
        assert all(c.isalnum() or c == '_' for c in ns)


class TestCacheIsolation:
    def test_pushes_dont_leak_across_namespaces(self, redis_url, redis_client):
        a = CacheClient(url=redis_url, namespace='alpha')
        b = CacheClient(url=redis_url, namespace='beta')

        a.push_paper(_make_paper('10.1234/aaa', 'src_a'))
        b.push_paper(_make_paper('10.1234/bbb', 'src_b'))

        lens_a = a.lengths()
        lens_b = b.lengths()
        assert lens_a['staged_papers'] == 1
        assert lens_b['staged_papers'] == 1

        popped_a = a.pop_papers_batch(10)
        popped_b = b.pop_papers_batch(10)
        assert [r.doi for r in popped_a] == ['10.1234/aaa']
        assert [r.doi for r in popped_b] == ['10.1234/bbb']

    def test_flush_all_only_clears_own_namespace(self, redis_url, redis_client):
        a = CacheClient(url=redis_url, namespace='alpha')
        b = CacheClient(url=redis_url, namespace='beta')

        a.push_paper(_make_paper('10.1234/aaa', 'src_a'))
        b.push_paper(_make_paper('10.1234/bbb', 'src_b'))

        a.flush_all()
        assert a.lengths()['staged_papers'] == 0
        assert b.lengths()['staged_papers'] == 1
        b.flush_all()    # cleanup

    def test_pending_cursor_is_per_namespace(self, redis_url, redis_client):
        a = CacheClient(url=redis_url, namespace='alpha')
        b = CacheClient(url=redis_url, namespace='beta')
        try:
            a.set_pending_cursor(100)
            b.set_pending_cursor(200)
            assert a.get_pending_cursor() == 100
            assert b.get_pending_cursor() == 200
        finally:
            a.flush_all()
            b.flush_all()

    def test_no_namespace_means_bare_keys(self, redis_url, redis_client):
        """Back-compat: explicit empty namespace = old un-namespaced behavior."""
        c = CacheClient(url=redis_url, namespace='')
        c.push_paper(_make_paper('10.1234/none', 'src'))
        # Should appear under the bare key, not bib_*:staged:papers
        assert redis_client.llen('staged:papers') == 1
        c.flush_all()

    def test_env_var_sets_default_namespace(
        self, redis_url, redis_client, monkeypatch,
    ):
        monkeypatch.setenv('BIBLION_REDIS_NAMESPACE', 'envset')
        c = CacheClient(url=redis_url)        # no explicit namespace
        c.push_paper(_make_paper('10.1234/env', 'src'))
        assert redis_client.llen('envset:staged:papers') == 1
        c.flush_all()
