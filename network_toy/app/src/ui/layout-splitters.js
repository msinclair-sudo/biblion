// Dynamic layout: draggable dividers + collapse/expand rails (J10).
//
// PERSISTENCE: OPTION A (localStorage UI-prefs blob). The sizes live in
// the state.js `uiPrefs` slice and are mirrored to localStorage via
// setUiPrefs; persistence/serialise.js is deliberately untouched, so
// layout is per-browser, not per-project.
//
// The #layout grid is driven by three CSS vars (--left-rail-w /
// --right-rail-w / --bottom-h). The handle elements live as absolutely-
// positioned overlays inside #layout (index.html); on pointer-drag we
// clamp to sane min/max and write the live size back to the matching var
// AND the uiPrefs slice. Collapse toggles force a rail width to 0 (a thin
// re-expand stub stays clickable) while remembering the prior width.

import { getUiPrefs, setUiPrefs, hydrateUiPrefs, subscribe } from "./state.js";

// Min / max clamps (px). Max for the side rails is computed per-drag from
// the live viewport so a rail can't eat the whole window; these are floors
// and a coarse ceiling fallback.
const MIN_RAIL   = 140;
const MIN_BOTTOM = 80;
const MIN_CENTRE = 240;   // primary+secondary region must keep this much width
const MIN_TOP    = 120;   // top row (above the bottom divider) floor

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Push the uiPrefs sizes/collapsed flags into the live #layout CSS vars.
// Collapsed rails resolve to 0 width regardless of the stored *W.
function applyVars(prefs) {
  const layout = document.getElementById("layout");
  if (!layout) return;
  const leftW  = prefs.leftCollapsed  ? 0 : prefs.leftRailW;
  const rightW = prefs.rightCollapsed ? 0 : prefs.rightRailW;
  layout.style.setProperty("--left-rail-w",  `${leftW}px`);
  layout.style.setProperty("--right-rail-w", `${rightW}px`);
  layout.style.setProperty("--bottom-h",     `${prefs.bottomH}px`);
  layout.classList.toggle("left-collapsed",  prefs.leftCollapsed);
  layout.classList.toggle("right-collapsed", prefs.rightCollapsed);
}

// Re-place the (absolutely-positioned) handles to sit on their grid
// boundaries. Driven off the live var values so the handles track drags
// and collapses without hard-coding pixel maths in two places.
function placeHandles(prefs) {
  const layout = document.getElementById("layout");
  if (!layout) return;
  const leftW  = prefs.leftCollapsed  ? 0 : prefs.leftRailW;
  const rightW = prefs.rightCollapsed ? 0 : prefs.rightRailW;

  const left   = document.getElementById("split-left");
  const right  = document.getElementById("split-right");
  const bottom = document.getElementById("split-bottom");
  if (left)   left.style.left   = `${leftW}px`;
  if (right)  right.style.right = `${rightW}px`;
  // The bottom divider spans the centre region (right of the left rail)
  // and sits on the top of the bottom row.
  if (bottom) {
    bottom.style.left   = `${leftW}px`;
    bottom.style.bottom = `${prefs.bottomH}px`;
  }
}

function refresh() {
  const prefs = getUiPrefs();
  applyVars(prefs);
  placeHandles(prefs);
}

// Generic pointer-drag wiring for one handle. `onMove(clientX, clientY,
// rect)` returns a partial uiPrefs patch (or null to ignore the move).
function wireDrag(handle, onMove) {
  if (!handle) return;
  let dragging = false;

  function move(e) {
    if (!dragging) return;
    const layout = document.getElementById("layout");
    const rect = layout ? layout.getBoundingClientRect() : null;
    const patch = onMove(e.clientX, e.clientY, rect);
    if (patch) setUiPrefs(patch);
    refresh();
    e.preventDefault();
  }
  function up(e) {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  handle.addEventListener("pointerdown", (e) => {
    // Ignore drags that start on a collapse toggle button inside the handle.
    if (e.target.closest(".rail-toggle")) return;
    dragging = true;
    handle.classList.add("dragging");
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  });
}

export function mountLayoutSplitters() {
  // Hydrate from localStorage first so the initial paint matches the
  // user's last session, then push the result into the live vars.
  hydrateUiPrefs();
  refresh();

  // Left divider: drag sets the left-rail width = pointer x relative to
  // the layout's left edge. Clamped so neither the rail nor the centre
  // region drops below its floor.
  wireDrag(document.getElementById("split-left"), (x, _y, rect) => {
    if (!rect) return null;
    const prefs = getUiPrefs();
    if (prefs.leftCollapsed) return null;
    const rightW = prefs.rightCollapsed ? 0 : prefs.rightRailW;
    const maxLeft = rect.width - rightW - MIN_CENTRE;
    const w = clamp(x - rect.left, MIN_RAIL, Math.max(MIN_RAIL, maxLeft));
    return { leftRailW: Math.round(w) };
  });

  // Right divider: width = distance from pointer to the layout's right edge.
  wireDrag(document.getElementById("split-right"), (x, _y, rect) => {
    if (!rect) return null;
    const prefs = getUiPrefs();
    if (prefs.rightCollapsed) return null;
    const leftW = prefs.leftCollapsed ? 0 : prefs.leftRailW;
    const maxRight = rect.width - leftW - MIN_CENTRE;
    const w = clamp(rect.right - x, MIN_RAIL, Math.max(MIN_RAIL, maxRight));
    return { rightRailW: Math.round(w) };
  });

  // Bottom divider: bottom-row height = distance from pointer to the
  // layout's bottom edge.
  wireDrag(document.getElementById("split-bottom"), (_x, y, rect) => {
    if (!rect) return null;
    const maxBottom = rect.height - MIN_TOP;
    const h = clamp(rect.bottom - y, MIN_BOTTOM, Math.max(MIN_BOTTOM, maxBottom));
    return { bottomH: Math.round(h) };
  });

  // Collapse / expand toggles. Each flips the matching collapsed flag;
  // the stored *W is preserved so expanding restores the prior width.
  const leftToggle  = document.getElementById("toggle-left-rail");
  const rightToggle = document.getElementById("toggle-right-rail");
  if (leftToggle) {
    leftToggle.addEventListener("click", () => {
      setUiPrefs({ leftCollapsed: !getUiPrefs().leftCollapsed });
      refresh();
    });
  }
  if (rightToggle) {
    rightToggle.addEventListener("click", () => {
      setUiPrefs({ rightCollapsed: !getUiPrefs().rightCollapsed });
      refresh();
    });
  }

  // Keep the vars/handles in sync if uiPrefs is mutated elsewhere.
  subscribe(() => refresh());

  // Re-place handles on viewport resize (their boundary positions are
  // relative to the live layout box).
  window.addEventListener("resize", () => placeHandles(getUiPrefs()));
}
