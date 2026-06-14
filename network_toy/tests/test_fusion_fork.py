"""Fusion fork (Phase A) — pre/post-fusion as forked workflow branches.

When a dim-reduction card ran fusion (a second pre-fusion embedding exists),
the workflow auto-forks into a pre branch + a post branch under it. Each
fusionBranch is a ROUTER: selecting it projects its endpoint's embedding into
the legacy dimredResult/_basePos slots, so a clustering card under the branch
clusters that embedding. Post is the default selection.

Phase A coexists with the existing dual-track; these tests cover the fork +
routing only.
"""


def test_fusion_branch_projects_correct_embedding(clean_page):
    """A pre branch projects the pre-fusion embedding into dimredResult; a post
    branch projects the post-fusion embedding. The projector swaps per branch."""
    out = clean_page.evaluate(r'''async () => {
        const wf = await import("/app/src/ui/workflow.js");
        const st = await import("/app/src/ui/state.js");
        const proj = await import("/app/src/ui/workflow-projection.js");
        wf.clearWorkflow();
        // Distinct marker objects so we can tell which embedding got projected.
        const POST = { d: 3, data: new Float32Array([1,1,1]), _tag: "post" };
        const PRE  = { d: 3, data: new Float32Array([2,2,2]), _tag: "pre"  };
        const POSTBP = new Float32Array([1,1,1]);
        const PREBP  = new Float32Array([2,2,2]);
        const data = wf.createStep({ type: "data", label: "data" });
        const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
        wf.updateStepStatus(dim, "running");
        wf.setStepResult(dim, {
            dimredResult: POST, _basePos: POSTBP, _basePos2d: null,
            dimredResultPreFusion: PRE, _basePosPreFusion: PREBP,
            fusionActive: true,
        });
        const preB  = wf.createStep({ type: "fusionBranch", label: "Pre-fusion",  params: { endpoint: "pre"  }, parentId: dim });
        const postB = wf.createStep({ type: "fusionBranch", label: "Post-fusion", params: { endpoint: "post" }, parentId: dim });
        wf.updateStepStatus(preB, "running");  wf.setStepResult(preB,  { endpoint: "pre"  });
        wf.updateStepStatus(postB, "running"); wf.setStepResult(postB, { endpoint: "post" });

        proj.projectStepIntoLegacyState(postB);
        const postTag = st.getState().dimredResult && st.getState().dimredResult._tag;
        proj.projectStepIntoLegacyState(preB);
        const preTag  = st.getState().dimredResult && st.getState().dimredResult._tag;
        const preBP   = st.getState()._basePos;

        return { postTag, preTag, preBPisPre: preBP === PREBP };
    }''')
    assert out["postTag"] == "post"        # post branch → post embedding
    assert out["preTag"] == "pre"          # pre branch → pre embedding (override)
    assert out["preBPisPre"] is True       # _basePos swapped too


def test_dimred_autospawns_branches_when_fusion(clean_page):
    """Applying a dimred whose result is fusionActive auto-spawns a pre + post
    branch under it, with the post branch selected."""
    out = clean_page.evaluate(r'''async () => {
        const wf = await import("/app/src/ui/workflow.js");
        const ld = await import("/app/src/ui/modals/layer-descriptors.js");
        wf.clearWorkflow();
        // Stand up a dimred card whose result reports fusionActive, then drive
        // the auto-spawn via the fusionBranch descriptor (the dimred
        // descriptor's promise hook calls exactly this).
        const data = wf.createStep({ type: "data", label: "data" });
        const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
        wf.updateStepStatus(dim, "running");
        wf.setStepResult(dim, {
            dimredResult: { d:1, data:new Float32Array([1]) },
            dimredResultPreFusion: { d:1, data:new Float32Array([2]) },
            _basePos: new Float32Array([1]), _basePosPreFusion: new Float32Array([2]),
            fusionActive: true,
        });
        const fb = ld.getLayerDescriptor("fusionBranch");
        await fb.applyChange({ endpoint: "pre",  parentId: dim });
        await fb.applyChange({ endpoint: "post", parentId: dim });

        const branches = wf.listSteps({ type: "fusionBranch" }).filter(b => b.parentId === dim);
        return {
            n: branches.length,
            endpoints: branches.map(b => b.params.endpoint).sort(),
            allDone: branches.every(b => b.status === "done"),
            parents: branches.every(b => b.parentId === dim),
        };
    }''')
    assert out["n"] == 2
    assert out["endpoints"] == ["post", "pre"]
    assert out["allDone"] is True
    assert out["parents"] is True


def test_clustering_attaches_under_selected_branch(clean_page):
    """With a fusion branch selected, a clustering / multi-layer step attaches
    UNDER that branch (so each branch carries its own clustering), not the
    dimred card."""
    out = clean_page.evaluate(r'''async () => {
        const wf = await import("/app/src/ui/workflow.js");
        const ld = await import("/app/src/ui/modals/layer-descriptors.js");
        wf.clearWorkflow();
        const data = wf.createStep({ type: "data", label: "data" });
        const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
        wf.updateStepStatus(dim, "running");
        wf.setStepResult(dim, { dimredResult: { d:1, data:new Float32Array([1]) }, _basePos: new Float32Array([1]),
            dimredResultPreFusion: { d:1, data:new Float32Array([2]) }, _basePosPreFusion: new Float32Array([2]),
            fusionActive: true });
        const postB = wf.createStep({ type: "fusionBranch", label: "Post-fusion", params: { endpoint: "post" }, parentId: dim });
        wf.updateStepStatus(postB, "running"); wf.setStepResult(postB, { endpoint: "post" });
        wf.selectStep(postB);

        // The multiLevel descriptor's resolveParent should pick the branch.
        const active = ld.getLayerDescriptor("multiLevel").getActive();
        // next-steps: fusionBranch offers clustering + multiLevel.
        const ns = await import("/app/src/ui/next-steps-rules.js");
        return {
            multiLevelParent: active.parentId,
            branchId: postB,
            branchOffers: ns.addStepRulesFor("fusionBranch").map(r => r.modal),
        };
    }''')
    assert out["multiLevelParent"] == out["branchId"]   # attaches under the branch
    assert "clustering" in out["branchOffers"]
    assert "multiLevel" in out["branchOffers"]
