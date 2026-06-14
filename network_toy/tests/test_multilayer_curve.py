"""Multi-layer LAYER-PICKER panel (panels/multilayer-curve.js).

The panel reads the producer card's sweep (state.multiLevelSweep, or the
picker descriptor's getActive()) and draws reproducibility vs. cluster count
via charts/line.js with the floor guide line. Clicking a point toggles it as
a picked layer; an Apply button commits the picks.

Uses `clean_page` — drives the panel with a synthetic sweep set straight into
state (no real clustering run needed). With no picker card selected the panel
falls back to the bare sweep slot, so nothing is pre-picked.
"""


def test_picker_panel_renders_points_and_toggles(clean_page):
    """One dot per candidate, floor line drawn, and clicking a dot toggles it
    into the picked set (selected class) + updates the summary."""
    out = clean_page.evaluate(
        '''async () => {
            const st  = await import("/app/src/ui/state.js");
            const reg = await import("/app/src/ui/panels/registry.js");
            st.update({ multiLevelSweep: { floor: 0.6, uidPrefix: "ML", curve: [
                { count: 2, size: 60, stability: 0.98, plateauWidth: 3 },
                { count: 3, size: 30, stability: 0.95, plateauWidth: 2 },
                { count: 4, size: 18, stability: 0.55, plateauWidth: 1 },
                { count: 6, size: 9,  stability: 0.91, plateauWidth: 2 },
                { count: 9, size: 4,  stability: null, plateauWidth: 1 },
            ]}});
            const host = document.createElement("div");
            host.style.width = "400px";
            document.body.appendChild(host);
            reg.getPanelType("multilayer-curve").mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 20));

            const dotsBefore = host.querySelectorAll(".chart-line-dot").length;
            const selBefore  = host.querySelectorAll(".chart-line-dot.selected").length;
            const nullDots   = host.querySelectorAll(".chart-line-dot.null").length;
            const hasHline   = !!host.querySelector(".chart-line-hline");

            // Click the first two dots to pick them.
            const dots = [...host.querySelectorAll(".chart-line-dot")];
            dots[0].dispatchEvent(new Event("click", { bubbles: true }));
            await new Promise(r => setTimeout(r, 10));
            dots[1].dispatchEvent(new Event("click", { bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const selAfter = host.querySelectorAll(".chart-line-dot.selected").length;
            const summary  = host.querySelector(".multilayer-curve-summary")?.textContent || "";
            const hasApply = !!host.querySelector(".multilayer-curve-apply");

            return { dotsBefore, selBefore, nullDots, hasHline, selAfter, summary, hasApply };
        }'''
    )
    assert out["dotsBefore"] == 5
    assert out["selBefore"] == 0           # nothing pre-picked (no picker card)
    assert out["nullDots"] == 1            # the unscored candidate
    assert out["hasHline"] is True         # floor guide line
    assert out["selAfter"] == 2            # two dots toggled on
    assert "2 picked" in out["summary"]
    assert out["hasApply"] is True


def test_picker_panel_shows_bridge_heatmap(clean_page):
    """When the sweep carries bridgesPerPair + candidates with clusterResults,
    the panel renders a heatmap beside the curve. Only the strict upper
    triangle (child > parent) is active; the rest is inactive. Cells show the
    raw bridge count as overlay text."""
    out = clean_page.evaluate(
        '''async () => {
            const st  = await import("/app/src/ui/state.js");
            const reg = await import("/app/src/ui/panels/registry.js");
            // 3 candidates in coarse → fine order; bridgesPerPair triangular.
            // child=1 vs parent=0: 0 bridges; child=2 vs parent=0: 0; child=2 vs parent=1: 1.
            const n = 3;
            const counts = new Int32Array(n * n);
            counts[2 * n + 1] = 1;
            const cand = (count) => ({
                count, size: count, stability: 0.9, plateauWidth: 1,
                clusterResult: { nodeCluster: new Int32Array([0,0,1,1,2,2]) },
            });
            st.update({ multiLevelSweep: {
                floor: 0.5, uidPrefix: "ML",
                curve: [
                    { count: 1, size: 6, stability: 0.99, plateauWidth: 1 },
                    { count: 2, size: 3, stability: 0.95, plateauWidth: 1 },
                    { count: 3, size: 2, stability: 0.92, plateauWidth: 1 },
                ],
                candidates: [cand(1), cand(2), cand(3)],
                bridgesPerPair: { n, counts },
            }});
            const host = document.createElement("div");
            host.style.width = "720px";
            document.body.appendChild(host);
            reg.getPanelType("multilayer-curve").mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 30));

            const cells       = host.querySelectorAll(".chart-heatmap-cell");
            const inactiveCt  = host.querySelectorAll(".chart-heatmap-cell.inactive").length;
            const overlays    = [...host.querySelectorAll(".chart-heatmap-overlay")]
                                  .map(n => n.textContent);
            // Click the live cell (child=2, parent=1) → highlights both layers.
            const heat = host.querySelectorAll(".chart-heatmap-cell:not(.inactive)");
            // child=2 row idx 2, parent=1 col idx 1 → the only live cell with v > 0
            heat[heat.length - 1].dispatchEvent(new Event("click", { bubbles: true }));
            await new Promise(r => setTimeout(r, 20));
            const highlightedDots = host.querySelectorAll(".chart-line-dot.highlighted").length;
            const hiRows = host.querySelectorAll(".chart-heatmap-highlight-row").length;
            const hiCols = host.querySelectorAll(".chart-heatmap-highlight-col").length;

            return {
                cellCount:  cells.length,
                inactiveCt,
                overlays:   overlays.filter(t => t && t.length),
                highlightedDots, hiRows, hiCols,
            };
        }'''
    )
    # 3x3 = 9 cells total; diagonal + lower triangle (6) are inactive; 3 live.
    assert out["cellCount"] == 9
    assert out["inactiveCt"] == 6
    # Only one live cell has a non-zero count → only one overlay text "1".
    assert out["overlays"] == ["1"]
    # Clicking that cell flags two curve dots and one row + one column on heatmap.
    assert out["highlightedDots"] == 2
    assert out["hiRows"] == 1
    assert out["hiCols"] == 1


def test_picker_panel_readout_shows_adjacent_bridges(clean_page):
    """Picking two layers populates the bottom readout with the adjacent-pair
    bridge count (filters from bridgesPerPair, no recompute)."""
    out = clean_page.evaluate(
        '''async () => {
            const st  = await import("/app/src/ui/state.js");
            const reg = await import("/app/src/ui/panels/registry.js");
            // Two candidates → one adjacent pair → one bridge entry.
            const n = 2;
            const counts = new Int32Array(n * n);
            counts[1 * n + 0] = 4;   // child=1 vs parent=0: 4 bridges
            const cand = (count) => ({
                count, size: count, stability: 0.9, plateauWidth: 1,
                clusterResult: { nodeCluster: new Int32Array([0,0,1,1]) },
            });
            st.update({ multiLevelSweep: {
                floor: 0.5, uidPrefix: "ML",
                curve: [
                    { count: 2, size: 2, stability: 0.95, plateauWidth: 1 },
                    { count: 4, size: 1, stability: 0.85, plateauWidth: 1 },
                ],
                candidates: [cand(2), cand(4)],
                bridgesPerPair: { n, counts },
            }});
            const host = document.createElement("div");
            host.style.width = "720px";
            document.body.appendChild(host);
            reg.getPanelType("multilayer-curve").mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 20));

            // Initially nothing picked → no readout.
            const readoutBefore = host.querySelector(".multilayer-curve-readout");

            // Click both dots in cluster-count order (2, then 4).
            const dots = [...host.querySelectorAll(".chart-line-dot")];
            // dots come back in x-sort order in the chart loop — but to be
            // safe, find the dots by their <title> text containing the count.
            const pickByCount = (cnt) => {
                for (const d of dots) {
                    const t = d.querySelector("title");
                    if (t && t.textContent.startsWith(cnt + " clusters")) return d;
                }
                return null;
            };
            pickByCount(2).dispatchEvent(new Event("click", { bubbles: true }));
            await new Promise(r => setTimeout(r, 10));
            // Re-query — render() rebuilt the DOM.
            const dots2 = [...host.querySelectorAll(".chart-line-dot")];
            const pick4 = (() => {
                for (const d of dots2) {
                    const t = d.querySelector("title");
                    if (t && t.textContent.startsWith("4 clusters")) return d;
                }
                return null;
            })();
            pick4.dispatchEvent(new Event("click", { bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const readout = host.querySelector(".multilayer-curve-readout");
            const lines = readout ? [...readout.querySelectorAll(".multilayer-curve-readout-line")]
                                         .map(n => n.textContent) : [];
            return {
                hadReadoutBefore: !!readoutBefore,
                lineCount: lines.length,
                layersLine:  lines[0] || "",
                bridgesLine: lines[1] || "",
            };
        }'''
    )
    assert out["hadReadoutBefore"] is False        # nothing picked → no readout
    assert out["lineCount"] == 2                   # layers + bridges lines
    assert "L0: 2" in out["layersLine"]
    assert "L1: 4" in out["layersLine"]
    assert "L1 vs L0: 4" in out["bridgesLine"]


def test_picker_panel_empty_without_sweep(clean_page):
    """No sweep in state → a hint, not a crash."""
    out = clean_page.evaluate(
        '''async () => {
            const st  = await import("/app/src/ui/state.js");
            const reg = await import("/app/src/ui/panels/registry.js");
            st.update({ multiLevelSweep: null });
            const host = document.createElement("div");
            document.body.appendChild(host);
            reg.getPanelType("multilayer-curve").mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 20));
            return {
                empty: host.querySelector(".multilayer-curve-empty")?.textContent || "",
                dots:  host.querySelectorAll(".chart-line-dot").length,
            };
        }'''
    )
    assert "No multi-layer sweep yet" in out["empty"]
    assert out["dots"] == 0
