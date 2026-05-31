# Changelog

All notable changes to **biblion** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]
### Added
- **Named project registry** for working with multiple databases. Register DBs
  by name and switch between them git-style: `biblion project add <name>
  <path>`, `biblion use <name>`, `biblion project list/current/remove`. DB
  resolution precedence is `--db` > `$BIBLION_DB` > current registered project,
  so explicit choices always win and concurrent runs on different DBs stay
  isolated. `biblion init` auto-registers the new DB and sets it current
  (`--name` / `--no-register` to control). Registry lives at
  `~/.config/biblion/projects.json` (override via `$BIBLION_CONFIG`).
- **Per-field provenance + class-based field resolution** (conflict-resolution
  steps 1+2). New tables `field_observations` (one row per paper/field/source),
  `field_class` (declarative field -> resolution class), `source_trust`
  (declarative source -> trust rank). The merge writer records every observed
  field and derives the canonical `papers` value via the field's class:
  representational fields canonicalize (venue/pub_type/title), authoritative
  fields resolve by a "prefer version-of-record over preprint" rule then source
  trust (crossref > openalex > s2 > ncbi > seed), citations stay observational.
  See `docs/conflict_resolution_discussion.md`.
- **Author resolution** by order-independent, initial-compatible token-set
  matching: a full name beats a same-letter initial; the fullest observed
  string is kept verbatim (no reformatting/reordering). Eastern-vs-Western
  order disagreements (`Chang Haixing` vs `Haixing Chang`) that can't be
  disambiguated from the name alone are logged as a conflict with the incumbent
  kept (venue-based order resolution deferred). Author lists sharing zero
  tokens with the incumbent (upstream mis-association) are skipped.
- `biblion backup --backup <path>` — online-backup snapshot of the DB and its
  claims sidecar, safe to run while the pipeline is live.
- `biblion advanced backfill-observations [--apply] [--apply-identifiers]` —
  rebuilds `field_observations` from existing `papers` + `field_conflicts` and
  re-resolves, with NO API calls (mines what the old first-write-wins writer
  already captured). Dry-run by default; identifier fields require an explicit
  opt-in to apply.
- **Incoming citations during enrichment** (who cites this paper, not just who
  it cites). Citation edges were already directional in storage
  (`citations.citing_id -> cited_id`), but the enrichers only pushed outgoing
  references. Now:
  - `enrich_metadata_s2` also requests `citations.externalIds` and builds the
    reverse edges — free, same batch call.
  - New `expand_incoming_oa` producer (service `oa_incoming`, in the default
    `enrich` set) queries OpenAlex's `cites:` filter per paper (cursor-
    paginated through all citers) and pushes incoming edges.
  Edges are identifier-only — no citer metadata is fetched. A citer already in
  the corpus becomes a real edge; an unknown one parks in `pending_citations`
  (promoted later if that paper arrives). Expect pending-edge counts to grow
  substantially, by design. Note: `expand_incoming_oa` adds one paginated OA
  query per paper, so a full enrich run is heavier on OpenAlex budget.
- `biblion hop --seeds` hops only seed papers (`is_seed=1`). Implemented as a
  seeds-filtered variant of the citation-hop candidate query that shares the
  `s2_hop` service, so hop-tracking is unified — a seed already hopped (by the
  full hop or a prior `--seeds` run) won't be re-hopped, and the run is
  resumable. Explicit `--target`/`--targets-file` still take precedence.
- **NCBI/PubMed abstract enricher** (`enrich_metadata_ncbi`, service `ncbi`):
  a third metadata source alongside OpenAlex and Semantic Scholar. It fetches
  abstracts (and title/year) from PubMed via E-utilities `efetch`, targeting
  papers that still lack an abstract and are reachable in PubMed — either they
  carry a `pubmed_id`, or their DOI resolves to one via `esearch`. PubMed
  often holds abstracts the other two sources lack (publisher-deposit gaps),
  so under the per-field claim model it fills the remaining abstract holes
  after OA/S2 have run. Added to the default `enrich` producer set. The NCBI
  client gains `fetch_abstracts_by_pmid` (efetch + structured-abstract XML
  parsing) and `pmids_for_dois` (esearch DOI→PMID). The efetch parser also
  harvests every identifier PubMed returns — PMID, PMCID, and DOI — onto the
  paper (no extra API calls), so a paper reached by one identifier gains the
  others as additional handles for future requests.
- `searches/example.json` factorial sample search file so the README
  60-second tour runs as written; in `--mode expand` its two queries fan
  out into 60 distinct Semantic Scholar searches.
- Live QC dashboard during `enrich` / `advanced daemon`, rendered with
  [Rich](https://github.com/Textualize/rich): a full-screen, scroll-locked
  panel showing coverage, enrichment-attempt counts, a per-module health
  table, uptime, and a rolling count of producer errors in the last 10
  minutes plus the log directory. Rich crops to the window and reflows on
  resize, so it never overflows or garbles regardless of terminal size; the
  full text QC report still prints once on exit. Falls back gracefully if
  Rich is unavailable.
- The dashboard's module view shows **one row per module** with a **live**
  status derived from the supervisor's ground truth — process alive/dead plus
  enrichment-attempt activity for its service — labelled `working`, `idle`, or
  `down`, with `in-flight` (claims a producer holds mid-batch), `did (5s)`
  (settled this tick), `settled total`, and a per-session restart count. A
  module counts as `working` if it has in-flight claims OR settled work within
  a rolling window, so a producer mid-batch on a slow API round-trip (OpenAlex
  flushes a 50-DOI batch only every ~2 min) reads `working` throughout instead
  of falsely flickering `idle` between flushes. This replaces both the old
  "last 10 runs" log and a first attempt that read `module_runs.status`
  (looping producers sit in `running` for minutes, then show `orphaned` after
  a restart, so it never reflected current activity). The one-shot `qc`
  command still summarises `module_runs` history.
- The dashboard now shows **remaining claimable work** per module and a
  `done` status, plus an "all producers caught up" banner when nothing is
  left to claim — so completion is distinguishable from a stall. `count_remaining`
  in `framework/claims.py` reuses the exact per-field eligibility predicate as
  the claim flow, so "remaining" matches what producers would actually claim.
- `tests/unit/test_producer_cmd.py` regression test pinning the producer
  subprocess argv and asserting the CLI parser accepts it.
- `tests/unit/test_rich_dashboard.py` smoke tests for the live dashboard
  renderable.
### Dependencies
- Added `rich>=13.0` (powers the live `enrich` dashboard).
### Changed
- A supervised run now **releases all in-flight claims on shutdown** (Ctrl-C
  or natural completion), via `release_all_claims`. Previously, a producer's
  claimed-but-unfinished papers sat `claimed` and were blocked from re-claim
  until the 60-minute stale-claim sweep — so an interrupted run left work
  stuck for the next one. (A hard `kill -9` still can't run cleanup; the
  stale-claim sweep remains the backstop for that.)
- All subprocess logging for a run now goes to **one central file**
  (`biblion_<timestamp>.log`) instead of one file per module per restart.
  Each line is tagged with its source (`[enrich_metadata_oa] ...`,
  `[merge writer] ...`), so per-module filtering is still a `grep` away.
  Restarts append to the same file rather than spawning new ones. Applies to
  `enrich`, `advanced start`, `advanced daemon`, and `advanced bulk`.
- Redis-dependent commands now fail fast with an actionable message when
  Redis is unreachable, instead of surfacing a raw redis-py traceback.
### Fixed
- Producers that aren't field-partitioned (the hop, DOI resolvers, stub
  enricher) still passed bare paper-id lists to `report_marks` after the
  per-field-claims change, crashing with `'int' object is not iterable` the
  moment their claim-flow mark path ran (e.g. `biblion hop --seeds`). They now
  report `(paper_id, '_all')` pairs like the field-partitioned producers.
- `enrich` / `advanced daemon` / `advanced start` spawned producers with a
  bare top-level `run` subcommand, which no longer exists after the
  citgraphv3 -> biblion rename; every producer subprocess exited with
  argparse code 2 and crash-looped. They now spawn `advanced run`.
### Removed
- The "Recent module runs (last 10)" section is gone from `biblion qc` and the
  end-of-run summary — its `running`/`orphaned` rows were stale and
  misleading. Run history is still in the `module_runs` table.
- A producer that cleanly runs out of claimable work (exits 0 / noop) is now
  **parked** rather than treated as a crash: the supervisor stops counting it
  as a restart/error and rechecks it for work on a slow (60s) heartbeat
  instead of respawning it immediately. Previously a finished run showed as
  `down` with a climbing restart count and inflated `errors(10m)`, making
  completion look like failure. Nonzero exits are still real crashes (backoff
  + restart).
- Enrichment claims are now tracked per **(paper, service, field)** instead
  of per (paper, service). Previously, once any service "succeeded" on a
  paper, every other service skipped it entirely — so OpenAlex never tried
  for an abstract on papers where Semantic Scholar had already filled
  author/venue/year (S2 often lacks abstracts). The cross-service
  "already succeeded elsewhere" skip is gone; the `papers` table's
  `field IS NULL` is the source of truth for what's still needed, and each
  source fills whatever fields it can, additively. This was capping abstract
  coverage well below what the sources actually offer.
- Failed per-field attempts are now retriable on a timestamp
  (`BIBLION_ENRICH_RETRY_DAYS`, default 180) so abstracts that upstream
  sources backfill over time get picked up on later runs, without
  re-spending API budget every pass.
### Migration
- The `enrichment_attempts` claims table gains a `field` column (new primary
  key `(paper_id, service, field)`). `biblion` migrates an existing
  `*_claims.db` in place on next startup, mapping legacy rows to the `_all`
  sentinel field (audit-preserving, non-blocking). Idempotent.

## [0.1.0] - 2026-05-30
### Added
- Initial public release.
- DAG-orchestrated, contract-driven citation graph pipeline.
- Producers for OpenAlex, Semantic Scholar, and NCBI; single-writer SQLite merge layer; Redis-backed cache.
- Primary CLI: `biblion init | import | search | hop | enrich | qc`, with a
  power-user surface under `biblion advanced` (`list | plan | run | start |
  daemon | bulk`).
- Adaptive rate limiting with anonymous-key fallback for OpenAlex and Semantic Scholar.
- pytest test suite (unit / integration / perf markers).
