# Data ingest — how the toy reads data in (current state)

Reference doc for the three Layer-1 sources the toy can ingest from:
the `toy` Gaussian-mixture generator, the `real` JSON+npy fixture, and
the `sqlite` biblion corpus (the last shipped 2026-06-01 —
`app/src/datasource/sqlite.js`). Describes the Layer-1 contract every
source must satisfy, what each existing source loads and from where,
and what each downstream consumer needs. The high-dim embedding stays
a **separate** `.npy` artifact (not in the db) — both `real` and
`sqlite` assume that split.

> **Ghost nodes:** `biblion advanced snapshot --include-structural` widens the
> node set to include metadata-less citation participants (`structural`, surfaced
> as `isGhost`). They are emitted as the **last** node indices with **no**
> embedding row, so `embeddings.npy` stays a contiguous `m × d` block (`m` =
> embedded count) while `citationEdges` still carries their edges. Positioning +
> clustering treatment: `doc/ghost-nodes.md`.

---

## 1. The Layer-1 output contract

`app/src/datasource/contract.js` — every source's `produce(params)` returns:

```
{
  nodes: [{
    id:        int,            // MUST be contiguous 0..n-1, id === array index
    t:         number ∈ [0,1], // publication-year normalised (newest→1, oldest→0)
    originId?: int | null,     // toy ground-truth label; null for real
    basePos?:  [x,y,z],        // optional per-node viz position (toy supplies; real omits)
    year?:     int | null,     // real adds this (not validated by the contract)
    paperId?:  string | null,  // real adds this (external paper id; not validated)
  }],
  origins?:   [{id, centre, spread, colour}],   // toy ground-truth mixture; null for real
  embedding?: { d:int, data: Float32Array(n*d) },// high-dim feature vectors per node
  basePos?:   Float32Array(n*3),                 // optional flat viz buffer
  method?:    string,                            // source id echoed back
  params?:    object,                            // echo of resolved params
}
```

**Hard rules** (validated, `validateDataSourceResult`):
- `nodes` non-empty; `nodes[i].id === i`; `nodes[i].t` finite.
- `embedding.data.length === n*d`; `basePos.length === n*3` when present.
- At least one of **per-node basePos**, **flat basePos**, or **embedding**
  must exist (else Layer 1.5 has nothing to reduce).
- `year` / `paperId` / any other per-node field are **passed through
  untouched** — the contract doesn't validate them, downstream consumers
  read them opportunistically. **This is where new fields (title, authors,
  venue, …) get added: just put them on the node object.**

Registration: one entry in `app/src/datasource/registry.js`
`DATA_SOURCES[]` — `{ id, label, description, defaultParams, produce,
modalSchema }`. The shipped registrations are `toy`, `real`, and
`sqlite`. Adding any new source = one new entry; no consumer changes
for the contract fields.

---

## 2. What the `real` source loads today

`app/src/datasource/real.js` → `produceReal(params)`. Files live under
`/literture-network/artifacts/<subset>/` (the static server is rooted at
the repo root, so they resolve alongside `/app/`). Per subset:

| File | Format | Purpose | Optional? |
|---|---|---|---|
| `expanded_embeddings.npy` | NumPy `<f4`, shape `(n, 768)` | the SPECTER2 embedding | **required** |
| `expanded_embeddings_paper_index.json` | `{ "<i>": "<paperId>" }` | node index → external paper id | **required** |
| `paper_years.json` | `{ "<i>": <year> }` | per-node publication year | optional (404 → `t=0`, `year=null`) |
| `citation_edges.json` | `{ edges: [[src,dst],…], meta }` | citation edges | optional (404 → no fusion/layout) |

Notes:
- The `.npy` is parsed by a hand-rolled reader (`parseNpy`) — only `<f4`
  dtype, 2-D shape. Embedding is the one artifact that stays a **file**,
  separate from the db.
- `t` is computed by min–max normalising `year` across the subset.
- **Citation edge direction**: on disk it's citgraphv2's "source is *cited
  by* target"; the toy contract is the reverse ("source cites target").
  Layer 3 (`citations/`) flips on materialisation. Fusion's symmetric
  diffusion doesn't care, so `real.js` passes edges through as-stored,
  flattened to `[src,dst,src,dst,…]` in `result.citationEdges`.

`produceReal` returns nodes as `{ id, t, year, paperId }` + `embedding
{d:768,data}` + `citationEdges` (flat). **No basePos** — the viewer stays
empty until Layer 1.5's viz sub-stage fits a 3-D reduction.

---

## 3. Engine ingest → state slots

`app/src/ui/engine.js` → `ingestDataOnly()` packs the source result into
the legacy state slots (`update({...})`):

| State slot | From | Consumed by |
|---|---|---|
| `state.genResult` | the whole source result (incl. `nodes`) | everything — `nodes[i].year`, `.paperId`, `.t` |
| `state.embedding` | `result.embedding` | dim-reduction (L1.5); labelling `representative` |
| `state.rawCitationEdges` | `result.citationEdges` (flat) | fusion (graph-diffusion), citation layout (L3/L4) |
| `state._basePos` | packed per-node basePos (toy) / `null` (real) | viewer; blend |

---

## 4. Who needs what (consumer ↔ source field matrix)

| Consumer | Field needed | Source today | Status |
|---|---|---|---|
| Dim-reduction (L1.5) | `embedding {d,data}` | `.npy` | ✅ separate file |
| Fusion / citation layout (L3/L4) | `rawCitationEdges` | `citation_edges.json` (real) / db query (sqlite) | ✅ |
| FR time anchor `t` | `nodes[i].t` (from year) | `paper_years.json` / db | ✅ |
| Labelling · **year** | `nodes[i].year` | `paper_years.json` / db | ✅ |
| Labelling · **representative** | `embedding` + `nodes[i].paperId` | `.npy` + index | ✅ (returns a paperId; the sqlite path can resolve it to a title) |
| Labelling · **c-TF-IDF / TF-IDF** | `ctx.getText(nodeId) → string` | sqlite (`getNodeText`) | ✅ when the `sqlite` source is the active datasource; ❌ on `real` (no titles in the JSON fixture) |
| Per-node display fields | authors, venue, title | sqlite only | ⏳ available in the db; not yet surfaced in any panel beyond labelling |

### Text accessor status

`app/src/labelling/cluster-labels.js` expects `getText: (nodeId) =>
string | null` on its ctx. The wiring landed with the SQLite source:

- `app/src/ui/runners/cluster-labels-runner.js` imports `hasSqliteText` +
  `getNodeText` from `app/src/datasource/sqlite.js` and supplies them as
  `ctx.getText` when the SQLite source is loaded; otherwise leaves it
  `undefined` (and `cTfidf` / `tfidf` report `available:false` with a
  human-readable reason).
- The scoring panel (`app/src/ui/panels/scoring.js`) only consumes
  labels produced by the labelling card upstream — it doesn't need its
  own text accessor.

Result: on the SQLite source, c-TF-IDF / TF-IDF light up automatically;
on the JSON-backed `real` source they stay gated (same reason text). The
text gap is closed *for the path that has a db*; bringing a title
column into the `real` JSON fixture would close it everywhere.

---

## 5. The SQLite source (`datasource/sqlite.js`) — shipped 2026-06-01

`produceSqlite({ dataset })` reads a biblion snapshot in the browser via
`sql.js` (WASM, fetched from esm.sh) and returns the same Layer-1
contract shape as `real`. Today the only registered dataset is `biblion`
(at `/data/biblion/{corpus.sqlite,embeddings.npy,paper_index.json}`); add
more by extending the `DATASETS` table inside `sqlite.js`.

### Inputs

| File | Format | Purpose |
|---|---|---|
| `corpus.sqlite` | sql.js readable snapshot | `papers` (id, year, title, abstract, …) + `citations` (citing_id, cited_id) |
| `embeddings.npy` | NumPy `<f4`, shape `(n, d)` | SPECTER2 embedding — **stays a separate file** by design |
| `paper_index.json` | `{ "<i>": "<paperId>" }` | embedding row → `papers.id` |

### Node-set contract (the hard invariant)

The canonical node set is the `papers` rows passing
`is_rejected = 0 AND is_stub = 0 AND title IS NOT NULL AND abstract IS NOT NULL`,
ordered by `id`. `produceSqlite` re-runs that query, compares row-for-row
against `paper_index.json`, and **fails loud** if they disagree — that's
how it catches an embedding/db drift (e.g. the db was re-enriched without
re-embedding). Rebuild via `biblion advanced snapshot` + `biblion advanced
embedding` to re-align.

### Per-node text (the labelling unlock)

The db handle stays open after `produceSqlite` returns. A prepared
`SELECT title, abstract FROM papers WHERE id = ?` lookup is exposed via
two helpers in the same module:

- `getNodeText(nodeId) → "title. abstract" | null`
- `hasSqliteText() → boolean` (true after the most recent
  `produceSqlite` succeeds)

`app/src/ui/runners/cluster-labels-runner.js` imports both and supplies
`ctx.getText = hasSqliteText() ? getNodeText : undefined` to the
labelling engine. With the SQLite source loaded, c-TF-IDF / TF-IDF light
up automatically; without it (on `real`), they gate off with a
human-readable reason.

### Result shape (what hits state)

`produceSqlite` returns `{ method: "sqlite", params, nodes, embedding,
citationEdges }`:

- `nodes[i] = { id: i, t, year, paperId }` — `t` is min–max-normalised
  `year` across the surviving set.
- `embedding = { d, data }` — straight from the `.npy`.
- `citationEdges` — flat `[src, dst, …]` in **node-index** space.
  Edges whose endpoint falls outside the node set (the abstract filter
  can exclude a paper that citations still reference) are dropped and
  counted in `params.edgesDropped`. biblion's `citing_id → cited_id` is
  already the toy's "source cites target", so **no direction flip**
  (unlike `real`).
- **No `basePos`** — the viewer stays empty until Layer 1.5's viz
  sub-stage fits a 3-D reduction.

---

*Companion: `doc/dynamics.md` (layer index), `doc/multi-level.md`
(multi-level clustering), `doc/ui-architecture.md` (card system).
Current
sources: `datasource/toy.js`, `datasource/real.js`,
`datasource/sqlite.js`. Contract + validator: `datasource/contract.js`.*
