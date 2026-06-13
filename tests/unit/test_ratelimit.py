"""
Tests for the shared cross-process API rate limiter
(biblion/clients/ratelimit.py). Uses the real Redis db 15 (repo convention).
Each test uses a fresh random engine name so gate/day keys never collide
across tests or repeated runs.
"""
import time
import uuid

import pytest

from biblion.clients import ratelimit
from biblion.clients.ratelimit import DailyLimitReached
from tests.conftest import needs_redis


pytestmark = [pytest.mark.unit, needs_redis]


def _eng() -> str:
    return 'test_' + uuid.uuid4().hex[:12]


@pytest.fixture(autouse=True)
def _reset_limiter():
    ratelimit.reset()
    yield
    ratelimit.reset()


class TestAcquire:
    def test_spaces_calls_at_rps(self, redis_client):
        eng = _eng()
        t0 = time.time()
        for _ in range(4):                       # 3 gaps @ 1/20s = 0.15s
            ratelimit._acquire(redis_client, eng, rps=20, daily=0)
        assert time.time() - t0 >= 0.14

    def test_no_spacing_when_rps_zero(self, redis_client):
        eng = _eng()
        t0 = time.time()
        for _ in range(5):
            ratelimit._acquire(redis_client, eng, rps=0, daily=0)
        assert time.time() - t0 < 0.05

    def test_day_counter_increments(self, redis_client):
        eng = _eng()
        assert ratelimit._acquire(redis_client, eng, rps=1000, daily=0) == 1
        assert ratelimit._acquire(redis_client, eng, rps=1000, daily=0) == 2

    def test_daily_limit_raises(self, redis_client):
        eng = _eng()
        ratelimit._acquire(redis_client, eng, rps=1000, daily=2)
        ratelimit._acquire(redis_client, eng, rps=1000, daily=2)
        with pytest.raises(DailyLimitReached) as ei:
            ratelimit._acquire(redis_client, eng, rps=1000, daily=2)
        assert ei.value.engine == eng

    def test_unlimited_daily_never_raises(self, redis_client):
        eng = _eng()
        for _ in range(12):
            ratelimit._acquire(redis_client, eng, rps=1000, daily=0)

    def test_keys_are_global_not_namespaced(self, redis_client):
        eng = _eng()
        ratelimit._acquire(redis_client, eng, rps=1000, daily=0)
        assert redis_client.exists(f'biblion:rl:{eng}:gate')
        assert redis_client.keys(f'biblion:rl:{eng}:day:*')


class TestThrottle:
    def test_returns_true_when_redis_up(self, redis_url, monkeypatch):
        monkeypatch.setenv('BIBLION_REDIS_URL', redis_url)
        ratelimit.reset()
        assert ratelimit.throttle(_eng()) is True

    def test_returns_false_when_redis_down(self, monkeypatch):
        # Nothing listening here → connection refused → graceful fallback.
        monkeypatch.setenv('BIBLION_REDIS_URL', 'redis://127.0.0.1:6399/0')
        ratelimit.reset()
        assert ratelimit.throttle(_eng()) is False

    def test_daily_limit_propagates_through_throttle(self, redis_url, monkeypatch):
        eng = _eng()
        monkeypatch.setenv('BIBLION_REDIS_URL', redis_url)
        # Make config report a daily cap of 1 for this engine.
        monkeypatch.setattr(ratelimit.config, 'RATES',
                            {eng: {'rps': 1000, 'daily': 1}})
        ratelimit.reset()
        assert ratelimit.throttle(eng) is True          # 1st ok
        with pytest.raises(DailyLimitReached):
            ratelimit.throttle(eng)                     # 2nd over cap
