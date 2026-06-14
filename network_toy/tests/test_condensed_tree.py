"""MLC-0 — the HDBSCAN condensed tree is surfaced on the L0 clusterResult.

The condensed tree (the stability hierarchy HDBSCAN builds internally) is
the substrate for the §9 multi-level extraction: each layer is a cut of
this one tree at a different λ. MLC-0 only *surfaces* it — a compact,
clone-safe projection riding on `clusterResult.condensedTree`. These tests
assert it's present, well-formed, survives a save/load round-trip, and is
faithful to the shipped flat labels.

`toy_page` (n=400 HDBSCAN) is the fast default; one `@slow` test confirms
the same at real-data scale (n=5000).
"""

import pytest


# Toy mode defaults to mutual-kNN clustering (no stability tree); the
# condensed tree is HDBSCAN-only. Switch the toy tree to HDBSCAN and
# recluster before inspecting. (The real-data `page` fixture already runs
# HDBSCAN, so the @slow test needs no prelude.)
_APPLY_HDBSCAN_JS = r'''async () => {
    const state  = await import("/app/src/ui/state.js");
    const engine = await import("/app/src/ui/engine.js");
    const { defaultHdbscanParams } = await import("/app/src/clustering-hdbscan.js");
    const cur = state.getState();
    state.update({
        layerParams: {
            ...cur.layerParams,
            clustering: {
                method: "hdbscan",
                levels: [{ uid: "ct-test", params: defaultHdbscanParams(), scope: "global" }],
            },
        },
    });
    await engine.recluster();
    const s = state.getState();
    return s.clusterLevels[0].clusterResult.method;
}'''


# In-page helper: pull a structural + correctness summary of the condensed
# tree off state.clusterLevels[0].clusterResult, computing the heavy
# per-leaf invariant in JS so we don't ship 400–5000-length arrays over the
# evaluate bridge.
_SUMMARY_JS = r'''async () => {
    const st = await import("/app/src/ui/state.js");
    const s  = st.getState();
    const lvl = s.clusterLevels && s.clusterLevels[0];
    const cr  = lvl && lvl.clusterResult;
    const t   = cr && cr.condensedTree;
    if (!t) return { present: false };

    const nc = cr.nodeCluster;
    const nf = cr.noiseFlags;

    // Structural sanity.
    const m = t.numNodes;
    const lens = {
        parent:        t.parent.length,
        birthLambda:   t.birthLambda.length,
        stability:     t.stability.length,
        size:          t.size.length,
        selectedLabel: t.selectedLabel.length,
        leafHome:      t.leafHome.length,
        leafLambda:    t.leafLambda.length,
    };
    let parentOk = (m === 0) || (t.parent[0] === -1);
    for (let i = 1; i < m; i++) {
        const p = t.parent[i];
        if (!(p >= 0 && p < i)) { parentOk = false; break; }
    }
    let homeOk = true;
    for (let p = 0; p < t.n; p++) {
        const h = t.leafHome[p];
        if (!(h >= 0 && h < m)) { homeOk = false; break; }
    }

    // selectedLabel must cover exactly the flat cluster ids the stable
    // points carry, contiguously from 0.
    const labelSet = new Set();
    for (let i = 0; i < m; i++) {
        const l = t.selectedLabel[i];
        if (l >= 0) labelSet.add(l);
    }

    // Faithfulness: deepest selected ancestor of each stable leaf's home
    // must reproduce its shipped nodeCluster label. (Absorbed / noise
    // points are reassigned post-selection, so we skip noiseFlags===1.)
    function deepestSelectedLabel(node) {
        let cur = node;
        while (cur !== -1) {
            if (t.selectedLabel[cur] >= 0) return t.selectedLabel[cur];
            cur = t.parent[cur];
        }
        return -1;
    }
    let stable = 0, match = 0, mismatch = 0;
    for (let p = 0; p < t.n; p++) {
        if (nf && nf[p] === 1) continue;
        stable++;
        const lab = deepestSelectedLabel(t.leafHome[p]);
        if (lab === nc[p]) match++; else mismatch++;
    }

    return {
        present: true,
        method: cr.method,
        n: t.n,
        numNodes: m,
        root: t.root,
        lens,
        parentOk,
        homeOk,
        numSelected: labelSet.size,
        maxLabel: labelSet.size ? Math.max(...labelSet) : -1,
        stable,
        match,
        mismatch,
    };
}'''


def _assert_wellformed(out):
    assert out["present"] is True
    assert out["method"] == "hdbscan"
    assert out["numNodes"] > 0
    assert out["root"] == 0
    n = out["n"]
    m = out["numNodes"]
    # node-parallel arrays length == numNodes; per-leaf arrays length == n.
    assert out["lens"]["parent"] == m
    assert out["lens"]["birthLambda"] == m
    assert out["lens"]["stability"] == m
    assert out["lens"]["size"] == m
    assert out["lens"]["selectedLabel"] == m
    assert out["lens"]["leafHome"] == n
    assert out["lens"]["leafLambda"] == n
    # parents are always lower-id ancestors; root parent is -1.
    assert out["parentOk"] is True
    # every leaf has a valid home node.
    assert out["homeOk"] is True
    # selected labels are contiguous 0..k-1 and match the flat clustering.
    assert out["numSelected"] >= 1
    assert out["maxLabel"] == out["numSelected"] - 1
    # the tree faithfully reproduces the shipped stable labels.
    assert out["stable"] > 0
    assert out["mismatch"] == 0
    assert out["match"] == out["stable"]


def test_condensed_tree_surfaced_toy(toy_page):
    """The condensed tree rides on the L0 clusterResult after a toy
    HDBSCAN run, is well-formed, and reproduces the flat labels."""
    assert toy_page.evaluate(_APPLY_HDBSCAN_JS) == "hdbscan"
    out = toy_page.evaluate(_SUMMARY_JS)
    _assert_wellformed(out)
    assert out["n"] == 400


def test_condensed_tree_survives_save_load(toy_page):
    """The tree must round-trip through the .zip persistence layer — the
    multi-level work loads a saved project and picks up where it left off,
    so dropping the tree on save would silently break MLC-1+ after a
    reload."""
    assert toy_page.evaluate(_APPLY_HDBSCAN_JS) == "hdbscan"
    out = toy_page.evaluate(r'''async () => {
        const st  = await import("/app/src/ui/state.js");
        const ser = await import("/app/src/persistence/serialise.js");
        const des = await import("/app/src/persistence/deserialise.js");

        const before = st.getState().clusterLevels[0].clusterResult.condensedTree;
        const blob = ser.serialiseState(st.getState());
        const file = new File([blob], "roundtrip.zip", { type: "application/zip" });
        const { patch } = await des.deserialiseFile(file);
        const after = patch.clusterLevels[0].clusterResult.condensedTree;

        const sameType = (a, b, ctor) =>
            a instanceof ctor && b instanceof ctor && a.length === b.length;
        let identical = sameType(before.parent, after.parent, Int32Array)
            && sameType(before.birthLambda, after.birthLambda, Float64Array)
            && sameType(before.stability, after.stability, Float64Array)
            && sameType(before.size, after.size, Int32Array)
            && sameType(before.selectedLabel, after.selectedLabel, Int32Array)
            && sameType(before.leafHome, after.leafHome, Int32Array)
            && sameType(before.leafLambda, after.leafLambda, Float64Array);
        // spot-check values survived the binary round-trip.
        let valuesOk = identical;
        if (identical) {
            for (let i = 0; i < before.parent.length; i++) {
                if (before.parent[i] !== after.parent[i]) { valuesOk = false; break; }
                if (before.selectedLabel[i] !== after.selectedLabel[i]) { valuesOk = false; break; }
            }
            for (let p = 0; p < before.leafHome.length; p++) {
                if (before.leafHome[p] !== after.leafHome[p]) { valuesOk = false; break; }
            }
        }
        return {
            beforeNodes: before.numNodes,
            afterNodes: after && after.numNodes,
            afterN: after && after.n,
            afterRoot: after && after.root,
            identical,
            valuesOk,
        };
    }''')
    assert out["beforeNodes"] > 0
    assert out["afterNodes"] == out["beforeNodes"]
    assert out["afterN"] == 400
    assert out["afterRoot"] == 0
    assert out["identical"] is True
    assert out["valuesOk"] is True


@pytest.mark.slow
def test_condensed_tree_surfaced_real(page):
    """Same surfacing + faithfulness invariant at real-data scale — the
    n=5000 BFS subset is where the degenerate deep-chain trees the
    condensation guards against actually appear."""
    out = page.evaluate(_SUMMARY_JS)
    _assert_wellformed(out)
    assert out["n"] == 5000
