"""Regression: clicking a row in a scrollable panel must NOT reset its
scroll position to the top (the preserveScroll fix in widgets.js).

The bug: every state mutation is broadcast to every panel, and a panel's
update() rebuilds its tbody via `tbody.innerHTML = ""`, collapsing the
persistent scroll wrapper's content height to 0 so the browser clamps
scrollTop back to 0. preserveScroll(scrollEl, rebuild) captures and
restores scrollTop around the rebuild.
"""

import pytest


def test_node_table_preserves_scroll_on_row_click(page):
    """Mount the node table tall enough to scroll, scroll down, click a
    row (which fires setSelection → broadcast → fullRender), and assert
    the scroll position is preserved."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            host.className = "panel-content";   // overflow:auto ancestor
            host.style.height = "240px";
            host.style.position = "absolute";
            host.style.top = "0";
            host.style.left = "0";
            host.style.width = "320px";
            document.body.appendChild(host);

            const { mount } = await import("/app/src/ui/panels/node-table.js");
            const state = await import("/app/src/ui/state.js");
            // Pick a source with many rows so the list overflows.
            const inst = mount(host, state.getState(), { source: "inDeg" });
            await new Promise(r => setTimeout(r, 120));

            const scroller = host.querySelector(".node-table-scroll");
            const rows = host.querySelectorAll(".node-table-row");
            if (!scroller || rows.length < 8) {
                return { err: `not enough rows: ${rows.length}` };
            }

            // Scroll well down the list.
            scroller.scrollTop = scroller.scrollHeight;
            const maxTop = scroller.scrollTop;
            if (maxTop <= 0) return { err: "list did not overflow / scroll" };

            // Click a row near the bottom — triggers selection → broadcast.
            const target = rows[rows.length - 2];
            target.click();
            await new Promise(r => setTimeout(r, 80));

            const after = host.querySelector(".node-table-scroll").scrollTop;

            inst.destroy();
            host.remove();
            return { maxTop, after };
        }'''
    )
    assert "err" not in out, out.get("err")
    # Scroll must be preserved (allow a few px of clamp slack from row-height
    # rounding after the rebuild).
    assert abs(out["after"] - out["maxTop"]) <= 4, out


def test_preserve_scroll_helper_clamps(page):
    """Unit check of the helper itself: restores scrollTop, and clamps when
    the rebuilt content is shorter than the saved position."""
    out = page.evaluate(
        '''async () => {
            const { preserveScroll } = await import("/app/src/ui/widgets.js");
            const box = document.createElement("div");
            box.style.cssText = "height:100px;overflow:auto;position:absolute;top:0;left:0;width:100px";
            document.body.appendChild(box);
            const fill = (n) => { box.innerHTML = ""; for (let i=0;i<n;i++){ const d=document.createElement("div"); d.style.height="30px"; d.textContent=i; box.appendChild(d);} };

            fill(20);                 // 600px tall content
            box.scrollTop = 400;
            const before = box.scrollTop;

            // Rebuild with the same amount → scroll preserved.
            preserveScroll(box, () => fill(20));
            const same = box.scrollTop;

            // Rebuild with much less content → clamp to new max, not negative.
            preserveScroll(box, () => fill(3));   // 90px < 100px viewport → max 0
            const clamped = box.scrollTop;

            box.remove();
            return { before, same, clamped };
        }'''
    )
    assert out["before"] == 400
    assert out["same"] == 400, out
    assert out["clamped"] == 0, out
