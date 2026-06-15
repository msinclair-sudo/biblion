// Dataset picker — the unified two-step "dataset → save | create-new" flow.
//
// Replaces the old toy/real/sqlite mode switcher. The workflow chart's "Data"
// node (and File ▸ Open dataset… / Open…) open this. Datasets come live from
// serve.py /api/datasets (data/*/ scan); selecting one reveals its saves
// (resume a project) plus "Create new" (fresh ingest).
//
//   Step 1: list datasets (label + stats + saves count).
//   Step 2: that dataset's saves → Load; "Create new" → engine.reingest.
//
// Heavy work (ingest fetches over the network + the pipeline cascade) runs via
// the descriptor's applyChange / the topbar's rehydrate job, so this modal just
// kicks the work off and closes.

import { openModal } from "./modal.js";
import { listDatasets, listSaves, loadSave, deleteSave } from "../../persistence/projects-api.js";
import { SQLITE_OPTIONS } from "../../datasource/sqlite.js";
import { rehydrateFromBlob } from "../topbar.js";

// descriptor: the data layer descriptor (applyChange(sourceId, params)).
// opts.openDatasetId: jump straight to that dataset's saves (Step 2).
export function openDataSourceModal(descriptor, opts = {}) {
  const body = document.createElement("div");
  body.className = "datasource-modal-body";

  const handle = openModal({
    title: descriptor.label || "Open dataset",
    body,
    actions: [{ label: "Close" }],
  });

  if (opts.openDatasetId) {
    renderSaves(body, descriptor, handle, { id: opts.openDatasetId, label: opts.openDatasetId });
  } else {
    renderDatasets(body, descriptor, handle);
  }
  return handle;
}

/* ── Step 1: dataset list ──────────────────────────────────────────── */

function renderDatasets(body, descriptor, handle) {
  body.innerHTML = "";
  const heading = document.createElement("div");
  heading.className = "datasource-modal-desc";
  heading.textContent = "Pick a dataset to resume a saved project or start fresh.";
  body.appendChild(heading);

  const list = document.createElement("div");
  list.className = "datasource-modal-list";
  body.appendChild(list);

  const loading = document.createElement("div");
  loading.className = "datasource-modal-hint";
  loading.textContent = "Loading datasets…";
  list.appendChild(loading);

  listDatasets().then((datasets) => {
    list.innerHTML = "";
    if (!datasets.length) {
      const none = document.createElement("div");
      none.className = "datasource-modal-hint";
      none.textContent = "No datasets found under data/. (Is serve.py running, and have you built a dataset with `biblion advanced snapshot` + `embedding`?)";
      list.appendChild(none);
      return;
    }
    for (const ds of datasets) {
      list.appendChild(datasetRow(ds, () => renderSaves(body, descriptor, handle, ds)));
    }
  }).catch((e) => {
    list.innerHTML = "";
    const err = document.createElement("div");
    err.className = "datasource-modal-hint";
    err.textContent = `Could not load datasets: ${e.message || e}`;
    list.appendChild(err);
  });
}

function datasetRow(ds, onClick) {
  const row = document.createElement("button");
  row.className = "datasource-modal-item";
  row.type = "button";

  const name = document.createElement("div");
  name.className = "datasource-modal-item-name";
  name.textContent = ds.label || ds.id;
  row.appendChild(name);

  const stats = document.createElement("div");
  stats.className = "datasource-modal-item-stats";
  const bits = [];
  if (ds.nNodes != null) bits.push(`${ds.nNodes} nodes`);
  if (ds.embeddingDim != null) bits.push(`${ds.embeddingDim}-d`);
  if (ds.domain) bits.push(ds.domain);
  bits.push(`${ds.savesCount || 0} save${(ds.savesCount || 0) === 1 ? "" : "s"}`);
  stats.textContent = bits.join(" · ");
  row.appendChild(stats);

  row.addEventListener("click", onClick);
  return row;
}

/* ── Step 2: saves + create-new for one dataset ────────────────────── */

function renderSaves(body, descriptor, handle, ds) {
  body.innerHTML = "";

  const back = document.createElement("button");
  back.className = "datasource-modal-back";
  back.type = "button";
  back.textContent = "← All datasets";
  back.addEventListener("click", () => renderDatasets(body, descriptor, handle));
  body.appendChild(back);

  const heading = document.createElement("div");
  heading.className = "datasource-modal-desc";
  heading.textContent = ds.label || ds.id;
  body.appendChild(heading);

  // Create new — fresh ingest of this dataset (and any of its subsets).
  const createWrap = document.createElement("div");
  createWrap.className = "datasource-modal-create";
  createWrap.appendChild(createButton(ds.id, ds.label || ds.id, descriptor, handle));
  // Subsets are selectable children: SQLITE_OPTIONS holds "<id>::<subset>".
  for (const opt of SQLITE_OPTIONS) {
    if (typeof opt.value === "string" && opt.value.startsWith(`${ds.id}::`)) {
      createWrap.appendChild(createButton(opt.value, opt.label, descriptor, handle));
    }
  }
  body.appendChild(createWrap);

  const savesHead = document.createElement("div");
  savesHead.className = "datasource-modal-hint";
  savesHead.textContent = "Or resume a saved project:";
  body.appendChild(savesHead);

  const list = document.createElement("div");
  list.className = "datasource-modal-list";
  body.appendChild(list);

  const loading = document.createElement("div");
  loading.className = "datasource-modal-hint";
  loading.textContent = "Loading saves…";
  list.appendChild(loading);

  listSaves(ds.id).then((saves) => {
    list.innerHTML = "";
    if (!saves.length) {
      const none = document.createElement("div");
      none.className = "datasource-modal-hint";
      none.textContent = "No saved projects yet.";
      list.appendChild(none);
      return;
    }
    for (const s of saves) {
      list.appendChild(saveRow(ds, s, handle, () => renderSaves(body, descriptor, handle, ds)));
    }
  }).catch((e) => {
    list.innerHTML = "";
    const err = document.createElement("div");
    err.className = "datasource-modal-hint";
    err.textContent = `Could not load saves: ${e.message || e}`;
    list.appendChild(err);
  });
}

function createButton(datasetValue, label, descriptor, handle) {
  const btn = document.createElement("button");
  btn.className = "datasource-modal-action primary";
  btn.type = "button";
  btn.textContent = `Create new (${label})`;
  btn.addEventListener("click", () => {
    descriptor.applyChange("sqlite", { dataset: datasetValue })
      .catch((e) => console.error("[datasource-modal] create-new failed:", e));
    handle.close();
  });
  return btn;
}

function saveRow(ds, save, handle, refresh) {
  const row = document.createElement("div");
  row.className = "datasource-modal-save-row";

  const open = document.createElement("button");
  open.className = "datasource-modal-item";
  open.type = "button";

  const name = document.createElement("div");
  name.className = "datasource-modal-item-name";
  name.textContent = save.projectName || stripZip(save.name);
  open.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "datasource-modal-item-stats";
  const bits = [save.name];
  if (save.savedAt) bits.push(new Date(save.savedAt).toLocaleString());
  if (save.sizeBytes != null) bits.push(`${(save.sizeBytes / 1024).toFixed(0)} KB`);
  meta.textContent = bits.join(" · ");
  open.appendChild(meta);

  open.addEventListener("click", async () => {
    let blob;
    try {
      blob = await loadSave(ds.id, save.name);
    } catch (e) {
      window.alert(`Load failed: ${e.message || e}`);
      return;
    }
    rehydrateFromBlob(blob, { displayName: save.name, datasetId: ds.id });
    handle.close();
  });
  row.appendChild(open);

  const del = document.createElement("button");
  del.className = "datasource-modal-delete";
  del.type = "button";
  del.title = "Delete save";
  del.textContent = "✕";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete save "${save.name}"?`)) return;
    try {
      await deleteSave(ds.id, save.name);
    } catch (err) {
      window.alert(`Delete failed: ${err.message || err}`);
      return;
    }
    refresh();
  });
  row.appendChild(del);

  return row;
}

function stripZip(name) {
  return String(name).replace(/\.zip$/i, "");
}
