// Panel system — multi-tab edition.
//
// Each slot (primary / secondary / bottom) holds an array of tabs;
// one is active at a time. Tab strip shows one tab per entry, plus
// a "+" button at the end for adding new ones via the panel-picker
// modal. Each tab has a small "×" close button.
//
// State coupling:
//   state.panels[slot] = { activeTabId, tabs: [{ id, type, config }] }
//
// Panel module contract:
//   mount(container, state, config, tabContext) → { update(state), destroy() }
// where tabContext = { slot, tabId } so panels can persist their own
// config (e.g. viewer-3d's camera settings).

import { getState, subscribe, addTab, closeTab, setActiveTab } from "./state.js";
import { getPanelType, listPanelTypes }                       from "./panels/registry.js";
import { openPanelPickerModal }                               from "./modals/panel-picker.js";

const SLOTS = ["primary", "secondary", "bottom"];

// MIME-ish key for the drag payload. Custom type so we only react to our
// own tab drags, never to text/file drops dragged in from outside.
const TAB_DRAG_TYPE = "application/x-panel-tab";

// Per-slot tracking. panelsRef lets us skip tab-strip rebuilds when
// only state.blend (or other unrelated slices) changed.
const slotInstances = new Map();   // slot → { panelsRef, instance, tabId, keepAlive, wrapper }

// Keep-alive cache for panels flagged keepAlive (e.g. viewer-3d): when such
// a panel is switched away from, its DOM wrapper + instance are DETACHED and
// stashed here (keyed by tabId) instead of destroyed, then re-attached on
// return. This is what stops the WebGL viewer rendering blank / leaking GL
// contexts on a destroy+remount round-trip. Entries are cleared (and the
// instance destroyed) only when the tab is actually closed.
const keptAlive = new Map();        // tabId → { wrapper, instance }

export function mountPanelSystem() {
  for (const slot of SLOTS) initSlot(slot);

  subscribe((state) => {
    for (const slot of SLOTS) {
      const slotEl = document.querySelector(`.panel-slot[data-slot="${slot}"]`);
      if (!slotEl) continue;
      const desired = state.panels[slot];
      const tracked = slotInstances.get(slot);

      // Tabs / active changed → re-render strip and possibly remount.
      if (!tracked || tracked.panelsRef !== desired) {
        renderTabs(slot, slotEl);
        if (!tracked || tracked.tabId !== desired.activeTabId) {
          renderActivePanel(slot, slotEl);
        }
      }

      // Always deliver fresh state to the active instance.
      const t = slotInstances.get(slot);
      if (t && t.instance && t.instance.update) {
        try { t.instance.update(state); }
        catch (e) { console.error("[panel-system] panel update threw:", e); }
      }
    }
  });

  // Auto-open the 2D viewer when a 2-d reduction (viz2d) produces positions, so
  // BOTH viewers show when both a 2-d and 3-d layout are calculated. The 2-d
  // viewer is off by default (only the 3-d is, in `primary`). Tracked by the
  // _basePos2d array identity: we open on each NEW 2-d layout, so a manual close
  // sticks until the next 2-d reduction is computed.
  let lastBasePos2d = null;
  subscribe((state) => {
    const bp2 = state._basePos2d;
    if (!bp2) { lastBasePos2d = null; return; }
    if (bp2 === lastBasePos2d) return;          // unchanged → respect a manual close
    lastBasePos2d = bp2;
    if (!isPanelOpen("viewer-2d")) addTab("secondary", "viewer-2d", {});
  });
}

// True if a panel of `type` is currently open in any slot.
function isPanelOpen(type) {
  const panels = getState().panels;
  return SLOTS.some((slot) => ((panels[slot] && panels[slot].tabs) || []).some((t) => t.type === type));
}

function initSlot(slot) {
  const slotEl = document.querySelector(`.panel-slot[data-slot="${slot}"]`);
  if (!slotEl) return;
  renderTabs(slot, slotEl);
  renderActivePanel(slot, slotEl);
}

function renderTabs(slot, slotEl) {
  const tabsEl = slotEl.querySelector(".panel-tabs");
  if (!tabsEl) return;
  const slotState = getState().panels[slot];

  tabsEl.innerHTML = "";

  // The whole strip is a drop target — dropping a dragged tab here moves it
  // into THIS slot (see moveTab). dragover must preventDefault to mark the
  // strip droppable; we only do so for our own tab-drag payload.
  wireSlotDropTarget(slot, tabsEl);

  // One tab per entry, with × close button.
  for (const tab of slotState.tabs) {
    const meta = getPanelType(tab.type);
    const tabEl = document.createElement("div");
    tabEl.className = "panel-tab" + (tab.id === slotState.activeTabId ? " active" : "");
    tabEl.title = meta.description || meta.label || "";

    // Drag affordance: pick the tab up and drop it on another slot's strip.
    tabEl.draggable = true;
    tabEl.addEventListener("dragstart", (e) => {
      // Identify source slot + tab; the strip drop handler reads this back.
      e.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify({ slot, tabId: tab.id }));
      // text/plain fallback so the drag is recognised as carrying data even
      // where the custom type isn't surfaced during dragover (some browsers
      // hide non-standard types until drop).
      e.dataTransfer.setData("text/plain", tab.id);
      e.dataTransfer.effectAllowed = "move";
    });

    const label = document.createElement("span");
    label.className = "panel-tab-label";
    label.textContent = meta.label || tab.type;
    label.addEventListener("click", () => setActiveTab(slot, tab.id));
    tabEl.appendChild(label);

    // Context action: right-click a tab to move it to another slot without
    // dragging (keyboard / touch-friendly fallback for the drag affordance).
    tabEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMoveMenu(slot, tab.id, e.clientX, e.clientY);
    });

    const closeBtn = document.createElement("span");
    closeBtn.className = "panel-tab-close";
    closeBtn.title = "Close tab";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(slot, tab.id);
    });
    tabEl.appendChild(closeBtn);

    tabsEl.appendChild(tabEl);
  }

  // "+" button at the end of the actual tabs.
  const addBtn = document.createElement("div");
  addBtn.className = "panel-tab-add";
  addBtn.title = "Add panel…";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    // §6.19.2 — the picker may pass a `config` for validation-run
    // panels (carrying runId) so the new panel is bound to a
    // specific saved run. Merge over the default config so
    // type-level defaults still apply.
    openPanelPickerModal(slot, (typeId, config) => {
      addTab(slot, typeId, { ...defaultConfigFor(typeId), ...(config || {}) });
    });
  });
  tabsEl.appendChild(addBtn);

  // Spacer + slot-name label on the right.
  const spacer = document.createElement("div");
  spacer.className = "panel-tab-spacer";
  spacer.style.flex = "1";
  tabsEl.appendChild(spacer);

  const slotLabel = document.createElement("div");
  slotLabel.className = "panel-tab slot-name";
  slotLabel.style.color = "var(--text-faint)";
  slotLabel.style.cursor = "default";
  slotLabel.textContent = slot;
  tabsEl.appendChild(slotLabel);
}

// Move (pop) a tab from one slot to another, reusing the addTab/closeTab
// plumbing rather than splicing panel DOM by hand. Returns the new tab id on
// success, or null if the move was rejected / a no-op.
//
// Singleton guard: viewers like viewer-2d/viewer-3d (registry `singleton`)
// must never end up double-claimed. If the target slot already hosts a tab of
// the same singleton type, we reject — duplicating a singleton viewer would
// leave two panels fighting over one WebGL context. Same-slot moves are a
// no-op (nothing to do but re-activate).
export function moveTab(fromSlot, tabId, toSlot) {
  if (fromSlot === toSlot) { setActiveTab(toSlot, tabId); return null; }
  const src = getState().panels[fromSlot];
  const dst = getState().panels[toSlot];
  if (!src || !dst) return null;

  const tab = src.tabs.find(t => t.id === tabId);
  if (!tab) return null;

  const meta = getPanelType(tab.type);
  if (meta && meta.singleton && dst.tabs.some(t => t.type === tab.type)) {
    // Target already hosts this singleton — refuse rather than duplicate.
    console.warn(`[panel-system] refusing to move singleton "${tab.type}" into ${toSlot}: already present`);
    return null;
  }

  // A kept-alive instance is cached by tabId; addTab below mints a fresh id,
  // so the old cache entry would orphan its detached DOM/instance. Drop it so
  // the panel mounts cleanly in its new home. (Acceptable for the rare move;
  // the common keep-alive path — switching tabs in place — is untouched.)
  if (keptAlive.has(tabId)) {
    const cached = keptAlive.get(tabId);
    keptAlive.delete(tabId);
    if (cached.instance && cached.instance.destroy) {
      try { cached.instance.destroy(); } catch (e) { console.warn(e); }
    }
  }

  // Order matters: copy the config out, drop the source tab, then re-add to
  // the target. addTab makes the new tab active in its slot.
  const config = tab.config || {};
  closeTab(fromSlot, tabId);
  return addTab(toSlot, tab.type, { ...config });
}

// Mark a tab strip as a drop target for tab drags. Idempotent per render —
// renderTabs rebuilds the strip's children but the strip element itself is
// stable, so we guard against re-binding the same listeners twice.
function wireSlotDropTarget(slot, tabsEl) {
  if (tabsEl._tabDropWired) return;
  tabsEl._tabDropWired = true;

  tabsEl.addEventListener("dragover", (e) => {
    // Only treat our own tab drags as droppable.
    if (!Array.from(e.dataTransfer.types || []).includes(TAB_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });

  tabsEl.addEventListener("drop", (e) => {
    const raw = e.dataTransfer.getData(TAB_DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (!payload || !payload.slot || !payload.tabId) return;
    moveTab(payload.slot, payload.tabId, slot);
  });
}

// Right-click context menu offering "Move to <slot>" for each other slot.
// Built with inline-styled DOM so it needs no CSS-file changes (styles are
// owned by another job). Singleton targets that already host the type are
// shown disabled so the user sees why the move is unavailable.
function openMoveMenu(fromSlot, tabId, x, y) {
  closeMoveMenu();
  const tab = getState().panels[fromSlot]?.tabs.find(t => t.id === tabId);
  if (!tab) return;
  const meta = getPanelType(tab.type);

  const menu = document.createElement("div");
  menu.className = "panel-tab-move-menu";
  menu.style.cssText =
    "position:fixed;z-index:1000;min-width:140px;padding:4px 0;" +
    "background:var(--bg-elev,#222);color:var(--text,#ddd);" +
    "border:1px solid var(--border,#444);border-radius:4px;" +
    "box-shadow:0 2px 8px rgba(0,0,0,0.4);font-size:12px;";
  menu.style.left = `${x}px`;
  menu.style.top  = `${y}px`;

  for (const target of SLOTS) {
    if (target === fromSlot) continue;
    const dst = getState().panels[target];
    const blocked = !!(meta && meta.singleton && dst &&
      dst.tabs.some(t => t.type === tab.type));

    const item = document.createElement("div");
    item.className = "panel-tab-move-item";
    item.textContent = `Move to ${target}`;
    item.style.cssText =
      "padding:5px 12px;cursor:pointer;white-space:nowrap;" +
      (blocked ? "opacity:0.4;cursor:not-allowed;" : "");
    if (!blocked) {
      item.addEventListener("mouseenter", () => { item.style.background = "var(--bg-hover,#333)"; });
      item.addEventListener("mouseleave", () => { item.style.background = ""; });
      item.addEventListener("click", () => {
        moveTab(fromSlot, tabId, target);
        closeMoveMenu();
      });
    } else {
      item.title = `${meta.label || tab.type} is already open in ${target}`;
    }
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  activeMoveMenu = menu;
  // Dismiss on the next click / escape anywhere else.
  setTimeout(() => {
    document.addEventListener("click", closeMoveMenu, { once: true });
    document.addEventListener("keydown", onMoveMenuKey);
  }, 0);
}

let activeMoveMenu = null;

function onMoveMenuKey(e) {
  if (e.key === "Escape") closeMoveMenu();
}

function closeMoveMenu() {
  document.removeEventListener("keydown", onMoveMenuKey);
  if (activeMoveMenu && activeMoveMenu.parentNode) {
    activeMoveMenu.parentNode.removeChild(activeMoveMenu);
  }
  activeMoveMenu = null;
}

function renderActivePanel(slot, slotEl) {
  const contentEl = slotEl.querySelector(".panel-content");
  if (!contentEl) return;
  const slotState = getState().panels[slot];

  // Detach (keep-alive) or tear down the previous instance for this slot.
  const prev = slotInstances.get(slot);
  if (prev && prev.instance) {
    // A keep-alive panel is only DETACHED if its tab still exists (i.e. we
    // switched away). If the tab was closed, fall through to real teardown.
    const tabStillOpen = prev.tabId && slotState.tabs.some(t => t.id === prev.tabId);
    if (prev.keepAlive && prev.wrapper && tabStillOpen) {
      if (prev.wrapper.parentNode) prev.wrapper.parentNode.removeChild(prev.wrapper);
      keptAlive.set(prev.tabId, { wrapper: prev.wrapper, instance: prev.instance });
    } else {
      if (prev.tabId) keptAlive.delete(prev.tabId);
      if (prev.instance.destroy) {
        try { prev.instance.destroy(); } catch (e) { console.warn(e); }
      }
    }
  }
  contentEl.innerHTML = "";   // kept-alive wrapper already detached above

  // No active tab → empty hint.
  if (!slotState.activeTabId || slotState.tabs.length === 0) {
    contentEl.appendChild(emptySlotHint());
    slotInstances.set(slot, { panelsRef: slotState, instance: null, tabId: null });
    return;
  }

  const tab = slotState.tabs.find(t => t.id === slotState.activeTabId);
  if (!tab) {
    slotInstances.set(slot, { panelsRef: slotState, instance: null, tabId: null });
    return;
  }

  const meta = getPanelType(tab.type);
  const tabContext = { slot, tabId: tab.id };

  // Re-attach a previously kept-alive instance instead of remounting.
  if (meta.keepAlive && keptAlive.has(tab.id)) {
    const cached = keptAlive.get(tab.id);
    keptAlive.delete(tab.id);
    contentEl.appendChild(cached.wrapper);
    try { cached.instance.update && cached.instance.update(getState()); } catch (e) { console.warn(e); }
    slotInstances.set(slot, {
      panelsRef: slotState, instance: cached.instance, tabId: tab.id,
      keepAlive: true, wrapper: cached.wrapper,
    });
    return;
  }

  // Pre-register the slot tracker BEFORE mount so any state writes
  // made during mount (e.g. colour-mode migration → setTabConfig)
  // re-entering the subscribe see `tracked.tabId === desired.activeTabId`
  // and skip re-running renderActivePanel — otherwise we recurse,
  // destroying the half-built panel and leaving orphan DOM overlays.
  slotInstances.set(slot, { panelsRef: slotState, instance: null, tabId: tab.id, keepAlive: !!meta.keepAlive });

  // Keep-alive panels mount into a STABLE wrapper that we can detach/
  // re-attach without destroying; others mount straight into contentEl.
  let instance = null;
  let wrapper = null;
  try {
    if (meta.keepAlive) {
      wrapper = document.createElement("div");
      wrapper.className = "panel-keepalive-wrap";
      wrapper.style.cssText = "width:100%;height:100%;position:relative;";
      contentEl.appendChild(wrapper);
      instance = meta.mount(wrapper, getState(), tab.config || {}, tabContext);
    } else {
      instance = meta.mount(contentEl, getState(), tab.config || {}, tabContext);
    }
  } catch (e) {
    console.error(`[panel-system] failed to mount ${tab.type}:`, e);
    contentEl.innerHTML = "";
    contentEl.appendChild(errorPlaceholder(tab.type, e));
  }
  slotInstances.set(slot, { panelsRef: slotState, instance, tabId: tab.id, keepAlive: !!meta.keepAlive, wrapper });
}

function emptySlotHint() {
  const root = document.createElement("div");
  root.className = "placeholder-panel";
  const title = document.createElement("div");
  title.className = "placeholder-title";
  title.textContent = "No panel";
  const hint = document.createElement("div");
  hint.className = "placeholder-hint";
  hint.innerHTML = "Click <strong>+</strong> in the tab bar to add one.";
  root.appendChild(title);
  root.appendChild(hint);
  return root;
}

function errorPlaceholder(type, err) {
  const root = document.createElement("div");
  root.className = "placeholder-panel";
  const title = document.createElement("div");
  title.className = "placeholder-title";
  title.textContent = `Failed to mount: ${type}`;
  const hint = document.createElement("div");
  hint.className = "placeholder-hint";
  hint.style.color = "var(--err)";
  hint.textContent = String(err && err.message ? err.message : err);
  root.appendChild(title);
  root.appendChild(hint);
  return root;
}

// Default configs for a freshly-added tab. Centralised so picking
// "viewer-3d" from the +-modal seeds it with sensible camera speeds
// rather than empty {}.
function defaultConfigFor(typeId) {
  switch (typeId) {
    case "viewer-3d":
      return {
        rotateSpeed: 0.3, zoomSpeed: 0.3, panSpeed: 0.3, smoothMotion: false,
        colourMode:  "cluster:finest",
      };
    default:
      return {};
  }
}

// Which panel renders the result of which ANALYSIS card type. Only cards that
// produce a result a panel can show are listed — data/dimred/clustering and
// the auto-spawned multiLevelPicker are deliberately absent (the picker opens
// its own panel; the producer sweep is what surfaces the curve). Keep in sync
// with panel-picker.js panelTypeForRun (the saved-run analogue).
const PANEL_FOR_CARD_TYPE = {
  dimSweep:          "dim-sweep",
  bootstrapStability:"bootstrap-stability",
  fusionComparison:  "fusion-comparison",
  scoring:           "scoring",
  multiLevel:        "multilayer-curve",   // the sweep producer → Pick layers
  export:            "export-ris",         // RIS export picker
  crossClusterCitations: "cross-cluster",  // citation flow matrix
  nodeDisplacement:      "node-displacement", // pre→post movement
};

// Per-card-type slot override for auto-open. Defaults to "bottom" when a card
// type isn't listed. The picker (multilayer-curve, opened off the multiLevel
// producer) and scoring belong in the PRIMARY slot — they're high-touch
// surfaces the user works in for the bulk of a session. Cross-cluster
// citations goes to SECONDARY (right) so it sits alongside the picker without
// stealing focus.
const SLOT_FOR_CARD_TYPE = {
  multiLevel:            "primary",   // → picker panel (multilayer-curve)
  scoring:               "primary",
  crossClusterCitations: "secondary",
};

// Auto-open the panel for a just-completed analysis card, bound to that card
// (config.stepId), in the slot picked from SLOT_FOR_CARD_TYPE (default
// "bottom"). Idempotent: if a tab of the same type already shows this card
// (or, for singletons, is already open in the same slot), just make it active
// rather than stacking duplicates. Does NOT touch the viewer — the viewer
// follows card SELECTION, which is a separate concern. Safe to call for any
// step; a no-op for non-analysis cards.
export function autoOpenPanelForStep(stepId) {
  const type = getState().workflow?.steps?.[stepId]?.type;
  const panelType = type && PANEL_FOR_CARD_TYPE[type];
  if (!panelType) return;
  const slot = SLOT_FOR_CARD_TYPE[type] || "bottom";
  const meta = getPanelType(panelType);

  const existingSlot = getState().panels[slot];
  if (existingSlot && Array.isArray(existingSlot.tabs)) {
    // Already showing this card? (or this singleton already open anywhere in
    // the slot — singletons render whatever card is selected/auto-picked.)
    const existing = existingSlot.tabs.find(t =>
      t.type === panelType &&
      (meta?.singleton || (t.config && t.config.stepId === stepId)));
    if (existing) { setActiveTab(slot, existing.id); return; }
  }
  addTab(slot, panelType, { ...defaultConfigFor(panelType), stepId });
}
