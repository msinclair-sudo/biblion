"""Node displacement — card / colour / next-steps WIRING.

The pure compute (eval/node-displacement.js: Procrustes-align pre onto post,
per-node distance) moved to the Node unit tier
(tests/unit/node-displacement.test.mjs). These remaining tests exercise the
card auto-spawn + refId wiring + colour-mode/next-steps surfacing, which import
layer-descriptors / next-steps-rules (engine → esm.sh UMAP) and so stay on
Playwright.
"""


def test_displacement_autospawns_after_fusion_fork(clean_page):
    """Pass 1d + J15: when the dimred descriptor's auto-fork creates the
    pre+post fusion branches, a nodeDisplacement card auto-spawns. J15
    re-parented it onto the two branch cards: the POST branch is the
    structural parent and the PRE branch rides as a ref-edge (promoted to a
    second solid edge by the chart). Drives this via the same code path the
    dimred descriptor uses: spawn the branches, then verify nodeDisplacement
    appears under the POST branch with a ref to the PRE branch.

    We can't easily run a real graph-diffusion dimred end-to-end (toy data
    doesn't ship citation edges by default), so this test exercises the
    helper by simulating the post-fork state and calling the same
    fusionBranchDescriptor path the auto-fork uses."""
    out = clean_page.evaluate(r'''async () => {
        const wf = await import("/app/src/ui/workflow.js");
        const ld = await import("/app/src/ui/modals/layer-descriptors.js");
        wf.clearWorkflow();
        // Stand up a fusion-active dimred + both branches.
        const n = 4;
        const post = Float32Array.from([0,0,0, 2,0,0, 0,2,0, 2,2,0]);
        const pre  = post.slice();
        pre[3] = 2 + 0.7;                  // node 1 moves
        const data = wf.createStep({ type: "data", label: "data" });
        const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
        wf.updateStepStatus(dim, "running");
        wf.setStepResult(dim, {
            dimredResult: { d:1, data:new Float32Array([1]) }, _basePos: post,
            dimredResultPreFusion: { d:1, data:new Float32Array([2]) }, _basePosPreFusion: pre,
            fusionActive: true,
        });
        // Create both branches as the dimred auto-fork does.
        const fbd = ld.getLayerDescriptor("fusionBranch");
        await fbd.applyChange({ endpoint: "pre",  parentId: dim });
        await fbd.applyChange({ endpoint: "post", parentId: dim });
        // Select POST as the auto-fork does.
        const preB  = wf.listSteps({ type: "fusionBranch" }).find(b => b.params.endpoint === "pre");
        const postB = wf.listSteps({ type: "fusionBranch" }).find(b => b.params.endpoint === "post");
        wf.selectStep(postB.id);

        // Now invoke the auto-spawn directly the way the dimred descriptor's
        // .then() callback does (its helper). Easiest way without re-running
        // engine.redimred: invoke nodeDisplacementDescriptor.applyChange,
        // which the auto-spawn helper would call.
        await ld.getLayerDescriptor("nodeDisplacement").applyChange();

        // J15: parent is the POST branch; PRE branch rides as the single ref.
        const ndCards = wf.listSteps({ type: "nodeDisplacement" }).filter(c => c.parentId === postB.id);
        const ndUnderPost = ndCards.length === 1;
        const refIsPre = ndCards[0] && ndCards[0].refIds
            && ndCards[0].refIds.length === 1 && ndCards[0].refIds[0] === preB.id;

        // Confirm the fusionBranch's "+" menu NO LONGER offers nodeDisplacement
        // (since it auto-fires from the dimred now).
        const ns = await import("/app/src/ui/next-steps-rules.js");
        const fbRules = ns.addStepRulesFor("fusionBranch").map(r => r.modal);

        return {
            ndUnderPost,
            refIsPre,
            status: ndCards[0] && ndCards[0].status,
            fbOffersND: fbRules.includes("nodeDisplacement"),
        };
    }''')
    assert out["ndUnderPost"] is True
    assert out["refIsPre"] is True
    assert out["status"] == "done"
    # The fusionBranch's manual menu no longer offers nodeDisplacement
    # (Pass 1d removed it — auto-fires from dimred fork instead).
    assert out["fbOffersND"] is False


def test_displacement_card_wires_both_branches(clean_page):
    """J15: the node-displacement card is parented on the POST fusion branch
    and references the PRE branch as its single refId. It computes a result
    from the dimred card's pre/post basePos (the job reads endpoints from the
    explicit branch ids, not from parentId)."""
    out = clean_page.evaluate(r'''async () => {
        const wf = await import("/app/src/ui/workflow.js");
        const ld = await import("/app/src/ui/modals/layer-descriptors.js");
        wf.clearWorkflow();
        const n = 8;
        const post = Float32Array.from([0,0,0, 2,0,0, 0,2,0, 2,2,0, 0,0,2, 2,0,2, 0,2,2, 2,2,2]);
        const pre  = post.slice();
        pre[9] = 2 + 0.8; pre[10] = 2 + 0.8;   // node 3 moves modestly
        const data = wf.createStep({ type: "data", label: "data" });
        const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
        wf.updateStepStatus(dim, "running");
        wf.setStepResult(dim, {
            dimredResult: { d:1, data:new Float32Array([1]) }, _basePos: post,
            dimredResultPreFusion: { d:1, data:new Float32Array([2]) }, _basePosPreFusion: pre,
            fusionActive: true,
        });
        const preB  = wf.createStep({ type: "fusionBranch", label: "Pre-fusion",  params: { endpoint: "pre"  }, parentId: dim });
        const postB = wf.createStep({ type: "fusionBranch", label: "Post-fusion", params: { endpoint: "post" }, parentId: dim });
        wf.updateStepStatus(preB, "running");  wf.setStepResult(preB,  { endpoint: "pre"  });
        wf.updateStepStatus(postB, "running"); wf.setStepResult(postB, { endpoint: "post" });
        wf.selectStep(postB);

        await ld.getLayerDescriptor("nodeDisplacement").applyChange();
        const card = wf.listSteps({ type: "nodeDisplacement" }).slice(-1)[0];
        const nd = card.result && card.result.nodeDisplacement;
        return {
            status: card.status,
            parentIsPostBranch: card.parentId === postB,
            refIds: card.refIds,
            refIsPre: !!(card.refIds && card.refIds.length === 1 && card.refIds[0] === preB),
            topMover: nd && nd.topMovers[0].id,
            hasDist: !!(nd && nd.dist && nd.dist.length === n),
        };
    }''')
    assert out["status"] == "done"
    assert out["parentIsPostBranch"] is True       # J15: parented on POST branch
    assert out["refIsPre"] is True                  # PRE branch is the single ref
    assert out["topMover"] == 3                    # the moved node
    assert out["hasDist"] is True


def test_displacement_colour_mode_and_next_steps(clean_page):
    """When state.nodeDisplacement is set, the viewer offers the displacement
    colour modes. The fusion branch no longer offers nodeDisplacement
    manually (Pass 1d: it auto-fires from the dimred fork once both branches
    exist), but compare-branch-clusterings stays as a manual option."""
    out = clean_page.evaluate(r'''async () => {
        const cm = await import("/app/src/ui/viewer-shared/colour-modes.js");
        const ns = await import("/app/src/ui/next-steps-rules.js");
        const state = {
            clusterLevels: [], genResult: { nodes: [{id:0},{id:1}] },
            nodeDisplacement: { dist: Float32Array.from([0.1, 0.9]), max: 0.9, logMax: Math.log1p(0.9) },
        };
        const opts = cm.getColourModeOptions(state).map(o => o.value);
        const c0 = cm.baseColourFor({ id: 0 }, state, "displacement");
        const c1 = cm.baseColourFor({ id: 1 }, state, "displacement");
        return {
            hasDisp: opts.includes("displacement"),
            hasDispLog: opts.includes("displacement:log"),
            coloursDiffer: c0 !== c1,
            branchOffers: ns.addStepRulesFor("fusionBranch").map(r => r.modal),
        };
    }''')
    assert out["hasDisp"] is True
    assert out["hasDispLog"] is True
    assert out["coloursDiffer"] is True            # low vs high displacement → different colour
    assert "nodeDisplacement" not in out["branchOffers"]  # auto-fires; no manual menu entry
    assert "fusionComparison" in out["branchOffers"]      # compare-branch topology remains manual
