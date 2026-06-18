"""Row-based selection / pinning across the table panels.

Two selection channels, both now driven by row clicks (no checkboxes):
  - Node table  → "selecting" (state.selection + Ctrl-click extras in
                  state.selectionExtra); dims the rest in the viewers.
  - Selected papers → "pinning" (state.pinnedNodes); paints white.
  - Cart → partial-commit export selection (panel-local `checked` set).

Each supports plain click (replace), Ctrl/Cmd click (extend), Shift click
(range). These mount the real panels against the rehydrated baseline page and
drive synthetic clicks, asserting both the state and the row highlight.
"""


def _ctrl_click_js():
    # Helper snippet: dispatch a click with a modifier (el.click() can't).
    return (
        'const fire = (el, mods={}) => el.dispatchEvent('
        'new MouseEvent("click", {bubbles:true, cancelable:true, ...mods}));'
    )


def test_node_table_ctrl_click_extends_dimming_selection(page):
    """Plain click selects one row; Ctrl-click adds a second (both rows lit,
    both ids resolved); a plain click then replaces back to one."""
    out = page.evaluate(
        '''async () => {
            ''' + _ctrl_click_js() + '''
            const host = document.createElement("div");
            host.className = "panel-content";
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/node-table.js");
            const state = await import("/app/src/ui/state.js");
            state.setSelection({ type: null, id: null });
            // in-degree source lists individual node rows (type:"node"). The
            // option value is "inDeg:log" (bare "inDeg" isn't a menu option, so
            // it would fall back to the cluster source).
            const inst = mount(host, state.getState(), { source: "inDeg:log" });
            await new Promise(r => setTimeout(r, 120));

            const rows = host.querySelectorAll(".node-table-row");
            if (rows.length < 3) return { err: `too few rows: ${rows.length}` };

            const selCount = () => host.querySelectorAll(".node-table-row.selected").length;
            // A directly-mounted panel isn't wired to the state broadcast (the
            // panel system does that in the app), so drive its repaint by hand.
            const repaint = () => inst.update(state.getState());

            fire(rows[0]);                          // plain → select only row 0
            repaint();
            const afterPlain = {
                sel: state.getState().selection.type,
                extra: (state.getState().selectionExtra || []).length,
                lit: selCount(),
            };

            fire(rows[1], { ctrlKey: true });       // Ctrl → extend to row 1
            repaint();
            const afterCtrl = {
                extra: (state.getState().selectionExtra || []).length,
                lit: selCount(),
            };

            fire(rows[2]);                          // plain → replace back to one
            repaint();
            const afterReplace = {
                extra: (state.getState().selectionExtra || []).length,
                lit: selCount(),
            };

            inst.destroy();
            host.remove();
            state.setSelection({ type: null, id: null });
            return { afterPlain, afterCtrl, afterReplace };
        }'''
    )
    assert "err" not in out, out.get("err")
    assert out["afterPlain"] == {"sel": "node", "extra": 0, "lit": 1}
    assert out["afterCtrl"]["extra"] == 1 and out["afterCtrl"]["lit"] == 2
    assert out["afterReplace"]["extra"] == 0 and out["afterReplace"]["lit"] == 1


def test_selected_papers_row_click_pins(page):
    """Plain click pins ONLY that paper; Ctrl-click accumulates; the row gets
    the .pinned highlight. Pinning never touches state.selection."""
    out = page.evaluate(
        '''async () => {
            ''' + _ctrl_click_js() + '''
            const host = document.createElement("div");
            host.className = "panel-content";
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/selected-papers.js");
            const state = await import("/app/src/ui/state.js");
            // Populate the panel with a handful of real papers via a node set.
            state.update({ pinnedNodes: new Set() });
            state.setSelection({ type: "nodes", key: "test", ids: [0, 1, 2, 3] });
            const inst = mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 120));

            const rows = host.querySelectorAll(".cart-row");
            if (rows.length < 3) return { err: `too few rows: ${rows.length}` };
            const pins = () => [...state.getState().pinnedNodes];
            // Directly-mounted panel → drive its repaint by hand (see node-table test).
            const repaint = () => inst.update(state.getState());

            fire(rows[0]);                          // plain → exactly one pin
            repaint();
            const afterPlain = pins().length;

            fire(rows[1], { metaKey: true });       // Ctrl/Cmd → add a second
            repaint();
            const afterCtrl = pins().length;
            const litCount = host.querySelectorAll(".cart-row.pinned").length;

            fire(rows[2]);                          // plain → back to one
            repaint();
            const afterReplace = pins().length;
            const selUntouched = state.getState().selection.type;   // still "nodes"

            inst.destroy();
            host.remove();
            state.update({ pinnedNodes: new Set() });
            state.setSelection({ type: null, id: null });
            return { afterPlain, afterCtrl, litCount, afterReplace, selUntouched };
        }'''
    )
    assert "err" not in out, out.get("err")
    assert out["afterPlain"] == 1
    assert out["afterCtrl"] == 2
    assert out["litCount"] == 2
    assert out["afterReplace"] == 1
    assert out["selUntouched"] == "nodes"          # pinning didn't disturb the selection


def test_cart_row_click_selects_for_export(page):
    """Plain click selects one cart row for export; Ctrl-click adds another;
    the selected rows carry the .row-selected highlight."""
    out = page.evaluate(
        '''async () => {
            ''' + _ctrl_click_js() + '''
            const host = document.createElement("div");
            host.className = "panel-content";
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/cart.js");
            const state = await import("/app/src/ui/state.js");
            const pt = await import("/app/src/ui/panels/paper-table.js");
            const s = state.getState();
            const levels = s.clusterLevels || [];
            // Stage a few real papers in the cart.
            const items = [];
            for (let i = 0; i < 4; i++) {
                const row = pt.joinPaperRow(i, s, levels);
                if (row.paperId != null) items.push({ nodeId: i, paperId: row.paperId, source: "test" });
            }
            state.clearCart();
            state.addToCart(items);
            const inst = mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 120));

            const rows = host.querySelectorAll(".cart-row");
            if (rows.length < 3) return { err: `too few cart rows: ${rows.length}` };
            const lit = () => host.querySelectorAll(".cart-row.row-selected").length;

            fire(rows[0]);                          // plain → one selected
            await new Promise(r => setTimeout(r, 40));
            const afterPlain = lit();

            fire(rows[1], { ctrlKey: true });       // Ctrl → add a second
            await new Promise(r => setTimeout(r, 40));
            const afterCtrl = lit();

            fire(rows[2]);                          // plain → back to one
            await new Promise(r => setTimeout(r, 40));
            const afterReplace = lit();

            inst.destroy();
            host.remove();
            state.clearCart();
            return { afterPlain, afterCtrl, afterReplace };
        }'''
    )
    assert "err" not in out, out.get("err")
    assert out["afterPlain"] == 1
    assert out["afterCtrl"] == 2
    assert out["afterReplace"] == 1


def test_viewer_node_click_toggles_pin(page):
    """Clicking a node in the 3D viewer toggles its white pin. We capture the
    onNodeClick callback the viewer registers on its ForceGraph3D instance and
    drive it directly (the canvas has no DOM nodes to click). Any click toggles;
    pins accumulate one node at a time."""
    out = page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            if (!((state.getState().genResult || {}).nodes || []).length) {
                return { skip: "no genResult" };
            }
            // Wrap the ForceGraph3D factory so the instance our viewer builds
            // records the onNodeClick callback it registers.
            if (!window.__nodeClickWrapped) {
                const orig = window.ForceGraph3D;
                if (!orig) return { skip: "ForceGraph3D unavailable" };
                window.ForceGraph3D = function (...a) {
                    const cfg = orig.apply(this, a);
                    return function (div) {
                        const inst = cfg(div);
                        const real = inst.onNodeClick.bind(inst);
                        inst.onNodeClick = (cb) => { window.__nodeClickCb = cb; return real(cb); };
                        return inst;
                    };
                };
                window.__nodeClickWrapped = true;
            }
            window.__nodeClickCb = null;

            const v3d = await import("/app/src/ui/panels/viewer-3d.js");
            state.update({ pinnedNodes: new Set() });
            const host = document.createElement("div");
            host.style.width = "400px"; host.style.height = "400px";
            document.body.appendChild(host);
            const inst = v3d.mount(host, state.getState(), {}, null);
            await new Promise(r => setTimeout(r, 300));

            const cb = window.__nodeClickCb;
            if (typeof cb !== "function") {
                try { inst.destroy(); } catch (_) {}
                host.remove();
                return { skip: "onNodeClick not captured" };
            }
            const has = (id) => state.getState().pinnedNodes.has(id);

            cb({ id: 3 });  const afterFirst  = has(3);   // → pinned
            cb({ id: 3 });  const afterSecond = has(3);   // → unpinned (toggle)
            cb({ id: 7 });                                 // → second, independent
            const seven = has(7), threeStill = has(3);
            cb(null);       // malformed → ignored, no throw
            const sizeAfterNull = state.getState().pinnedNodes.size;

            try { inst.destroy(); } catch (_) {}
            host.remove();
            state.update({ pinnedNodes: new Set() });
            return { afterFirst, afterSecond, seven, threeStill, sizeAfterNull };
        }'''
    )
    if out.get("skip"):
        import pytest
        pytest.skip(out["skip"])
    assert out["afterFirst"] is True       # first click pins node 3
    assert out["afterSecond"] is False     # clicking it again unpins
    assert out["seven"] is True            # clicking node 7 pins it
    assert out["threeStill"] is False      # node 3 stays unpinned (independent)
    assert out["sizeAfterNull"] == 1       # malformed click ignored
