// Multi-level clustering modal — tabbed surface for everything
// cluster-related. Two tabs:
//
//   Configure  — pick algorithm + edit per-level params.
//   Optimise   — sweep configs, rank by stability or ARI, apply a row.
//
// The Configure / Apply pair is the "configuration commit" path —
// Apply commits the working levels editor and triggers recluster.
// Optimise's per-row Apply commits the chosen config to the named
// level and lets the bottom busy bar carry the cascade feedback.
//
// (Validate tab removed 2026-05-24 — bootstrap-Jaccard is reachable
// from Optimise via the richness / stability scorers and via the
// target-range sweep's `runBootstrap` flag, so a standalone
// single-config Validate surface is redundant. Spec: doc/plan.md §6.18.1.)

import { openModal } from "./modal.js";
import { buildConfigureTab } from "./clustering-tabs/configure-tab.js";
import { buildOptimiseTab }  from "./clustering-tabs/optimise-tab.js";
// enqueueBusy import removed 2026-05-27 (slice 2.5) — descriptor.applyChange
// now creates a tree step + enqueues its own job via queue.js, which
// mirrors lifecycle to state.busy. Wrapping the descriptor call in an
// outer enqueueBusy would just nest the queues.

const TABS = [
  { id: "configure", label: "Configure" },
  { id: "optimise",  label: "Optimise"  },
];

export function openClusteringModal(descriptor) {
  // Per-tab handles, populated lazily on first activation.
  const tabHandles = {};

  // Forward-declared so the Optimise tab's Run handler can close the
  // modal after enqueueing the sweep. Set when openModal returns
  // below. The Optimise tab calls closeModal() once enqueueJob
  // succeeds; the modal goes away, the bottom busy bar takes over.
  let modalHandle = null;
  const closeModal = () => { if (modalHandle) modalHandle.close(); };

  // Body shell.
  const body = document.createElement("div");
  body.className = "clustering-modal-body";

  const tabStrip = document.createElement("div");
  tabStrip.className = "modal-tab-strip";
  body.appendChild(tabStrip);

  const tabPanes = document.createElement("div");
  tabPanes.className = "modal-tab-panes";
  body.appendChild(tabPanes);

  const paneEls = {};
  for (const t of TABS) {
    const pane = document.createElement("div");
    pane.className = "modal-tab-pane";
    pane.dataset.tabId = t.id;
    pane.style.display = "none";
    tabPanes.appendChild(pane);
    paneEls[t.id] = pane;
  }

  let activeTab = "configure";

  function setActiveTab(tabId) {
    if (!paneEls[tabId]) return;
    // Notify the previously-active tab so it can cancel in-flight work.
    if (tabHandles[activeTab] && tabHandles[activeTab].onTabHidden) {
      try { tabHandles[activeTab].onTabHidden(); } catch (_) {}
    }
    activeTab = tabId;
    for (const t of TABS) {
      paneEls[t.id].style.display = (t.id === tabId) ? "" : "none";
    }
    rebuildTabStrip();
    // Lazily build the tab body the first time it's shown.
    if (!tabHandles[tabId]) {
      tabHandles[tabId] = buildTab(tabId, paneEls[tabId]);
    }
  }

  function rebuildTabStrip() {
    tabStrip.innerHTML = "";
    for (const t of TABS) {
      const tab = document.createElement("div");
      tab.className = "modal-tab" + (t.id === activeTab ? " active" : "");
      tab.textContent = t.label;
      tab.addEventListener("click", () => setActiveTab(t.id));
      tabStrip.appendChild(tab);
    }
  }

  function buildTab(tabId, host) {
    if (tabId === "configure") return buildConfigureTab(host, descriptor);
    if (tabId === "optimise") return buildOptimiseTab(host, {
      // Close the modal when a sweep is queued (workflow-tree-redesign
      // Phase 1 slice B). The job runs on the background queue; the
      // bottom busy bar shows progress; results auto-save to
      // validationRuns and surface in the panel picker.
      closeModal,

      // The legacy onApplyRow + getLevels callbacks were dropped
      // 2026-05-26 with the inline result-table removal. Per-row Apply
      // now lives in the validation-run-optimise panel, which passes
      // its own callback. Stubs below kept for now in case any
      // external consumer still calls buildOptimiseTab with these
      // names — they're ignored inside.
      // levelIdx semantics:
      //   0..existingLevels.length-1 → replace that level's params with
      //                                row.params; other levels untouched.
      //   existingLevels.length       → append a new level (within-parent
      //                                if not the first; global otherwise).
      // The whole levels array is rewritten and committed via applyChange
      // because recluster reads cfg.levels wholesale.
      onApplyRow: (row, levelIdx = 0) => {
        const active = descriptor.getActive();
        const existing = active.levels.map(l => ({
          uid: l.uid, params: { ...l.params }, scope: l.scope,
        }));
        const isAppend = levelIdx >= existing.length;
        const newLvl = {
          uid:    Math.random().toString(36).slice(2, 10),
          params: { ...row.params },
          scope:  isAppend && existing.length > 0 ? "within-parent" : "global",
        };
        let levels;
        if (isAppend) {
          levels = [...existing, newLvl];
        } else {
          levels = existing.slice();
          // Keep the slot's uid + scope; only swap params (and the
          // algorithm if the optimise row picked a different one).
          levels[levelIdx] = {
            uid:    existing[levelIdx].uid,
            params: { ...row.params },
            scope:  existing[levelIdx].scope,
          };
        }
        // Reflect into Configure so when the user hops back they
        // see what landed. The cascade itself runs on the global
        // busy queue; the bottom bar shows progress.
        if (tabHandles.configure && tabHandles.configure.overwrite) {
          tabHandles.configure.overwrite(row.algoId, levels);
        }
        // A3 (§6.18.3): pass the swept cr through so the engine cascade
        // can skip the L0 re-infer when the user applies to L0 with a
        // single level. Cache is ignored downstream when the levels
        // shape doesn't match (e.g. appending as a within-parent
        // sub-level). row._cr is the runtime-only cache stamped by
        // sweep.js / runTargetRangeSweep.
        const precomputedCr = row._cr
          ? { algoId: row.algoId, params: row.params, cr: row._cr }
          : null;
        // descriptor.applyChange (slice 2.5) creates a tree step + enqueues
        // its own job via queue.js. The bottom busy bar lights up via the
        // queue's mirror; the chart card shows a spinner. No outer
        // enqueueBusy needed — that would just nest the queues + race
        // state.busy publishes between the two.
        descriptor.applyChange(row.algoId, levels, { precomputedCr })
          .catch(e => console.error("[clustering-modal] onApplyRow applyChange failed:", e));
      },
    });
    return null;
  }

  // Initial state: Configure tab visible.
  rebuildTabStrip();
  paneEls.configure.style.display = "";
  tabHandles.configure = buildTab("configure", paneEls.configure);

  modalHandle = openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply",
        primary: true,
        onClick: () => {
          // Apply commits the Configure tab's working state; the
          // descriptor (slice 2.5) creates a new clustering tree step
          // and enqueues a job that runs the cascade. Modal closes
          // immediately; the spinner shows on the new card; the
          // bottom busy bar mirrors the running job.
          const w = tabHandles.configure && tabHandles.configure.getWorking();
          if (w) {
            descriptor.applyChange(w.algoId, w.levels, { bootstrap: w.bootstrap })
              .catch(e => console.error("[clustering-modal] applyChange failed:", e));
          }
          // returning undefined → modal closes
        },
      },
    ],
  });
  return modalHandle;
}
