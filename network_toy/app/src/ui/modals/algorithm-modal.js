// Algorithm modal — generic algorithm picker + params editor.
//
// Takes a layer descriptor:
//   {
//     layer:       "clustering" | "layout",
//     label:       string (modal title)
//     listAlgos:   () => [{ id, label, description, modalSchema, defaultParams }],
//     getActive:   () => { method: string, params: object },
//     applyChange: (algoId, params) => void,
//   }
//
// Renders:
//   - Algorithm <select> with all registered algos
//   - Each schema row → range / int / select input
//   - Cancel + Apply buttons
//
// "Apply" calls applyChange(); the layer descriptor's owner plumbs
// the change through to state.layerParams and triggers the engine
// lane (recluster, relayoutCitations, …).

import { openModal } from "./modal.js";
import { paramRow } from "../widgets.js";
// enqueueBusy import removed 2026-05-27 (slice 2.5) — see Apply onClick.

export function openAlgorithmModal(descriptor) {
  const active = descriptor.getActive();
  const algos  = descriptor.listAlgos();

  // Working copy of (algoId, params) — committed only on Apply.
  let chosenAlgoId = active.method;
  let chosenParams = { ...active.params };

  const body = document.createElement("div");
  body.className = "algorithm-modal-body";

  // Algorithm switcher
  const algoRow = document.createElement("div");
  algoRow.className = "algorithm-modal-algo-row";

  const algoLabel = document.createElement("label");
  algoLabel.textContent = "Algorithm";
  algoRow.appendChild(algoLabel);

  const algoSelect = document.createElement("select");
  for (const a of algos) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.label || a.id;
    if (a.id === chosenAlgoId) opt.selected = true;
    algoSelect.appendChild(opt);
  }
  algoRow.appendChild(algoSelect);
  body.appendChild(algoRow);

  // Description + params (re-rendered on algo switch)
  const desc = document.createElement("div");
  desc.className = "algorithm-modal-desc";
  body.appendChild(desc);

  const paramsHost = document.createElement("div");
  paramsHost.className = "algorithm-modal-params";
  body.appendChild(paramsHost);

  function renderForAlgo(algoId) {
    const algo = algos.find(a => a.id === algoId);
    if (!algo) return;
    chosenAlgoId = algoId;

    // Reset params to whatever's in active state if same algo,
    // else seed from defaults.
    if (algoId === active.method) {
      chosenParams = { ...active.params };
    } else {
      chosenParams = { ...algo.defaultParams() };
    }

    desc.textContent = algo.description || "";

    paramsHost.innerHTML = "";
    if (!algo.modalSchema || algo.modalSchema.length === 0) {
      const none = document.createElement("div");
      none.className = "kit-noparams";
      none.textContent = "No tuneable parameters.";
      paramsHost.appendChild(none);
      return;
    }
    for (const field of algo.modalSchema) {
      // paramRow (widgets.js) reads/writes chosenParams[field.key] and
      // keeps its slider readout in sync — same wiring as the old inline
      // renderField/buildInput/formatField this replaced.
      paramsHost.appendChild(paramRow(field, chosenParams));
    }
  }

  // Initial render with active algo.
  renderForAlgo(chosenAlgoId);

  algoSelect.addEventListener("change", () => {
    renderForAlgo(algoSelect.value);
  });

  const modal = openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply",
        primary: true,
        onClick: () => {
          // Apply commits the choice, closes the modal. The descriptor's
          // applyChange (slice 2.5) creates a tree step + enqueues a
          // job via queue.js; the chart card spins via the step↔job
          // binding (slice 2.4). No outer wrap — would nest queues.
          descriptor.applyChange(chosenAlgoId, chosenParams)
            .catch(e => console.error("[algorithm-modal] applyChange failed:", e));
        },
      },
    ],
  });
  return modal;
}
