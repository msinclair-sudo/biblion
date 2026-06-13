"""
biblion configuration — what modules and clients actually need.

Loads a `.env` from the current working directory (if present); environment
variables already set in the process always win.

Also loads `rates.config` (JSON) — per-engine API rate limits + daily caps
used by the shared cross-process rate limiter. A `rates.config` in the current
working directory overrides the one shipped inside the package.
"""
import json
import os
from pathlib import Path


def _load_env(env_path: Path) -> None:
    if not env_path.exists():
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


_load_env(Path.cwd() / '.env')


# ---------------------------------------------------------------------------
# OpenAlex
# ---------------------------------------------------------------------------

# Free tier works without a key (10 RPS with polite-pool mailto).
# Add an API key via .env entry: OpenAlex_api=xxx
OPENALEX_API_KEY = os.environ.get('OpenAlex_api', '')

# Polite-pool email. Required for sustainable OA throughput — without it
# we get free-tier limits. Accept several env var names for backwards compat
# with the user's existing .env layout.
OPENALEX_MAILTO = (
    os.environ.get('OPENALEX_MAILTO')
    or os.environ.get('CROSSREF_MAILTO')
    or os.environ.get('ENTREZ_EMAIL')
    or ''
)

OPENALEX_BASE_URL = 'https://api.openalex.org'

# Sustained safe rate. The polite-pool ceiling is 10 RPS but heavy
# concurrent use earns adaptive throttling. 5 RPS is safe for hours.
OPENALEX_RATE_LIMIT_RPS = 5


# ---------------------------------------------------------------------------
# Crossref
# ---------------------------------------------------------------------------

# Crossref needs no key; a polite-pool `mailto` earns a better-behaved pool
# and is strongly encouraged. Reuse the same address as OpenAlex by default.
CROSSREF_MAILTO = (
    os.environ.get('CROSSREF_MAILTO')
    or os.environ.get('OPENALEX_MAILTO')
    or os.environ.get('ENTREZ_EMAIL')
    or ''
)
CROSSREF_BASE_URL = 'https://api.crossref.org'
# Polite-pool guidance is ~50 RPS; we stay well under for sustainable use.
CROSSREF_RATE_LIMIT_RPS = 5


# ---------------------------------------------------------------------------
# Enrichment claim flow
# ---------------------------------------------------------------------------

# How long before a failed per-field enrichment attempt becomes retriable.
# A service that tried to fill a field (e.g. OpenAlex fetching an abstract)
# and the API had no value records a 'failed' attempt; we don't re-spend
# budget on it until this interval passes. Upstream sources backfill metadata
# over time, so periodic re-attempts let those abstracts get picked up.
# Override via .env: BIBLION_ENRICH_RETRY_DAYS=NN. Default ~6 months.
ENRICH_RETRY_DAYS = int(os.environ.get('BIBLION_ENRICH_RETRY_DAYS', '180'))


# ---------------------------------------------------------------------------
# API rate limits (rates.config)
# ---------------------------------------------------------------------------

# Safe defaults if rates.config is missing/unreadable for an engine — match
# the historical hardcoded per-client values.
_RATE_DEFAULTS = {
    's2':       {'rps': 5.0, 'daily': 0},
    'openalex': {'rps': 5.0, 'daily': 9500},
    'ncbi':     {'rps': 8.0, 'daily': 0},
    'crossref': {'rps': 5.0, 'daily': 0},
}
# Last-resort for an engine not in defaults: a slow, unlimited fallback.
_RATE_FALLBACK = {'rps': 2.0, 'daily': 0}


def _load_rates() -> dict:
    """Load rates.config (JSON): a CWD copy overrides the packaged default.
    Keys with leading underscore (e.g. '_comment') are ignored. Returns a
    dict {engine: {'rps': float, 'daily': int}}, merged over _RATE_DEFAULTS."""
    rates = {k: dict(v) for k, v in _RATE_DEFAULTS.items()}
    for path in (Path.cwd() / 'rates.config',
                 Path(__file__).parent / 'rates.config'):
        if not path.exists():
            continue
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        except (ValueError, OSError):
            break
        for engine, cfg in data.items():
            if engine.startswith('_') or not isinstance(cfg, dict):
                continue
            entry = rates.get(engine, {})
            if 'rps' in cfg:
                entry['rps'] = float(cfg['rps'])
            if 'daily' in cfg:
                entry['daily'] = int(cfg['daily'])
            rates[engine] = entry
        break    # first existing file wins (CWD over packaged)
    return rates


RATES = _load_rates()


def rate_for(engine: str) -> dict:
    """Return {'rps': float, 'daily': int} for an engine (s2/openalex/ncbi/
    crossref/...), falling back to a safe slow default for unknown engines."""
    return RATES.get(engine, dict(_RATE_FALLBACK))
