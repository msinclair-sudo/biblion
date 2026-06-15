# J13 — Eager pre/post-fusion branch cards

- **Source plan:** `plans/ui-cleanup-plan.md` (Workflow cards — Eager pre/post-fusion branch cards)
- **Wave:** 3
- **Depends on:** J02 (descriptor/state defaults settled)
- **Locks files:** network_toy/app/src/ui/modals/layer-descriptors.js
- **Parallel-safe with:** any job not locking those files. NOT with: J15, J16 (same file: layer-descriptors.js)
- **Order constraint:** J13 → J15 → J16 (all three serialize on layer-descriptors.js)

## Goal
Make the pre- and post-fusion branch cards appear under a dim-reduction card as soon as it is added/selected, instead of waiting for the compute job to finish. This lets the user queue clustering on either branch while dim-reduction is still running.

## Changes
Group by file.

- `network_toy/app/src/ui/modals/layer-descriptors.js`
  - In the dimred descriptor, the branch cards are currently spawned inside the `promise.then(...)` after `engine.redimred()` resolves and gated on `dimredCard.result.fusionActive` (~L435-459). Move the fork creation earlier: spawn pending/placeholder branch cards eagerly when the `fusion` param (already known up front from the dimred modal config) is non-identity.
  - When the job lands, fill in the placeholder cards with the resolved result rather than creating them.
  - Re-run path: when branches already exist, do not double-spawn — reuse/refresh the existing branch cards.
  - Identity-fusion case: when `fusion` is identity there is no fork — do not spawn branch cards.

## Verification
Must be verified in a real browser (Playwright / webapp-testing), not just unit smoke.

- Add/select a dim-reduction card with a non-identity fusion: confirm the pre- and post-fusion branch cards appear immediately (as pending/placeholder), before the dimred job finishes.
- While dim-reduction is still running, confirm clustering can be queued on either branch.
- When the dimred job resolves, confirm the placeholder cards fill in (no duplicate cards spawned).
- Re-run a dimred card whose branches already exist: confirm no duplicate branch cards appear.
- Add a dimred card with identity fusion: confirm no branch fork is created.
