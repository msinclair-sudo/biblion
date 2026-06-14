# Menu-locality audit (J28) — modals in `network_toy/app/src/ui/modals/`

Analysis-only deliverable. No app code changed. Audits every modal: what it
does, how it is reached (entry point + the `file:line` of the open call),
how often it is realistically used, and whether it should stay a modal, be
surfaced inline in a panel, or be promoted to the topbar. Downstream
UI-cleanup jobs pick relocations from the prioritised shortlist at the end.

Line numbers were read from HEAD on 2026-06-14 and may drift; locate by
content if they have moved.

## How modals are reached in this app (entry-point taxonomy)

There are five ways a surface under `modals/` gets opened. Knowing the
taxonomy makes each entry below shorter.

1. **Gear icon on a workflow-chart card** — `workflow-chart.js:533
   openStepModal(step)` → `getLayerDescriptor(...).openModal()`. Only the
   four card types in `DESCRIPTOR_BY_TYPE` (`workflow-chart.js:39`) that map
   to an in-place editable descriptor get a gear: `data`, `dimred`,
   `clustering`, `citationLayout`. The gear EDITS the card in place.
2. **Per-card "+" add-step button** — `workflow-chart.js:507
   openAddStepModal(step)`. Lists the valid downstream steps from the rule
   table (`next-steps-rules.js` `NEXT_STEP_RULES`); picking one calls
   `runNextStepAction` → `getLayerDescriptor(rule.modal).openModal()`
   (`next-steps-rules.js:115`), which forks a NEW child card on Apply.
3. **Next-steps panel** — same rule table, same `openModal()` indirection
   (`panels/next-steps.js`, documented at its head; routed through
   `next-steps-rules.js:115`). This is a second front-end onto the same
   add-step rules, so "+"-reachable modals are also reachable here.
4. **"+ Add data source" button** on the empty-workflow placeholder —
   `workflow-chart.js:240` `getLayerDescriptor("data").openModal()`.
5. **Panel slot "+" tab** — `panel-system.js:112 openPanelPickerModal(...)`.
   This is the only modal reached from the panel chrome rather than the
   workflow chart.

Almost every descriptor modal is therefore reached through
`descriptor.openModal()`, wired in `layer-descriptors.js` (the
`openModal:` properties at lines 358, 462, 514, 584, 654, 762, 851, 933,
1026, 1117, 1216, 1266, 1326, 1378). The rule-table key → descriptor map is
in `next-steps-rules.js` `NEXT_STEP_RULES`.

Note: a SEPARATE legacy modal system lives in `main.js` (`settings-modal`,
`cluster-modal`, `citlayout-modal`, `cit-modal` — DOM-template modals, not
ES-module openers). Those are NOT under `modals/` and are out of scope for
this audit; flagged here only so a later job does not assume `modals/` is
the whole modal surface.

---

## Infrastructure / non-modal files (not relocatable surfaces)

These three files under `modals/` are not user-facing modals; they are
audited for completeness but carry no keep/relocate recommendation of their
own.

### `modal.js` — generic modal infrastructure
- **(a) Purpose:** the `openModal()` / `closeAllModals()` primitive every
  other modal builds on (backdrop, header, body, footer actions, ESC/click
  close).
- **(b) How reached:** imported by every modal; also called directly for
  two ad-hoc confirms — the delete-card confirm (`workflow-chart.js:550`)
  and add-step's empty/list shell (`add-step-modal.js`).
- **(c) Usage:** frequent (transitively — every modal open routes through
  it).
- **(d) Recommendation:** KEEP as infrastructure. Out of scope for
  relocation. If anything, downstream work should keep extending this
  rather than spawning bespoke modal DOM (see the legacy `main.js` modals
  that bypass it).

### `step-tree-picker.js` — reusable step `<select>` helper
- **(a) Purpose:** `buildStepSelect()` + `listComparableClusterings()` /
  `lineageLabel()` — a lineage-labelled dropdown for choosing a workflow
  card. Not a modal.
- **(b) How reached:** imported only by `fusion-comparison-modal.js:12`.
- **(c) Usage:** rare (tracks fusion-comparison usage, which is rare).
- **(d) Recommendation:** KEEP as a helper. It is already the right
  granularity to be reused inline if fusion-comparison is surfaced into a
  panel.

### `layer-descriptors.js` — descriptor registry (the open-call hub)
- **(a) Purpose:** builds every layer descriptor (`getLayerDescriptor`),
  each exposing `{ label, openModal, applyChange }`. This is where each
  descriptor's `openModal:` decides whether to pop a real modal or just
  fork a card (`save`/`scoring`/`export`/`crossClusterCitations`/
  `nodeDisplacement`/`fusionBranch` are `openModal: () => desc.applyChange()`
  or `() => {}` — no modal at all).
- **(b) How reached:** imported by `next-steps-rules.js`,
  `workflow-chart.js`, `panels/next-steps.js`.
- **(c) Usage:** frequent (every gear / "+" / next-step routes through it).
- **(d) Recommendation:** KEEP. It is the natural seam for any relocation:
  surfacing a modal inline means changing the descriptor's `openModal` to
  mount into a panel instead of calling `openModal()`. Downstream jobs
  should treat this file as the integration point, not rewrite call sites.

---

## Modals (user-facing surfaces)

### 1. `data-source-modal.js` — `openDataSourceModal`
- **(a) Purpose:** pick the active data source + edit its params; Apply runs
  `engine.reingest()`, dropping every downstream artifact (full tree reset).
- **(b) How reached:** gear on the `data` card (`workflow-chart.js:533`→`538`)
  and the empty-workflow "+ Add data source" button
  (`workflow-chart.js:240`); descriptor `openModal:` at
  `layer-descriptors.js:358`.
- **(c) Usage:** OCCASIONAL. Every session needs exactly one data source set
  once at the start; re-picking is destructive (wipes the tree), so it is
  not a knob users twiddle. Bounded, deliberate, low-frequency.
- **(d) Recommendation:** PROMOTE TO TOPBAR. The `Data` topbar menu already
  has stub items (`topbar.js:39` "New toy dataset…", "Citation source…")
  that are exactly this action. Wiring those stubs to this modal makes the
  "start a project" gesture discoverable from the menu rather than
  requiring the user to find a button inside an empty chart. Keep the modal
  itself (it is a genuine config form); just add the topbar entry point.

### 2. `dimred-modal.js` — `openDimredModal`
- **(a) Purpose:** five stacked algorithm sections (noise / fusion /
  compression / 3D viz / 2D viz) for the dim-reduction stage; Apply forks /
  edits a `dimred` card and runs the cascade.
- **(b) How reached:** "+" on a `data` card (rule `data → dimred`,
  `next-steps-rules.js`); gear on a `dimred` card (`workflow-chart.js:538`,
  `DESCRIPTOR_BY_TYPE.dimred`); descriptor `openModal:` at
  `layer-descriptors.js:462`.
- **(c) Usage:** FREQUENT. Dim-reduction is on the critical path between data
  and clustering; users tune it repeatedly while exploring.
- **(d) Recommendation:** KEEP MODAL. Five sections each with an algo picker
  + params is too tall for an inline panel control and is a deliberate
  commit (it triggers a heavy cascade). Modal focus is appropriate. (A
  later nicety: collapse the rarely-touched fusion/2D-viz sections by
  default — that is a within-modal cleanup, not a relocation.)

### 3. `clustering-modal.js` — `openClusteringModal` (+ `clustering-tabs/`)
- **(a) Purpose:** tabbed clustering surface — Configure (algorithm +
  per-level params) and Optimise (sweep configs, rank, apply). The
  `clustering-tabs/` files (`configure-tab.js`, `optimise-tab.js`,
  `optimise-results-renderer.js`) are its tab bodies, not independent
  modals.
- **(b) How reached:** "+" on `dimred` / `fusionBranch` cards (rule
  `→ clustering`); gear on a `clustering` card (`workflow-chart.js:538`,
  `DESCRIPTOR_BY_TYPE.clustering`); descriptor `openModal:` at
  `layer-descriptors.js:654`.
- **(c) Usage:** FREQUENT. Clustering is the core analytic step; the
  Configure tab is opened often.
- **(d) Recommendation:** KEEP MODAL, with a split worth flagging for
  downstream. The Optimise tab already closes the modal and pushes its
  results into the `validation-run-optimise` PANEL (`clustering-modal.js`
  `closeModal` + the comment block at lines ~96-114; inline result table
  was removed 2026-05-26). So Optimise is already half-relocated to panels.
  The Configure tab is a true config form and should stay modal. Downstream
  could finish the job: make Optimise a panel-launched action rather than a
  modal tab, leaving the modal as Configure-only.

### 4. `algorithm-modal.js` — `openAlgorithmModal`
- **(a) Purpose:** generic single-algorithm picker + params editor; used by
  the citation-layout layer (the only descriptor that routes here).
- **(b) How reached:** "+" on a `clustering` card → rule
  `clustering → layout`; gear on a `citationLayout` card
  (`DESCRIPTOR_BY_TYPE.citationLayout` → descriptor id `layout`); descriptor
  `openModal:` at `layer-descriptors.js:762`.
- **(c) Usage:** OCCASIONAL. Citation layout is an optional visual step many
  runs skip; when used it is configured once or twice.
- **(d) Recommendation:** KEEP MODAL (component), but note the descriptor
  binding. Because this is the generic algo+params form, it is the obvious
  candidate to be embedded inline if the layout config is ever surfaced
  into the viewer panel's controls. Low priority — it is small and rarely
  used.

### 5. `dim-sweep-modal.js` — `openDimSweepModal`
- **(a) Purpose:** configure an ARI dim-stability sweep (dims, seeds,
  verdict threshold; other algos fixed to validation defaults); Apply forks
  a `dimSweep` card + enqueues the sweep job.
- **(b) How reached:** "+" on `dimred` / `clustering` cards (rule
  `→ dimSweep`); descriptor `openModal:` at `layer-descriptors.js:851`.
  Sole opener is `layer-descriptors.js` (grep-confirmed). No gear (`dimSweep`
  is not in `DESCRIPTOR_BY_TYPE`).
- **(c) Usage:** RARE. Dim-sweep is a validation/methods step, not part of
  the everyday explore loop; results land in the dim-sweep panel.
- **(d) Recommendation:** KEEP MODAL. It is a deliberate, parameterised job
  launch (12+ runs, shows a wall-time estimate). A modal commit fits. Do
  NOT promote — it would clutter the topbar with a rarely-used action. Its
  results already live in a panel, which is the right place for output.

### 6. `fusion-comparison-modal.js` — `openFusionComparisonModal`
- **(a) Purpose:** pick a reference + candidate clustering card and create a
  `fusionComparison` card comparing them (ARI / NMI / Jaccard). Self-labelled
  "⚠ Placeholder · pending further work" in-modal.
- **(b) How reached:** "+" on `clustering` / `fusionBranch` /
  `multiLevelPicker` cards (rule `→ fusionComparison`, appears in several
  rule lists in `next-steps-rules.js`); descriptor `openModal:` at
  `layer-descriptors.js:933`. Sole opener is `layer-descriptors.js`. No gear
  (`fusionComparison` is not gear-editable).
- **(c) Usage:** RARE. Placeholder feature, only meaningful when two
  clusterings used identical settings; the modal itself warns it is not
  finished.
- **(d) Recommendation:** KEEP MODAL for now; do NOT invest in relocating
  until the feature is real. It is a two-dropdown picker, so when finished
  it could become inline panel controls in a comparison panel — but that is
  contingent on the feature graduating from placeholder status. Lowest
  relocation priority.

### 7. `labelling-modal.js` — `openLabellingModal`
- **(a) Purpose:** choose which cluster-label methods to run (checkboxes,
  unavailable methods disabled with a reason); Apply forks a `labelling`
  card that labels every ladder level.
- **(b) How reached:** "+" on `clustering` / `multiLevelPicker` cards (rule
  `→ labelling`); gear on a `labelling` card (`DESCRIPTOR_BY_TYPE.labelling`
  → descriptor id `labelling`); descriptor `openModal:` at
  `layer-descriptors.js:1216`.
- **(c) Usage:** OCCASIONAL. Labelling runs once per clustering you intend to
  score; common in a full pipeline run but not repeatedly tuned.
- **(d) Recommendation:** SURFACE INLINE (candidate). The body is just a
  checklist of methods plus a context line — it is small and stateless
  enough to live as an inline control block. But its Apply forks a card and
  runs a job, so the simplest correct move is to keep it modal short-term
  and revisit when a labelling/scoring panel exists to host the checklist.
  Medium priority.

### 8. `multi-level-modal.js` — `openMultiLevelModal`
- **(a) Purpose:** configure a multi-layer HDBSCAN reproducibility sweep
  (min samples, reproducibility floor, bootstrap iterations); Apply forks a
  `multiLevel` card + enqueues the sweep, then auto-spawns a picker.
- **(b) How reached:** "+" on `dimred` / `fusionBranch` cards (rule
  `→ multiLevel`); descriptor `openModal:` at `layer-descriptors.js:1026`.
  Sole opener is `layer-descriptors.js`. No gear (`multiLevel` IS in
  `DESCRIPTOR_BY_TYPE` mapping to descriptor `multiLevel`, so it does get a
  gear that re-opens this modal in edit mode).
- **(c) Usage:** OCCASIONAL. An alternative to single-shot clustering for
  users who want a layer ladder; chosen deliberately, configured a few
  times.
- **(d) Recommendation:** KEEP MODAL. Three numeric knobs that launch a
  bootstrap sweep — a deliberate, parameterised commit. Its real output (the
  layer-picking) already happens in a separate picker surface
  (`multiLevelPicker`, `layer-descriptors.js:1117`, which creates a card and
  selects it rather than opening a modal). So the heavy interactive part is
  already out of the modal. No relocation needed.

### 9. `panel-picker.js` — `openPanelPickerModal`
- **(a) Purpose:** the "Add panel" picker: lists registered panel types
  (minus mounted singletons / hidden) and saved validation runs; picking
  one mounts a tab.
- **(b) How reached:** the "+" tab in any panel slot — `panel-system.js:112`.
  This is the ONLY modal reached from panel chrome rather than the workflow
  chart.
- **(c) Usage:** FREQUENT-to-OCCASIONAL. Users add panels often early in a
  session, then settle into a layout. The validation-runs section is hit
  whenever a sweep/bootstrap result needs viewing.
- **(d) Recommendation:** KEEP MODAL. It is a launcher, not a config form;
  modal-as-menu is the right pattern and it is already local to the panel
  "+" that invokes it. The only refinement worth flagging: the two sections
  (panel types vs saved runs) could become a dropdown anchored to the "+"
  for fewer clicks, but that is a UX tweak, not a locality fix.

### 10. `add-step-modal.js` — `openAddStepModal`
- **(a) Purpose:** the per-card "Add step" chooser. Lists the valid
  downstream steps for the card's type (from `addStepRulesFor`); picking one
  closes this modal and hands off to that descriptor's config modal via
  `runNextStepAction` (which forks a new child card on Apply).
- **(b) How reached:** the per-card "+" button on the workflow chart —
  `workflow-chart.js:507 openAddStepModal(step)`. Sole opener
  (grep-confirmed). Not descriptor-driven; called directly.
- **(c) Usage:** FREQUENT. It is the primary "grow the tree" gesture — every
  new analysis step starts with a "+" click that opens this.
- **(d) Recommendation:** SURFACE INLINE (candidate, but careful). This is a
  pure menu (a list of buttons) and duplicates the next-steps PANEL, which
  already renders the same `nextStepsFor` rules inline (`panels/next-steps.js`
  + `next-steps-rules.js`). The two are redundant front-ends onto one rule
  table. Downstream could drop this modal in favour of an inline popover
  anchored to the "+" (or lean entirely on the next-steps panel), removing a
  modal hop before every config modal. Medium-high value because it is on
  the hot path; flagged in the shortlist.

---

## Coverage cross-check (no modal omitted)

Every file under `modals/` is accounted for above:

| File | Covered as |
|---|---|
| `modal.js` | Infrastructure §modal.js |
| `step-tree-picker.js` | Infrastructure §step-tree-picker |
| `layer-descriptors.js` | Infrastructure §layer-descriptors |
| `data-source-modal.js` | Modal 1 |
| `dimred-modal.js` | Modal 2 |
| `clustering-modal.js` | Modal 3 |
| `clustering-tabs/configure-tab.js` | sub-surface of Modal 3 |
| `clustering-tabs/optimise-tab.js` | sub-surface of Modal 3 |
| `clustering-tabs/optimise-results-renderer.js` | sub-surface of Modal 3 |
| `algorithm-modal.js` | Modal 4 |
| `dim-sweep-modal.js` | Modal 5 |
| `fusion-comparison-modal.js` | Modal 6 |
| `labelling-modal.js` | Modal 7 |
| `multi-level-modal.js` | Modal 8 |
| `panel-picker.js` | Modal 9 |
| `add-step-modal.js` | Modal 10 |

---

## Prioritised shortlist of modals to relocate

Framed so a downstream job can pick one item and ship it. The integration
seam for all of these is the descriptor's `openModal:` in
`layer-descriptors.js` (or the topbar `stub()` actions in `topbar.js`).

1. **Data-source modal → wire into the topbar `Data` menu (PROMOTE).**
   `topbar.js:39` already has dead "New toy dataset…" / "Citation source…"
   stubs (currently `stub(...)` no-ops). Point them at
   `getLayerDescriptor("data").openModal()`. Highest value, smallest blast
   radius: it activates already-present menu items and makes
   project-creation discoverable. Keep the modal as the form behind the
   menu. Touch: `topbar.js`.

2. **Add-step modal → inline popover / lean on the next-steps panel (SURFACE
   INLINE).** It is a pure menu redundant with the next-steps panel (both
   render `nextStepsFor`). Collapsing it to a popover anchored on the "+"
   removes a modal hop before every config modal on the hot path. High value
   because it fires on every tree-grow action. Touch: `add-step-modal.js`,
   `workflow-chart.js:507`, possibly `panels/next-steps.js`.

3. **Clustering Optimise tab → finish moving it out of the modal (SURFACE
   INLINE).** The Optimise tab already closes the modal and renders results
   in the `validation-run-optimise` panel. The remaining work is to make
   the Optimise *launch* a panel/card action instead of a modal tab,
   leaving `clustering-modal.js` as Configure-only. Removes a tab and a
   modal-to-panel handoff. Touch: `clustering-modal.js`,
   `clustering-tabs/optimise-tab.js`, the validation-run-optimise panel.

4. **Labelling modal → inline checklist in a labelling/scoring panel
   (SURFACE INLINE).** The modal body is a small method checklist; once a
   panel exists to host it, the checklist + Apply can live inline. Medium
   value, contingent on having a host panel. Touch: `labelling-modal.js`,
   target panel, descriptor `openModal:` at `layer-descriptors.js:1216`.

5. **Algorithm modal (citation layout) → inline viewer control (SURFACE
   INLINE, low priority).** Small generic algo+params form for an optional
   visual step; natural fit as a control in the layout/viewer panel if/when
   one wants it. Low value because it is small and rarely used. Touch:
   descriptor `openModal:` at `layer-descriptors.js:762`.

6. **Fusion-comparison modal → defer (DO NOT relocate yet).** Self-labelled
   placeholder; relocating to inline panel controls only makes sense once
   the feature is real. Listed last so a downstream job knows it is
   explicitly de-prioritised, not overlooked.

**Explicitly KEEP as modals (no relocation):** `dimred-modal` (too tall,
deliberate cascade), `dim-sweep-modal` (rare, parameterised job launch),
`multi-level-modal` (rare, parameterised sweep launch), `panel-picker`
(launcher, already local to the panel "+"), and the three infrastructure
files (`modal.js`, `step-tree-picker.js`, `layer-descriptors.js`).
