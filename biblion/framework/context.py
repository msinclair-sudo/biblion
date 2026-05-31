"""
v3 module execution context.

A Context is the only thing a Module.run() receives. It provides:

  - db_path / connect():  read-only DB access for producers (writes go via cache)
  - cache:                CacheClient — the only place producers push results
  - work_dir:             scratch space for module-specific intermediate files
  - shutdown:             cooperative SIGINT flag (poll between batches)
  - config:               flat dict of env vars / API keys / rate limits
  - logger:               structured logger
  - run_id:               UUID of this module invocation
"""
import logging
import sqlite3
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


from ..runtime import ShutdownFlag
from ..cache import CacheClient


@dataclass
class Context:
    db_path:   Path
    work_dir:  Path
    shutdown:  ShutdownFlag
    cache:     Optional[CacheClient] = None
    config:    dict   = field(default_factory=dict)
    run_id:    str    = field(default_factory=lambda: str(uuid.uuid4()))
    logger:    logging.Logger = field(default_factory=lambda: logging.getLogger('biblion'))

    def connect(self, *, readonly: bool = True) -> sqlite3.Connection:
        """
        Open a SQLite connection to the MAIN v3 DB.

        Defaults to read-only because producer modules MUST NOT write to
        the main DB directly — they push to `ctx.cache` and the merge writer
        applies. Pass readonly=False only inside the merge writer / resolver.
        """
        if readonly:
            uri = f"file:{self.db_path}?mode=ro"
            conn = sqlite3.connect(uri, uri=True)
        else:
            conn = sqlite3.connect(str(self.db_path))

        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode  = WAL")
        conn.execute("PRAGMA foreign_keys  = ON")
        conn.execute("PRAGMA busy_timeout  = 30000")
        conn.execute("PRAGMA synchronous   = NORMAL")
        return conn

    def connect_claims(self) -> sqlite3.Connection:
        """
        Open a connection to the CLAIMS DB with the main v3 DB ATTACHed
        as `main_v3` (read-only).

        This is the only connection producers use for claim_candidates() /
        mark_succeeded / mark_failed / release_claims. Writes go to the
        claims DB; the main DB stays unlocked for the merge writer.
        """
        from ..db import get_claims_connection
        return get_claims_connection(main_db_path=self.db_path)
