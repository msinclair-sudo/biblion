"""Tests for the tree-aware workflow-chart renderer (Phase 2 slice 2.3).

Real-data (BFS-5000) page by default — the chart auto-migrates the
legacy state on render, so we verify the spine appears in the SVG
once the page has booted.
"""


def test_chart_renders_spine_from_workflow(page):
    """After boot + auto-migration, the workflow chart's SVG contains
    one rect per spine step (data → dimred → clustering → citations
    for BFS-5000). Each rect carries the canonical wf-node-rect class
    plus a status dot reflecting step.status."""
    out = page.evaluate(
        '''async () => {
            // Force a re-render by importing the mount (already mounted
            // at boot — second mount is harmless because mountWorkflowChart
            // re-uses #workflow-chart). Migration runs as part of render.
            const wf  = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            // Ensure tree is populated — the boot path should already
            // have done this once the chart subscribed, but call again
            // to be sure for the test.
            mig.migrateLegacyToWorkflowIfNeeded();
            await new Promise(r => setTimeout(r, 100));
            const root = document.getElementById("workflow-chart");
            const rects = root.querySelectorAll("svg .wf-node-rect");
            const dots  = root.querySelectorAll("svg .wf-state-dot");
            const labels = Array.from(root.querySelectorAll("svg .wf-node-label"))
                                 .map(el => el.textContent);
            const types  = wf.listSteps().map(s => s.type);
            return {
                rectCount:  rects.length,
                dotCount:   dots.length,
                labels,
                types,
                hasArrow:   !!root.querySelector("svg .wf-arrow"),
                hasEmpty:   !!root.querySelector(".wf-empty-hint"),
            };
        }'''
    )
    # BFS-5000 spine = data, dimred, clustering, citations = 4 cards.
    assert out["rectCount"] >= 4, f"expected ≥4 cards, got {out['rectCount']}"
    assert out["dotCount"] >= 4
    # Spine label sanity (truncated; just check the prefixes).
    assert any("Real" in l for l in out["labels"])
    assert any("Dim" in l or "dim" in l for l in out["labels"])
    assert any("Cluster" in l or "cluster" in l for l in out["labels"])
    assert out["hasArrow"] is True
    assert out["hasEmpty"] is False


def test_chart_card_click_selects_step(page):
    """Clicking a card calls selectStep so state.workflow.selected
    updates. We don't assert modal-open here (that's a side effect
    that may already be open from a previous test)."""
    out = page.evaluate(
        '''async () => {
            const wf  = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            const state = await import("/app/src/ui/state.js");
            mig.migrateLegacyToWorkflowIfNeeded();
            // Find the clustering card — its label starts with "Clustering".
            const root = document.getElementById("workflow-chart");
            const cards = Array.from(root.querySelectorAll("svg g"));
            let clusteringRect = null;
            for (const g of cards) {
                const lbl = g.querySelector(".wf-node-label");
                if (lbl && lbl.textContent.includes("Clustering")) {
                    clusteringRect = g.querySelector(".wf-node-rect");
                    break;
                }
            }
            if (!clusteringRect) throw new Error("clustering card not found in SVG");
            // Capture before/after selection.
            const before = state.getState().workflow.selected;
            clusteringRect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await new Promise(r => setTimeout(r, 50));
            const after = state.getState().workflow.selected;
            // Close whatever modal may have opened so the next test
            // boots cleanly.
            const backdrop = document.querySelector(".modal-backdrop");
            if (backdrop) backdrop.click();
            return {
                before, after,
                afterType: after ? wf.getStep(after).type : null,
            };
        }'''
    )
    # before may be null (no selection) or whatever migration set it to.
    # after must be the clustering step's id.
    assert out["afterType"] == "clustering"


def test_chart_selected_card_has_selected_class(page):
    """Status reflects the currently-selected step via the 'selected'
    CSS class on the rect."""
    out = page.evaluate(
        '''async () => {
            const wf  = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            mig.migrateLegacyToWorkflowIfNeeded();
            await new Promise(r => setTimeout(r, 50));
            // Pick a specific step + select it.
            const dimredStep = wf.listSteps({ type: "dimred" })[0];
            wf.selectStep(dimredStep.id);
            await new Promise(r => setTimeout(r, 50));
            // Find the rect with .selected class.
            const root = document.getElementById("workflow-chart");
            const selectedRects = root.querySelectorAll("svg .wf-node-rect.selected");
            return {
                selectedCount: selectedRects.length,
            };
        }'''
    )
    assert out["selectedCount"] == 1


def test_chart_empty_hint_when_no_tree(clean_page):
    """When state.workflow is empty AND state.genResult is also
    missing (degenerate state), the chart shows the empty hint
    rather than a blank rail."""
    out = clean_page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const state = await import("/app/src/ui/state.js");
            wf.clearWorkflow();
            // Force genResult null too so the migration can't bootstrap.
            state.update({ genResult: null });
            // Force a re-render by toggling state.
            state.update({ projectName: state.getState().projectName });
            await new Promise(r => setTimeout(r, 100));
            const root = document.getElementById("workflow-chart");
            return {
                hasHint:  !!root.querySelector(".wf-empty-hint"),
                hasSvg:   !!root.querySelector("svg"),
            };
        }'''
    )
    assert out["hasHint"] is True
    assert out["hasSvg"] is False
