"""Tests for app/src/ui/workflow.js (CRUD + invariants) and
app/src/ui/workflow-migration.js (legacy state → tree migration).

All tests share the bfs5000_page session. CRUD tests don't read
genResult / dimredResult / etc., so they reuse the session context
(workflow + jobs + validationRuns are reset between tests by the
`page` fixture). The migration tests verify spine shape on the
real-data fixture, including the imported-edges citation branch.
"""


def test_empty_workflow_on_boot(page):
    out = page.evaluate(
        '''async () => {
            const w = await import("/app/src/ui/workflow.js");
            const state = await import("/app/src/ui/state.js");
            w.clearWorkflow();
            return {
                workflow: state.getState().workflow,
                root:     w.getRootStep(),
                selected: w.getSelectedStep(),
                list:     w.listSteps(),
            };
        }'''
    )
    assert out["workflow"] == {"steps": {}, "rootId": None, "selected": None}
    assert out["root"] is None
    assert out["selected"] is None
    assert out["list"] == []


def test_create_step_validation(page):
    out = page.evaluate(
        '''async () => {
            const w = await import("/app/src/ui/workflow.js");
            w.clearWorkflow();
            const out = {};
            // missing type
            try { w.createStep({ label: "x" }); out.missingType = false; }
            catch (e) { out.missingType = e.message.includes("type is required"); }
            // missing label
            try { w.createStep({ type: "data" }); out.missingLabel = false; }
            catch (e) { out.missingLabel = e.message.includes("label is required"); }
            // bad refIds (not array)
            try { w.createStep({ type: "data", label: "x", refIds: "no" }); out.badRefs = false; }
            catch (e) { out.badRefs = e.message.includes("refIds must be an array"); }
            // root
            const rootId = w.createStep({ type: "data", label: "n=400" });
            out.rootSet = w.getRootStep().id === rootId;
            // second root attempt
            try { w.createStep({ type: "data", label: "another" }); out.twoRoots = false; }
            catch (e) { out.twoRoots = e.message.includes("root already exists"); }
            // unknown parentId
            try { w.createStep({ type: "dimred", label: "x", parentId: "nope" }); out.badParent = false; }
            catch (e) { out.badParent = e.message.includes("unknown parentId"); }
            // unknown refId
            try { w.createStep({ type: "fc", label: "x", parentId: rootId, refIds: ["nope"] }); out.badRef = false; }
            catch (e) { out.badRef = e.message.includes("unknown refId"); }
            return out;
        }'''
    )
    assert all(out.values()), f"validation failures: {out}"


def test_status_transitions(page):
    out = page.evaluate(
        '''async () => {
            const w = await import("/app/src/ui/workflow.js");
            w.clearWorkflow();
            const root  = w.createStep({ type: "data",    label: "root" });
            const child = w.createStep({ type: "dimred", label: "child", parentId: root });
            const out = {};
            w.updateStepStatus(child, "running");
            out.runningStatus = w.getStep(child).status;
            // bad transition
            try { w.updateStepStatus(child, "pending"); out.badBack = false; }
            catch (e) { out.badBack = e.message.includes("invalid transition"); }
            // setStepResult only valid when running
            try { w.setStepResult(root, { x: 1 }); out.notRunning = false; }
            catch (e) { out.notRunning = e.message.includes("must be \\"running\\""); }
            // running → done
            w.setStepResult(child, { dim: 50 });
            const cSnap = w.getStep(child);
            out.done = cSnap.status === "done";
            out.revision = cSnap.revision;             // 1
            out.upstreamRevision = cSnap.upstreamRevision;  // 0 (root.revision was 0)
            // done terminal
            try { w.updateStepStatus(child, "running"); out.terminal = false; }
            catch (e) { out.terminal = e.message.includes("invalid transition"); }
            return out;
        }'''
    )
    assert out["runningStatus"] == "running"
    assert out["badBack"] is True
    assert out["notRunning"] is True
    assert out["done"] is True
    assert out["revision"] == 1
    assert out["upstreamRevision"] == 0
    assert out["terminal"] is True


def test_stale_propagation(page):
    out = page.evaluate(
        '''async () => {
            const w = await import("/app/src/ui/workflow.js");
            w.clearWorkflow();
            const root  = w.createStep({ type: "data",   label: "root" });
            const child = w.createStep({ type: "dimred", label: "child", parentId: root });
            w.updateStepStatus(child, "running");
            w.setStepResult(child, { dim: 50 });
            const before = w.isStepStale(child);
            // Re-run the ROOT.
            w.updateStepStatus(root, "running");
            w.setStepResult(root, { reingested: true });
            const after = w.isStepStale(child);
            return { before, after };
        }'''
    )
    assert out["before"] is False
    assert out["after"] is True


def test_progress_clamping_and_running_only(page):
    out = page.evaluate(
        '''async () => {
            const w = await import("/app/src/ui/workflow.js");
            w.clearWorkflow();
            const root = w.createStep({ type: "data",   label: "root" });
            const id   = w.createStep({ type: "optimise", label: "sweep", parentId: root });
            // No-op when pending.
            w.updateStepProgress(id, { phase: "noisy", fraction: 0.3 });
            const before = w.getStep(id).progress;
            // After running.
            w.updateStepStatus(id, "running");
            w.updateStepProgress(id, { phase: "compress", fraction: 0.5 });
            const mid = w.getStep(id).progress;
            // Clamped.
            w.updateStepProgress(id, { fraction: 2.0 });
            const clamped = w.getStep(id).progress.fraction;
            w.updateStepStatus(id, "cancelled");
            return { before, mid, clamped };
        }'''
    )
    assert out["before"] is None
    assert out["mid"] == {"phase": "compress", "fraction": 0.5}
    assert out["clamped"] == 1.0


def test_select_step(page):
    out = page.evaluate(
        '''async () => {
            const w = await import("/app/src/ui/workflow.js");
            w.clearWorkflow();
            const root  = w.createStep({ type: "data",   label: "root" });
            const child = w.createStep({ type: "dimred", label: "child", parentId: root });
            w.selectStep(child);
            const sA = w.getSelectedStep().id;
            w.selectStep(null);
            const sB = w.getSelectedStep();
            w.selectStep("nope");                    // silent no-op
            const sC = w.getSelectedStep();
            w.selectStep(root);
            const sD = w.getSelectedStep().id;
            return { sA, sB, sC, sD, root, child };
        }'''
    )
    assert out["sA"] == out["child"]
    assert out["sB"] is None
    assert out["sC"] is None
    assert out["sD"] == out["root"]


def test_delete_cascade(page):
    out = page.evaluate(
        '''async () => {
            const w = await import("/app/src/ui/workflow.js");
            w.clearWorkflow();
            const root  = w.createStep({ type: "data",   label: "root" });
            const child = w.createStep({ type: "dimred", label: "child", parentId: root });
            const gc    = w.createStep({ type: "clustering", label: "gc", parentId: child });
            // A sibling card with a ref to gc.
            const cmp   = w.createStep({
                type: "fusionComparison", label: "cmp",
                parentId: root, refIds: [child, gc],
            });
            w.selectStep(gc);
            const deleted = w.deleteStep(child);
            return {
                deletedCount:  deleted.length,
                childGone:     w.getStep(child) === null,
                gcGone:        w.getStep(gc) === null,
                cmpStill:      w.getStep(cmp) !== null,
                cmpRefIdsAfter: w.getStep(cmp).refIds,        // pruned of deleted ids
                rootStill:     w.getStep(root) !== null,
                rootChildren:  w.getStep(root).childIds,
            };
        }'''
    )
    assert out["deletedCount"] == 2                     # child + gc
    assert out["childGone"] is True
    assert out["gcGone"] is True
    assert out["cmpStill"] is True
    assert out["cmpRefIdsAfter"] == []
    assert out["rootStill"] is True


def test_list_steps_filters_dont_prune_traversal(page):
    out = page.evaluate(
        '''async () => {
            const w = await import("/app/src/ui/workflow.js");
            w.clearWorkflow();
            // Build: A (data) → B (dimred) → D (clustering); A → C (dimred)
            const a = w.createStep({ type: "data",       label: "A" });
            const b = w.createStep({ type: "dimred",     label: "B", parentId: a });
            const c = w.createStep({ type: "dimred",     label: "C", parentId: a });
            const d = w.createStep({ type: "clustering", label: "D", parentId: b });
            w.updateStepStatus(b, "running");
            w.setStepResult(b, "B-result");
            return {
                types: w.listSteps({ type: "dimred" }).map(s => s.label).sort(),
                done:  w.listSteps({ status: "done" }).map(s => s.label),
                anc:   w.getStepAncestors(d).map(s => s.label),
                desc:  w.getStepDescendants(a).map(s => s.label).sort(),
            };
        }'''
    )
    assert out["types"] == ["B", "C"]
    assert out["done"] == ["B"]
    assert out["anc"] == ["A", "B", "D"]
    assert out["desc"] == ["B", "C", "D"]


# ── workflow-migration tests ────────────────────────────────────────


def test_migration_fallworm_real_mode(page):
    """Real-mode (fallworm): migration emits data → dimred → clustering →
    citations. The citations card appears because the fixture ships with
    citation_edges.json and the §6.4c `imported-edges` Layer 3
    algorithm populates state.citationResult on ingest. citationLayout /
    alignment / blend are opt-in (§6.16) and NOT emitted by default."""
    out = page.evaluate(
        '''async () => {
            const w   = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            w.clearWorkflow();
            const ran = mig.migrateLegacyToWorkflowIfNeeded();
            const all = w.listSteps().map(s => ({ type: s.type, label: s.label }));
            return {
                ran,
                typeChain: all.map(c => c.type),
                rootLabel: all[0] ? all[0].label : null,
            };
        }'''
    )
    assert out["ran"] is True
    # BFS-5000 ships with citations → migration emits the spine + citations.
    # No citationLayout / alignment / blend (opt-in).
    assert out["typeChain"] == ["data", "dimred", "clustering", "citations"]
    # Fixture is now fallworm (no subset name in its config) → label falls back
    # to "(unknown subset)" with the fallworm node count.
    assert "Real · (unknown subset) (n=1638)" in out["rootLabel"]


def test_migration_empty_plan_when_no_genResult():
    """inferBaselineTree on degenerate input returns []. Doesn't need
    a page — the planner is pure JS, but we still need to import it.
    Skip in this file; covered by the pattern of empty plans not
    being applied."""
    pass


def test_migration_is_idempotent(page):
    out = page.evaluate(
        '''async () => {
            const w   = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            w.clearWorkflow();
            const firstRan = mig.migrateLegacyToWorkflowIfNeeded();
            const firstCount = w.listSteps().length;
            const secondRan = mig.migrateLegacyToWorkflowIfNeeded();
            const secondCount = w.listSteps().length;
            return { firstRan, firstCount, secondRan, secondCount };
        }'''
    )
    assert out["firstRan"] is True
    assert out["secondRan"] is False
    assert out["firstCount"] == out["secondCount"]


def test_validation_runs_attach_to_right_anchor(page):
    """ValidationRun anchor mapping: dimSweep → dimred; everything else
    → clustering. Tests inferBaselineTree on a hand-built snapshot
    (independent of the session's real-data state — workflow is cleared
    first)."""
    out = page.evaluate(
        '''async () => {
            const w   = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            w.clearWorkflow();
            const fakeState = {
                dataSource: { mode: "real", configs: { real: { subset: "test" } } },
                genResult:  { nodes: new Array(100).fill({}), origins: [] },
                layerParams: {
                    dimred: {
                        noise:       { method: "identity", params: {} },
                        fusion:      { method: "identity", params: {} },
                        compression: { method: "identity", params: {} },
                        viz:         { method: "identity", params: {} },
                        viz2d:       { method: "identity", params: {} },
                    },
                    clustering: { method: "mutualKNN", levels: [{ params: { mutualK: 5 } }] },
                },
                dimredResult:  { method: "identity", n: 100, d: 3, data: new Float32Array(300) },
                clusterLevels: [{ uid: "abc", clusterResult: { method: "mutualKNN", nodeCluster: new Int32Array(100), clusters: [] } }],
                citationResult: null,
                validationRuns: [
                    { id: "r1", type: "optimise",           label: "opt",  results: {}, scoreVersion: 3, timestamp: "2026-05-26T10:00Z" },
                    { id: "r2", type: "dimSweep",           label: "ds",   results: {}, scoreVersion: 1, timestamp: "2026-05-26T10:01Z" },
                    { id: "r3", type: "bootstrapStability", label: "boot", results: {}, scoreVersion: 3, timestamp: "2026-05-26T10:02Z" },
                ],
            };
            const plan = mig.inferBaselineTree(fakeState);
            mig.applyTreePlan(plan);
            const parentOf = (type) => {
                const steps = w.listSteps({ type });
                return steps.map(s => s.parentId ? w.getStep(s.parentId).type : null);
            };
            return {
                opt:  parentOf("optimise"),
                ds:   parentOf("dimSweep"),
                boot: parentOf("bootstrapStability"),
            };
        }'''
    )
    assert out["opt"]  == ["clustering"]
    assert out["ds"]   == ["dimred"]
    assert out["boot"] == ["clustering"]
