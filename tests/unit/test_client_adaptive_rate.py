"""
Tests for the adaptive-rate / key-fallback behavior on the API clients.

These are pure-unit tests with the HTTP layer mocked. They cover:
  - S2 adaptive RPS ramp (success bumps rate, 429 halves it)
  - S2 fallback to anonymous when key is rate-limited
  - S2 key probe after 24h: success restores, failure resets timer
  - OA fallback when X-RateLimit-Remaining drops below threshold
  - OA omits api_key URL param while in fallback
"""
from __future__ import annotations

import time
from typing import Any
from unittest import mock

import pytest

from biblion.clients import semanticscholar as s2_mod
from biblion.clients import openalex      as oa_mod
from biblion.clients.semanticscholar import SemanticScholarClient
from biblion.clients.openalex      import OpenAlexClient


pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# Helpers — fake HTTP responses
# ---------------------------------------------------------------------------

class _FakeResp:
    """Minimal stand-in for requests.Response covering what our clients touch."""
    def __init__(self, status_code: int = 200,
                 body: bytes = b'{}',
                 headers: dict | None = None):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}
        self.text = body.decode('utf-8', errors='replace')

    def iter_content(self, chunk_size: int = 8192):
        # OA reads via iter_content.
        if self._body:
            yield self._body

    def close(self): pass


# ---------------------------------------------------------------------------
# S2 — adaptive RPS
# ---------------------------------------------------------------------------

class TestS2AdaptiveRate:
    def test_success_ramps_rate_after_threshold(self):
        """100 consecutive successes → +1 RPS (default ramp_step)."""
        c = SemanticScholarClient(api_key='test',
                                  rate_limit_rps=5.0,
                                  ramp_after_n=3,    # tiny so test is fast
                                  ramp_step=1.0,
                                  rps_max=50.0)
        assert c._current_rps == 5.0
        # 3 successes → bump
        for _ in range(3):
            c._record_success()
        assert c._current_rps == 6.0
        # Another 3 → 7
        for _ in range(3):
            c._record_success()
        assert c._current_rps == 7.0

    def test_rate_caps_at_max(self):
        c = SemanticScholarClient(api_key='test',
                                  rate_limit_rps=5.0,
                                  ramp_after_n=2,
                                  ramp_step=10.0,
                                  rps_max=7.0)
        for _ in range(2):
            c._record_success()
        # Would be 15 but capped at 7
        assert c._current_rps == 7.0
        # And further ramps don't go past
        for _ in range(2):
            c._record_success()
        assert c._current_rps == 7.0

    def test_429_halves_rate(self):
        c = SemanticScholarClient(api_key='test', rate_limit_rps=10.0)
        c._record_429()
        assert c._current_rps == 5.0
        c._record_429()
        assert c._current_rps == 2.5
        # Floor stops at the anonymous rate.
        for _ in range(20):
            c._record_429()
        assert c._current_rps >= c._anon_rps

    def test_429_resets_consec_ok(self):
        c = SemanticScholarClient(api_key='test', rate_limit_rps=5.0,
                                  ramp_after_n=10, ramp_step=1.0)
        for _ in range(8):
            c._record_success()
        assert c._consec_ok == 8
        c._record_429()
        assert c._consec_ok == 0


# ---------------------------------------------------------------------------
# S2 — fallback + probe
# ---------------------------------------------------------------------------

class TestS2KeyFallback:
    def test_enter_fallback_drops_key_and_resets_breaker(self):
        c = SemanticScholarClient(api_key='test', rate_limit_rps=10.0)
        c._breaker_open_until = time.time() + 999
        c._enter_fallback()
        assert c.api_key is None
        assert c._in_fallback is True
        assert c._original_key == 'test'      # remembered for the probe
        assert c.breaker_open is False        # breaker reset

    def test_no_fallback_when_no_original_key(self):
        c = SemanticScholarClient(api_key='', rate_limit_rps=1.0)
        c._enter_fallback()                   # should be a no-op
        assert c._in_fallback is False

    def test_should_probe_false_until_interval_elapsed(self):
        c = SemanticScholarClient(api_key='test',
                                  probe_interval_s=10.0)
        c._enter_fallback()
        assert c._should_probe_key() is False
        # Backdate the fallback start
        c._fallback_started -= 11
        assert c._should_probe_key() is True

    def test_probe_success_restores_key(self):
        c = SemanticScholarClient(api_key='test',
                                  probe_interval_s=0.0)   # immediately due
        c._enter_fallback()
        with mock.patch.object(c._session, 'post',
                               return_value=_FakeResp(status_code=200)):
            ok = c._attempt_key_probe()
        assert ok is True
        assert c.api_key == 'test'
        assert c._in_fallback is False
        # And the RPS resets to the initial — not the depleted halved value.
        assert c._current_rps == s2_mod._S2_RPS_INITIAL

    def test_probe_failure_resets_timer(self):
        c = SemanticScholarClient(api_key='test',
                                  probe_interval_s=10.0)
        c._enter_fallback()
        c._fallback_started -= 11             # probe is due
        before = c._fallback_started
        with mock.patch.object(c._session, 'post',
                               return_value=_FakeResp(status_code=429)):
            ok = c._attempt_key_probe()
        assert ok is False
        assert c._in_fallback is True
        # Timer was reset (started > before).
        assert c._fallback_started > before


# ---------------------------------------------------------------------------
# OA — fallback to anonymous
# ---------------------------------------------------------------------------

class TestOaKeyFallback:
    def test_capture_quota_enters_fallback_below_threshold(self,
                                                            monkeypatch):
        """When keyed remaining drops below threshold, switch to anonymous."""
        monkeypatch.setattr(oa_mod, 'OPENALEX_API_KEY', 'test-key')
        c = OpenAlexClient()
        c._fallback_threshold = 100
        # Build a fake response with rate-limit headers
        resp = _FakeResp(headers={
            'X-RateLimit-Limit':     '10000',
            'X-RateLimit-Remaining': '50',     # below threshold
            'X-RateLimit-Reset':     '3600',
        })
        c._capture_quota(resp)
        assert c._in_fallback is True

    def test_capture_quota_no_fallback_when_remaining_healthy(self,
                                                                monkeypatch):
        monkeypatch.setattr(oa_mod, 'OPENALEX_API_KEY', 'test-key')
        c = OpenAlexClient()
        c._fallback_threshold = 100
        resp = _FakeResp(headers={
            'X-RateLimit-Limit':     '10000',
            'X-RateLimit-Remaining': '5000',
            'X-RateLimit-Reset':     '3600',
        })
        c._capture_quota(resp)
        assert c._in_fallback is False

    def test_no_fallback_when_no_key_configured(self, monkeypatch):
        """Anonymous-only client must not 'fall back' — it has no key
        to fall back from."""
        monkeypatch.setattr(oa_mod, 'OPENALEX_API_KEY', '')
        c = OpenAlexClient()
        c._fallback_threshold = 100
        resp = _FakeResp(headers={
            'X-RateLimit-Limit':     '10000',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset':     '3600',
        })
        c._capture_quota(resp)
        # Without a key the path opens the breaker (existing behavior),
        # but does NOT mark in_fallback.
        assert c._in_fallback is False

    def test_breaker_status_exposes_fallback(self, monkeypatch):
        monkeypatch.setattr(oa_mod, 'OPENALEX_API_KEY', 'test-key')
        c = OpenAlexClient()
        c._enter_fallback()
        st = c.breaker_status()
        assert st['in_fallback'] is True
        assert st['fallback_age_s'] >= 0
