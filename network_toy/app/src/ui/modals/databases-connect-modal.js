// "Connect New" — attach an existing biblion snapshot dataset as the active
// data source. A connected dataset is just a data/<id>/ bundle that serve.py
// already discovers (snapshot DB + embeddings.npy + paper_index.json); this
// modal lets the user point the toy at one without going through the full
// dataset → save picker. Selecting a dataset runs the data layer's
// applyChange("sqlite", {dataset}) — same wiring the picker's "Create new"
// uses — so the chosen snapshot becomes the live source.
//
// There is no server-side "register a DB" endpoint (serve.py only scans
// data/*/ and serves saves); "connecting" therefore means selecting from the
// discovered datasets, or typing an id that exists on disk. A typed id that
// isn't on disk fails loud at ingest time via produceSqlite's HTTP 404s.

import { openModal } from "./modal.js";
import { listDatasets } from "../../persistence/projects-api.js";
import { SQLITE_OPTIONS } from "../../datasource/sqlite.js";

// descriptor: the data layer descriptor (applyChange(sourceId, params)).
export function openDatabasesConnectModal(descriptor) {
  const body = document.createElement("div");
  body.className = "datasource-modal-body";

  const handle = openModal({
    title: "Connect a dataset",
    body,
    actions: [{ label: "Close" }],
  });

  const desc = document.createElement("div");
  desc.className = "datasource-modal-desc";
  desc.textContent =
    "Attach an existing biblion snapshot (data/<id>/) as the active source.";
  body.appendChild(desc);

  const list = document.createElement("div");
  list.className = "datasource-modal-list";
  body.appendChild(list);

  const loading = document.createElement("div");
  loading.className = "datasource-modal-hint";
  loading.textContent = "Loading datasets…";
  list.appendChild(loading);

  const connect = (datasetValue) => {
    descriptor.applyChange("sqlite", { dataset: datasetValue })
      .catch((e) => console.error("[databases-connect] applyChange failed:", e));
    handle.close();
  };

  listDatasets().then((datasets) => {
    list.innerHTML = "";
    if (!datasets.length) {
      const none = document.createElement("div");
      none.className = "datasource-modal-hint";
      none.textContent =
        "No datasets found under data/. Use \"Make New\" for the commands that build one, or check that serve.py is running.";
      list.appendChild(none);
    }
    for (const ds of datasets) {
      list.appendChild(connectRow(ds.label || ds.id, ds.id, () => connect(ds.id)));
      // Embedded subsets are connectable too ("<id>::<subset>"), discovered by
      // the datasource layer into SQLITE_OPTIONS.
      for (const opt of SQLITE_OPTIONS) {
        if (typeof opt.value === "string" && opt.value.startsWith(`${ds.id}::`)) {
          list.appendChild(connectRow(opt.label, opt.value, () => connect(opt.value)));
        }
      }
    }
    list.appendChild(manualRow(connect));
  }).catch((e) => {
    list.innerHTML = "";
    const err = document.createElement("div");
    err.className = "datasource-modal-hint";
    err.textContent = `Could not load datasets: ${e.message || e}`;
    list.appendChild(err);
    list.appendChild(manualRow(connect));
  });

  return handle;
}

function connectRow(label, value, onClick) {
  const row = document.createElement("button");
  row.className = "datasource-modal-item";
  row.type = "button";

  const name = document.createElement("div");
  name.className = "datasource-modal-item-name";
  name.textContent = label;
  row.appendChild(name);

  const stats = document.createElement("div");
  stats.className = "datasource-modal-item-stats";
  stats.textContent = value;
  row.appendChild(stats);

  row.addEventListener("click", onClick);
  return row;
}

// Escape hatch: connect by typing a dataset id that exists on disk but the
// server hasn't surfaced (e.g. just-built, before a re-scan).
function manualRow(connect) {
  const wrap = document.createElement("div");
  wrap.className = "datasource-modal-create";

  const btn = document.createElement("button");
  btn.className = "datasource-modal-action";
  btn.type = "button";
  btn.textContent = "Connect by id…";
  btn.addEventListener("click", () => {
    const id = window.prompt("Dataset id (the data/<id>/ folder name):");
    if (id == null) return;
    const trimmed = id.trim();
    if (trimmed) connect(trimmed);
  });
  wrap.appendChild(btn);
  return wrap;
}
