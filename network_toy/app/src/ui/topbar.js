// Topbar — menu strip at the top of the window.
//
// Menus per doc/ui.md §3:
//   Data ▾   Workflow ▾   Validate ▾   Help ▾
// plus a global seed input.
//
// Most menu items open modals; in this slice they're stubs
// (console.log placeholder). Modals get built in slice 5.

import {
  getState, subscribe, setProjectName, update,
  addTab, setActiveTab, refreshTagsForActiveDataset,
} from "./state.js";
import { serialiseState }   from "../persistence/serialise.js";
import { deserialiseFile }  from "../persistence/deserialise.js";
import { saveProject as apiSaveProject } from "../persistence/projects-api.js";
import { reconnectSqliteCorpus } from "../datasource/sqlite.js";
import { enqueueJob }       from "./queue.js";
import { importWorkflow } from "./workflow.js";
import { projectStepIntoLegacyState } from "./workflow-projection.js";
import { getLayerDescriptor } from "./modals/layer-descriptors.js";
import { openDataSourceModal } from "./modals/data-source-modal.js";
import { openDatabasesConnectModal } from "./modals/databases-connect-modal.js";
import { openDatabasesMakeModal }    from "./modals/databases-make-modal.js";
import { openDatabasesManageModal }  from "./modals/databases-manage-modal.js";

// Phase 2 slice 2.11.b — disabled stub items removed. The 7 dropped
// were either subsumed by panels (ARI dim-sweep → Dim sweep panel /
// card; bootstrap → Bootstrap card) or speculative (presets, method
// manual, keyboard shortcuts, real-dataset loader, edge/label
// export). The remaining active stubs are kept until their real
// targets are designed.
const MENUS = [
  {
    id: "file",
    label: "File",
    items: [
      { label: "Save",          action: () => saveProject({ promptForName: false }) },
      { label: "Save as…",      action: () => saveProject({ promptForName: true }) },
      { label: "Open…",         action: () => openSave() },
      { divider: true },
      { label: "Import .zip…",  action: () => loadProject() },
    ],
  },
  {
    id: "data",
    label: "Data",
    items: [
      { label: "Open dataset…",        action: () => openDataSourceModal(getLayerDescriptor("data")) },
    ],
  },
  {
    id: "workflow",
    label: "Workflow",
    items: [
      { label: "Reset to defaults",    action: stub("workflow:reset") },
    ],
  },
  {
    id: "help",
    label: "Help",
    items: [
      { label: "About",                action: stub("help:about") },
    ],
  },
];

export function mountTopbar() {
  const root = document.getElementById("topbar");
  if (!root) return;
  root.innerHTML = "";

  // Databases dropdown sits at the top-LEFT (first menu) — the data-source /
  // serve.py entry point, paired with the top-right cart precedent.
  root.appendChild(renderMenu(databasesMenu()));

  for (const menu of MENUS) {
    root.appendChild(renderMenu(menu));
  }

  const spacer = document.createElement("div");
  spacer.className = "topbar-spacer";
  root.appendChild(spacer);

  root.appendChild(renderSearch());
  root.appendChild(renderSelected());
  root.appendChild(renderCart());

  // Click-outside handler closes any open menu.
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) closeAllMenus();
  });
}

function renderMenu(menu) {
  const wrap = document.createElement("div");
  wrap.className = "topbar-menu";
  wrap.dataset.menuId = menu.id;

  const label = document.createElement("span");
  label.textContent = `${menu.label} ▾`;
  wrap.appendChild(label);

  const dropdown = document.createElement("div");
  dropdown.className = "topbar-menu-dropdown";

  for (const item of menu.items) {
    if (item.divider) {
      const div = document.createElement("div");
      div.className = "topbar-menu-divider";
      dropdown.appendChild(div);
      continue;
    }
    const el = document.createElement("div");
    el.className = "topbar-menu-item" + (item.disabled ? " disabled" : "");
    el.textContent = item.label;
    if (!item.disabled) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllMenus();
        try { item.action(); } catch (err) { console.error(err); }
      });
    }
    dropdown.appendChild(el);
  }

  wrap.appendChild(dropdown);

  wrap.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = wrap.classList.contains("open");
    closeAllMenus();
    if (!wasOpen) wrap.classList.add("open");
  });

  return wrap;
}

function closeAllMenus() {
  document.querySelectorAll("#topbar .topbar-menu.open").forEach((el) => {
    el.classList.remove("open");
  });
}

// Databases dropdown (top-left): the three data-source actions, each opening
// its modal wired to the data layer descriptor (applyChange → serve.py /
// datasource flow). Built as a normal topbar menu so it shares the open/close
// + click-outside behaviour with File/Data/etc.
function databasesMenu() {
  const dataDescriptor = () => getLayerDescriptor("data");
  return {
    id: "databases",
    label: "Databases",
    items: [
      { label: "Connect New",        action: () => openDatabasesConnectModal(dataDescriptor()) },
      { label: "Make New",           action: () => openDatabasesMakeModal(dataDescriptor()) },
      { divider: true },
      { label: "Manage Connections", action: () => openDatabasesManageModal(dataDescriptor()) },
    ],
  };
}

// Global cart button (top-right): opens the cart panel and shows a live count
// badge of how many papers are currently in the cart.
function renderCart() {
  const btn = document.createElement("button");
  btn.className = "topbar-cart";
  btn.title = "Open cart";

  const label = document.createElement("span");
  label.textContent = "Cart";
  btn.appendChild(label);

  const badge = document.createElement("span");
  badge.className = "topbar-cart-badge";
  btn.appendChild(badge);

  const paint = (state) => {
    const n = (state.cart || []).length;
    badge.textContent = String(n);
    btn.classList.toggle("empty", n === 0);
  };
  paint(getState());
  subscribe(paint);

  btn.addEventListener("click", openCartPanel);
  return btn;
}

// Open the (singleton) cart panel, or focus it if it's already open somewhere.
function openCartPanel() {
  const s = getState();
  for (const slot of Object.keys(s.panels)) {
    const existing = s.panels[slot].tabs.find(t => t.type === "cart");
    if (existing) { setActiveTab(slot, existing.id); return; }
  }
  // Default to the full-width bottom slot — the cart table is wide.
  addTab("bottom", "cart", {});
}

// Selected-papers button (top-right): opens the singleton panel listing the
// currently-selected papers, where the user can pin some white in the viewer.
function renderSelected() {
  const btn = document.createElement("button");
  btn.className = "topbar-search";          // reuse the search button styling
  btn.title = "Open the selected-papers panel";
  btn.textContent = "Selected";
  btn.addEventListener("click", openSelectedPanel);
  return btn;
}

function openSelectedPanel() {
  const s = getState();
  for (const slot of Object.keys(s.panels)) {
    const existing = s.panels[slot].tabs.find(t => t.type === "selected-papers");
    if (existing) { setActiveTab(slot, existing.id); return; }
  }
  addTab("bottom", "selected-papers", {});
}

// Global search button (top-right): opens the SQL library-search panel (J09).
function renderSearch() {
  const btn = document.createElement("button");
  btn.className = "topbar-search";
  btn.title = "Open SQL library search";
  btn.textContent = "Search";
  btn.addEventListener("click", openSearchPanel);
  return btn;
}

// Open the (singleton) search panel, or focus it if it's already open somewhere.
function openSearchPanel() {
  const s = getState();
  for (const slot of Object.keys(s.panels)) {
    const existing = s.panels[slot].tabs.find(t => t.type === "search-results");
    if (existing) { setActiveTab(slot, existing.id); return; }
  }
  // Bottom slot — the editor + results table want the full width.
  addTab("bottom", "search-results", {});
}

function stub(id) {
  return () => {
    console.log(`[topbar action stub] ${id}`);
    // Once modals are built (slice 5), each action opens its modal here.
  };
}

/* ── File menu actions ─────────────────────────────────────────────── */

// The dataset a save belongs to: the dataset id stored under the active data
// source's config (set by the data picker / engine ingest). Saves nest under
// that dataset (data/<id>/saves/), so a save can't be written until a dataset
// is loaded.
export function getCurrentDatasetId() {
  const ds = getState().dataSource;
  if (!ds) return null;
  const cfg = (ds.configs && ds.configs[ds.mode]) || {};
  return cfg.dataset || null;
}

// "Save" writes in place to data/<datasetId>/saves/<projectName>.zip via the
// dev server. state.projectName is the save name (from the most-recent save /
// load / Save-as). First save in a session, or Save-as, prompts for a name.
function saveProject({ promptForName }) {
  const state = getState();
  const datasetId = getCurrentDatasetId();
  if (!datasetId) {
    window.alert("Load a dataset before saving (File ▸ Open dataset…).");
    return;
  }
  let name = state.projectName;
  if (promptForName || !name) {
    const suggestion = name || defaultProjectName(state);
    const entered = window.prompt("Save project as:", suggestion);
    if (entered == null) return;          // user cancelled
    name = sanitiseProjectName(entered);
    if (!name) return;
    setProjectName(name);
  }

  // A save is self-contained and must not leave tracks in the workflow tree:
  // run the job stepless (no "save" card). The .zip already captures the whole
  // state — recording each save as a card just accumulates clutter on every
  // save. Save writes to data/<datasetId>/saves/<name>.zip; with the loaded
  // project's name + dataset restored, "Save" overwrites the file it came from.
  const label = `Save "${name}"`;
  const { promise } = enqueueJob({
    type:  "save",
    label,
    stepId: null,
    fn:    async () => {
      let blob;
      try {
        blob = serialiseState(getState());
      } catch (e) {
        console.error("[topbar] save failed:", e);
        window.alert("Save failed — see browser console.");
        throw e;
      }
      try {
        await apiSaveProject(datasetId, `${name}.zip`, blob);
      } catch (e) {
        console.error("[topbar] save POST failed:", e);
        window.alert(`Save failed: ${e.message || e}\n(Is serve.py running?)`);
        throw e;
      }
      return {
        capturedAt: new Date().toISOString(),
        filename:   `${name}.zip`,
        datasetId,
        sizeBytes:  blob.size,
        savedAt:    new Date().toISOString(),
      };
    },
  });
  promise.catch((e) => {
    if (e && e.name === "AbortError") return;
    console.error("[topbar] save job failed:", e);
  });
}

// "Open…" routes into the unified dataset → save picker. If a dataset is
// already loaded, jump straight to its saves list; otherwise start at the
// dataset list.
function openSave() {
  openDataSourceModal(getLayerDescriptor("data"), { openDatasetId: getCurrentDatasetId() });
}

// Rehydrate a saved project from a Blob (server save) or File (Import .zip).
// Shared by loadProject() (file picker) and the dataset picker's "Load save".
// Runs the deserialise → apply → re-project flow as a queue job; relies on the
// J01 round-trip fix so state.workflow + flat slots restore exactly.
export function rehydrateFromBlob(blobOrFile, { displayName, datasetId } = {}) {
  const fileName = displayName || (blobOrFile && blobOrFile.name) || "save.zip";
  const label = `Load "${fileName}"`;
  const { promise } = enqueueJob({
    type:  "load",
    label,
    stepId: null,    // can't bind: outgoing tree is about to be replaced
    fn:    async () => {
      let res;
      try {
        res = await deserialiseFile(blobOrFile);
      } catch (e) {
        console.error("[topbar] load failed:", e);
        window.alert(`Load failed: ${e.message || e}`);
        throw e;
      }
      // Apply the patch wholesale — engine cascade is intentionally
      // skipped (we have all the results already; re-running would
      // overwrite them and defeat the point of saving). This sets the
      // flat projection slots AND state.workflow (the canonical tree)
      // from the saved file.
      const cur = getState();
      update({
        ...res.patch,
        clusterResult:  res.patch.clusterLevels && res.patch.clusterLevels.length
                         ? res.patch.clusterLevels[res.patch.clusterLevels.length - 1].clusterResult
                         : null,
        projectName:    res.patch.projectName || stripExtension(fileName),
      });

      // Re-install the tree through workflow.js so the module-local
      // serial counter advances past the restored ids (a later
      // createStep mustn't collide with a loaded id).
      importWorkflow(res.patch.workflow ?? { steps: {}, rootId: null, selected: null });

      // Reconcile the flat slots with the restored tree and force the
      // viewer to repaint.
      const selected = getState().workflow.selected;
      if (selected) {
        projectStepIntoLegacyState(selected, { bumpRevision: true });
      } else {
        update({ engineRevision: cur.engineRevision + 1 });
      }
      console.log(`[topbar] loaded project '${fileName}'${datasetId ? ` (dataset ${datasetId})` : ""} (saved ${res.manifest.savedAt})`);

      // Re-open the sqlite corpus so per-paper metadata (title / authors / venue
      // / …) is available again — the load above skips the data cascade, so the
      // live DB handle that getNodeRecord relies on was never reopened. Without
      // this the Cart / Selected-papers tables show year + cluster (from
      // genResult) but everything from the papers table is blank. Best-effort:
      // a missing DB just leaves metadata empty, it doesn't fail the load.
      try {
        const ds   = getState().dataSource;
        const mode = ds && ds.mode;
        const cfg  = (ds && ds.configs && ds.configs[mode]) || {};
        const dsId = cfg.dataset || datasetId;
        const nodes = getState().genResult && getState().genResult.nodes;
        if (mode === "sqlite" && dsId && nodes) {
          await reconnectSqliteCorpus(dsId, nodes);
          // Bump so the metadata-joining panels (cart / selected-papers) rejoin.
          update({ engineRevision: getState().engineRevision + 1 });
          // Sync tags from the (now reopened) live DB — DB is the source of
          // truth, overriding any tags carried in the loaded save.
          refreshTagsForActiveDataset();
        }
      } catch (e) {
        console.warn("[topbar] sqlite reconnect failed (paper metadata unavailable):", e);
      }

      // No load-history card: a load restores the saved tree verbatim and must
      // not leave tracks of its own. The restored workflow is exactly what was
      // saved — appending a "load" card would mutate it on every open.
      return {
        capturedAt:      new Date().toISOString(),
        filename:        fileName,
        datasetId:       datasetId || null,
        savedAtOriginal: res.manifest && res.manifest.savedAt,
        loadedAt:        new Date().toISOString(),
      };
    },
  });
  promise.catch((e) => {
    if (e && e.name === "AbortError") return;
    console.error("[topbar] load job failed:", e);
  });
  return promise;
}

function loadProject() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.style.display = "none";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    rehydrateFromBlob(file, { displayName: file.name });
  });
  document.body.appendChild(input);
  input.click();
}

function defaultProjectName(state) {
  const dsId = getCurrentDatasetId() || (state.dataSource && state.dataSource.mode);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${dsId || "project"}-${stamp}`;
}

function sanitiseProjectName(s) {
  return String(s).trim().replace(/[\\/:*?"<>|]/g, "_");
}

function stripExtension(filename) {
  return filename.replace(/\.zip$/i, "");
}
