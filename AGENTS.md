# AGENTS.md

This file orients an AI agent (or any automated tool) that has been asked
to use **biblion** as a black-box CLI. It covers what biblion is, how to
invoke it, what each command does, common failure modes, and licensing.

For deeper architectural information, see [`docs/user_guide.md`](docs/user_guide.md).

- **Repository:** <https://github.com/msinclair-sudo/biblion>
- **License:** MIT (see [`LICENSE`](LICENSE))

---

## What biblion is

biblion is a command-line tool that builds and maintains a **citation
graph** in a single SQLite database. It ingests papers from:

- Boolean-keyword Semantic Scholar searches
- Existing reference lists (RIS format — Zotero, EndNote, Mendeley, …)
- Citation hops (the references in / citations to existing papers)

…then enriches each paper with metadata from OpenAlex, Semantic Scholar,
and NCBI. The output is a `papers` table, a `citations` table, and
supporting metadata that any downstream tool (Python, R, SQL, BI) can
query directly.

biblion is **not** a search engine, a recommender, or a reference
manager. It assembles a corpus you query later.

---

## Prerequisites the agent must verify

Before invoking biblion, confirm:

1. **Python ≥ 3.11** is available and biblion is importable
   (`python -c "import biblion"`). If not, install with
   `pip install git+https://github.com/msinclair-sudo/biblion.git`.
2. **Redis is running** at `redis://localhost:6379/0` (or the user's
   custom URL). Check with `redis-cli ping` → should reply `PONG`.
3. **`BIBLION_DB` is set** to a writable path, OR every biblion
   invocation passes `--db PATH`. biblion never writes to a default
   location; an unset DB path raises `DatabaseLocationError`.
4. *(Optional)* API keys in `.env` if rate-limited free-tier
   throughput is insufficient:
   - `OpenAlex_api`, `OPENALEX_MAILTO`
   - `semantic_scholar_key`
   - `ENTREZ_api`, `ENTREZ_EMAIL`

---

## Command surface

### Primary commands

| Command | Purpose |
|---|---|
| `biblion init PATH` | Create the SQLite database and write a `.env` scaffold. Must run once before anything else. |
| `biblion import FILE` | Ingest a `.ris` reference list. Records with DOIs are added directly; records without are resolved via OpenAlex title search (≥0.85 similarity threshold). Imported papers are flagged `is_seed=1`. |
| `biblion search FILE` | Run boolean-keyword Semantic Scholar searches from a JSON file of `{queries: [{id, title, query}]}`. |
| `biblion hop` | Follow citation links from existing papers (forward and backward). With no args, hops every eligible paper; pass `--target ID` / `--targets-file FILE` to scope, or `--seeds` to hop only seed papers. |
| `biblion enrich` | Spawn merge writer + resolver + enrichment producers (OpenAlex / Semantic Scholar / NCBI metadata, DOI resolvers, and incoming-citation collection). Long-running, with a live dashboard. Ctrl-C once = graceful drain; twice = SIGKILL. |
| `biblion qc` | Print a snapshot of corpus state (paper counts, identifier coverage, edges, pending edges, enrichment attempts). |

### Advanced commands (nested under `biblion advanced`)

These exist but should not be the agent's first choice — they expose
lower-level pipeline modules.

| Command | Purpose |
|---|---|
| `biblion advanced list` | Enumerate every registered module with its contract |
| `biblion advanced plan TARGET` | Show the execution DAG for a target |
| `biblion advanced run TARGET` | Run one module in-process |
| `biblion advanced daemon MOD1 MOD2 …` | Supervise a custom producer set |
| `biblion advanced start TARGET` | One-shot: spawn daemons, run a producer, drain, stop |
| `biblion advanced bulk papers` | Bulk-import via the Semantic Scholar Datasets API |

---

## Common workflows

### Workflow A — Build a corpus from scratch

```bash
biblion init ~/biblion.db
# (edit ~/.env to add API keys if available)
biblion search searches/my_topic.json    # ingest seed papers
biblion enrich                            # fill in metadata (Ctrl-C to stop)
biblion hop                               # discover related work
biblion enrich                            # enrich the newly discovered stubs
biblion qc                                # check coverage
```

### Workflow B — Start from an existing reference list

```bash
biblion init ~/review.db
biblion import zotero_export.ris          # imports + marks as seeds
biblion enrich                            # backfill missing metadata
biblion hop                               # expand outward from seeds
biblion qc
```

### Workflow C — One-shot inspection

```bash
biblion qc                                # snapshot, no mutation
```

---

## Running multiple instances

biblion is safe to run concurrently against **different databases**,
even sharing one Redis server. Per-DB Redis key namespacing
(`bib_<hash>:…`) is automatic; the daemon-collision check is also
scoped per-DB. Two instances against the **same** database are
refused (would corrupt state).

```bash
# Terminal A
BIBLION_DB=~/corpus_a.db biblion enrich

# Terminal B (different DB, same Redis — totally fine)
BIBLION_DB=~/corpus_b.db biblion enrich
```

---

## Reading the database

The output is a standard SQLite file. Useful tables:

- `papers` — one row per paper. Key columns: `id`, `doi`, `oa_id`,
  `s2_id`, `pubmed_id`, `title`, `year`, `venue`, `authors` (JSON),
  `abstract`, `is_seed`, `is_stub`, `is_rejected`, `raw` (original
  upstream payload).
- `citations` — one row per `(citing_id, cited_id)` edge.
- `citation_counts` — derived in-degree per paper.
- `pending_citations` — edges whose endpoints aren't yet both in
  `papers`; promoted automatically as papers arrive.
- `field_conflicts` — first-write-wins audit log.

```sql
-- Coverage summary
SELECT
  COUNT(*) AS papers,
  COUNT(doi)       AS with_doi,
  COUNT(abstract)  AS with_abstract,
  SUM(is_seed)     AS seeds
FROM papers;

-- Most-cited papers
SELECT p.title, c.in_degree
FROM citation_counts c JOIN papers p ON c.paper_id = p.id
ORDER BY c.in_degree DESC LIMIT 20;
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `biblion: no database path configured` | `BIBLION_DB` unset and no `--db` | `export BIBLION_DB=PATH` or run `biblion init PATH` |
| `Existing merge daemons found` | Previous run didn't shut down cleanly *(or another daemon is using the same DB)* | `pgrep -af 'biblion.merge.*--db <yourdb>'` then `kill -9 <pids>` |
| Producer respawns endlessly with `noop` | Producer has no work — the candidate query returns nothing | Expected; supervisor backs off to 60s. Ctrl-C to stop. |
| `database is locked` errors | Another process holds a write lock on the SQLite file | Find and stop the other writer (usually a stray `sqlite3` shell mid-transaction) |
| Cache queues growing without bound | Merge writer can't keep up | Check the run log `<db-dir>/logs/biblion_*.log` (grep `[merge writer]`); verify disk space |
| `pending_citations` is large | **Normal.** Discovered citations whose target paper isn't yet in `papers`. Promoted automatically as papers arrive. |
| Tests fail with Redis errors | Test suite needs Redis on db=15 | `BIBLION_TEST_REDIS_URL=redis://localhost:6379/<spare_db>` |
| Import skips records with `unresolvable` | RIS record had no DOI and OpenAlex didn't match its title ≥0.85 | Either accept the loss, or pre-clean the RIS to add DOIs |

### Recovering from a hard crash

If the user killed biblion with `kill -9` (or Ctrl-C twice), there
may be "claimed" rows stuck in the claims DB. Release them:

```bash
sqlite3 <db_dir>/<db_name>_claims.db \
  "UPDATE enrichment_attempts SET status='failed', finished_at=datetime('now')
   WHERE status='claimed'"
```

(biblion auto-reaps stale claims after 60 minutes; this just speeds it up.)

---

## Safety guidance for the agent

- **Never delete or overwrite the user's database** without explicit
  instruction. The DB is the only persistent state biblion produces.
- **`biblion enrich` and `biblion hop` are long-running** (potentially
  hours). If running unattended, redirect logs and warn the user
  about expected duration.
- **API calls cost rate-limit budget**, not money. But sustained
  abusive use can earn the user a temporary block from OpenAlex /
  Semantic Scholar. biblion has adaptive throttling; do not work
  around it.
- **Modifying the database directly via SQL** is permitted (it's a
  standard SQLite file) but bypasses the merge writer's conflict
  logging. Prefer using biblion commands for writes.
- **Re-running `biblion import` on the same file is safe** — the
  merge writer dedups by DOI. The same applies to `search` (Redis
  checkpoints) and `hop` (claims DB).
- **biblion writes only to `BIBLION_DB`**, the sibling claims DB,
  the `logs/` directory under the DB's dir, and the `bulk_cache/`
  subdir. It does not touch anything else.

---

## Licensing

biblion is released under the **MIT License**. See [`LICENSE`](LICENSE)
for the full text. In short: you may use, copy, modify, and
redistribute the software with attribution. No warranty.

Third-party API terms still apply when biblion makes requests to
external services on the user's behalf:

- OpenAlex — <https://docs.openalex.org/how-to-use-the-api/api-overview>
- Semantic Scholar — <https://api.semanticscholar.org/api-docs/>
- NCBI Entrez — <https://www.ncbi.nlm.nih.gov/books/NBK25497/>

---

## Where to go next

- **End-user documentation:** [`docs/user_guide.md`](docs/user_guide.md)
- **Project README:** [`README.md`](README.md)
- **Source code & issues:** <https://github.com/msinclair-sudo/biblion>
