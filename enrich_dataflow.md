# biblion enrich — daemons & data flow

A full map of the `biblion enrich` machinery: every process, every Redis
queue, every table, and the direction data moves. Use it as a checklist when
verifying behaviour.

## 1. The big picture — processes, Redis, SQLite

```
                          EXTERNAL APIs
              (OpenAlex, Semantic Scholar, Crossref, NCBI)
                                 │  fetch
                                 ▼
   ┌───────────────────────────────────────────────────────────┐
   │                      PRODUCERS  (N subprocesses)           │
   │   advanced run <target> --loop                             │
   │   enrich_metadata_oa / _s2 / _ncbi / enrich_biblio_crossref│
   │   resolve_dois_oa / _s2 / via_pmid / via_s2id              │
   │   expand_incoming_oa / expand_papers_s2                    │
   │   resolve_pending_dois / materialize_ghost_stubs           │
   │                                                            │
   │   WRITES TO DB: nothing. Only talks to Redis.              │
   └───────────────────────────────────────────────────────────┘
        │ push records          ▲ claim grants      │ push marks
        │ push claim-requests   │                   │
        ▼                       │                   ▼
  ╔═══════════════════════════════════════════════════════════════╗
  ║                          REDIS  (the cache)                    ║
  ║   namespace:  bib_<sha256(db_path)[:10]>:                      ║
  ║                                                               ║
  ║   staged:papers            staged:citations                   ║
  ║   parked:papers            resolved:papers                    ║
  ║   promote:citations        backfill:pending_dois              ║
  ║   pending_resolver:cursor                                     ║
  ║   claim_request:<svc>   claim_grant:<svc>   result_mark:<svc> ║
  ╚═══════════════════════════════════════════════════════════════╝
     ▲pop/push        ▲pop/push           ▲pop (read-only producer)
     │                │                   │
┌──────────────┐ ┌──────────────┐ ┌────────────────────┐
│ MERGE WRITER │ │  RESOLVER    │ │ PENDING_RESOLVER   │
│ (1 process)  │ │ (1 process)  │ │ (1 process)        │
│              │ │ multi-hit    │ │ promote pending    │
│ THE ONLY     │ │ dedup;       │ │ edges; READ-ONLY   │
│ DB WRITER    │ │ writes DB    │ │ conn, writes       │
│              │ │ directly     │ │ NOTHING to DB      │
└──────┬───────┘ └──────┬───────┘ └─────────┬──────────┘
       │ writes         │ writes            │ reads only
       ▼                ▼                   ▼
  ╔══════════════════════════════════╗   (reads pending_citations)
  ║   SQLite MAIN DB  (<db>.db)       ║
  ║   papers, citations,             ║
  ║   pending_citations,             ║
  ║   field_observations,            ║
  ║   field_conflicts,               ║
  ║   citation_counts, identifiers   ║
  ╚══════════════════════════════════╝
  ╔═══════════════════════════════════╗
  ║  SQLite CLAIMS DB (<db>_claims.db) ║  ← writer ATTACHes main as main_v3
  ║   enrichment_attempts             ║
  ╚═══════════════════════════════════╝
```

Data flow: `producers → Redis → MergeWriter → SQLite`, with Resolver and
PendingResolver as side-loops feeding back through Redis. The claim flow
(`enrichment_attempts`) is brokered *through* the writer — producers
`request_claim` → writer runs the candidate SQL → `ClaimGrant` back.

> **Note on what `cmd_daemon` actually spawns.** `biblion enrich` →
> `cmd_enrich` → `cmd_daemon` spawns only **writer + resolver** (`__main__.py`
> ~1305-1306). The **pending_resolver** is auto-spawned only by
> `_ensure_merge_daemons` (used by `import` / `search` / `hop`), and
> `resolve_pending_dois` is a one-shot producer in `ENRICH_PRODUCERS`. Confirm
> what is really running before trusting the diagram.

## 2. Process read/write roles

| Process | Reads | Writes | Notes |
|---|---|---|---|
| **MergeWriter** (`biblion.merge.writer`) | `staged:papers`, `staged:citations`, `resolved:papers`, `promote:citations`, `backfill:pending_dois`; claim-request queues | **main DB** (`papers`, `citations`, `pending_citations`, `field_observations`, …) **and claims DB** (`enrichment_attempts`) | The **only** writer to both SQLite files. Single-writer invariant. |
| **Resolver** (`biblion.merge.resolver`) | `parked:papers` | main DB (merges multi-hit duplicates, re-homes edges), pushes `resolved:papers` | Own connection — writes directly (the one exception to "writer only," for dedup). |
| **PendingResolver** (`biblion.merge.pending_resolver`) | `pending_citations` (**read-only** conn, `file:...?mode=ro`) | **nothing** — pushes `promote:citations` | Writer applies the promotions. |
| **Producers** (N× `advanced run <t> --loop`) | external APIs; claim grants | **nothing in SQLite** — push records to Redis, push claim-requests/result-marks | Never touch the DB. |

## 3. Redis queue inventory — who pushes, who pops

| Queue (key) | Pushed by | Popped by | Payload |
|---|---|---|---|
| `staged:papers` | producers (`push_paper`) | **writer** | PaperRecord |
| `staged:citations` | producers | **writer** | CitationRecord |
| `parked:papers` | **writer** (multi-hit) | **resolver** | PaperRecord |
| `resolved:papers` | **resolver** | **writer** (drained *first* each cycle) | PaperRecord |
| `promote:citations` | **pending_resolver** | **writer** | PromoteCitationAction |
| `backfill:pending_dois` | `resolve_pending_dois` producer | **writer** | PendingDoiBackfill *(new)* |
| `pending_resolver:cursor` | **pending_resolver** | **pending_resolver** | int (sweep cursor) |
| `claim_request:<svc>` | producers | **writer** | ClaimRequest |
| `claim_grant:<svc>` | **writer** | producer (BLPOP) | ClaimGrant (claimed rows) |
| `result_mark:<svc>` | producers | **writer** | ResultMark (succeeded/failed) |

Every key is prefixed `bib_<hash>:` per-DB, so two corpora on one Redis don't
collide.

## 4. The writer's cycle — exact order of operations

`MergeWriter.run_cycle()` on the **persistent** main connection (`self._conn`):

```
1.  pop resolved:papers      → _process_paper_batch   (guaranteed single-hit)
2.  pop staged:papers        → _process_paper_batch
       ├─ 0 matches → _insert_new()       (new papers row)
       ├─ 1 match   → _apply_single_hit() (observe → resolve → UPDATE, is_stub=0)
       └─ 2+ matches→ park_paper()        → parked:papers  (resolver's job)
3.  pop staged:citations     → _process_citation_batch
       ├─ both endpoints resolve to 1 paper → INSERT citations
       └─ else → INSERT pending_citations
4.  pop promote:citations    → _apply_promote_actions   (INSERT citations + DELETE pending)
4b. pop backfill:pending_dois→ _apply_doi_backfills      (UPDATE pending_citations SET *_doi) [NEW]
    ── conn.commit() ──
5.  _serve_claim_flow()  on self._claims_conn (claims DB + main_v3 ATTACHed)
       for each served module:
         drain claim_request:<svc> → claim_candidates() → push claim_grant:<svc>
         drain result_mark:<svc>   → bulk_mark()
```

Steps 1–4b are one transaction on the main DB; step 5 is separate writes on the
claims DB. Commit happens **before** the claim flow, so the two persistent
connections never self-deadlock.

## 5. The claim flow (how a producer gets work without touching the DB)

```
PRODUCER                         REDIS                         WRITER
   │  request_claim(name, batch)                                 │
   ├──── ClaimRequest ───► claim_request:<svc> ───── pop ───────►│
   │                                                claim_candidates()
   │                                                  on claims DB:
   │                                                  - sweep stale 'claimed'
   │                                                  - run candidate_sql vs main_v3.papers
   │                                                  - INSERT 'claimed' rows per (paper,field)
   │◄─── ClaimGrant ◄──── claim_grant:<svc> ◄──── push ──────────┤
   │  (do API work)                                              │
   ├──── ResultMark ───► result_mark:<svc> ────── pop ─────────►│ bulk_mark()
   │                                                  status→succeeded/failed
```

`enrichment_attempts` states: `claimed` (in-flight, others skip) → `succeeded`
(done, never retried) / `failed` (retriable after `ENRICH_RETRY_DAYS`). Stale
`claimed` rows reaped after 60 min (`_DEFAULT_EXPIRY_MIN`).

**Service pools** (multiple modules can share one budget):

| service | modules |
|---|---|
| `oa` | enrich_metadata_oa, enrich_stubs_oa, resolve_dois_oa |
| `s2_live` | enrich_metadata_s2, resolve_dois_s2, resolve_dois_via_s2id |
| `ncbi` | enrich_metadata_ncbi |
| `ncbi_pmid` | resolve_dois_via_pmid |
| `crossref` | enrich_biblio_crossref |
| `oa_incoming` | expand_incoming_oa |
| `s2_hop` | expand_papers_s2 (+ seeds variant) |

## 6. The pending-citation / ghost lifecycle

```
writer sees edge, one endpoint missing
        │
        ▼
  pending_citations row  (raw identifiers: citing_*/cited_* doi/s2_id/oa_id)
        │
        ├──[A] resolve_pending_dois producer scans OA-only endpoints (no DOI)
        │        → OpenAlex id→DOI (50/call) → backfill:pending_dois
        │        → writer _apply_doi_backfills stamps *_doi on both sides   [NEW]
        │        → an oa-id-only half and an S2 doi half now share a DOI
        │
        ├──[B] materialize_ghost_stubs reads pending endpoints, degree≥2
        │        → pushes is_stub=1 ghost PaperRecords → staged:papers
        │        → writer inserts them as real (leaf) paper rows
        │
        └──[C] pending_resolver sweeps pending_citations (read-only, cursor)
                 → both endpoints now resolve → promote:citations
                 → writer _apply_promote_actions: INSERT citations + DELETE pending
                 (FK IntegrityError = endpoint merged away → keep pending, retry)
```

Ordering in `ENRICH_PRODUCERS` matters: **resolve_pending_dois must run before
materialize_ghost_stubs**, because the degree≥2 ghost threshold is only correct
once cross-source halves are DOI-unified.

## 7. The is_seed=1 leaf-bound gate

The boundary that keeps enrich from crawling the whole graph:

```
              gated AND p.is_seed = 1          NOT gated (whole corpus)
   ┌────────────────────────────────┐   ┌────────────────────────────────┐
   │ enrich_metadata_oa             │   │ resolve_dois_oa / _s2          │
   │ enrich_metadata_s2             │   │ resolve_dois_via_pmid / _s2id  │
   │ expand_incoming_oa (cites)     │   │ enrich_metadata_ncbi           │
   └────────────────────────────────┘   │ enrich_biblio_crossref         │
                                         │ expand_papers_s2 (s2_hop)      │
                                         └────────────────────────────────┘
```

Rationale: enriching a paper's metadata also pulls its `referenced_works` → new
pending endpoints → new ghosts → unbounded BFS. Anchoring on `is_seed` (which
never flips, unlike `is_stub`, which the writer flips to 0 on any touch) keeps
expansion to **1 hop from seeds**. Ghosts stay identifier-only leaves.

Consequence to verify: `resolve_dois_*` resolve DOIs graph-wide, but only seeds
get metadata-enriched. Non-seed papers accumulate DOIs and never get
titles/abstracts/venues. Intentional under this design; the gate is the lever
if that is not the wanted behaviour.

## 8. Single-writer invariant — exceptions

"Only the writer writes" has two documented exceptions, both writing the main
DB directly on their own connections:

- **Resolver** — multi-hit merges (re-homes citations/observations, deletes losers).
- One-shot CLI commands (`clean-titles`, `flag-retractions`, `migrate`,
  `backfill`) write directly too, but are meant to run while daemons are stopped.

The **pending_resolver** is strictly read-only. If it ever holds a write lock,
something regressed.

## 9. Verification checklist

- Is the **pending_resolver actually running** under `enrich`? `cmd_daemon`
  spawns only writer + resolver — pending edges won't promote otherwise.
- Did **`_migrate_citation_attempt_fields`** (relabel `oa_incoming` `_all`→`cites`)
  run on the claims DB? It runs inside `ensure_claims_db`.
- Are non-seed papers stuck **DOI'd-but-unenriched** because of the `is_seed=1`
  gate?
- Is `resolve_pending_dois` running **before** `materialize_ghost_stubs` so the
  degree≥2 ghost count is correct?
```
