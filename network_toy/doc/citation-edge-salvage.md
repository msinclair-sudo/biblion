# Citation-edge salvage over filtered-out nodes (design note)

> **Status: superseded by ghost nodes (the *inclusion* approach).** This note
> proposed *contraction* — elide the textless intermediate and synthesise an
> `a→c` edge. We instead **kept** the textless endpoints as first-class
> structure-only nodes (`isGhost`) that carry their real edges and are positioned
> by citation topology. See `doc/ghost-nodes.md`. The contraction idea below is
> retained for reference; it is not what shipped.
>
> *(Original status: parked idea, not built. Captured 2026-05-31 while wiring the
> SQLite (biblion) data source.)*

## The problem

The node set requires an abstract (`is_rejected=0 AND is_stub=0 AND title IS
NOT NULL AND abstract IS NOT NULL`) so every node has clean text for SPECTER2
and for labelling. Good for embeddings — but it deletes papers that are real
participants in the citation graph.

Measured on `testdb/test.db` (4251 papers, all non-rejected/non-stub):

| node filter | nodes | edges surviving | survival |
|---|---|---|---|
| title only | 4251 | 12120 / 12120 | 100% |
| **title + abstract (chosen)** | **3109** | **5296 / 12120** | **43.7%** |

So requiring an abstract roughly **halves the citation graph**. The toy leans
hard on citation structure (graph-diffusion fusion, citation layout, bridge
clusters), so losing 56% of edges is not cosmetic.

The dropped edges aren't noise — they're edges with one endpoint that happens
to lack an abstract. The *relationship* is real; only the endpoint's text is
missing.

## The idea: contract the graph onto the kept-node set

When a removed node `b` (no abstract) sits on a directed citation path
`a → b → c`, there is still a directed relationship from `a` to `c`. Recover
it: **add a synthetic directed edge between two kept nodes when a directed
citation path connects them passing only through removed nodes.**

```
kept:    a           c              a ─────▶ c   (synthetic, "contracted")
removed:   ╲       ╱
            ▶ b ──▶
```

- Direction is preserved — `a → c`, never `c → a`. A contracted edge is a
  valid directed path, just with the textless waypoints elided.
- This is graph contraction / transitive reduction restricted to the removed
  subgraph: kept nodes are the quotient, removed nodes are the "glue."

## Decisions to make when we build it

1. **Path-length bound.**
   - *Single intermediate* (`a→b→c` ⇒ `a→c`, exactly one removed node) is
     cheap, safe, and probably captures most of the value. Easy first cut.
   - *Chains* (`a→b→d→c`, runs of consecutive removed nodes) need a bounded
     BFS/DFS over the removed-node subgraph between each pair of kept
     endpoints. Without a hop cap this can explode and manufacture a dense,
     misleading graph. Start with cap = 1 intermediate, raise only if the
     graph is still too sparse.

2. **Weighting.** A direct citation and a 2-hop contracted one shouldn't
   count equally. Options: hop-count decay (`w = ρ^hops`), or just a flat
   lower weight for all contracted edges. Fusion's diffusion can read the
   weight; binary consumers (layout, bridges) can threshold or ignore it.

3. **Scope — keep two edge sets.** This salvage is primarily for the
   **embedding/fusion layer** (restoring the diffusion signal that the
   abstract filter severed). It is *not* obviously something the displayed
   citation graph should claim as real citations. So keep them separate:
   - `realEdges` — actual `citations` rows, both endpoints in the node set.
   - `contractedEdges` — synthetic, with hop count / weight metadata.
   Each consumer opts in: fusion uses both (weighted); citation layout and
   bridge analysis can choose real-only or both.

4. **Multiplicity / dedup.** Multiple removed paths can imply the same `a→c`.
   Collapse to one edge; optionally record path multiplicity as a strength
   signal (more independent textless paths ⇒ stronger latent relationship).

## Open questions

- Does a real `a→c` citation that *already exists* get reinforced by a
  parallel contracted path, or left alone? (Probably leave the real edge,
  maybe bump its weight.)
- Cost: contraction is computed once at ingest over the full `citations`
  table (in `papers.id` space) *before* remapping to node indices — the
  removed nodes must still be visible at that point. Then remap survivors +
  contracted edges together onto `0..n-1`.
- Sanity metric: after salvage, report `realEdges`, `contractedEdges`, and
  resulting avg degree, so we can see how much connectivity we recovered vs.
  how much we invented.

## Related

- `doc/data-ingest.md` — Layer-1 contract + edge remapping (`papers.id →
  nodeIndex`, drop out-of-set endpoints — this note is about *not* simply
  dropping them).
- `doc/biblion_data_model_and_query_guide.md` — `citations(citing_id,
  cited_id)`, canonical `citing→cited`, intra-corpus only.
- Fusion layer: `doc/dynamics.md` / the graph-diffusion fusion sub-stage
  (where contracted edges would feed in).
