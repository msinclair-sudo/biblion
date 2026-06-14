// New UI bootstrap.
//
// Imports each UI section module and mounts it into its DOM slot.
// Each module is responsible for its own rendering, state subscription,
// and event handling.
//
// Engine wiring (generation, clustering, citations, layout, blend) is
// not connected in this slice — see doc/ui.md §9 for the build phasing.
// Modules below render placeholder content where the engine isn't yet
// wired; the layout shell is fully functional.

import { mountTopbar }           from "./topbar.js";
import { mountDataPanel }        from "./data-panel.js";
import { mountWorkflowChart }    from "./workflow-chart.js";
import { mountPanelSystem }      from "./panel-system.js";
import { mountLayoutSplitters }  from "./layout-splitters.js";
import { setFusionBlend, setView, getState, subscribe } from "./state.js";

export function boot() {
  mountTopbar();
  mountDataPanel();
  mountWorkflowChart();
  mountPanelSystem();
  mountLayoutSplitters();
  mountFusionBlendSlider();
  mountEdgeControls();

  // UI #2: the workflow no longer auto-runs the pipeline on boot. The
  // tree + viewer start empty; the user grows the tree explicitly,
  // starting from the chart's "+ Add data source" affordance. (Tests
  // that need data trigger engine.regenerate()/reingest() themselves;
  // see tests/conftest.py.)
  console.log("[ui] shell mounted; engine wired (idle — add a data source to begin).");
}

// Fusion-comparison slider — interpolates between pre-fusion and
// post-fusion basePos via the same blend hook (nested lerp inside
// makeBlendForce). Hidden when _basePosPreFusion is null (fusion is
// identity or hasn't run); shown as soon as a fusion run produces a
// pre-fusion endpoint to compare against.
function mountFusionBlendSlider() {
  const row     = document.getElementById("fusion-blend-row");
  const input   = document.getElementById("fusion-blend-slider");
  const readout = document.getElementById("fusion-blend-readout");
  if (!row || !input || !readout) return;

  const s0 = getState();
  input.value = String(s0.fusionBlend);
  readout.textContent = (+input.value).toFixed(2);
  row.style.display = s0._basePosPreFusion ? "" : "none";

  input.addEventListener("input", (e) => {
    const v = +e.target.value;
    setFusionBlend(v);
    readout.textContent = v.toFixed(2);
  });

  subscribe((state) => {
    if (Math.abs(+input.value - state.fusionBlend) > 1e-9) {
      input.value = String(state.fusionBlend);
      readout.textContent = state.fusionBlend.toFixed(2);
    }
    const wantShown = !!state._basePosPreFusion;
    const isShown   = row.style.display !== "none";
    if (wantShown !== isShown) {
      row.style.display = wantShown ? "" : "none";
    }
  });
}

// Edge-display controls (citations / base / structure / arrows + sliders
// + colour pickers). The ec-* inputs live in #edge-controls-host, which
// viewer-3d adopts into its settings popup (J19) — this just wires them
// by id, so it works regardless of where the host is currently parked.
// Writes state.view via setView; viewer-3d reacts on its next update()
// callback. Each slider/colour input gets a live numeric/hex readout so
// users can read values without hovering.
function mountEdgeControls() {
  const cite         = document.getElementById("ec-citations");
  const arrows       = document.getElementById("ec-cit-arrows");
  const citOpa       = document.getElementById("ec-cit-opacity");
  const citOpaRead   = document.getElementById("ec-cit-opacity-readout");
  const citCol       = document.getElementById("ec-cit-colour");
  const base         = document.getElementById("ec-base");
  const baseDens     = document.getElementById("ec-base-density");
  const baseDensRead = document.getElementById("ec-base-density-readout");
  const baseCol      = document.getElementById("ec-base-colour");
  const skel         = document.getElementById("ec-structure");
  const skelCol      = document.getElementById("ec-structure-colour");
  if (!cite || !citOpa || !arrows || !base || !baseDens || !skel) return;

  // Seed widgets from state.
  const v0 = getState().view;
  cite.checked       = !!v0.showCitations;
  arrows.checked     = !!v0.citArrows;
  citOpa.value       = String(v0.citOpacity);
  if (citCol)        citCol.value     = v0.citColour       || "#8a8a8a";
  base.checked       = !!v0.showBase;
  baseDens.value     = String(v0.baseDensity);
  if (baseCol)       baseCol.value    = v0.baseColour      || "#5a6878";
  skel.checked       = !!v0.showStructure;
  if (skelCol)       skelCol.value    = v0.structureColour || "#5dd39e";
  if (citOpaRead)    citOpaRead.textContent   = (+v0.citOpacity).toFixed(2);
  if (baseDensRead)  baseDensRead.textContent = (+v0.baseDensity).toFixed(3);

  cite.addEventListener("change",     () => setView({ showCitations: cite.checked }));
  arrows.addEventListener("change",   () => setView({ citArrows:     arrows.checked }));
  base.addEventListener("change",     () => setView({ showBase:      base.checked }));
  skel.addEventListener("change",     () => setView({ showStructure: skel.checked }));
  citOpa.addEventListener("input",    () => {
    const v = +citOpa.value;
    setView({ citOpacity: v });
    if (citOpaRead) citOpaRead.textContent = v.toFixed(2);
  });
  baseDens.addEventListener("input",  () => {
    const v = +baseDens.value;
    setView({ baseDensity: v });
    if (baseDensRead) baseDensRead.textContent = v.toFixed(3);
  });
  if (citCol)  citCol.addEventListener("input",  () => setView({ citColour:       citCol.value }));
  if (baseCol) baseCol.addEventListener("input", () => setView({ baseColour:      baseCol.value }));
  if (skelCol) skelCol.addEventListener("input", () => setView({ structureColour: skelCol.value }));

  // Re-sync widgets if state.view changes elsewhere (e.g. project load).
  subscribe((state) => {
    const v = state.view;
    if (cite.checked     !== !!v.showCitations) cite.checked     = !!v.showCitations;
    if (arrows.checked   !== !!v.citArrows)     arrows.checked   = !!v.citArrows;
    if (base.checked     !== !!v.showBase)      base.checked     = !!v.showBase;
    if (skel.checked     !== !!v.showStructure) skel.checked     = !!v.showStructure;
    if (Math.abs(+citOpa.value   - v.citOpacity)  > 1e-6) {
      citOpa.value = String(v.citOpacity);
      if (citOpaRead) citOpaRead.textContent = (+v.citOpacity).toFixed(2);
    }
    if (Math.abs(+baseDens.value - v.baseDensity) > 1e-6) {
      baseDens.value = String(v.baseDensity);
      if (baseDensRead) baseDensRead.textContent = (+v.baseDensity).toFixed(3);
    }
    if (citCol  && v.citColour       && citCol.value.toLowerCase()  !== v.citColour.toLowerCase())       citCol.value  = v.citColour;
    if (baseCol && v.baseColour      && baseCol.value.toLowerCase() !== v.baseColour.toLowerCase())      baseCol.value = v.baseColour;
    if (skelCol && v.structureColour && skelCol.value.toLowerCase() !== v.structureColour.toLowerCase()) skelCol.value = v.structureColour;
  });
}
