"""Methods recipe — export the workflow's method (card sequence + params,
pruned at cluster picking) and replay it onto a freshly-loaded dataset.

Two tiers:
  1. buildRecipe() prune/shape — pure, synthetic tree via wf.createStep
     (mirrors test_scoring.py / test_fusion_fork.py harness), no compute.
  2. end-to-end replay — real toy compute: build data→dimred→multiLevel,
     export, clear, re-load data, applyRecipe, assert the compute cards
     re-ran and the picker auto-spawned pending (the stop-at-picking boundary).
"""

import pytest


def test_build_recipe_prunes_at_cluster_picking(clean_page):
    """A synthetic data→dimred→(pre/post branches)→multiLevel→picker→labelling
    tree exports only the long-running compute: the picker and everything below
    it (labelling) are pruned; params are kept, result/status stripped."""
    out = clean_page.evaluate(r'''async () => {
        const wf = await import("/app/src/ui/workflow.js");
        const rc = await import("/app/src/persistence/recipe.js");
        wf.clearWorkflow();
        const data = wf.createStep({ type: "data", label: "data",
            params: { mode: "sqlite", dataset: "fallworm" } });
        const dim = wf.createStep({ type: "dimred", label: "dim", parentId: data,
            params: { noise: {}, fusion: { method: "graph-diffusion" },
                      compression: {}, viz: {}, viz2d: {} } });
        const pre  = wf.createStep({ type: "fusionBranch", label: "Pre",
            params: { endpoint: "pre" },  parentId: dim });
        const post = wf.createStep({ type: "fusionBranch", label: "Post",
            params: { endpoint: "post" }, parentId: dim });
        const ml = wf.createStep({ type: "multiLevel", label: "sweep", parentId: post,
            params: { minSamples: 15, floor: 0.6, B: 10 } });
        const pk = wf.createStep({ type: "multiLevelPicker", label: "pick",
            params: {}, parentId: ml });
        wf.createStep({ type: "labelling", label: "labels",
            params: { methods: [] }, parentId: pk });

        const recipe = rc.buildRecipe();
        const mlStep = recipe.steps.find(s => s.type === "multiLevel");
        const postStep = recipe.steps.find(s => s.endpoint === "post");
        const first = recipe.steps[0];
        return {
            schema:  recipe.schema,
            version: recipe.version,
            dataset: recipe.dataBinding.dataset,
            types:   recipe.steps.map(s => s.type),
            stepKeys: Object.keys(first).sort(),
            // multiLevel's parent must be the post branch (mapping preserved).
            mlParentIsPost: mlStep.parentRecipeId === postStep.recipeId,
            // no surviving step references a pruned step.
            refsResolve: recipe.steps.every(s =>
                s.refRecipeIds.every(r => recipe.steps.some(t => t.recipeId === r))),
            mlHasParams: !!mlStep.params && mlStep.params.minSamples === 15,
        };
    }''')
    assert out["schema"] == "network_toy.recipe"
    assert out["version"] == 1
    assert out["dataset"] == "fallworm"
    # picker + labelling pruned; the two branches + sweep survive.
    assert out["types"] == ["data", "dimred", "fusionBranch", "fusionBranch", "multiLevel"]
    assert out["mlParentIsPost"] is True
    assert out["refsResolve"] is True
    assert out["mlHasParams"] is True
    # result / status / timestamps stripped — only the recipe whitelist remains.
    assert "result" not in out["stepKeys"]
    assert "status" not in out["stepKeys"]
    assert out["stepKeys"] == sorted(
        ["recipeId", "type", "label", "params", "parentRecipeId", "refRecipeIds", "endpoint"])


def test_apply_recipe_replays_compute_and_stops_at_picking(clean_page):
    """End-to-end: build data→dimred→multiLevel on toy data, export the recipe,
    clear + re-load data, applyRecipe → the dimred and multiLevel cards re-run
    (done) and a multiLevelPicker auto-spawns pending (the user picks layers)."""
    out = clean_page.evaluate(r'''async () => {
        const ld = await import("/app/src/ui/modals/layer-descriptors.js");
        const wf = await import("/app/src/ui/workflow.js");
        const st = await import("/app/src/ui/state.js");
        const rc = await import("/app/src/persistence/recipe.js");

        // --- author the method on toy data ---
        wf.clearWorkflow();
        const dd = ld.getLayerDescriptor("data");
        const da = dd.getActive();
        await dd.applyChange(da.method, da.params);
        const dimDesc = ld.getLayerDescriptor("dimred");
        await dimDesc.applyChange(dimDesc.getActive());
        await ld.getLayerDescriptor("multiLevel").applyChange(
            { minSamples: 5, floor: 0.6, B: 3 });

        // export → JSON round-trip (proves it serialises cleanly)
        const recipe = JSON.parse(JSON.stringify(rc.buildRecipe()));

        // --- fresh dataset, then apply ---
        wf.clearWorkflow();
        await dd.applyChange(da.method, da.params);
        await rc.applyRecipe(recipe);
        await new Promise(r => setTimeout(r, 50));   // let picker .then spawn

        const steps = wf.listSteps();
        const byType = t => steps.filter(x => x.type === t);
        const s = st.getState();
        const picker = byType("multiLevelPicker")[0];
        return {
            recipeTypes: recipe.steps.map(x => x.type),
            dimredStatus: (byType("dimred")[0] || {}).status,
            mlStatus:     (byType("multiLevel")[0] || {}).status,
            hasPicker:    !!picker,
            pickerStatus: picker ? picker.status : null,
            hasDimredResult: !!s.dimredResult,
        };
    }''')
    # recipe stops at picking — no picker/labelling captured.
    assert "multiLevelPicker" not in out["recipeTypes"]
    assert out["dimredStatus"] == "done"
    assert out["mlStatus"] == "done"
    assert out["hasDimredResult"] is True
    # the picker auto-spawned and waits for the user (stop-at-picking boundary).
    assert out["hasPicker"] is True
    assert out["pickerStatus"] == "pending"
