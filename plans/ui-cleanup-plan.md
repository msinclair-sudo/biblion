# Plan — UI cleanup: cleaner, more functionally intuitive shell

> **Living document.** This is a running backlog, not a one-shot spec.
> New items get appended to §3 as they surface. Each item, once it's
> ripe, can be promoted into its own dev spec under `claude_doc_dump/`
> (per the "specs go to doc dump" convention) and linked back here.

## 1. Context

The toy UI (`network_toy/app/`) is a no-build ES-modules shell:

- **Layout** is a CSS grid (`app/styles/main.css` `#layout`) with fixed
  rails: `--left-rail-w` / `--right-rail-w` columns, `--bottom-h` row.
  Areas: `left`, `primary`, `secondary`, `bottom`.
- **Panels** live in three multi-tab slots (`primary` / `secondary` /
  `bottom`), driven by `app/src/ui/panel-system.js` +
  `panels/registry.js`. viewer-2d / viewer-3d are singletons.
- **Menus** are modal-driven (`app/src/ui/modals/*`) plus the topbar
  (`topbar.js`) and the workflow tree / card gear+`+` affordances.

The goal: make the shell feel **direct and reconfigurable** — panels
the user can resize and rearrange in-app, menus that are where you'd
reach for them, less modal indirection where a panel would do.

This is **spec/plan work first**. Implementation items get pulled out
into focused specs as they're scoped.

## 2. Themes (the "why")

1. **Dynamic layout.** Rails and the bottom row are fixed-width today
   (CSS vars set once). Users should be able to drag-resize slots and
   have it persist (into project save + a UI-prefs slice).
2. **Menu locality.** Things you trigger often shouldn't be buried in
   modals; things you set once can stay modal. Audit where each action
   lives vs. how often it's used.
3. **Panel mobility.** Moving a tab between slots, popping a panel to a
   different slot, sane defaults for what opens where.
4. **Consistency.** One spacing/affordance language across the topbar,
   rails, tabs, and modals (currently many bespoke `grid-template`s).

## 3. Backlog (append items here)

Format: `- [ ] **<short title>** — <what + where> · _(status)_`

### Layout / resizing
- [ ] **Draggable slot dividers** — splitter handles between
  left-rail / primary / secondary and above the bottom row; write the
  dragged sizes back to CSS vars (`--left-rail-w`, `--right-rail-w`,
  `--bottom-h`). Needs a UI-prefs state slice + persistence. _(not started)_
- [ ] **Persist layout** — fold rail/slot sizes (and collapsed state)
  into project save (`persistence/serialise.js`) or a separate
  localStorage UI-prefs blob. Decide which. _(not started)_
- [ ] **Collapse / expand rails** — quick toggle to reclaim space for
  the viewer. _(not started)_

### Menus / navigation
- [ ] **Menu-locality audit** — list every modal in `ui/modals/`, how
  it's reached, and how often; flag candidates to surface as inline
  panel controls or topbar items. _(not started)_
- [ ] **Dim-reduction modal: default profile + two-column layout** —
  two changes to the dimred modal (`modals/dimred-modal.js`):
  (1) **Default profile** — ship a sensible default preset of stage
  selections (noise / fusion / compression / viz / viz2d) so the user
  isn't configuring every stage by hand; surface it as the initial state
  and/or a "Reset to default" affordance. (2) **Two-column layout** —
  today each section (`renderSection`) stacks title → description →
  algorithm `select` → params vertically. Split the modal into two
  columns: **selections on the left** (the algorithm pickers per stage),
  the **selection-specific description text + sliders/params on the
  right**, driven by the focused/active selection. Needs CSS work in the
  `dimred-modal-*` rules (`styles/main.css`). _(not started)_
- [ ] **Standardise modals / panels / menus on shared resources** —
  the base contracts already exist (`modals/modal.js` `openModal`, the
  `panels/registry.js` `mount → {update, destroy}` contract), but each
  modal and panel hand-rolls its own form controls (selectors, toggles,
  sliders, label/field rows) and bespoke `grid-template` CSS (dozens of
  one-off grids in `styles/main.css`). Extract a small shared
  widget/field-row kit + one spacing/affordance language so menus,
  modals, and panels are built from the same pieces. Code-cleanup item:
  cuts duplication, makes new panels/modals cheap and consistent.
  _(not started)_

### Workflow cards
- [ ] **Eager pre/post-fusion branch cards** — the pre- and post-fusion
  branch cards should appear under a dim-reduction card **as soon as it's
  added/selected**, not after the job finishes. Today they're spawned in
  the `promise.then(...)` after `engine.redimred()` resolves and gated on
  `dimredCard.result.fusionActive` (`modals/layer-descriptors.js`
  dimred descriptor, ~L435–459) — so the card topology waits on compute.
  The `fusion` param is already known up front from the dimred modal
  config, so the fork can be created eagerly (pending/placeholder cards)
  when `fusion` is non-identity, then filled in when the job lands. Lets
  the user queue clustering on either branch while dim-reduction is still
  running. Watch the re-run path (branches already exist) and the
  identity-fusion case (no fork). _(not started)_

- [ ] **Remove the alpha (blend) slider** — the topbar α/blend slider is
  no longer used; remove it. Touch points: `#blend-slider` /
  `#blend-readout` in `index.html`, `mountBlendSlider` (`ui/main.js`
  ~L37), `setBlend` + `state.blend` (`ui/state.js` ~L515), the `blend`
  step `α = …` label (`workflow-chart.js` ~L597), and the `alpha`
  handling in `workflow-projection.js` / `workflow-migration.js`. **Keep
  the separate fusion-blend slider** (`mountFusionBlendSlider`,
  `#fusion-blend-slider`, `setFusionBlend`) — that one is still in use.
  Check persistence/migration shims don't choke on saves that carried an
  `alpha`/`blend` value. _(not started)_

- [ ] **Node-displacement branches from pre + post fusion** — in the
  workflow viewer the node-displacement card should visually **branch off
  the pre- and post-fusion branch cards** (two incoming edges), not hang
  off the dimred card. Today the descriptor sets `parentId: dimredId`
  (solid spine edge from dimred) with `refIds: [preId, postId]` drawn
  only as dashed cross-edges (`modals/layer-descriptors.js`
  `nodeDisplacementDescriptor` ~L563–570; chart draws solid `parentId` +
  dashed `refIds` in `workflow-chart.js` ~L167/L187). Make the lineage
  read from the two fusion branches — re-parent / promote the ref-edges
  to the primary branching edges (decide how, given the single-`parentId`
  tree model). It already auto-spawns with the fork
  (`spawnNodeDispIfMissing` runs once both branches exist); keep that so
  the card auto-loads alongside the pre/post fusion cards. _(not started)_

- [ ] **Drop the cross-cluster-citations card (auto-fired, no config)** —
  `crossClusterCitations` is auto-spawned after the layer ladder commits
  (`modals/layer-descriptors.js` ~L1081–1103) and its descriptor takes
  **no configuration** (`crossClusterDescriptor.applyChange()` ~L1337),
  so it's a wasted node in the workflow tree. Surface the result as an
  auto-opened panel reading `state.crossClusterCitations` (the projection
  already populates it, `workflow-projection.js` ~L138–145) instead of a
  card. **Ripple to handle:** the card currently doubles as a tree
  attach-point — labelling gets bumped to become a child of the
  crossCluster card (~L1152–1153, L1284); re-anchor that to the
  clustering card when the card goes away. _(not started)_

- [ ] **Scoring card: mini stacked-bar of node scores** — add a small
  vertical **stacked bar** down the right-hand side of each scoring card
  in the workflow chart. Single bar (x = 1), y normalised 0–1, segments
  coloured by **score value**, each segment's height = the fraction of
  **nodes** (node-weighted, not cluster-weighted) whose cluster carries
  that score. Derive the distribution from the card's
  `result.scores[levelUid][clusterId]` (mirrored in `state.clusterScores`)
  mapped over cluster membership counts. Render in `workflow-chart.js`
  card drawing for `step.type === "scoring"` (right edge, like the queue
  badge ~L387); reuse a score colour ramp (check `ui/gradients.js` /
  `viewer-shared/colour-modes.js` for an existing 1–5 scale before adding
  one). _(not started — confirm which level's scores the bar reflects:
  the selected level, or pooled across all scored levels)_

### Panels
- [ ] **Move/pop tabs between slots** — drag a tab to another slot, or
  a context action; respect singleton constraint (viewer-2d/3d). _(not started)_
- [ ] **Cart panel defaults to the right (secondary) slot** —
  `openCartPanel` (`ui/topbar.js` ~L158) currently opens the cart in the
  `bottom` slot (`addTab("bottom", "cart", {})`, "the cart table is
  wide"). Change the default to the right-hand `secondary` slot. Check
  the cart table layout still reads OK in the narrower right rail (may
  pair with the dynamic-resizing work). _(not started)_
- [ ] **Edge colour/toggle controls → 3D viewer settings** — the edge
  controls (citation/base/structure toggles, arrows, opacity/density
  sliders, colour pickers) live at the bottom of the **left rail** today
  (`mountEdgeControls` in `ui/main.js` ~L100, `ec-*` elements +
  edge-controls container in `index.html`, all writing `state.view` via
  `setView`). Move them into the 3D viewer's existing **settings popup**
  (`buildSettingsOverlay` / gear button in `panels/viewer-3d.js` ~L125)
  so they sit with the controls they affect. Keep the `setView` wiring;
  just relocate the inputs. Frees up left-rail space (pairs with the
  collapse-rails item). _(not started)_
- [ ] **Fusion slider → into the 3D viewer (bottom-left, vertical)** —
  move the fusion-blend slider into the viewer panel, anchored
  bottom-left and oriented **vertically**. Currently
  `mountFusionBlendSlider` (`ui/main.js` ~L65) wires `#fusion-blend-row`
  / `#fusion-blend-slider` / `#fusion-blend-readout` outside the viewer,
  writing `setFusionBlend` / `state.fusionBlend` and shown only when
  `_basePosPreFusion` exists. Relocate the input into
  `panels/viewer-3d.js` as a bottom-left vertical overlay (keep the
  show/hide-on-`_basePosPreFusion` gating and the `setFusionBlend`
  wiring). _(not started)_

### Panels / charts
- [ ] **"Pick layers" panel: single-column stack, not side-by-side** —
  the multi-layer picker (`panels/multilayer-curve.js`, label "Pick
  layers") currently renders a **two-column body** (LEFT reproducibility/
  stability curve + selector, RIGHT bridge heatmap) with the picked-layer
  readout below. Restack all of it into **one column / one row**: heatmap,
  reproducibility curve + selector, layers-information display, and the
  Apply/Clear buttons in a single stacked flow — not side by side.
  Touch the `multilayer-curve-body` two-column layout (`styles/main.css`)
  and the host ordering in `mount()`. _(not started — confirm exact
  vertical order of the four blocks with the user)_
- [ ] **Scoring cluster blocks: add-to-cart button + paper count** — on
  each scoring cluster block (`panels/scoring.js` `renderClusterBlock`
  ~L205–311): (1) an **Add to cart** button that pushes that cluster's
  papers via the existing `addToCart` helper (`state.js` ~L425) — map the
  cluster's `members` node indices to their `paperId`s, excluding ghosts;
  (2) show the **paper count**. Note a count already renders (`Cluster
  {id} · {count}`, ~L222–223) from `members.length || count` — confirm
  whether the wanted "paper count" is distinct from that (e.g.
  real-papers-only, excluding ghost nodes) or just relabelling the
  existing one. _(not started — confirm target surface: these scoring
  *panel* cluster blocks vs. the workflow-chart scoring card)_
- [ ] **Scoring panel: sort-by control for cluster columns** — add a
  sort selector to the scoring board's columns (`panels/scoring.js`,
  which renders one column per layer, each listing its clusters as
  blocks). Options: **Default** (current layout order), **Score
  descending**, **Score ascending**, **Un-scored first**. Sorts the
  cluster blocks within each column; scores come from the card's
  `result.scores[levelUid][clusterId]`. Decide whether the sort is
  per-column or board-wide (suggest board-wide single control). _(not
  started)_
- [ ] **Cross-citation heatmap excludes the diagonal** — the
  cross-cluster matrix renders within-cluster citations (cluster i →
  cluster i, the same-to-same row/col intersection). Suppress the
  diagonal via the existing `cellEnabled` predicate in
  `charts/heatmap.js` (pass `cellEnabled: (r,c) => r!==c` at the
  `renderHeatmap` call in `panels/cross-cluster.js`), and recompute
  `vmax` over off-diagonal cells so the scale isn't dominated by
  intra-cluster counts. Data layer already excludes the diagonal for
  degree metrics (`cross-cluster-citations.js`). _(not started)_

### Viewer framework
- [ ] **Node-highlight framework (coloured glow, multi-source)** — set up
  a general framework for the viewer to highlight nodes with a **coloured
  glow**, driven by highlight *requests* from any source — not bound to
  one caller. First consumers: (a) selecting a card in the **scoring
  panel** highlights its nodes, with **Ctrl+click to multi-select** cards
  (additive); (b) the **SQL search bar** — query results get highlighted.
  Design as a shared **highlight channel** distinct from the existing
  single-`state.selection` dim mechanism (`state.selection` +
  `nodeMatchesSelection` / selection-dim in
  `viewer-shared/colour-modes.js`): a state slice like
  `state.highlights` (sets of node ids, each with a colour/source tag,
  supporting multiple concurrent groups) + a small API
  (`addHighlight/clearHighlight(source, nodeIds, colour)`; plain click
  replaces, Ctrl+click adds). Render the glow in **both** viewers
  (`panels/viewer-3d.js`, `viewer-2d.js`) via the shared colour resolver
  so it's consistent. Keep it additive over the existing colour mode (a
  halo/emissive layer, not a recolour). **Purely visual:** in-memory
  only, never persisted to project save, and must be **very fast** —
  highlight updates should hit a cheap render path (e.g. toggle a glow
  attribute / emissive on the existing node objects), not trigger a full
  `rebuildData()` or engine recompute. Keep it off the heavy serialised
  state so it can update at interaction speed. _(not started — define how
  glow composes with the current selection-dim)_

### Data panel / shell
- [ ] **"Databases" dropdown menu (top-left)** — add a Databases dropdown
  to the top-left of the topbar (`ui/topbar.js`; cart button is the
  existing top-right precedent, `renderCart` ~L132). Options: **Connect
  New**, **Make New**, **Manage Connections**. Wire each to the relevant
  data-source / DB flow (`datasource/sqlite.js` + `real.js`; new modals
  likely needed for connect/make/manage). Pairs with the open-dataset
  reference item below. _(not started — define what each action does:
  Connect New = attach an existing biblion DB; Make New = init a new DB;
  Manage Connections = list/switch/remove connected DBs)_
- [ ] **Top-left data panel references the open dataset / connected DB** —
  the left-rail data panel (`ui/data-panel.js` `renderRealMode` ~L64–95)
  shows a hardcoded "Real data" title and a **static** subset label
  (`cfg.subset`, e.g. `dev_subset_1000`, from the `SUBSETS` registry in
  `datasource/real.js`) plus the placeholder hint "Open the Data card in
  the workflow chart to load a subset…". Make it reference the **actual
  open dataset / connected DB(s)** instead of the baked-in subset id —
  surface the real source identity (the biblion SQLite DB / dataset
  behind `datasource/sqlite.js` + `real.js`) so the panel reflects what's
  actually connected. _(not started — confirm what "connected DB"
  identity to show: file/path, biblion DB name, subset, or all)_

## 4. Working notes

- Keep changes inside `network_toy/app/`; the shell is plain
  CSS-grid + vanilla state (`ui/state.js`), no framework.
- Verify UI changes in a real browser (webapp-testing / Playwright),
  not just unit smoke — viewer regressions don't show in type checks.
- When an item is ripe, promote it to a spec in `claude_doc_dump/` and
  replace the backlog line with a link.
