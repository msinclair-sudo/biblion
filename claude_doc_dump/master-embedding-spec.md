---
title: Master embedding + multi-corpus exploration — spec sheet
status: vision spec (foundational fact verified; core ops partly built)
updated: 2026-06-13
tags:
  - doc_dump
  - biblion
  - network
  - embedding
destinations:
  - "[[ghost-node-positioning]]"
---

# Master embedding + multi-corpus exploration

## 1. The idea in one line

Keep **one master embedding** (a per-paper "fingerprint book") per text-prep
recipe, grow it forever by appending, and treat every full corpus, subset, and
even multi-database union as a **selection of pages** from it — explored
interactively in the network-toy, where the layout is computed fresh per view.

## 2. The foundational fact (why this works)

SPECTER2 embeds each paper **independently** (title+abstract → [CLS] vector, no
cross-document attention), so a paper's 768-d vector is **set-independent**.

Verified empirically (fallworm, 2026-06-13): the same paper's vector across the
full set and three subsets (picks/rand1/rand2) matched at **cosine 1.000000**,
max \|Δ\| ~1.9e-6 (float32 noise); papers shared between two subsets embedded in
one run were **bit-identical** (Δ = 0). The ~1e-6 is GPU batch/padding
nondeterminism *across separate runs*, not set membership.

Consequences:
- An embedding set is just a **bag of (paper_id → vector)** pairs.
- Bags **combine freely**: union + dedup + re-index, no recomputation.
- **Slicing** the master gives bit-exact subset embeddings with **no GPU**.
- **Contrast — layout is NOT set-independent.** PCA / graph-diffusion fusion /
  UMAP are all fit on the set, so a paper's *position* changes per view. You
  never store a "master layout"; positions are always recomputed per selection.

## 3. Core objects

- **Recipe** = `(model, adapter, normalization-domain)`. The vector depends on
  the input text, so one master exists **per recipe**. Mixing recipes is
  incoherent (same paper, different vector).
- **Master embedding** = append-only fingerprint book for one recipe:
  `embeddings.npy` (N×768) + an **append-stable `id→row` index** + a manifest
  (model, adapter, recipe, version, count). Today's per-project
  `data/<project>/embeddings.npy` is effectively a master already.
- **Snapshot DB** = metadata + citation edges, read by the toy via sql.js. The
  master is keyed to its paper ids.
- **View / subset** = a selection of ids (selector: `--where/--seeds/--year/
  --ids`, or a saved set). Its embedding is a **slice** of the master.
- **Union** = the bag-merge of two or more masters of the **same recipe**
  (dedup shared papers), with a merged snapshot for metadata + edges. The basis
  for multi-database exploration.

## 4. Operations

- **Build / extend a master** (`biblion advanced embedding`, incremental):
  embed only papers **not yet** in the master, append their rows; never
  recompute existing vectors. New papers from the enrich pipeline cost only
  their own forward pass.
- **Slice a subset** (default for `subset` / snapshot embedding): gather the
  selection's rows from the master → write the subset bundle (index + sliced
  npy). Instant, no GPU, bit-exact. **Re-embed only** when a *different recipe*
  is requested (`--domain` / model change).
- **Combine corpora / databases**: union of `id→vector` across same-recipe
  masters, dedup by canonical paper identity, plus a merged snapshot
  (metadata + citation edges). Lets several biblion DBs (fields/projects) be
  explored in one space.
- **Explore in the toy**: pick a master / subset / union → PCA → fusion → UMAP →
  cluster → render; switch freely; compare views. Layout is recomputed per pick.

## 5. Invariants & caveats

1. **One recipe per master.** All vectors must share `(model, adapter, text
   prep)`. Different `--domain`/`normalize` ⇒ a separate master.
2. **Append-stable indexing — do NOT `ORDER BY id` on each build.** New papers
   get higher ids and append naturally, but a paper that was un-embeddable (no
   abstract) and later gains one via enrichment would slot in at its old, lower
   id and shift every subsequent row. A growable master must persist `id→row`
   and only ever append new ids.
3. **Model/adapter version pins the master.** Stamp it in the manifest; refuse to
   append across a version change → that requires a full re-embed.
4. **Never store a master layout.** Positions are set-relative; always recompute
   per view (optionally cache per *named* view, invalidated on set change).
5. **Cross-DB union needs identity resolution.** The same paper via DOI vs S2 vs
   OA id across databases is one node — reuse biblion's `Resolver` /
   identifier-index dedup. Edges merge as the union of `citations`.

## 6. Why this gives a reason to combine databases

Because embeddings combine freely, each biblion database (a field, a project, a
search) can be embedded **once** into its master, then explored **together** as a
union: cross-field clusters, bridges, and gaps become visible without
re-embedding anything. The cost is identity dedup + edge merge, not compute. This
is the concrete payoff that makes a multi-database workflow worthwhile.

## 7. Current state vs needed

Built (this work stream):
- Per-project full embedding + snapshot (`advanced snapshot` / `embedding`).
- Named subsets (`advanced subset make/list/remove`, `embedding --subset`) — but
  they currently **re-embed** rather than slice.
- Toy: subset mode + picker discovery (`<project>::<subset>`).
- Ghost/structural nodes (separate feature; `doc/ghost-nodes.md`).
- **Set-independence verified** (the fact this whole spec rests on).

Needed:
- **Incremental master**: append deltas, append-stable `id→row`, recipe+version
  manifest; `embedding` embeds only the missing papers.
- **Subset = slice the master** by default; re-embed only on recipe change.
- **Union across databases**: cross-DB identity dedup, merged snapshot, union
  master; a CLI to define/build a union.
- **Toy**: master-centric picker (masters, subsets, unions); optional live
  refresh; a "compare two views" affordance (highlight a shared paper across
  layouts).

## 8. Open questions

- Append-stable index store: format + handling of late-embeddable papers,
  deletions, and Resolver re-homing (a paper merged into another loses a row).
- Cross-DB identity + edge merge at scale (10⁴–10⁶ papers).
- Recipe management: multiple masters per project; how CLI + toy select a recipe.
- Per-view layout caching vs always-recompute (cache keyed by the id-set hash).
- Compare-views UX in the toy: linking a paper's position across two selections.

## 9. Verification (when built)

- **Slice fidelity**: a subset sliced from the master is byte-identical to the
  master rows for those ids (Δ = 0).
- **Incremental append**: embed N, add M new papers, master grows by exactly M;
  the original N rows are byte-unchanged; `id→row` stable.
- **Recipe guard**: appending with a different model/domain is refused.
- **Union**: a paper shared across two DBs appears once; node/edge counts correct;
  identity dedup matches the Resolver's.
