"""
Shared, cross-process API rate limiter.

Every external-API client constructs its own throttle state per process, so
when several producers hit the same API at once (e.g. enrich_metadata_s2 +
resolve_dois_s2 + the hop + search, all on Semantic Scholar) they collectively
exceed the API's real limit. This module replaces that with ONE global gate
per engine, backed by Redis, so all processes draw from the same budget.

Two limits per engine, read from rates.config via biblion.config.rate_for():
  - rps   : requests/second, enforced as a global minimum spacing between calls
  - daily : requests per UTC calendar day; 0 = unlimited. When exceeded,
            throttle() raises DailyLimitReached so the producer can stop that
            engine for the day.

Keys are GLOBAL (not per-DB namespaced): the API limit is per account/key,
shared across every biblion project on the same Redis.

Resilience: if Redis is unreachable or the script errors, throttle() returns
False and the caller falls back to its own in-process interval. DailyLimitReached
is the only intentional exception.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional

from .. import config


GATE_TTL_MS = 60_000            # idle gate key self-expires after 60s
DAY_TTL_MS  = 2 * 24 * 3600_000  # daily counter lives ~2 days then resets

# Atomic: advance the per-engine gate by one interval and bump the day counter.
# Returns {next_slot_start (string float), day_count (int)}.
_LUA = """
local gate = tonumber(redis.call('GET', KEYS[1]) or '0')
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local slot = math.max(now, gate)
redis.call('SET', KEYS[1], slot + interval, 'PX', tonumber(ARGV[4]))
local day = redis.call('INCR', KEYS[2])
if day == 1 then
  redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]))
end
return {tostring(slot), day}
"""

_conn = None
_conn_failed = False


class DailyLimitReached(BaseException):
    """Raised by throttle() when an engine's daily request cap is exceeded.

    Subclasses BaseException (NOT Exception) on purpose: it must propagate
    cleanly through producers' per-batch `except Exception` handlers (which
    would otherwise swallow it and busy-spin re-hitting the cap) up to the
    Orchestrator, which catches it once and records the module as noop —
    "stopped this engine for the day". The UTC-day counter resets at midnight.
    """
    def __init__(self, engine: str):
        super().__init__(f"daily API limit reached for engine {engine!r}")
        self.engine = engine


def _redis_url() -> str:
    import os
    return os.environ.get('BIBLION_REDIS_URL', 'redis://localhost:6379/0')


def _get_redis():
    """Lazily open (and cache) the limiter's Redis connection. Returns None if
    Redis is unreachable — callers then fall back to local throttling."""
    global _conn, _conn_failed
    if _conn is not None:
        return _conn
    if _conn_failed:
        return None
    try:
        import redis
        c = redis.from_url(_redis_url(), decode_responses=True,
                           socket_connect_timeout=2)
        c.ping()
        _conn = c
        return _conn
    except Exception:
        _conn_failed = True
        return None


def reset() -> None:
    """Drop the cached connection (tests / reconfiguration)."""
    global _conn, _conn_failed
    _conn = None
    _conn_failed = False


def _utc_date() -> str:
    return datetime.now(timezone.utc).strftime('%Y%m%d')


def _acquire(conn, engine: str, rps: float, daily: int) -> int:
    """Apply shared spacing for one call to `engine`, sleeping as needed to
    honour `rps` globally. Returns the running day count. Raises
    DailyLimitReached when `daily` (>0) is exceeded. Uses the given Redis conn."""
    interval = (1.0 / rps) if rps and rps > 0 else 0.0
    gate_key = f'biblion:rl:{engine}:gate'
    day_key  = f'biblion:rl:{engine}:day:{_utc_date()}'
    now = time.time()
    slot_s, day = conn.eval(_LUA, 2, gate_key, day_key,
                            repr(now), repr(interval),
                            str(DAY_TTL_MS), str(GATE_TTL_MS))
    wait = float(slot_s) - time.time()
    if wait > 0:
        time.sleep(wait)
    day = int(day)
    if daily and daily > 0 and day > daily:
        raise DailyLimitReached(engine)
    return day


def throttle(engine: str) -> bool:
    """Gate one API call to `engine` against the shared budget.

    Returns True if the shared limiter applied (the caller should NOT also
    sleep on its local interval), or False if Redis was unavailable (the caller
    should fall back to its own in-process throttle). Raises DailyLimitReached
    if the engine's daily cap is exceeded."""
    conn = _get_redis()
    if conn is None:
        return False
    cfg = config.rate_for(engine)
    try:
        _acquire(conn, engine, cfg.get('rps', 0.0), cfg.get('daily', 0))
        return True
    except DailyLimitReached:
        raise
    except Exception:
        # Any Redis/Lua error: degrade to the caller's local throttle and
        # retry the connection next time.
        reset()
        return False
