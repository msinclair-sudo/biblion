# Workflow card palette

> This diagram is a **palette of card choices at each layer** — not a representation of a single workflow instance. A real workflow picks one path through it (e.g. `clust` OR `multiL`, never both in the same branch).

## Interaction markers

Each card is prefixed with a marker for how the user interacts with it:

| Marker | Meaning |
|---|---|
| ⚙ | **modal** — gear-click opens a config modal; user picks params before running |
| 🎛 | **panel** — no modal, but produces an interactive results panel the user drives |
| 🚀 | **run-only** — no modal, no interactive panel; fires and produces a passive result |

Shared *algorithms* (called by cards, not cards themselves) use a hexagon shape.

```mermaid
flowchart TB
    %% ─────────────── L1 · DATA ───────────────
    subgraph L1["Layer 1 · Data"]
        direction TB
        data["⚙ 📊 imported data"]
    end

    %% ─────────────── L2 · DIMRED ───────────────
    subgraph L2["Layer 2 · Dim-reduction"]
        direction TB
        dimred["⚙ 🔄 dimreductions → fusion → compression → viz"]
        dimSweep["⚙ 📏 dimensional sweep<br/><i>manual — embedding-quality check</i>"]
        dimSweepRes(["🎛 results panel"])
    end

    %% ─────────────── L3 · FUSION FORK ───────────────
    subgraph L3["Layer 3 · Fusion fork"]
        direction LR
        fbPre["🚀 🔀 fusionBranch (pre)"]
        fbPost["🚀 🔀 fusionBranch (post)"]
        nodeDisp["🎛 📍 node displacement<br/><i>auto — needs both branches' positions</i>"]
        nodeDispRes(["🎛 results panel"])
    end

    %% ─────────────── L4 · CLUSTERING (choose one per branch) ───────────────
    subgraph L4["Layer 4 · Clustering &nbsp;·&nbsp; ⚠ choose ONE per branch"]
        direction LR
        clust["⚙ 🎯 clustering single-level<br/><i>modal also exposes bootstrap knobs</i>"]
        choice{{"choose one"}}
        multiL["⚙ ⚙️ multiLevel sweep"]
        picker["🎛 🖱️ multiLevelPicker<br/>commits cluster ladder<br/><i>panel shows stability curve + bridge heatmap</i>"]
        bootAlgo{{"⚡ bootstrap stability<br/><i>shared algorithm —<br/>called by clust + multiL</i>"}}
        bridgeAlgo{{"🌉 bridge analysis<br/><i>shared algorithm —<br/>called by multiL over every<br/>(layer_i, layer_j) pair</i>"}}
    end

    %% ─────────────── L5 · ANALYSIS ON COMMITTED CLUSTERS ───────────────
    subgraph L5["Layer 5 · Analysis on committed clusters"]
        direction TB
        crossCite["🚀 🔍 cross-cluster citations<br/><i>auto under picker when citation edges exist<br/>· manual on clust</i>"]
        label["⚙ 🏷️ labelling<br/><i>manual — pick algorithm</i>"]
        score["🎛 ⭐ scoring<br/><i>requires labels</i>"]
        fusionComp["⚙ 🔗 fusion comparison<br/><i>⚠ placeholder · pending further work<br/>warning: only meaningful when both branches<br/>use the same clustering settings</i>"]
    end

    %% ─────────────── L6 · SELECT & EXPORT ───────────────
    subgraph L6["Layer 6 · Select &amp; export"]
        direction TB
        selectNode["🎛 🎛️ selectNode<br/><i>filter / pick by any upstream signal<br/>(design TBD)</i>"]
        exportRis["🎛 📤 export (RIS)"]
        exportCSV["🎛 📤 export (CSV)"]
    end

    %% ─────────────── EDGES ───────────────
    data --> dimred
    dimred --> dimSweep
    dimSweep -.-> dimSweepRes

    dimred --> fbPre
    dimred --> fbPost
    nodeDisp == auto ==> fbPre
    nodeDisp == auto ==> fbPost
    nodeDisp -.-> nodeDispRes

    fbPre  --> choice
    fbPost --> choice
    choice --> clust
    choice --> multiL
    multiL == auto ==> picker

    bootAlgo -.uses.- clust
    bootAlgo -.uses.- multiL
    bridgeAlgo -.uses.- multiL

    crossCite == auto ==> picker
    crossCite --> clust

    clust  --> label
    picker --> label
    label  --> score

    clust  -.refIds.-> fusionComp
    picker -.refIds.-> fusionComp

    label     -.-> selectNode
    score     -.-> selectNode
    crossCite -.-> selectNode
    nodeDispRes -.-> selectNode
    selectNode --> exportRis
    selectNode --> exportCSV

    %% ─────────────── CLASS ASSIGNMENTS ───────────────
    data:::root
    dimred:::pipeline
    dimSweep:::leaf
    dimSweepRes:::chain
    fbPre:::router
    fbPost:::router
    nodeDisp:::autoFire
    nodeDispRes:::chain
    clust:::pipeline
    multiL:::pipeline
    picker:::pipeline
    choice:::gate
    bootAlgo:::algo
    bridgeAlgo:::algo
    crossCite:::autoFire
    label:::chain
    score:::chain
    fusionComp:::placeholder
    selectNode:::pipeline
    exportRis:::leaf
    exportCSV:::leaf

    classDef root        fill:#fce4ec,stroke:#880e4f,stroke-width:2px,color:#000
    classDef pipeline    fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px,color:#000
    classDef router      fill:#bbdefb,stroke:#0d47a1,stroke-width:1px,stroke-dasharray:4 2,color:#000
    classDef chain       fill:#fff9c4,stroke:#f57f17,stroke-width:1px,color:#000
    classDef leaf        fill:#eeeeee,stroke:#424242,stroke-width:1px,color:#000
    classDef autoFire    fill:#ffccbc,stroke:#bf360c,stroke-width:2px,color:#000
    classDef gate        fill:#ffffff,stroke:#000,stroke-width:2px,stroke-dasharray:2 2,color:#000
    classDef placeholder fill:#f5f5f5,stroke:#9e9e9e,stroke-width:1px,stroke-dasharray:6 3,color:#666
    classDef algo        fill:#e1bee7,stroke:#4a148c,stroke-width:2px,color:#000
```

## Edge legend

| Symbol | Meaning |
|---|---|
| `-->` solid arrow | manual "+" add — user chooses to add this card |
| `== auto ==>` thick arrow | auto-spawned when the parent's job completes |
| `-.->` dotted arrow | feeds a results panel or downstream UI (not a parent edge) |
| `-.uses.-` undirected dotted | algorithm called by a card (not a parent edge, not data flow) |
| `-.refIds.->` dotted with label | DAG fan-in reference (card consumes results from multiple upstreams) |
| `{{ choose one }}` diamond gate | mutually-exclusive choice within a branch |

## Class legend

| Class | Shape | Role |
|---|---|---|
| 🟪 **root** | rect | single entry point |
| 🟩 **pipeline** | rect | data-processing spine |
| 🟦 **router** | dashed rect | no-modal fork node (pre/post-fusion branches) |
| 🟧 **autoFire** | rect | computed automatically, no card-level config |
| 🟨 **chain** | rect / stadium | sequential analysis or results panel |
| ⬜ **leaf** | rect | terminal output |
| ⬜ **gate** | hex | mutually-exclusive choice |
| ⬜ **placeholder** | dashed rect | card slot reserved; logic is stub-only |
| 🟣 **algo** | hex | shared algorithm called by cards (not a card itself) |

## Picker panel layout

The multiLevelPicker's panel is now a multi-signal informer. The user picks layers with both **stability** (already there) and **bridge density** (new) visible at the same time:

```
┌─────────────────────────────────── Picker panel ────────────────────────────────────┐
│  ┌─────────────────────────┐  ┌──────────────────────────────────────────────────┐ │
│  │ Stability curve  (LEFT) │  │  Bridge heatmap  (RIGHT)                         │ │
│  │ y = bootstrap stability │  │   x = parent layer (coarser)                     │ │
│  │ x = granularity         │  │   y = child  layer (finer)                       │ │
│  │ + clickable dots        │  │   cell = bridge count, raw in tile,              │ │
│  │   for each level        │  │          normalised colour                       │ │
│  │   click ↔ heatmap       │  │   click cell highlights both layers on curve     │ │
│  └─────────────────────────┘  └──────────────────────────────────────────────────┘ │
│                                                                                      │
│  ┌──────────────────────────── Live readout (BOTTOM) ───────────────────────────┐  │
│  │  Selected layers: [L0: 142 clusters] → [L4: 38] → [L9: 12]                   │  │
│  │  Bridges (adjacent picks):    L4 vs L0: 27       L9 vs L4: 8                 │  │
│  └────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Heatmap and stability curve are bound: clicking a heatmap cell highlights both layers on the curve; clicking a stability point shades the matching heatmap row/column. The readout updates live as the user picks (no recompute — filters from pre-computed `bridgesPerPair`).

## Semantics notes

- **`bootstrap` is no longer a card.** It's a shared algorithm called by both `clust` (single-level) and `multiL` (per-granularity). Its knobs (iteration count `B`, etc.) move into the clustering modal as a bootstrap section.
- **`bridge` is no longer a card.** Bridges are computed over every (`layer_i`, `layer_j`) pair during the multiLevel sweep and rendered as a heatmap in the picker panel. The result is stored on the multiLevel producer (`multiLevel.result.bridgesPerPair`); the picker reads from there.
- **`nodeDisp` is one instance taking both fusion branches as inputs** — not one per branch. Conceptually part of the fork; auto-fires as soon as both branch positions exist.
- **`crossCite` auto-fires under `picker`** when the ladder commits, **gated on `state.rawCitationEdges` being non-empty** (toy data without synthetic citations skips the auto-spawn rather than creating a perma-failed card). Still available as a manual "+" option on `clust` (single-level) and `picker` (for toy data with manually-generated edges).
- **`label` is the only manual card downstream of clustering** — the user picks the labelling algorithm. `scoring` depends on labels.
- **`dimSweep` stays on `dimred` only** — embedding-quality check, separate from cluster-quality (which is what bootstrap measures).
- **`fusionComparison` is a placeholder** — the card and its full runner are still in place (so a user with matching clustering settings can get value), but a ⚠ warning banner sits above every modal + panel render and on its next-steps hints to flag that this is pending further work. Only meaningful when both clusterings used the same algorithm + parameters.
- **`selectNode` is deferred** — a filter/picker UI that aggregates upstream signals (labels, scores, citation degree, displacement). Design TBD.

## Out of scope for this palette

The following card types exist in code but are **not user-creatable in the new flow**:

- `citationLayout` — was useful during app development; superseded by selectNode-driven export.
- `citations`, `alignment`, `blend` — toy-graph chain. Code stays pinned for future work; not exposed here.

These remain in the codebase untouched and are not shown on the diagram to keep it focused on the live, user-driven flow.
