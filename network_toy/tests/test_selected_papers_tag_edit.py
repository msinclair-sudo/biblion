"""Per-paper tag editing from the Selected-papers panel.

A pinned row exposes a compact "tags" button in its tags cell; clicking it
opens the edit-tags modal (chips + add row) wired to the optimistic
addTag/removeTag mutators. These drive the real panel + modal against the
rehydrated baseline page and assert the optimistic state + the cell text.

Backend persistence of tag writes is covered by test_serve_tags.py; here we
only exercise the UI path, so the synchronous optimistic update is what we
assert (any async write-through to serve.py is irrelevant to these checks).
"""


def _fire_js():
    return (
        'const fire = (el, mods={}) => el.dispatchEvent('
        'new MouseEvent("click", {bubbles:true, cancelable:true, ...mods}));'
    )


def test_pinned_row_tag_edit_button_only_when_pinned(page):
    """The tags-edit button appears only on pinned rows: none before pinning,
    exactly one after a single pin."""
    out = page.evaluate(
        '''async () => {
            ''' + _fire_js() + '''
            const host = document.createElement("div");
            host.className = "panel-content";
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/selected-papers.js");
            const state = await import("/app/src/ui/state.js");
            state.update({ pinnedNodes: new Set() });
            state.setSelection({ type: "nodes", key: "test", ids: [0, 1, 2, 3] });
            const inst = mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 120));

            const rows = host.querySelectorAll(".cart-row");
            if (rows.length < 3) return { err: `too few rows: ${rows.length}` };
            const repaint = () => inst.update(state.getState());

            const before = host.querySelectorAll(".cart-tag-edit").length;
            fire(rows[0]);                                  // pin exactly one row
            repaint();
            const after = host.querySelectorAll(".cart-tag-edit").length;
            const onPinned = host.querySelectorAll(".cart-row.pinned .cart-tag-edit").length;

            inst.destroy();
            host.remove();
            state.update({ pinnedNodes: new Set() });
            state.setSelection({ type: null, id: null });
            return { before, after, onPinned };
        }'''
    )
    assert "err" not in out, out.get("err")
    assert out["before"] == 0          # no editable rows until something is pinned
    assert out["after"] == 1           # the single pinned row gains the button
    assert out["onPinned"] == 1        # and it lives in that pinned row's cell


def test_edit_modal_adds_and_removes_a_tag(page):
    """Open the modal from a pinned row, add a tag (optimistic state + cell text
    update), then remove it via its chip ×."""
    out = page.evaluate(
        '''async () => {
            ''' + _fire_js() + '''
            const origAlert = window.alert;
            window.alert = () => {};                        // never block on write-through errors
            const host = document.createElement("div");
            host.className = "panel-content";
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/selected-papers.js");
            const { closeAllModals } = await import("/app/src/ui/modals/modal.js");
            const state = await import("/app/src/ui/state.js");
            const TAG = "uitest-tag";
            state.update({ pinnedNodes: new Set() });
            state.setSelection({ type: "nodes", key: "test", ids: [0, 1, 2, 3] });
            const inst = mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 120));

            const rows = host.querySelectorAll(".cart-row");
            if (rows.length < 3) return { err: `too few rows: ${rows.length}` };
            const repaint = () => inst.update(state.getState());
            const taggedWith = (t) => Object.entries(state.getState().tags || {})
                .filter(([, arr]) => arr.includes(t)).map(([pid]) => Number(pid));

            fire(rows[0]);                                  // pin the first row
            repaint();

            // Open the edit modal from the pinned row's button.
            fire(host.querySelector(".cart-row.pinned .cart-tag-edit"));
            const addBox = document.querySelector("#modal-root .tags-modal-add");
            if (!addBox) return { err: "modal add row missing" };
            const input = addBox.querySelector("input");
            const addBtn = addBox.querySelector("button");

            input.value = TAG;
            fire(addBtn);                                   // commit → optimistic addTag
            const taggedAfterAdd = taggedWith(TAG);
            // The panel re-joined (onChange=fullRender), so the cell shows it now.
            const cellShowsTag = (host.querySelector(".cart-row.pinned")
                .textContent || "").includes(TAG);

            // Remove it via the chip × in the (still-open) modal.
            const rm = [...document.querySelectorAll("#modal-root .tags-modal-chip-rm")]
                .find(b => b.getAttribute("aria-label") === "Remove " + TAG);
            const hadChip = !!rm;
            if (rm) fire(rm);
            const taggedAfterRemove = taggedWith(TAG);

            closeAllModals();
            inst.destroy();
            host.remove();
            window.alert = origAlert;
            state.update({ pinnedNodes: new Set() });
            state.setSelection({ type: null, id: null });
            return {
                taggedAfterAdd, cellShowsTag, hadChip, taggedAfterRemove,
            };
        }'''
    )
    assert "err" not in out, out.get("err")
    assert len(out["taggedAfterAdd"]) == 1     # exactly one paper gained the tag
    assert out["cellShowsTag"] is True         # and the tags cell reflects it
    assert out["hadChip"] is True              # the new tag rendered as a removable chip
    assert out["taggedAfterRemove"] == []      # removing the chip cleared it
