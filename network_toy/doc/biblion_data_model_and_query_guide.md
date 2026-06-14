# biblion data model & query guide

> For a fresh Claude Code session (or a human) that needs to **read information
> out of a biblion database**. This describes the SQLite schema as it actually
> exists, the meaning of each table, the JSON-shaped columns, and ready-to-run
> query recipes. It is descriptive, not a spec — verify against the live DB
> with `.schema` if in doubt.

## Where the database is

A biblion DB is a single SQLite file. Its path is **not** hardcoded — it comes
from the `BIBLION_DB` environment variable or `--db PATH`. There is a sibling
`<db>_claims.db` (enrichment bookkeeping) that you rarely need for analysis.

```bash
# point everything at a DB
export BIBLION_DB=testdb/test.db

# open it read-only for ad-hoc queries (safe while the pipeline runs)
sqlite3 "file:$BIBLION_DB?mode=ro"
```

The pipeline runs in WAL mode, so read-only connections see a consistent
committed snapshot without blocking writers. Prefer `mode=ro` for analysis.

The built-in coverage snapshot is the fastest orientation:

```bash
biblion --db "$BIBLION_DB" qc
```

## The tables (live schema)

### `papers` — one row per unique work (the canonical record)

The hot table. One row per deduplicated paper. Any of the three identifiers may
be NULL but at least one is set once the merge writer has touched the row.

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | surrogate key; all joins use this |
| `doi` | TEXT | unique when present |
| `s2_id` | TEXT | Semantic Scholar paper id; unique when present |
| `oa_id` | TEXT | OpenAlex Work id (e.g. `W123…`); unique when present |
| `title` | TEXT | |
| `year` | INTEGER | publication year (see caveat below) |
| `venue` | TEXT | journal/venue display string |
| `authors` | TEXT | **JSON array of display-name strings** (see JSON columns) |
| `abstract` | TEXT | |
| `pub_type` | TEXT | canonicalized: lowercase, no punctuation (`journalarticle`, `preprint`, …) |
| `publication_date` | TEXT | ISO `YYYY-MM-DD` when known |
| `is_open_access` | INTEGER | 0/1, NULL if unknown |
| `influential_cit_count` | INTEGER | S2's "influential citations" subset |
| `s2_fields_of_study` | TEXT | **JSON array of `{category, source}`** |
| `pubmed_id`, `pubmed_central_id` | TEXT | |
| `is_seed` | INTEGER | 1 = came from the user's imported reference set |
| `is_stub` | INTEGER | 1 = only identifier(s) known, not yet enriched |
| `is_rejected` | INTEGER | 1 = filtered out (patent/proceedings/etc.) |
| `discovery_count` | INTEGER | how many times this paper was independently discovered |
| `created_at`, `updated_at` | TEXT | ISO timestamps |

Filter `is_rejected = 0` for "real" papers; `is_seed = 1` for the original
literature set; `is_stub = 0` for enriched rows.

### `citations` — the directed citation graph (resolved edges)

One row per edge where **both** endpoints exist in `papers`.

| column | notes |
|---|---|
| `citing_id` | papers.id of the citing paper |
| `cited_id` | papers.id of the cited paper |
| `provenance` | which source produced the edge (`oa_references`, `s2_references`, `oa_incoming`, …) |
| `discovered` | timestamp |

PK is `(citing_id, cited_id)`. Direction is **citing → cited**: the citing
paper references the cited paper. Indexed both ways (`idx_cit_citing`,
`idx_cit_cited`).

### `pending_citations` — edges with a missing endpoint

Edges discovered before both endpoints were in `papers`. Stored by **identifier**
(not paper id) because the endpoint isn't resolved yet. A sidecar resolver
promotes these into `citations` once both ends arrive. This table is large by
design (incoming-citation collection parks a lot here). Endpoints:
`citing_doi/s2_id/oa_id`, `cited_doi/s2_id/oa_id`.

### `citation_counts` — per-source metric, never reconciled

| column | notes |
|---|---|
| `paper_id` | papers.id |
| `source` | `openalex` \| `s2` (bucketed) |
| `cit_count`, `ref_count` | as reported by that source |
| `fetched_at` | timestamp |

PK `(paper_id, source)`. This is the **observational** class: different sources
legitimately disagree, so we keep all numbers. To "the citation count" for a
paper, pick a source deliberately (see recipes) — do not sum across sources.

### `field_observations` — per-(paper, field, source) provenance

The substrate behind conflict resolution. One row per **(paper, field, source)**
= the latest value that source observed for that field.

| column | notes |
|---|---|
| `paper_id` | papers.id |
| `field` | `doi`/`s2_id`/`oa_id`/`title`/`year`/`venue`/`authors`/`pub_type`/`publication_date`/`is_open_access`/`pubmed_id`/`pubmed_central_id` |
| `value` | the **canonical/comparison form** (case-folded for title/venue, JSON for authors, scalar for year/ids) |
| `raw_value` | the value **as observed** (use this for display/forensics) |
| `source` | the raw producer source string (e.g. `oa_works_doi`, `s2_batch`, `ris:<file>`); `_incumbent` marks a value backfilled from the old `papers` row whose true source was never recorded |
| `pub_type_hint` | the observing record's pub_type at observe time |
| `observed_at` | timestamp |

PK `(paper_id, field, source)`. The canonical `papers` value is *derived* from
these by resolving each field through its class (see "How resolution works").
Map a raw `source` to its trust bucket with `biblion.db._source_bucket()`.

### `field_class` & `source_trust` — declarative resolution config

- `field_class(field, class)` — each field's resolution class:
  `representational` | `authoritative` | `observational`.
- `source_trust(source, rank)` — lower rank = more trusted.
  Seeded: `crossref=1, openalex=2, s2=3, ncbi=4, seed=5`.

These are small lookup tables; read them to understand how a field resolves.

### `field_conflicts` — append-only audit log

Historical record of disagreements seen by the merge writer. **It is NOT the
current conflict set** — it never shrinks, even after a value is re-resolved.
For "what still genuinely conflicts," recompute from `field_observations` (the
`qc` command does this; see `_live_conflicts_by_field` in `biblion/__main__.py`).
Columns: `paper_id, field, existing_value, proposed_value, proposed_source,
discovered_at`.

### `module_runs` — orchestrator run state

One row per module invocation: `status`, `started_at`, `finished_at`,
`stats_json`, `error`. Useful for "did the last enrich finish / what failed,"
not for bibliographic analysis.

## JSON-shaped columns

Two `papers` columns hold JSON; use SQLite's `json_*` functions or parse in
Python.

- **`papers.authors`** — array of display-name strings, e.g.
  `["E. H. Bredda", "Aneirson Francisco da Silva", "M. B. Silva"]`.
  Names are kept **verbatim** (not reformatted). Some are `Family, Given`,
  some `Given Family`, some initials — by design (see the conflict-resolution
  doc; order is not guessed).
- **`papers.s2_fields_of_study`** — array of objects, e.g.
  `[{"category": "Environmental Science", "source": "external"}, …]`.

```sql
-- authors as a count
SELECT id, json_array_length(authors) AS n_authors
FROM papers WHERE authors IS NOT NULL LIMIT 5;

-- explode authors (one row per author)
SELECT p.id, je.value AS author
FROM papers p, json_each(p.authors) je
WHERE p.authors IS NOT NULL LIMIT 20;

-- papers in a field of study
SELECT DISTINCT p.id, p.title
FROM papers p, json_each(p.s2_fields_of_study) fos
WHERE json_extract(fos.value, '$.category') = 'Environmental Science';
```

## How resolution works (so you trust `papers` values)

`papers` is a **projection**. When multiple sources report a field, the merge
writer resolves it by the field's class:

- **representational** (`title`, `venue`, `pub_type`, `authors`): canonicalize
  (case/whitespace/punctuation folded); if equal after that → done. If
  genuinely different → the highest-trust source's string wins. `authors` uses
  token-set matching and keeps the fullest name verbatim.
- **authoritative** (`doi`, `s2_id`, `oa_id`, `year`, `publication_date`,
  identifiers, `is_open_access`): "prefer version-of-record over preprint" rule
  (currently inert — pending preprint/VoR detection), then highest-trust source.
- **observational** (citation counts): never collapsed — kept per-source in
  `citation_counts`.

**Important caveat on `year` / `publication_date`:** these are
*version-sensitive*. A year disagreement is often the preprint-vs-VoR gap (the
preprint has an earlier year). Until preprint/VoR detection lands, biblion does
**not** overwrite `papers.year` from conflicting sources — it keeps the
incumbent and records the alternatives in `field_observations`. So
`papers.year` may be a first-seen value, and the disagreements live in
`field_observations` / surface in `qc` as unresolved. Treat year as provisional
where multiple year observations exist.

## Query recipes

### Coverage / sanity

```sql
-- how complete is the corpus?
SELECT
  COUNT(*)                                            AS papers,
  SUM(doi      IS NOT NULL)                           AS with_doi,
  SUM(abstract IS NOT NULL)                           AS with_abstract,
  SUM(is_seed = 1)                                    AS seeds,
  SUM(is_stub = 1)                                    AS stubs
FROM papers WHERE is_rejected = 0;
```

### Citation graph

```sql
-- most-cited papers IN THIS CORPUS (incoming edges we actually hold)
SELECT p.id, p.title, COUNT(*) AS cited_by
FROM citations c JOIN papers p ON p.id = c.cited_id
GROUP BY c.cited_id ORDER BY cited_by DESC LIMIT 20;

-- what a given paper cites
SELECT p2.title
FROM citations c
JOIN papers p2 ON p2.id = c.cited_id
WHERE c.citing_id = :paper_id;

-- who cites a given paper
SELECT p1.title
FROM citations c
JOIN papers p1 ON p1.id = c.citing_id
WHERE c.cited_id = :paper_id;

-- reference / citation counts AS REPORTED by a chosen source
SELECT p.id, p.title, cc.cit_count, cc.ref_count
FROM papers p JOIN citation_counts cc
  ON cc.paper_id = p.id AND cc.source = 'openalex';
```

Note: `COUNT(*)` over `citations` is "citations **within the corpus**", which
is much smaller than the world citation count in `citation_counts`. Use the
right one for the question.

### Provenance — where did a value come from?

```sql
-- every source's view of one paper's year
SELECT source, value, raw_value, observed_at
FROM field_observations
WHERE paper_id = :paper_id AND field = 'year'
ORDER BY observed_at;

-- fields where sources still disagree for a paper (distinct values per field)
SELECT field, COUNT(DISTINCT value) AS n_distinct
FROM field_observations
WHERE paper_id = :paper_id
GROUP BY field HAVING n_distinct > 1;
```

### Finding unresolved disagreements (the live set)

Do **not** count `field_conflicts` rows — they're history. Recompute:

```sql
-- candidate groups: a paper/field seen by >1 source
SELECT paper_id, field, COUNT(DISTINCT source) AS n_src,
       COUNT(DISTINCT value) AS n_val
FROM field_observations
GROUP BY paper_id, field
HAVING n_src > 1 AND n_val > 1;
```

Whether a given group is "still a conflict" depends on the resolution rules
(trust can settle a divergence cleanly). The authoritative answer is the Python
resolver: `biblion.merge.resolve.resolve(field, observations)` returns
`Resolution(value, conflict)`, where `conflict` is non-None only when no
confident winner exists. `biblion/__main__.py:_live_conflicts_by_field` shows
the exact pattern (and treats `year`/`publication_date` as live-on-any-
disagreement because their resolution is deferred).

## Doing analysis in Python

```python
import sqlite3, json, os
conn = sqlite3.connect(f"file:{os.environ['BIBLION_DB']}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

# authors of every seed paper, parsed
for r in conn.execute("SELECT id, authors FROM papers WHERE is_seed=1 AND authors IS NOT NULL"):
    names = json.loads(r["authors"])
    ...

# reuse the project's resolver / bucketing
from biblion.merge.resolve import resolve, Observation
from biblion.db import _source_bucket
```

Run analysis scripts with the conda env active (the user activates it) and
`BIBLION_DB` set. Keep connections read-only; the merge writer is the only
intended writer to the main DB.

## Gotchas

- **`pub_type` is canonicalized** in `papers` (`journalarticle`, not
  `Journal Article`). Match against the folded form, or read `raw_value` from
  `field_observations` for the original.
- **`citations` ≠ world citation count.** It's intra-corpus edges. World counts
  live in `citation_counts`, per source.
- **`pending_citations` is huge and identifier-keyed.** Don't join it to
  `papers` expecting resolved ids; it exists precisely because ids aren't
  resolved yet.
- **`year` is provisional under disagreement** (preprint/VoR not yet modelled).
- **`field_conflicts` only grows.** For "current" conflicts, recompute from
  observations.
- **`authors` are verbatim, mixed formats**, and name order is intentionally
  not normalized — don't assume `Family, Given`.
