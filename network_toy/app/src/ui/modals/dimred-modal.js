// Dim-reduction modal — two-column layout.
//
// Layer 1.5 has five stages: noise reduction, citation-aware fusion,
// dimension compression (clustering input), 3D visualisation reduction,
// and 2D visualisation reduction. The modal lays the stages out in two
// columns: a LEFT column of algorithm pickers (one per stage) and a
// RIGHT column showing the focused stage's description + sliders/params.
// Selecting (or clicking) a picker focuses that stage. Each picker
// lists only registry entries whose family matches the slot (plus
// identity, which is "any" = "skip this stage").
//
// The modal opens on a sensible default preset (DEFAULT_PRESET) rather
// than the previously-committed state; a "Reset to default" control
// restores the preset at any time.
//
// Descriptor shape (from layer-descriptors.js):
//   {
//     label:       string,
//     listAlgos:   (slot) => entries,
//     applyChange: ({ noise, fusion, compression, viz, viz2d }) => void,
//   }
//
// Apply triggers descriptor.applyChange, which writes layerParams.dimred
// and re-runs engine.redimred(). Cancel discards the working copy.

import { openModal } from "./modal.js";
import { paramRow } from "../widgets.js";
// enqueueBusy import removed 2026-05-27 (slice 2.5) — see Apply onClick.

// Default preset — the "sensible starting point" applied as the modal's
// initial working state and restored by the Reset control. Params are
// left empty here; renderForAlgo() seeds them from each algorithm's
// slot-specific defaults (PCA-100 noise, UMAP-50/50/0 compression,
// UMAP-3/15/0.1 viz, etc.) when the method is applied.
//
// Fusion defaults to graph-diffusion: the app is real-data only and every
// biblion corpus carries citation edges, so citation-aware fusion is the
// intended default — it produces the pre/post-fusion fork (and the comparison
// slider). It safely falls through to identity (no fork) when a source has no
// edges, so this is harmless for edge-less data.
const DEFAULT_PRESET = {
  noise:       "pca",
  fusion:      "graph-diffusion",
  compression: "umap",
  viz:         "umap",
  // The 2-D viewer is opt-in: viz2d defaults to identity, so a default
  // dim-reduction computes ONLY the 3-D layout (state._basePos). Pick a 2-D
  // reduction (UMAP-2) to also produce state._basePos2d — the 2-D viewer panel
  // then auto-opens (panel-system) so both viewers show when both are computed.
  viz2d:       "identity",
};

const SECTIONS = [
  {
    key: "noise",
    title: "Noise reduction",
    family: "noise",
    sub: "Denoiser stage; output feeds fusion, then compression, 3D viz, and 2D viz.",
  },
  {
    key: "fusion",
    title: "Citation-aware fusion",
    family: "fusion",
    sub: "Optional. Blends each paper's embedding with the mean of its citation neighbours' embeddings, so clustering and viewing happen on a citation-aware representation. Requires citation edges loaded at ingest time — toy data sources don't supply edges here, so this stage falls through as identity. Pick Graph diffusion to opt in.",
  },
  {
    key: "compression",
    title: "Dimension compression (clustering input)",
    family: "compression",
    sub: "Reduces fusion output to the dim Layer 2 clusters in.",
  },
  {
    key: "viz",
    title: "3D visualisation reduction (3D viewer / blend)",
    family: "viz",
    sub: "Reduces fusion output to 3-d for the 3D viewer + blend's α=0 endpoint. Pick UMAP-3 for real data; toy data already provides basePos.",
  },
  {
    key: "viz2d",
    title: "2D visualisation reduction (2D viewer)",
    family: "viz2d",
    sub: "Reduces fusion output to 2-d for the 2D viewer panel. Independent of the 3D viz — different seed, different fit. The 2D panel stays empty until this produces a 2-d output.",
  },
];

export function openDimredModal(descriptor) {
  // Seed a stage's params from its algorithm's slot-specific defaults — the
  // same source resetParams() draws on when a stage is focused. We do this
  // EAGERLY for every stage (not lazily on first focus), so a user who opens
  // the modal and clicks Apply without visiting each stage still commits real
  // params. Otherwise unvisited UMAP stages commit empty params and fall back
  // to computeUmap's generic n_components=2 — the viz stage then produces a 2-D
  // layout, redimred never adopts _basePos (it requires a 3-D viz), and the 3-D
  // viewer is stuck on the "pick a 3-d reduction" empty state.
  const seedParamsFor = (section, method) => {
    const algo = descriptor.listAlgos(section.family).find(a => a.id === method);
    if (!algo) return {};
    const fresh = (typeof algo.defaultParamsForSlot === "function")
      ? algo.defaultParamsForSlot(section.family)
      : algo.defaultParams();
    return { ...fresh };
  };

  // Working copy — committed only on Apply. Each stage keeps its own
  // (method, params) cursor, seeded from the default preset + slot defaults.
  const working = {};
  for (const section of SECTIONS) {
    const method = DEFAULT_PRESET[section.key];
    working[section.key] = { method, params: seedParamsFor(section, method) };
  }

  const body = document.createElement("div");
  body.className = "dimred-modal-body";

  // Left column: one algorithm picker per stage. Right column: the
  // focused stage's description + params. `focused` is the stage key
  // whose detail the right column currently shows.
  const pickers = document.createElement("div");
  pickers.className = "dimred-modal-pickers";
  const detail = document.createElement("div");
  detail.className = "dimred-modal-detail";

  let focused = SECTIONS[0].key;

  // renderDetail rebuilds the right column for the focused stage. It is
  // declared up front so picker callbacks can call it; the per-stage
  // render closure is stored on each entry below.
  const detailRenderers = new Map();
  function renderDetail() {
    detail.innerHTML = "";
    const render = detailRenderers.get(focused);
    if (render) render(detail);
  }

  function setFocus(key) {
    if (focused === key) return;
    focused = key;
    for (const row of pickers.children) {
      row.classList.toggle("active", row.dataset.section === focused);
    }
    renderDetail();
  }

  // applyPreset resets working state to the default preset, rebuilds the
  // pickers' selected options, and re-renders the focused detail.
  function applyPreset() {
    for (const section of SECTIONS) {
      const method = DEFAULT_PRESET[section.key];
      working[section.key] = { method, params: seedParamsFor(section, method) };
    }
    for (const row of pickers.children) {
      const sel = row.querySelector("select");
      if (sel) sel.value = DEFAULT_PRESET[row.dataset.section];
    }
    renderDetail();
  }

  for (const section of SECTIONS) {
    pickers.appendChild(renderPicker(section, working, descriptor, {
      setFocus,
      renderDetail,
      registerDetail: (fn) => detailRenderers.set(section.key, fn),
    }));
  }
  pickers.appendChild(renderResetControl(applyPreset));

  pickers.firstChild.classList.add("active");
  renderDetail();

  body.appendChild(pickers);
  body.appendChild(detail);

  const modalHandle = openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply",
        primary: true,
        onClick: () => {
          // Apply commits the working state; the descriptor (slice 2.5)
          // creates a new dimred tree step and enqueues a job that
          // runs the cascade. Modal closes immediately; the spinner
          // shows on the new card via the step↔job binding (slice 2.4).
          descriptor.applyChange(working)
            .catch(e => console.error("[dimred-modal] applyChange failed:", e));
          // returning undefined → modal closes via the default handler
        },
      },
    ],
  });
  return modalHandle;
}

function renderResetControl(applyPreset) {
  const row = document.createElement("div");
  row.className = "dimred-modal-reset";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dimred-modal-reset-btn";
  btn.textContent = "Reset to default";
  btn.addEventListener("click", applyPreset);
  row.appendChild(btn);
  return row;
}

// Left-column picker for one stage: a small title + algorithm select.
// Selecting an algorithm seeds its params (resetParams) and focuses the
// stage so the right column shows its detail. `hooks` wires the picker
// back into the modal: setFocus, renderDetail, registerDetail.
function renderPicker(section, working, descriptor, hooks) {
  const algos = descriptor.listAlgos(section.family);

  const wrap = document.createElement("div");
  wrap.className = "dimred-modal-picker";
  wrap.dataset.section = section.key;
  // Clicking anywhere on the picker focuses this stage's detail.
  wrap.addEventListener("click", () => hooks.setFocus(section.key));

  const title = document.createElement("div");
  title.className = "dimred-modal-picker-title";
  title.textContent = section.title;
  wrap.appendChild(title);

  const algoSelect = document.createElement("select");
  algoSelect.className = "dimred-modal-select";
  for (const a of algos) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.label || a.id;
    if (a.id === working[section.key].method) opt.selected = true;
    algoSelect.appendChild(opt);
  }
  wrap.appendChild(algoSelect);

  // resetParams seeds working[stage].params from the algorithm's
  // slot-specific defaults when the method changes, keeping current
  // params on a no-op re-select. Prefer slot defaults (PCA-100 noise,
  // UMAP-50/50/0 compression, UMAP-3/15/0.1 viz) when declared;
  // defaultParams() is the generic toy-friendly fallback.
  function resetParams(algoId) {
    const algo = algos.find(a => a.id === algoId);
    if (!algo) return;
    if (algoId === working[section.key].method && Object.keys(working[section.key].params).length) {
      return; // unchanged and already seeded — keep params as-is
    }
    working[section.key].method = algoId;
    const fresh = (typeof algo.defaultParamsForSlot === "function")
      ? algo.defaultParamsForSlot(section.family)
      : algo.defaultParams();
    working[section.key].params = { ...fresh };
  }

  // Detail renderer for this stage (right column). Registered with the
  // modal so it can re-render on focus / reset.
  hooks.registerDetail((host) => {
    resetParams(working[section.key].method);
    renderDetailFor(host, section, working, algos);
  });

  algoSelect.addEventListener("change", () => {
    resetParams(algoSelect.value);
    hooks.setFocus(section.key);
    // setFocus is a no-op when already focused, so re-render explicitly
    // to reflect the new algorithm's description + params.
    hooks.renderDetail();
  });

  return wrap;
}

// Right-column detail for the focused stage: title, sub, description,
// and params for the currently-selected algorithm. The detail host is
// cleared by the caller before each render.
function renderDetailFor(host, section, working, algos) {
  const algo = algos.find(a => a.id === working[section.key].method);

  const title = document.createElement("h4");
  title.className = "dimred-modal-section-title";
  title.textContent = section.title;
  host.appendChild(title);

  if (section.sub) {
    const sub = document.createElement("div");
    sub.className = "dimred-modal-section-sub";
    sub.textContent = section.sub;
    host.appendChild(sub);
  }

  if (!algo) return;

  const desc = document.createElement("div");
  desc.className = "dimred-modal-desc";
  desc.textContent = algo.description || "";
  host.appendChild(desc);

  const paramsHost = document.createElement("div");
  paramsHost.className = "dimred-modal-params";
  host.appendChild(paramsHost);

  if (!algo.modalSchema || algo.modalSchema.length === 0) {
    const none = document.createElement("div");
    none.className = "kit-noparams";
    none.textContent = "No tuneable parameters.";
    paramsHost.appendChild(none);
    return;
  }
  for (const field of algo.modalSchema) {
    // paramRow (widgets.js) reads/writes working[stage].params[field.key]
    // and keeps its slider readout in sync — same wiring as the old
    // inline renderField/buildInput/formatField this replaced. The
    // left-column picker selects keep their bespoke .dimred-modal-select.
    paramsHost.appendChild(paramRow(field, working[section.key].params));
  }
}
