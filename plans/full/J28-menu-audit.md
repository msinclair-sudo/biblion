# J28 — Menu-locality audit (analysis → spec)

> **STATUS — DONE (Wave 0, run `wf_f1eccd83-aca`).** Branch `wave0/J28-menu-locality-audit` · commit `1d4933a`. Deliverable `claude_doc_dump/menu-locality-audit-spec.md` complete (every `ui/modals/` modal covered). Flagged: legacy DOM-template modals in `main.js` excluded from scope.

- **Source plan:** `plans/ui-cleanup-plan.md` (Menus / navigation — Menu-locality audit)
- **Wave:** 0
- **Depends on:** none — can start immediately
- **Locks files:** none in app code. DELIVERABLE is an analysis spec written to `claude_doc_dump/menu-locality-audit-spec.md` (per the "specs go to claude_doc_dump/" convention).
- **Parallel-safe with:** everything — read-only over the code; writes only to `claude_doc_dump/`.
- **Order constraint:** none. Its findings feed later UI-cleanup items, so run it early.

## Goal
Audit every modal in network_toy/app/src/ui/modals/ to map menu locality: how each modal is reached, how often it is realistically used, and which ones should instead be surfaced as inline panel controls or topbar items. The output is a written spec that later UI-cleanup jobs consume.

## Changes
- Read-only pass over network_toy/app/src/ui/modals/ (and the call sites that open them — topbar, panels, workflow cards).
- Produce `claude_doc_dump/menu-locality-audit-spec.md` containing, for every modal in `ui/modals/`:
  - the modal's purpose;
  - how it is reached (entry point: topbar / panel / card / keyboard / programmatic), with file:line pointers to the open call;
  - an estimate of how often it is used (frequent / occasional / rare), with reasoning;
  - a recommendation: keep as modal, surface as an inline panel control, or promote to a topbar item — with rationale.
- Conclude with a prioritized shortlist of modals to relocate, framed so downstream jobs can pick them up.

## Verification
- The deliverable exists at `claude_doc_dump/menu-locality-audit-spec.md`.
- It is complete: every modal under network_toy/app/src/ui/modals/ appears in the audit (cross-check the file list against the spec — no modal omitted).
- Each entry has all four fields (purpose, how reached + file:line, usage estimate, recommendation) and the spec ends with the prioritized relocation shortlist.
