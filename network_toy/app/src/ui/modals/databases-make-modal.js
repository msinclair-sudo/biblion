// "Make New" — scaffold a new dataset entry.
//
// A toy dataset is a data/<id>/ bundle (snapshot DB + embeddings.npy +
// paper_index.json) built by biblion itself. serve.py only *scans* data/*/;
// it has no endpoint to create or ingest a corpus (that's deliberately the
// CLI's job — see the data-source-modal note and CLAUDE.md's DatabaseLocation
// contract). So "Make New" tells the user exactly which biblion commands to
// run for the id they pick, then offers to jump straight to Connect once the
// bundle exists. This keeps the heavy, networked ingest out of the browser.

import { openModal } from "./modal.js";
import { openDatabasesConnectModal } from "./databases-connect-modal.js";

// descriptor: the data layer descriptor, forwarded to the Connect modal so the
// freshly-built dataset can be attached without re-opening the menu.
export function openDatabasesMakeModal(descriptor) {
  const body = document.createElement("div");
  body.className = "datasource-modal-body";

  const handle = openModal({
    title: "Make a new dataset",
    body,
    actions: [{ label: "Close" }],
  });

  const desc = document.createElement("div");
  desc.className = "datasource-modal-desc";
  desc.textContent =
    "A dataset is a biblion snapshot bundle under data/<id>/. Pick an id, build it with biblion, then Connect it.";
  body.appendChild(desc);

  const idLabel = document.createElement("div");
  idLabel.className = "datasource-modal-hint";
  idLabel.textContent = "New dataset id:";
  body.appendChild(idLabel);

  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.className = "databases-make-id";
  idInput.placeholder = "e.g. my_corpus";
  body.appendChild(idInput);

  const cmds = document.createElement("pre");
  cmds.className = "databases-make-cmds";
  body.appendChild(cmds);

  const renderCmds = () => {
    const id = (idInput.value.trim() || "<id>");
    // The canonical build sequence (see CLAUDE.md smoke-test + datasource/
    // sqlite.js header): snapshot carves the *_snapshot.db + paper_index.json,
    // embedding writes embeddings.npy, both landing in data/<id>/.
    cmds.textContent =
      `biblion advanced snapshot ${id}\n` +
      `biblion advanced embedding ${id}\n` +
      `# bundle lands at network_toy/data/${id}/`;
  };
  renderCmds();
  idInput.addEventListener("input", renderCmds);

  const actions = document.createElement("div");
  actions.className = "datasource-modal-create";
  body.appendChild(actions);

  const goConnect = document.createElement("button");
  goConnect.className = "datasource-modal-action primary";
  goConnect.type = "button";
  goConnect.textContent = "Built it — Connect now";
  goConnect.addEventListener("click", () => {
    handle.close();
    openDatabasesConnectModal(descriptor);
  });
  actions.appendChild(goConnect);

  return handle;
}
