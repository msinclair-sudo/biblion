# Full execution approach — network_toy feature additions

This directory is the **orchestration layer** over the seven plans in
`plans/`. The plans say *what* to build; this says *in what order, by whom,
and what can run at the same time without two jobs fighting over the same
file*.

Source plans (the detail lives there — jobs link back, they don't restate):

| Plan | File |
|---|---|
| Round-trip save fidelity | `plans/project-save-fix-plan.md` (Part A only — Part B is superseded) |
| Toy-data removal | `plans/toy-removal-plan.md` |
| Dataset picker + nested saves | `plans/dataset-picker-plan.md` |
| SQL library search | `plans/sql-search-plan.md` |
| Cluster labelling improvements | `plans/labelling-improvement-plan.md` |
| Test-suite overhaul | `plans/test-suite-plan.md` |
| UI cleanup (living backlog) | `plans/ui-cleanup-plan.md` |

Each unit of work is a numbered job (`J01`…) with its own file in this
directory. A job is sized to be one branch / one PR / one agent.

---

## 1. The shape of the problem

These are not seven independent features. Three forces couple them:

1. **A shared spine of foundational files.** `deserialise.js`,
   `serialise.js`, `manifest.js`, `engine.js`, `state.js`, `topbar.js`,
   and the datasource `registry.js` are each edited by *multiple* plans.
   Parallel-editing any of them produces merge pain or, worse, silent
   logic clobbering (two plans both flipping a default).

2. **A schema-version gate.** Round-trip (J01) bumps `SCHEMA_VERSION`
   3 → 4 and changes what a save contains. Toy-removal (J02) changes
   defaults and adds a back-compat shim. **Test fixtures cannot be
   generated until both have landed** — otherwise the committed `.zip`s
   are stale the moment they're created.

3. **A feature dependency chain.** The dataset picker introduces
   `serve.py` and `/api/datasets`; SQL-search's scope selector and several
   UI-cleanup items (databases dropdown, data-panel identity) consume that
   API. They cannot start until the picker exists.

So the strategy is **waves**: within a wave, jobs touch disjoint files and
run fully in parallel; between waves, a barrier where the next wave depends
on the previous wave's output (a schema, an API, a settled set of defaults).

---

## 2. Dependency graph

```
                         ┌──────────────────────────────────────────────┐
 WAVE 0 (start now)      │  J03 test-tier-0   J04 labelling             │
 fully independent       │  J11 dimred-modal  J17 scoring-stackedbar    │
 no spine files          │  J18 cart-slot     J21 move-tabs             │
                         │  J22 pick-layers   J24 heatmap-diagonal      │
                         │  J28 menu-audit                              │
                         └──────────────────────────────────────────────┘

 WAVE 1 (the spine — sequential with each other)
   J01 round-trip fidelity  ──►  J02 toy-removal + legacy retirement
   (serialise/deserialise/       (deserialise shim, engine, state,
    manifest/workflow/topbar      registries, data-panel, tests)
    → SCHEMA v4)                  └── settles defaults + schema

 WAVE 2 (needs the spine)
   J05 dataset-picker + serve.py   ◄── needs J01 (round-trip) + J02 (registry/real drop)
   J06 generate fixtures + guards  ◄── needs J01 (v4) + J02 (defaults final)
   J14 remove alpha slider          ◄── needs J02 (migration/state settled)
   J10 dynamic layout + UI-prefs    ◄── needs J01 (serialise) for persistence

 WAVE 3 (needs Wave 2 output)
   J07 test Tier-1 retier + xdist  ◄── needs J06 (fixtures) + J01 (round-trip)
   J09 SQL library search           ◄── needs J05 (/api/datasets)
   J26 databases dropdown           ◄── needs J05
   J27 data-panel open-dataset      ◄── needs J05
   J13 eager fusion branch cards    ◄── layer-descriptors (after J02 settles)
       └─► J15 node-disp branches    (same files as J13 — sequential)
       └─► J16 drop cross-cluster card (same files — sequential)

 WAVE 4 (consumers + refactors, late so they rebase onto everything)
   J25 node-highlight framework     ◄── folds in J09 searchMatches + scoring select
   J23 scoring panel add-to-cart/sort ◄── after J04 (same file: scoring.js)
   J19 edge controls → 3D settings   ┐ share main.js/viewer-3d.js —
   J20 fusion slider → 3D viewer     ┘ sequential with each other
   J12 shared widget/field-row kit   ◄── last: touches the most surfaces
   J08 Tier-2 @slow quarantine       ◄── fold into J07 if convenient
```

---

## 3. File-conflict matrix (the parallel-safety contract)

Two jobs may run **in parallel only if they share no file in this table**.
When they do share a file, the **Order** column is law.

| Shared file | Jobs that touch it | Order |
|---|---|---|
| `persistence/deserialise.js` | J01, J02 | J01 → J02 |
| `persistence/serialise.js` | J01, J10 | J01 → J10 |
| `persistence/manifest.js` | J01 | — |
| `ui/workflow.js` | J01 | — |
| `ui/topbar.js` | J01, J05, J09, J18, J26 | J01 first; then one at a time |
| `ui/engine.js` | J02 | — |
| `ui/state.js` | J02, J09, J10, J14, J25 | J02 first; then coordinate (distinct slices) |
| `datasource/sqlite.js` | J05, J09, J27 | J05 → {J09, J27} |
| `datasource/registry.js` | J02 (drop toy), J05 (drop real) | J02 → J05 |
| `ui/viewer-shared/colour-modes.js` | J02(opt), J09, J25 | J02 → J09 → J25 |
| `ui/panels/scoring.js` | J04, J23 | J04 → J23 |
| `tests/conftest.py` | J02, J07 | J02 → J07 |
| `ui/data-panel.js` | J02, J27 | J02 → J27 |
| `ui/modals/layer-descriptors.js` | J13, J15, J16 | J13 → J15 → J16 |
| `ui/workflow-chart.js` | J14, J15, J16, J17 | J17 standalone; J14/J15/J16 sequential |
| `ui/main.js` | J14, J19, J20 | J14 → J19 → J20 |
| `ui/panels/viewer-3d.js` | J19, J20, J25 | J19 → J20 → J25 |
| `index.html` | J14, J19 | J14 → J19 |
| `styles/main.css` | J10, J11, J12, J22 | J11/J22 early; J10 mid; J12 last |

Everything **not** in this table (e.g. `cluster-labels.js`, `dimred-modal.js`,
`panel-system.js`, `multilayer-curve.js`, `cross-cluster.js`, `heatmap.js`,
new files like `serve.py`, `sql-search.js`, `search-results.js`,
`projects-api.js`) is touched by exactly one job and is parallel-safe.

**Worktree note:** because so many jobs converge on `topbar.js`, `state.js`,
and the descriptor/chart files, prefer running same-file jobs in sequence on
one branch over isolated worktrees that all rebase onto a moving target. Use
worktrees only for the genuinely file-disjoint Wave-0 set.

---

## 4. Critical path

```
J01 ─► J02 ─► J05 ─► J09
            └► J06 ─► J07
```

`J01 → J02` is the longest hard-sequential chain and gates the most
downstream work (fixtures, picker, search). **Land J01 and J02 first and
fast.** Everything in Wave 0 runs alongside them and buys nothing by
waiting; everything in Waves 2–4 is blocked until the spine settles.

The single biggest scheduling lever: get J01 reviewed and merged so J02
can take `deserialise.js` cleanly, then merge J02 so the registry/default
churn stops and J05 + J06 can both start.

---

## 5. Job index

Foundations / spine:
- **J01** — Round-trip save fidelity (`plans/project-save-fix-plan.md` Part A)
- **J02** — Toy-data removal + legacy v3 retirement (`plans/toy-removal-plan.md`)

Test suite:
- **J03** — Tier-0 Node pure-logic port + portability boundary check
- **J06** — Build & commit fallworm fixtures + freshness/determinism guards
- **J07** — Tier-1 browser rehydrate retier + `pytest-xdist`
- **J08** — Tier-2 `@slow` quarantine (real UMAP/HDBSCAN)

Data / search:
- **J05** — Dataset picker + `serve.py` `/api/datasets` + nested saves
- **J09** — SQL library search panel (ATTACH cross-DB)

Labelling:
- **J04** — Cluster labelling improvements (paper-df banding + scoring-panel visibility)

UI cleanup — workflow cards:
- **J13** — Eager pre/post-fusion branch cards
- **J14** — Remove the alpha/blend slider
- **J15** — Node-displacement branches from pre+post fusion
- **J16** — Drop the cross-cluster-citations card → auto panel
- **J17** — Scoring card mini stacked-bar

UI cleanup — panels & charts:
- **J18** — Cart panel defaults to the right (secondary) slot
- **J19** — Edge colour/toggle controls → 3D viewer settings popup
- **J20** — Fusion slider → 3D viewer (bottom-left, vertical)
- **J21** — Move/pop tabs between slots
- **J22** — "Pick layers" panel: single-column stack
- **J23** — Scoring panel: add-to-cart + paper count + sort control
- **J24** — Cross-citation heatmap excludes the diagonal
- **J25** — Node-highlight framework (coloured glow, multi-source)

UI cleanup — layout / shell / refactor:
- **J10** — Dynamic layout: draggable dividers, collapse rails, persisted UI-prefs
- **J11** — Dimred modal: default profile + two-column layout
- **J12** — Shared widget / field-row kit + one spacing language
- **J26** — "Databases" dropdown menu (top-left)
- **J27** — Data panel references the open dataset / connected DB
- **J28** — Menu-locality audit (analysis deliverable → spec)

---

## 6. How to run this

1. **Kick off Wave 0 immediately** — J03, J04, J11, J17, J18, J21, J22,
   J24, J28 share no spine files and can each go on their own branch/agent
   in parallel today.
2. **Run the spine in series** — J01, then J02. Nothing in Wave 2+ starts
   until both merge.
3. **After the spine merges**, fan out Wave 2 (J05, J06, J10, J14), then
   Wave 3, then Wave 4, honouring the order column in §3 for any shared file.
4. **Each job file** lists: source plan, depends-on, files it locks,
   jobs it's parallel-safe with, the change, and its own verification.
   Re-read the source plan section it cites before starting — line numbers
   there were verified 2026-06-14.

Convention reminders (from project memory): feature **specs** that come out
of analysis jobs (e.g. J28, or any UI-cleanup item promoted to a spec) go
to `claude_doc_dump/`, not here. This `plans/full/` tree is the execution
plan only.

---

## 7. Status log

**Wave 0 — DONE** (run `wf_f1eccd83-aca`). Each on its own branch, one scoped
commit, **unmerged** (review-then-merge):

| Job | Branch | Commit | Verified |
|---|---|---|---|
| J03 | `wave0/J03-node-portable-ports` | `15b07e2` | `npm run test:unit` 47/47 |
| J04 | `wave0/J04-cluster-labelling-paper-df` | `39fe06f` | Node tests green; browser eyeball pending |
| J11 | `wave0/J11-dimred-default-two-column` | `622cfa5` | parse-only; browser pending |
| J17 | `wave0/J17-scoring-mini-bar` | `90afc84` | parse-only; browser pending |
| J21 | `wave0/J21-move-pop-tabs` | `0a4c3eb` | parse-only; browser pending |
| J22 | `wave0/J22-pick-layers-single-column` | `ecc62d5` | parse-only; browser pending |
| J24 | `wave0/J24-heatmap-exclude-diagonal` | `2a0e19e` | parse-only; browser pending |
| J28 | `wave0/J28-menu-locality-audit` | `1d4933a` | deliverable complete |

**Emergent merge note (not in the §3 matrix):** J02 and J03 both touch
`tests/test_multilevel.py`, `tests/test_slice_2_9_step_bindings.py`, and
`tests/test_step_job_binding.py` (J03 trims them to browser residue; J02
re-homes toy tests off them). **Merge J03 before J02** and resolve J02 on top.

**Wave 1 (spine) — DONE** (run `wf_de3bc524-91c`). Sequential; J02 built on J01.

| Job | Branch | Commit | Verified |
|---|---|---|---|
| J01 | `wave1/J01-roundtrip` | `f4f66cd` | parse + grep; browser round-trip pending |
| J02 | `wave1/J02-toy-removal` (contains J01) | `e03fd18` | parse + dangling-ref grep clean; boot/ingest + pytest pending |

`wave1/J02-toy-removal` is the merge-ready spine tip: base + J01 + J02. All
Wave-2 branches should build on it (merge `wave1/J02-toy-removal` first).

**Spine verification — DONE (Playwright/Chromium, conda env `biblion`).**
- J01: focused workflow-tree round-trip test PASSES — `state.workflow` persists,
  nested TypedArrays revive (type + values), shared-buffer dedup revives the flat
  slot, and `view` pass-through restores. `test_persistence` (stash/revive +
  TypedArray) also green.
- J02: registries carry no `toy`/`taste-network`, defaults are `real` /
  `imported-edges`, toy state slots gone, app boots clean (no console errors).
- Fast suite on J02: **56 passed**; the 47 errors + 2 of the 3 failures are the
  pre-existing **`dev_subset_bfs_5000` dataset being absent** in this environment
  (session fixture 404 → JSON-parse-of-HTML) — NOT a spine defect; J06/J07 remove
  this dependency. The 3rd failure (`test_scoring_card` `scoringFollow == []` vs
  `['export']`) is a stale pre-existing test (J02 never touched next-steps-rules).
- **Not exercised here:** full real-data ingest cascade (needs the absent
  dev-subset). Covered indirectly by boot + round-trip + registry checks.

Setup note: `playwright==1.60.0` was declared in `pyproject.toml` `[dev]` but not
installed; `pip install -e '.[dev]'` fixed it (Chromium binaries were already
cached). The `biblion` env now has the web viewer.
