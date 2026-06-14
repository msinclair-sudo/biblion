"""Keep-alive panels (viewer-3d): switching tabs must NOT destroy + rebuild
the WebGL viewer (which rendered a blank canvas on the first switch back and
leaked GL contexts). The panel system detaches/re-attaches its DOM instead,
and only truly destroys it when the tab is closed.

Uses `page` — a booted app (panel system mounted) with real data + a
3-d viz reduction so the 3D viewer has a canvas.
"""


def test_viewer_kept_alive_across_tab_switch(page):
    """Switching away from and back to the 3D viewer returns the SAME canvas
    element (kept alive), not a freshly-built one."""
    out = page.evaluate(
        '''async () => {
            const st = await import("/app/src/ui/state.js");
            // mark the live viewer canvas
            const c0 = [...document.querySelectorAll("canvas")]
                .sort((a, b) => (b.width*b.height) - (a.width*a.height))[0];
            if (!c0) return { noCanvas: true };
            c0.dataset.kaMark = "ORIG";

            // add a second tab to primary + switch to it (away from viewer)
            st.addTab("primary", "node-table", {});
            await new Promise(r => setTimeout(r, 120));
            const awayCanvases = document.querySelectorAll("canvas").length;

            // switch back to the viewer
            st.setActiveTab("primary", "p-viewer-3d");
            await new Promise(r => setTimeout(r, 200));
            const back = document.querySelector("canvas[data-ka-mark]");
            return {
                awayCanvases,
                sameCanvasBack: !!(back && back.isConnected && back.dataset.kaMark === "ORIG"),
                viewerUiBack: !!document.querySelector(".viewer-3d-colour-mode, .viewer-3d-empty"),
            };
        }'''
    )
    assert out.get("noCanvas") is not True
    assert out["awayCanvases"] == 0          # detached while away
    assert out["sameCanvasBack"] is True     # the SAME instance came back
    assert out["viewerUiBack"] is True


def test_viewer_destroyed_on_tab_close(page):
    """Closing the viewer tab (not just switching) DOES tear it down."""
    out = page.evaluate(
        '''async () => {
            const st = await import("/app/src/ui/state.js");
            const c0 = [...document.querySelectorAll("canvas")]
                .sort((a, b) => (b.width*b.height) - (a.width*a.height))[0];
            if (c0) c0.dataset.kaMark = "ORIG";
            // need another tab so the slot isn't empty after closing the viewer
            st.addTab("primary", "node-table", {});
            await new Promise(r => setTimeout(r, 100));
            st.closeTab("primary", "p-viewer-3d");
            await new Promise(r => setTimeout(r, 200));
            const marked = document.querySelector("canvas[data-ka-mark]");
            return { canvasGone: !(marked && marked.isConnected) };
        }'''
    )
    assert out["canvasGone"] is True
