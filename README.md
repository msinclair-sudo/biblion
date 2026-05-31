# biblion

**Build and maintain a citation graph from OpenAlex, Semantic Scholar, and NCBI.**

biblion ingests papers from boolean-keyword searches, follows citation links
between them, and enriches each paper with metadata from multiple public
sources. It writes everything into a single SQLite database that you can
query, analyse, or hand off to downstream tools.

The pipeline is built around a single-writer SQLite model and a Redis cache,
so producers can run in parallel without contending for the database lock.

> **Status:** beta. The pipeline has been running continuously against a
> 2M-paper / 23M-citation corpus.

---

## Install

```bash
pip install git+https://github.com/msinclair-sudo/biblion.git
```

Or from a local clone:

```bash
git clone https://github.com/msinclair-sudo/biblion.git
cd biblion
pip install -e .
```

### Requirements

- Python ≥ 3.11
- A running Redis server (default: `redis://localhost:6379/0`)
- Optional API keys for OpenAlex, Semantic Scholar, and NCBI (free-tier
  limits apply without them)

---

## A 60-second tour

```bash
# 1. Create a database and a .env scaffold
biblion init ~/biblion.db

# 2a. Ingest from a boolean-keyword search file …
biblion search searches/example.json

# 2b. … or import an existing reference list (Zotero, EndNote, Mendeley)
biblion import library.ris

# 3. Enrich with metadata (Ctrl-C to stop)
biblion enrich

# 4. Discover cited / citing papers
biblion hop

# 5. Snapshot the corpus
biblion qc
```

That's the whole primary surface. Lower-level commands live under
`biblion advanced`.

---

## Documentation

- **[User Guide](docs/user_guide.md)** — end-to-end walkthrough of the
  five primary commands, search-file format, configuration, day-to-day
  operations, troubleshooting.
- **Technical Guide** *(coming soon)* — architecture, module contracts,
  database schema, extending the pipeline.

---

## License

MIT — see [LICENSE](LICENSE).
