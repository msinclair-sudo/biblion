// "Manage Connections" — list the discovered datasets, switch the active one,
// and remove a connection.
//
// "Connected" datasets are exactly what serve.py surfaces from data/*/ via
// /api/datasets. Switching = re-point the data layer at a dataset (the same
// applyChange("sqlite", {dataset}) the picker and Connect use). The active
// dataset is the one whose snapshot is the live sql.js handle
// (getActiveDatasetId()).
//
// Removal: serve.py has no "delete dataset" endpoint (it never destroys a
// corpus bundle — that's a filesystem op the user does deliberately). So
// "Remove" hides the dataset from the in-memory option lists for this session
// and tells the user how to delete the bundle on disk. A re-scan / reload
// brings it back if the folder still exists.

import { openModal } from "./modal.js";
import { listDatasets } from "../../persistence/projects-api.js";
import { getActiveDatasetId, SQLITE_OPTIONS } from "../../datasource/sqlite.js";

// descriptor: the data layer descriptor (applyChange(sourceId, params)).
export function openDatabasesManageModal(descriptor) {
  const body = document.createElement("div");
  body.className = "datasource-modal-body";

  const handle = openModal({
    title: "Manage connections",
    body,
    actions: [{ label: "Close" }],
  });

  // Session-only hidden ids (Remove without a server delete endpoint).
  const hidden = new Set();

  const render = () => {
    body.innerHTML = "";

    const desc = document.createElement("div");
    desc.className = "datasource-modal-desc";
    desc.textContent = "Switch the active dataset or remove a connection.";
    body.appendChild(desc);

    const list = document.createElement("div");
    list.className = "datasource-modal-list";
    body.appendChild(list);

    const loading = document.createElement("div");
    loading.className = "datasource-modal-hint";
    loading.textContent = "Loading datasets…";
    list.appendChild(loading);

    const active = getActiveDatasetId();

    listDatasets().then((datasets) => {
      list.innerHTML = "";
      const visible = datasets.filter((d) => !hidden.has(d.id));
      if (!visible.length) {
        const none = document.createElement("div");
        none.className = "datasource-modal-hint";
        none.textContent = "No connected datasets.";
        list.appendChild(none);
        return;
      }
      for (const ds of visible) {
        list.appendChild(manageRow(ds, active, descriptor, handle, () => {
          hidden.add(ds.id);
          removeFromOptions(ds.id);
          render();
        }));
      }
    }).catch((e) => {
      list.innerHTML = "";
      const err = document.createElement("div");
      err.className = "datasource-modal-hint";
      err.textContent = `Could not load datasets: ${e.message || e}`;
      list.appendChild(err);
    });
  };

  render();
  return handle;
}

function manageRow(ds, activeId, descriptor, handle, onRemove) {
  const row = document.createElement("div");
  row.className = "datasource-modal-save-row";

  const info = document.createElement("div");
  info.className = "datasource-modal-item";
  info.style.cursor = "default";

  const name = document.createElement("div");
  name.className = "datasource-modal-item-name";
  const isActive = activeId === ds.id;
  name.textContent = (ds.label || ds.id) + (isActive ? "  (active)" : "");
  info.appendChild(name);

  const stats = document.createElement("div");
  stats.className = "datasource-modal-item-stats";
  const bits = [];
  if (ds.nNodes != null) bits.push(`${ds.nNodes} nodes`);
  if (ds.embeddingDim != null) bits.push(`${ds.embeddingDim}-d`);
  if (ds.domain) bits.push(ds.domain);
  bits.push(`${ds.savesCount || 0} save${(ds.savesCount || 0) === 1 ? "" : "s"}`);
  stats.textContent = bits.join(" · ");
  info.appendChild(stats);
  row.appendChild(info);

  const use = document.createElement("button");
  use.className = "datasource-modal-action" + (isActive ? "" : " primary");
  use.type = "button";
  use.textContent = isActive ? "In use" : "Use";
  use.disabled = isActive;
  if (!isActive) {
    use.addEventListener("click", () => {
      descriptor.applyChange("sqlite", { dataset: ds.id })
        .catch((e) => console.error("[databases-manage] switch failed:", e));
      handle.close();
    });
  }
  row.appendChild(use);

  const del = document.createElement("button");
  del.className = "datasource-modal-delete";
  del.type = "button";
  del.title = "Remove connection";
  del.textContent = "✕";
  del.addEventListener("click", () => {
    const ok = window.confirm(
      `Remove "${ds.label || ds.id}" from this session?\n\n` +
      `This only hides it here — to delete the corpus, remove ` +
      `network_toy/data/${ds.id}/ on disk.`
    );
    if (ok) onRemove();
  });
  row.appendChild(del);

  return row;
}

// Drop a removed dataset (and its subsets) from the shared in-memory option
// list so the Connect modal and picker stop offering it this session.
function removeFromOptions(id) {
  for (let i = SQLITE_OPTIONS.length - 1; i >= 0; i--) {
    const v = SQLITE_OPTIONS[i].value;
    if (v === id || (typeof v === "string" && v.startsWith(`${id}::`))) {
      SQLITE_OPTIONS.splice(i, 1);
    }
  }
}
