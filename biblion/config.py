"""
biblion configuration — what modules and clients actually need.

Loads a `.env` from the current working directory (if present); environment
variables already set in the process always win.
"""
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
# Enrichment claim flow
# ---------------------------------------------------------------------------

# How long before a failed per-field enrichment attempt becomes retriable.
# A service that tried to fill a field (e.g. OpenAlex fetching an abstract)
# and the API had no value records a 'failed' attempt; we don't re-spend
# budget on it until this interval passes. Upstream sources backfill metadata
# over time, so periodic re-attempts let those abstracts get picked up.
# Override via .env: BIBLION_ENRICH_RETRY_DAYS=NN. Default ~6 months.
ENRICH_RETRY_DAYS = int(os.environ.get('BIBLION_ENRICH_RETRY_DAYS', '180'))
