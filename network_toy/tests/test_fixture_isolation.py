"""Guards on the per-test geometry-slot reset (conftest `_reset_page`).

The browser tier shares one rehydrated session page across a module's
tests and restores the pristine real-data geometry slots between tests.
That restore deep-clones each slot from the snapshot (`structuredClone`)
so a test that mutates a geometry array IN PLACE gets its own copy and
cannot corrupt the shared pristine snapshot for later tests — pytest
documents that shared values are otherwise passed with no copy (the same
no-copy reference-sharing hazard). These tests lock that property in.
"""

import pytest


def test_pristine_slots_are_cloned_not_shared(page):
    """After reset, every restored geometry slot is a DISTINCT object from
    the pristine snapshot (proof the clone-on-restore ran), and mutating a
    restored typed array in place leaves the snapshot untouched."""
    res = page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const s = state.getState();
            const ps = window.__pristineSlots || {};

            // (1) Identity: each non-null restored slot must be a fresh clone,
            //     i.e. a different object reference than the snapshot holds.
            const sharedRefs = [];
            for (const k of Object.keys(ps)) {
                if (ps[k] == null) continue;
                if (s[k] === ps[k]) sharedRefs.push(k);   // would be a leak
            }

            // (2) In-place isolation: mutate the first typed-array slot we
            //     find and confirm the pristine snapshot does not move.
            let mutationProbed = null;     // slot name we tested, or null
            let mutationIsolated = null;
            for (const k of Object.keys(ps)) {
                const live = s[k], pristine = ps[k];
                if (ArrayBuffer.isView(live) && ArrayBuffer.isView(pristine)
                    && live.length > 0) {
                    const before = pristine[0];
                    live[0] = before + 9999;            // clobber the live copy
                    mutationIsolated = (pristine[0] === before);
                    live[0] = before;                   // leave live tidy
                    mutationProbed = k;
                    break;
                }
            }
            return {
                snapshotKeys: Object.keys(ps),
                sharedRefs,
                mutationProbed,
                mutationIsolated,
            };
        }'''
    )

    assert res["snapshotKeys"], "no pristine geometry slots were snapshotted"
    assert res["sharedRefs"] == [], (
        f"slots restored by shared reference, not cloned: {res['sharedRefs']} "
        "— an in-place mutation in one test would leak into the next"
    )
    # The baseline fixture carries typed-array geometry, so we expect to have
    # actually exercised the mutation path.
    assert res["mutationProbed"] is not None, (
        "no typed-array slot found to probe in-place isolation"
    )
    assert res["mutationIsolated"] is True, (
        f"mutating live {res['mutationProbed']} in place corrupted the "
        "pristine snapshot — clone-on-restore is not protecting the session"
    )


@pytest.mark.perf
def test_pristine_clone_cost(page):
    """Measure the wall-clock cost of the per-test deep-clone restore. The
    clone-on-restore in `_reset_page` runs once per test, so it must stay
    cheap. Budget is deliberately generous (a regression catcher, not a
    tight gate); the measured value rides in the assertion message."""
    ms = page.evaluate(
        '''async () => {
            const ps = window.__pristineSlots || {};
            const t0 = performance.now();
            const restored = {};
            for (const k of Object.keys(ps)) {
                restored[k] = ps[k] == null ? ps[k] : structuredClone(ps[k]);
            }
            const t1 = performance.now();
            return t1 - t0;
        }'''
    )
    assert ms < 50.0, (
        f"per-test geometry clone took {ms:.2f} ms (budget 50 ms) — if this "
        "is consistently high, switch to cloning only the slots a test "
        "dirtied (see plans/test-suite/standards-alignment-plan.md §3.2)"
    )
