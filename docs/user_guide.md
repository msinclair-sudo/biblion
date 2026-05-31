# biblion — User Guide

This guide walks through using biblion end-to-end: setting up a database,
running searches, enriching papers with metadata from multiple sources,
hopping along citation links, and inspecting the result.

If you want to know *how* biblion works internally — the module contracts,
the merge writer, the database schema — see the **Technical Guide** (coming
soon).

---

## Contents

1. [What biblion does](#1-what-biblion-does)
2. [Prerequisites](#2-prerequisites)
3. [Installation](#3-installation)
4. [First-time setup: `biblion init`](#4-first-time-setup-biblion-init)
5. [Configuration: the `.env` file](#5-configuration-the-env-file)
6. [Loading papers: `biblion search`](#6-loading-papers-biblion-search)
7. [Importing a reference list: `biblion import`](#7-importing-a-reference-list-biblion-import)
8. [Filling in metadata: `biblion enrich`](#8-filling-in-metadata-biblion-enrich)
9. [Following citations: `biblion hop`](#9-following-citations-biblion-hop)
10. [Checking progress: `biblion qc`](#10-checking-progress-biblion-qc)
11. [A typical end-to-end session](#11-a-typical-end-to-end-session)
12. [Stopping and resuming](#12-stopping-and-resuming)
13. [Working with the database](#13-working-with-the-database)
14. [Advanced commands](#14-advanced-commands)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. What biblion does

biblion builds a **citation graph** — a SQLite database where each row in
`papers` is one paper and each row in `citations` is one "paper A cites
paper B" edge. You feed it search queries; it fetches matching papers from
Semantic Scholar, then enriches each one with metadata from OpenAlex
(authors, venues, abstracts, identifier crosswalks), and finally walks the
citation edges out of each paper to grow the graph.

The same database supports five common workflows:

- **Systematic literature reviews** — define your inclusion criteria as
  search strings, enrich the hits, export to RIS / CSV.
- **Bibliometric analysis** — query the `papers` and `citations` tables
  directly for centrality, clustering, co-citation analysis.
- **Reference collection** — start from a few seed DOIs and hop outwards
  to discover related work.
- **Corpus building for ML** — assemble a labelled corpus of titles +
  abstracts in a known domain.
- **Provenance tracking** — every paper records which API and which
  search/query found it.

biblion is **not** a search engine, a recommender, or a Zotero replacement.
It's a pipeline you point at sources, run, and inspect with SQL.

---

## 2. Prerequisites

| What | Why |
|---|---|
| Python ≥ 3.11 | biblion is pure Python; no compilation needed |
| Redis | Used as a coordination cache between producer processes and the merge writer. The default is `redis://localhost:6379/0`. |
| OpenAlex API key *(optional)* | Free; lets you ingest faster than the anonymous tier |
| Semantic Scholar API key *(optional)* | Free; same |
| NCBI Entrez API key *(optional)* | Only needed if you resolve DOIs via PubMed IDs |

### Installing Redis

```bash
# Debian / Ubuntu / WSL
sudo apt install redis-server

# macOS (Homebrew)
brew install redis && brew services start redis

# Verify
redis-cli ping
# → PONG
```

You don't need to configure Redis — biblion uses the default port and a
single database number.

---

## 3. Installation

From GitHub:

```bash
pip install git+https://github.com/msinclair-sudo/biblion.git
```

From a local clone (recommended if you want to read the code or contribute):

```bash
git clone https://github.com/msinclair-sudo/biblion.git
cd biblion
pip install -e .
```

To install with the development extras (pytest, build):

```bash
pip install -e '.[dev]'
```

Verify:

```bash
biblion --help
```

You should see five primary commands: `init`, `search`, `hop`, `enrich`,
`qc`, plus `advanced`.

---

## 4. First-time setup: `biblion init`

biblion never writes to a default location — you choose where the database
lives. Run `init` once to create it:

```bash
biblion init ~/biblion.db
```

This does two things:

1. **Creates the SQLite database** at the given path (and a sibling
   `~/biblion_claims.db` used internally for tracking enrichment attempts).
2. **Writes a `.env` file** in the current directory with placeholders for
   API keys and a `BIBLION_DB=...` line.

You should see:

```
Initialized biblion database at /home/you/biblion.db
Wrote .env scaffold to /home/you/.env

Next: edit the .env to add API keys, then try `biblion qc`.
```

If a `.env` already exists in the current directory, biblion won't
overwrite it — you'll need to add `BIBLION_DB=...` manually.

### Choosing a location

The database can grow large (a 2M-paper corpus is roughly 6 GB plus indexes,
and the WAL file can briefly double that during heavy ingestion). Pick a
location with room to grow. A few common patterns:

```bash
biblion init ~/biblion.db                       # personal use, home directory
biblion init /data/projects/litreview/main.db   # shared / project storage
biblion init ./review.db                        # one DB per project folder
```

You can always move the file later — biblion follows whatever
`BIBLION_DB` (or `--db PATH`) points to.

---

## 5. Configuration: the `.env` file

After `init`, your `.env` looks roughly like this:

```bash
# biblion configuration. Lines without values use defaults.
BIBLION_DB=/home/you/biblion.db
# Optional API keys (free-tier limits apply without them):
OpenAlex_api=
OPENALEX_MAILTO=
semantic_scholar_key=
ENTREZ_api=
ENTREZ_EMAIL=
```

### What each value does

| Key | Used by | Effect |
|---|---|---|
| `BIBLION_DB` | every command | Path to the main SQLite database |
| `OpenAlex_api` | OpenAlex client | Authenticated requests; higher per-IP rate limits |
| `OPENALEX_MAILTO` | OpenAlex client | Polite-pool email — required for sustained throughput |
| `semantic_scholar_key` | Semantic Scholar client | Adds your key to requests; biblion ramps from 5 RPS up to 50 RPS with a key, then falls back to the anonymous tier if the key starts being throttled |
| `ENTREZ_api` | NCBI client | API key for PubMed lookups |
| `ENTREZ_EMAIL` | NCBI client | Required by NCBI's usage policy if you query PubMed |

### Where the `.env` is loaded from

biblion loads `.env` from your **current working directory** at the moment
you run a command. This means you can have multiple projects each with
their own `.env`:

```bash
~/projects/soil-review/
  .env                  # BIBLION_DB=~/projects/soil-review/soil.db
~/projects/llm-papers/
  .env                  # BIBLION_DB=~/projects/llm-papers/llm.db
```

`cd` into the project, run `biblion ...`, and you're talking to the right
database. Process-level environment variables always override `.env`
values, so `BIBLION_DB=/tmp/test.db biblion qc` works for one-off use.

### Running multiple biblion instances at once

biblion is safe to run as multiple concurrent processes as long as each
process points at a **different database**. Two instances against the
same DB *would* corrupt state, so biblion detects and refuses that.

How isolation works:

- biblion derives a short namespace from the resolved database path
  (e.g. `bib_a1b2c3d4e5`) and prefixes every Redis key with it. A
  second instance against a different DB gets a different namespace,
  so neither can see the other's cache queues, claim flow, or pending
  cursor — even on a shared Redis server.
- The merge-daemon collision check (`pgrep`) matches only daemons
  spawned with this DB path, so spawning daemons for DB *A* doesn't
  trip the "existing daemons found" guard when DB *B*'s daemons are
  already running.
- The SQLite database itself is per-instance by construction.

This means you can, for example:

```bash
# Terminal 1
BIBLION_DB=~/soil.db biblion enrich        # corpus A enrichment

# Terminal 2 (different DB, same Redis)
BIBLION_DB=~/llm.db  biblion enrich        # corpus B enrichment, in parallel
```

If you really want two instances on a single Redis db without auto-deriving
the namespace, set `BIBLION_REDIS_NAMESPACE` explicitly:

```bash
BIBLION_REDIS_NAMESPACE=team_alice biblion enrich
```

Process-level env vars override the auto-derived value.

### Named projects — switching databases without `--db`

If you keep several corpora, register each as a **named project** and switch
between them git-style instead of setting `BIBLION_DB` each time.

```bash
biblion init data/algae.db          # auto-registers project 'algae', sets it current
biblion init data/microbiome.db     # auto-registers 'microbiome', now current

biblion project list                # show all (* marks current)
biblion qc                          # acts on the current project
biblion use algae                   # switch current
biblion qc                          # now acts on algae
```

Full command set:

```bash
biblion project add <name> <path>   # register an existing DB (--use to make current)
biblion project use <name>          # set current   (shortcut: biblion use <name>)
biblion project list                # list projects
biblion project current             # print current name + path
biblion project remove <name>       # unregister (does NOT delete the DB file)
```

**Which database a command uses**, highest priority first:

1. `--db PATH` on the command
2. `$BIBLION_DB`
3. the current registered project

So `--db` / `BIBLION_DB` always override the current project — handy for a
one-off against another DB, or for the concurrent-run pattern above. The
registry lives at `~/.config/biblion/projects.json` (override with
`$BIBLION_CONFIG`). `biblion init` auto-registers; `--name` chooses the name,
`--no-register` skips it.

### Getting API keys

- **OpenAlex** — no signup; just put your email in `OPENALEX_MAILTO` to
  join the polite pool. A real API key is only needed for premium volume.
- **Semantic Scholar** — apply at <https://www.semanticscholar.org/product/api>.
  Approval takes a few days. You can run biblion without a key but it's
  much slower (1 RPS vs. 5–50 RPS with a key).
- **NCBI** — sign up at <https://www.ncbi.nlm.nih.gov/account/> and
  generate an API key. Increases your rate limit from 3 → 10 requests/sec.

---

## 6. Loading papers: `biblion search`

`search` runs boolean-keyword queries against Semantic Scholar and adds
the matching papers to your database.

### The search file format

A search file is JSON listing one or more queries:

```json
{
  "queries": [
    {
      "id": "soil_microbiome",
      "title": "Soil microbiome diversity",
      "query": "(soil OR rhizosphere) AND (microbiome OR microbial community) AND (diversity OR richness)"
    },
    {
      "id": "n_cycling",
      "title": "Nitrogen cycling",
      "query": "(nitrogen cycling OR N-cycling) AND (soil OR agricultural)"
    }
  ]
}
```

- `id` is your label; it ends up in the `source` field of every paper
  found by this query so you can later ask "which query found this paper?"
- `title` is for your own reference.
- `query` is a boolean expression. Parentheses group; `AND` and `OR` are
  case-insensitive; `NOT (...)` clauses are stripped before sending to
  Semantic Scholar (Semantic Scholar doesn't support negation in the
  search API).

Save this as `searches/my_review.json` (or anywhere you like).

A ready-made **factorial** example ships with the repo at
`searches/example.json` (theme: microalgae / algal biotechnology). Each
query there is one big boolean string whose AND-groups hold many OR
alternatives; in `--mode expand` the Cartesian product turns the two
queries into 60 distinct Semantic Scholar searches. Use it to try the
workflow end-to-end before writing your own.

### Running a search

```bash
biblion search searches/my_review.json
# …or try the bundled factorial sample (run it in expand mode to see
# the Cartesian blow-out — 60 sub-queries from just two queries):
biblion search searches/example.json --mode expand --sub-limit 25
```

This will:

1. Auto-spawn the merge writer + resolver + pending resolver in the
   background.
2. For each query in the file, fetch up to `--sub-limit` (default 100)
   results from Semantic Scholar.
3. Stream papers into the database as they arrive.
4. Drain the cache when the search completes, then shut down the daemons.

### Useful options

```bash
biblion search FILE \
  --mode expand          # split AND-of-ORs into Cartesian sub-queries (broader)
  --sub-limit 250        # fetch up to 250 papers per (sub-)query
  --year-min 2015        # only papers from 2015 onwards
  --year-max 2024        # only papers up to 2024
  --verbose              # print per-paper progress
```

- **`--mode simplify`** (default): treats each `query` as one Semantic
  Scholar query. Faster, fewer results.
- **`--mode expand`**: parses the boolean expression and submits one
  query per Cartesian combination of the AND-groups. Much wider coverage,
  many more API calls.

### Resumability

biblion checkpoints in Redis after each sub-query completes. If you Ctrl-C
and re-run the same search, it skips the queries it already finished.

---

## 7. Importing a reference list: `biblion import`

Instead of (or in addition to) running a new search, you can seed biblion
with a reference list you already curated — for example a Zotero collection
exported as RIS, a saved EndNote library, or a Mendeley group. This is the
fastest way to start with a known-good corpus.

```bash
biblion import library.ris
```

This will:

1. Auto-spawn the merge writer + resolver + pending resolver.
2. Parse every `TY...ER` block in the file.
3. For records that already have a DOI, push them straight into the cache.
4. For records without a DOI, query OpenAlex by title and accept the top
   match if it's ≥85% similar to the source title. Records that can't be
   confidently matched are skipped with a warning.
5. After the cache drains, flag every imported paper as a **seed**
   (`is_seed = 1`). Seeds get priority in subsequent enrichment passes and
   are obvious starting points for `biblion hop`.

### Supported formats

biblion's RIS parser handles the common variants exported by Zotero,
EndNote, Mendeley, Web of Science, Scopus, and most library catalogues.
Recognised tags include:

| Tag | Mapped to |
|---|---|
| `TY` | `pub_type` (JOUR → article, CHAP → book-chapter, CONF → conference, …) |
| `TI` / `T1` | `title` |
| `AU` / `A1`–`A4` | `authors` (collected, deduplicated) |
| `PY` / `Y1` | `year` (first 4-digit year found) |
| `T2` / `JF` / `JO` | `venue` |
| `DO` | `doi` (URL/scheme prefixes stripped, lowercased) |
| `UR` | scanned for a DOI if `DO` is missing |
| `AB` / `N2` | `abstract` |

Unknown tags are kept in the `raw` JSON payload for forensic inspection
but ignored otherwise. The entire original record is preserved in `raw`.

### Options

```bash
biblion import FILE \
  --no-resolve     # skip the OpenAlex title-search fallback; records
                   # without DOIs are simply skipped
  --verbose        # per-record progress (one line each)
```

### What you'll see

```
[biblion] starting merge daemons (logs → /home/you/biblion-logs/)
  import_ris: file=library.ris records=247 no_resolve=False
[biblion] draining cache...
  [drain] queues: {...}

[biblion import] summary:
  records                247
  pushed_with_doi        239
  resolved_via_oa          6
  skipped_no_id            0
  unresolvable             2
  pushed                 245
  marked is_seed=1       245
```

- **`pushed_with_doi`** — records that had a DOI directly
- **`resolved_via_oa`** — records OpenAlex matched by title
- **`unresolvable`** — records with no DOI and no confident OpenAlex match
- **`marked is_seed=1`** — how many rows were flagged as seeds (rows that
  were already in your database aren't re-flagged)

### Re-importing is safe

The merge writer dedups against existing DOIs. Re-importing the same RIS
file (or a superset of it) won't create duplicates — it will simply
COALESCE any new fields into the existing rows. The `--no-resolve` flag
also makes re-imports faster if you don't need title-search fallback.

### Quick recipe: review a Zotero collection

```bash
# In Zotero: right-click your collection → Export Collection… → RIS
biblion init ~/review.db
biblion import ~/Downloads/My_Collection.ris
biblion enrich      # OA + S2 will fill in missing metadata
biblion qc          # how complete is the corpus?
biblion hop         # discover related papers your collection missed
```

---

## 8. Filling in metadata: `biblion enrich`

After a search, your `papers` rows have whatever Semantic Scholar returned
(title, authors, year, abstract if available). `enrich` fills in
everything else by:

- Resolving missing DOIs via OpenAlex and Semantic Scholar title search
- Adding OpenAlex paper IDs, venues, full author lists, MeSH terms, etc.
- Adding Semantic Scholar IDs where missing
- Cross-referencing PubMed identifiers via NCBI

Run it with:

```bash
biblion enrich
```

This is the workhorse command. It:

1. Spawns the merge writer + resolver + pending resolver.
2. Spawns the enrichment producers in parallel:
   - `enrich_metadata_oa` — OpenAlex metadata for any paper with a DOI
   - `enrich_metadata_s2` — Semantic Scholar metadata for the same (and
     both citation directions — see below)
   - `enrich_metadata_ncbi` — PubMed abstracts via NCBI for papers
     reachable by a PMID or DOI (often fills abstracts OA/S2 lack)
   - `expand_incoming_oa` — incoming citations (who cites each paper) via
     OpenAlex
   - `resolve_dois_oa` — OpenAlex title search for papers missing DOIs
   - `resolve_dois_s2` — same via Semantic Scholar
3. Logs everything to **one central file** per run,
   `<db-dir>/logs/biblion_<timestamp>.log`. Each line is tagged with its
   source (e.g. `[enrich_metadata_oa] ...`), so filter a single producer
   with `grep '[enrich_metadata_oa]' <logfile>`.
4. Supervises each producer — restarts genuinely crashed ones with
   exponential backoff. A producer that cleanly runs out of work is
   *parked* (not counted as a crash) and rechecked on a slow heartbeat.
5. Shows a live dashboard: coverage, enrichment-attempt counts, and a
   per-module health table (`working` / `idle` / `done`, with remaining
   claimable work and restart counts).
6. Runs indefinitely. Press **Ctrl-C once** to drain the cache and shut
   down cleanly. **Ctrl-C twice** to kill everything immediately.

> **Citation directions.** Edges are directional: who-cites-whom is
> stored as `citing → cited`. Outgoing references (who a paper cites) come
> from the OA/S2 metadata enrichers for free. Incoming citations (who
> cites a paper) come from `enrich_metadata_s2` (free, same call) and the
> dedicated `expand_incoming_oa` producer (OpenAlex can only return them
> via a separate query). Incoming edges are identifier-only — an unknown
> citer parks in `pending_citations` until that paper arrives, so expect
> `pending edges` to grow substantially. `expand_incoming_oa` adds one
> paginated OpenAlex query per paper, so it is the heaviest part of a run.

### How long does it take?

Enrichment is rate-limited by the upstream APIs:

- OpenAlex: ~5 requests/second sustained (you can burst to 10 in the
  polite pool)
- Semantic Scholar: 5 requests/second baseline, ramps to 50 with a key

For a corpus of 100k papers, expect ~6-12 hours of enrichment for a
complete pass. You can stop and resume freely.

### What if a producer keeps crashing?

If the dashboard shows a producer `down` with a climbing restart count,
check the central run log at `<db-dir>/logs/biblion_<ts>.log` and filter
to that producer, e.g. `grep '[enrich_metadata_oa]' <logfile>`. The most
common causes are missing API keys, network issues, or hitting the daily
quota on the OpenAlex/Semantic Scholar free tier. (A producer showing
`done` or `idle` with 0 remaining is finished, not broken.)

### Options

```bash
biblion enrich \
  --log-dir /var/log/biblion    # override log location
  --force                       # bypass precondition checks
```

---

## 9. Following citations: `biblion hop`

Every enriched paper has citation links into other papers. `hop` follows
those links — for each paper, it fetches its references and the papers
that cite it from Semantic Scholar, and inserts the new ones as stub
papers (with minimal metadata) plus citation edges.

You can let it run over every eligible paper:

```bash
biblion hop
```

Or target specific identifiers:

```bash
biblion hop --target DOI:10.1093/nar/gkad1015
biblion hop --target W2741809807
biblion hop --target 649def34f8be52c8b66281af98ae884c09aef38b   # Semantic Scholar sha
```

Or read targets from a file:

```bash
biblion hop --targets-file dois_to_hop.txt    # one identifier per line
```

Or hop only your **seed** papers (the ones you imported / searched in,
flagged `is_seed=1`) — useful to expand outward from a curated reference
list without hopping the whole corpus:

```bash
biblion hop --seeds
```

Once a paper has been hopped, it's marked as such in the claims database
and won't be re-hopped — including across `--seeds` and full runs, which
share the same tracking. Newly discovered papers added by the hop become
candidates for the next `biblion enrich` run.

### Useful options

```bash
biblion hop --limit 1000        # stop after 1000 seeds
biblion hop --verbose           # per-paper progress
biblion hop --force             # bypass preconditions
```

---

## 10. Checking progress: `biblion qc`

`qc` prints a snapshot of your database and exits:

```bash
biblion qc
```

Example output (after an enrichment run on a small corpus):

```
============================================================
  v3 QC — /home/you/biblion.db
============================================================

  Identifiers
  papers                          12,847   (100.0%)
  with DOI                        11,902   ( 92.6%)
  with OA ID                       9,438   ( 73.5%)
  with S2 ID                      12,103   ( 94.2%)

  Metadata
  with title                      12,847   (100.0%)
  with year                       12,701   ( 98.9%)
  with venue                       9,802   ( 76.3%)
  with authors                    11,556   ( 89.9%)
  with abstract                    8,219   ( 64.0%)

  Flags
  seeds                                0   (  0.0%)
  stubs                            1,243   (  9.7%)
  rejected                             0   (  0.0%)

  Graph
  edges                           87,402
  pending edges                   12,801
  cit_count rows                  12,847

  Conflicts
  total                              219

  Enrichment attempts (by service × status)
  oa         success              9,438
  oa         failed                 821
  s2_live    success             11,234
  s2_live    failed                 869
```

What the numbers mean:

- **`papers`** — total rows in your `papers` table
- **`with DOI/OA ID/S2 ID`** — coverage of each cross-reference identifier
- **`stubs`** — papers known only by identifier (discovered via a hop but
  not yet enriched). Run `biblion enrich` to fill them in.
- **`edges`** — confirmed citation edges (both endpoints exist as papers)
- **`pending edges`** — discovered citations where one endpoint isn't in
  the database yet. They'll be promoted automatically once both
  endpoints exist.
- **`conflicts`** — fields where two sources disagreed and the first
  populated value was kept (biblion is first-write-wins).
- **`Enrichment attempts`** — per-service success/failure history. High
  failure rates suggest API quota issues or missing keys.

---

## 11. A typical end-to-end session

Here's a realistic first-day workflow:

```bash
# Day 1, morning: set up
cd ~/projects/soil-review
biblion init ./soil.db
nano .env                          # paste in your API keys

# Define your queries
mkdir searches
cat > searches/main.json <<EOF
{ "queries": [
  {"id": "main", "title": "Soil microbiome studies",
   "query": "(soil OR rhizosphere) AND (microbiome OR microbiota)"}
]}
EOF

# Day 1, afternoon: ingest
biblion search searches/main.json --sub-limit 500 --year-min 2010
biblion qc                         # see the raw count

# Day 1, evening through Day 2: enrich
biblion enrich
# (let it run overnight; Ctrl-C in the morning)
biblion qc                         # see the metadata coverage now

# Day 2: discover related work
biblion hop --limit 5000           # hop first 5k papers as a sanity check
biblion qc                         # corpus has grown via stubs
biblion enrich                     # fill in the stubs (much faster now)

# Day 3: query the database
sqlite3 ./soil.db
sqlite> SELECT year, COUNT(*) FROM papers WHERE abstract IS NOT NULL
        GROUP BY year ORDER BY year;
```

---

## 12. Stopping and resuming

Every long-running command (`enrich`, `hop`, `search`) is **safely
interruptible**. The merge writer is the only process that touches the
database, and it commits in small batches.

### Stopping

- **Ctrl-C once** — graceful shutdown. Producers stop pushing new work,
  the cache drains, the daemons exit. Wait for it to finish; this can
  take 30-60 seconds.
- **Ctrl-C twice** — SIGKILL everything. Use this only if a graceful
  shutdown hangs. The database is still consistent thanks to SQLite WAL,
  but you'll have some "claimed" rows in the claims DB that need to be
  released. biblion auto-reaps stale claims after 60 minutes; or you can
  run the SQL in [§14 Troubleshooting](#14-troubleshooting).

### Resuming

Just re-run the same command. biblion tracks state per-paper and
per-search-query, so it picks up where it left off:

- `search` re-reads Redis checkpoints and skips completed sub-queries.
- `enrich` queries the claims DB and skips papers already successfully
  attempted by each service.
- `hop` queries the claims DB for the `s2_hop` service and skips
  already-hopped papers.

You can run them in any order, any number of times.

---

## 13. Working with the database

biblion writes to a standard SQLite database. Open it with any tool:

```bash
sqlite3 ~/biblion.db
```

### Key tables

- **`papers`** — one row per paper. Columns: `id`, `doi`, `oa_id`,
  `s2_id`, `pubmed_id`, `title`, `abstract`, `year`, `venue`, `authors`
  (JSON), `is_stub`, `is_seed`, `source`, plus `raw` (the original API
  payload as JSON for forensic inspection).
- **`citations`** — confirmed edges. Columns: `citing_id`, `cited_id`.
- **`citation_counts`** — derived in/out-degree per paper.
- **`pending_citations`** — discovered citations whose endpoints aren't
  both in `papers` yet. Promoted to `citations` automatically once both
  ends exist.
- **`field_conflicts`** — audit log of fields where two sources
  disagreed. Useful for understanding data provenance issues.

The technical guide (coming soon) has the full schema.

### Useful queries

```sql
-- How many papers per source query?
SELECT json_extract(raw, '$.query_id') AS q, COUNT(*)
FROM papers GROUP BY q ORDER BY 2 DESC;

-- Most-cited papers in the corpus
SELECT p.title, c.in_degree
FROM citation_counts c JOIN papers p ON c.paper_id = p.id
ORDER BY c.in_degree DESC LIMIT 20;

-- Papers from one venue, by year
SELECT year, COUNT(*) FROM papers
WHERE venue LIKE '%Nature%' GROUP BY year ORDER BY year;
```

### Backups

WAL-mode SQLite is safe to copy while the database is in use, but the
simplest backup is:

```bash
# while biblion is NOT running:
cp ~/biblion.db ~/biblion-backup-$(date +%F).db
```

For live backups, use `sqlite3 ~/biblion.db ".backup ~/backup.db"`.

---

## 14. Advanced commands

biblion has more producer modules than the primary CLI exposes. They're
available under `biblion advanced`:

```bash
biblion advanced list             # every registered module + its contract
biblion advanced plan <module>    # execution order for a target
biblion advanced run <module>     # run one module in-process
biblion advanced daemon mod1 mod2 # supervise a custom producer set
biblion advanced start <module>   # one-shot: spawn daemons, run, drain, stop
biblion advanced bulk papers      # stream the Semantic Scholar Datasets API
```

Useful examples:

```bash
# What modules exist?
biblion advanced list

# Bulk-import everything from the Semantic Scholar Datasets API.
# This is the fastest way to backfill a large corpus.
biblion advanced bulk papers

# Custom daemon: only resolve DOIs, no enrichment
biblion advanced daemon resolve_dois_oa resolve_dois_s2

# Enrich stubs only (after a big hop)
biblion advanced run enrich_stubs_oa
```

See the technical guide (coming soon) for a full module catalogue.

---

## 15. Troubleshooting

### "biblion: no database path configured"

You haven't set `BIBLION_DB`. Either run `biblion init PATH`, set the
env var (`export BIBLION_DB=...`), or pass `--db PATH` to the command.

### "Existing merge daemons found"

A previous `biblion enrich` didn't shut down cleanly. Find and kill the
stragglers:

```bash
pgrep -af 'biblion.merge'
kill -9 <pids>
```

Then if you had a hard crash, release any stuck claims so re-running
doesn't skip papers stuck in the `claimed` state:

```bash
sqlite3 ~/biblion_claims.db \
  "UPDATE enrichment_attempts SET status='failed', finished_at=datetime('now')
   WHERE status='claimed'"
```

### Producers respawn endlessly with `noop` results

This is expected when there's no work left for that producer (e.g., every
paper with a DOI has already been enriched). The supervisor will keep
restarting them with exponential backoff up to 60s — harmless but noisy.
If you want them to stop, Ctrl-C the `enrich` command; the corpus is fine.

### Cache queues growing without bound

If `biblion qc` shows huge cache lengths (visible during `enrich` in the
supervisor output), the merge writer can't keep up. Stop everything, then:

1. Check the run log `<db-dir>/logs/biblion_*.log` for `[merge writer]`
   errors (`grep '[merge writer]' <logfile>`).
2. Check disk space — WAL mode can briefly double DB size.
3. Ensure nothing else is holding a write lock on the database.

### `database is locked` errors

biblion serialises all writes through one process, so this should be
rare. It usually means another process (often an interactive `sqlite3`
session in another terminal that's in the middle of a transaction) is
holding a write lock. Find and close it.

### `pending_citations` is huge

This is normal and expected. Every newly discovered paper has ~30-50
references, most pointing to papers not yet in your corpus. They live in
`pending_citations` until both endpoints exist. The pending resolver
sweeps continuously and promotes them as soon as possible.

### Tests fail with Redis errors

The pytest suite uses Redis db=15 by default to stay clear of production
data. Set `BIBLION_TEST_REDIS_URL=redis://localhost:6379/15` (or any
spare db) if you want to override.

---

For deeper questions about architecture, schema, or extending biblion
with new modules, see the **Technical Guide** (coming soon).
