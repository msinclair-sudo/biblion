// Optimise tab — sweeps clustering algorithms × params and ranks
// configs by a chosen scorer.
//
// Auto-picks the scorer based on data-source mode:
//   * toy  → ariScorer(originId)  (ground-truth available)
//   * real → stabilityScorer({B}) (Hennig fraction-stable)
// User can override via the "Ranked by" dropdown.
//
// Per-row Apply rewrites layerParams.clustering with the chosen
// (algoId, params) — single level, scope=global — and reclusters.
// After Apply, the parent modal switches to the Validate tab so the
// user can confirm the new config is stable.

import { getState, update, subscribe, setOptimiseResult, saveValidationRun } from "../../state.js";
import { enqueueJob }    from "../../queue.js";
import { createStep, listSteps } from "../../workflow.js";
import { listAlgorithms } from "../../../clustering-registry.js";
import { sweepAcrossAlgorithms, runTargetRangeSweep } from "../../../eval/sweep.js";
import {
  ariScorer, stabilityScorer,
  numClustersScorer, clusterRichnessScorer,
} from "../../../eval/scorers.js";
import { SCORE_VERSION } from "../../../eval/bootstrap.js";

export function buildOptimiseTab(host, opts = {}) {
  // closeModal: called after a successful enqueue so the modal goes
  // away while the sweep runs in the background. Result auto-saves to
  // state.validationRuns; the user picks it up from the panel picker.
  // Optional for back-compat: if absent, the modal stays open
  // (legacy behaviour, useful for any external consumer).
  const closeModal = opts.closeModal || (() => {});

  // (onApplyRow + getLevels removed 2026-05-26 — the modal no longer
  //  renders the in-tab results table. Per-row Apply lives in the
  //  validation-run-optimise panel now; the panel passes its own
  //  callbacks. See workflow-tree-redesign.md Phase 1 slice B.)

  const allAlgos = listAlgorithms();
  // Per-algorithm enable flags.
  const enabled = new Map(allAlgos.map(a => [a.id, true]));

  // ── notice ──────────────────────────────────────────────────────
  const notice = document.createElement("div");
  notice.className = "cm-tab-notice";
  notice.textContent = "Sweeps algorithm × parameter combinations and ranks by how stable (or how accurate, in toy mode) the resulting clusters are.";
  host.appendChild(notice);

  // ── settings ────────────────────────────────────────────────────
  const settings = document.createElement("div");
  settings.className = "cm-tab-section";

  const settingsTitle = document.createElement("h4");
  settingsTitle.className = "cm-tab-section-title";
  settingsTitle.textContent = "Settings";
  settings.appendChild(settingsTitle);

  // Algorithms checkboxes.
  const algosRow = document.createElement("div");
  algosRow.className = "cm-tab-checkbox-row";
  const algosLabel = document.createElement("label");
  algosLabel.textContent = "Algorithms";
  algosRow.appendChild(algosLabel);
  const algosBody = document.createElement("div");
  algosBody.className = "cm-tab-checkbox-body";
  for (const a of allAlgos) {
    const lab = document.createElement("label");
    lab.className = "cm-tab-checkbox";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.addEventListener("change", () => enabled.set(a.id, cb.checked));
    lab.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = a.label || a.id;
    lab.appendChild(span);
    algosBody.appendChild(lab);
  }
  algosRow.appendChild(algosBody);
  settings.appendChild(algosRow);

  // B (bootstraps) — only meaningful for bootstrap-based scorers
  // (stability + richness). Ignored by ARI and numClusters.
  let B = 10;
  let scorerId = "auto";
  // §6.18.9 B8 — how the bootstrap treats -1 (noise) labels.
  //   "exclude"   — drop -1 from ref + cand before matching (default;
  //                 reproducibility scored only on the non-noise portion)
  //   "asCluster" — remap -1 to a synthetic NOISE_ID and match like a
  //                 real cluster (noise-vs-noise contributes)
  //   "penalise"  — same matching as exclude, but aggregate Jaccards
  //                 scaled by (1 − noiseFraction) so noisier
  //                 clusterings lose stability proportionally
  let noiseHandling = "exclude";
  // Sweep mode: "resolution" (default; sweep only resolution-tagged
  // fields), "full" (cartesian product of every modalSchema axis), or
  // "target" (LHS-driven hunt for configs producing a specific
  // cluster-count range — see eval/sweep.js runTargetRangeSweep).
  let sweepMode = "resolution";
  // Target-range params (only used when sweepMode === "target").
  let targetMin    = 5;
  let targetMax    = 20;
  let phase1Count  = 30;
  let refineStep   = 3;
  let targetBoot   = false;
  // Which dim-reduction the sweep optimises against. "post" = the
  // citation-aware (post-fusion) UMAP; "pre" = the semantic-only
  // (pre-fusion) UMAP; "both" = run the sweep twice and tag each row
  // by source so the user can see which params win on each surface.
  // Only meaningful when fusion is active; auto-collapses to "post"
  // when state.dimredResultPreFusion is null.
  let sweepAgainst = "post";

  // Sweep mode toggle — three radios.
  const depthRow = document.createElement("div");
  depthRow.className = "cm-tab-checkbox-row";
  const depthLabel = document.createElement("label");
  depthLabel.textContent = "Sweep mode";
  depthRow.appendChild(depthLabel);
  const depthBody = document.createElement("div");
  depthBody.className = "cm-tab-checkbox-body";
  for (const opt of [
    { value: "resolution", label: "Resolution only", checked: true },
    { value: "full",       label: "Full grid",       checked: false },
    { value: "target",     label: "Target range",    checked: false },
  ]) {
    const lab = document.createElement("label");
    lab.className = "cm-tab-checkbox";
    const r = document.createElement("input");
    r.type = "radio";
    r.name = "sweep-depth";
    r.value = opt.value;
    r.checked = opt.checked;
    r.addEventListener("change", () => {
      if (r.checked) {
        sweepMode = opt.value;
        // Show / hide the target-range settings panel.
        if (targetPanel) targetPanel.style.display = sweepMode === "target" ? "" : "none";
        // Sweep-against row only meaningful when pre-fusion data exists
        // (fusion ran). Auto-collapse to "post" if pre-fusion isn't
        // available; the visible row guides the user when it is.
        if (sweepMode === "target") refreshSweepAgainstVisibility();
        // Bootstraps slider only meaningful for full/resolution modes;
        // target mode has its own bootstrap toggle.
        if (bootstrapsRow) bootstrapsRow.style.display = sweepMode === "target" ? "none" : "";
      }
    });
    lab.appendChild(r);
    const span = document.createElement("span");
    span.textContent = opt.label;
    lab.appendChild(span);
    depthBody.appendChild(lab);
  }
  depthRow.appendChild(depthBody);
  const depthHint = document.createElement("div");
  depthHint.className = "cm-tab-slider-hint cm-tab-checkbox-hint";
  depthHint.textContent = "Resolution only: tries different settings for the parameters that control cluster count (e.g. min cluster size, k). Faster. Full grid: tries every combination of every parameter — much slower. Target range: looks for settings producing a specific cluster-count band; Latin-hypercube probe + neighbourhood refine, much cheaper when you know what cluster count you want.";
  depthRow.appendChild(depthHint);
  settings.appendChild(depthRow);

  // ── Target-range settings panel (hidden unless sweepMode === "target"). ──
  const targetPanel = document.createElement("div");
  targetPanel.className = "cm-tab-section";
  targetPanel.style.display = "none";        // hidden by default
  targetPanel.style.marginTop = "4px";
  targetPanel.style.paddingLeft = "12px";
  targetPanel.style.borderLeft = "2px solid var(--bg-3)";

  // ── Sweep-against radio row (which dim-reduction to optimise against). ──
  // Hidden when fusion isn't active (no pre-fusion to compare against).
  // Builds the row eagerly but the wrapper auto-hides based on state.
  const againstRow = document.createElement("div");
  againstRow.className = "cm-tab-checkbox-row";
  const againstLabel = document.createElement("label");
  againstLabel.textContent = "Sweep against";
  againstRow.appendChild(againstLabel);
  const againstBody = document.createElement("div");
  againstBody.className = "cm-tab-checkbox-body";
  for (const opt of [
    { value: "post", label: "Post-fusion (citation-aware)",   checked: true  },
    { value: "pre",  label: "Pre-fusion (semantic-only)",     checked: false },
    { value: "both", label: "Both (compare side-by-side)",    checked: false },
  ]) {
    const lab = document.createElement("label");
    lab.className = "cm-tab-checkbox";
    const r = document.createElement("input");
    r.type = "radio";
    r.name = "sweep-against";
    r.value = opt.value;
    r.checked = opt.checked;
    r.addEventListener("change", () => { if (r.checked) sweepAgainst = opt.value; });
    lab.appendChild(r);
    const span = document.createElement("span");
    span.textContent = opt.label;
    lab.appendChild(span);
    againstBody.appendChild(lab);
  }
  againstRow.appendChild(againstBody);
  const againstHint = document.createElement("div");
  againstHint.className = "cm-tab-slider-hint cm-tab-checkbox-hint";
  againstHint.textContent = "Which dim-reduction to optimise against. Post-fusion = the UMAP that includes citation context; pre-fusion = the semantic-only baseline. 'Both' runs the sweep twice and tags each row's source — useful for asking 'does fusion change which params are most stable?'.";
  againstRow.appendChild(againstHint);
  targetPanel.appendChild(againstRow);

  // Show / hide the sweep-against row based on whether pre-fusion data
  // is available. When fusion is identity (toy mode default) there's
  // no pre-fusion buffer and the choice collapses to post-only — no
  // need to clutter the UI.
  function refreshSweepAgainstVisibility() {
    const hasPre = !!getState()._basePosPreFusion;
    againstRow.style.display = hasPre ? "" : "none";
    if (!hasPre && sweepAgainst !== "post") {
      sweepAgainst = "post";
      const postRadio = againstBody.querySelector('input[value="post"]');
      if (postRadio) postRadio.checked = true;
    }
  }
  refreshSweepAgainstVisibility();

  // Cluster-count range row (two number inputs).
  const rangeRow = document.createElement("div");
  rangeRow.className = "cm-tab-slider-row";
  const rangeLabel = document.createElement("label");
  rangeLabel.textContent = "Target clusters";
  rangeRow.appendChild(rangeLabel);
  const rangeBody = document.createElement("div");
  rangeBody.style.display = "flex";
  rangeBody.style.gap = "6px";
  rangeBody.style.alignItems = "center";
  const minInput = numberInput(targetMin, 1, 999, (v) => { targetMin = v; });
  const maxInput = numberInput(targetMax, 1, 999, (v) => { targetMax = v; });
  rangeBody.appendChild(minInput);
  const dash = document.createElement("span");
  dash.textContent = "to";
  dash.style.color = "var(--text-dim)";
  rangeBody.appendChild(dash);
  rangeBody.appendChild(maxInput);
  rangeRow.appendChild(rangeBody);
  const rangeHint = document.createElement("div");
  rangeHint.className = "cm-tab-slider-hint";
  rangeHint.textContent = "Sweep keeps configs producing this many clusters. Top results land in the middle of the band.";
  rangeRow.appendChild(rangeHint);
  targetPanel.appendChild(rangeRow);

  targetPanel.appendChild(slider("Phase-1 samples", 10, 100, 5, phase1Count, (v) => { phase1Count = v; },
    "How many parameter combinations to probe per algorithm in the broad first pass. Higher = better coverage but slower. 30 is fine at toy scale; 50-80 helps at BFS-5000."));

  targetPanel.appendChild(slider("Refine step", 0, 6, 1, refineStep, (v) => { refineStep = v; },
    "After Phase 1, each hit's resolution parameters are perturbed by ±N steps to refine. 0 = no refinement (Phase 1 only); 3 covers a small neighbourhood; 6 is generous. Higher values blow up config count fast."));

  const bootRow = document.createElement("div");
  bootRow.className = "cm-tab-checkbox-row";
  const bootCb = document.createElement("input");
  bootCb.type = "checkbox";
  bootCb.checked = targetBoot;
  bootCb.addEventListener("change", () => { targetBoot = bootCb.checked; });
  const bootLab = document.createElement("label");
  bootLab.className = "cm-tab-checkbox";
  bootLab.appendChild(bootCb);
  const bootSpan = document.createElement("span");
  bootSpan.textContent = "Rank by reproducibility (bootstrap)";
  bootLab.appendChild(bootSpan);
  bootRow.appendChild(bootLab);
  const bootHint = document.createElement("div");
  bootHint.className = "cm-tab-slider-hint cm-tab-checkbox-hint";
  bootHint.textContent = "Off (default): rank by closeness to the band's midpoint. Quick exploration — not a quality measure; treats every in-band config as equally good and just picks the one nearest the centre. On: bootstrap-Jaccard each Phase-2 candidate and rank by reproducibility. Slower (≈ B × per-config cost) but this is the metric you want when choosing a final config to commit to.";
  bootRow.appendChild(bootHint);
  targetPanel.appendChild(bootRow);

  settings.appendChild(targetPanel);

  const bootstrapsRow = slider("Bootstraps",  5, 30, 1, B, (v) => { B = v; },
    "Bootstrap iterations per config (only used when ranking by reproducibility or richness; ignored for other scorers). Lower for faster sweeps; 10 is a reasonable default.");
  settings.appendChild(bootstrapsRow);

  // §6.18.9 B8 — noise-handling dropdown. Affects bootstrap-based
  // scorers + target-range bootstrap; ignored by ARI / numClusters
  // (no bootstrap involved). Default "exclude" preserves the pre-
  // §6.18.9 behaviour.
  const noiseRow = document.createElement("div");
  noiseRow.className = "cm-tab-select-row";
  const noiseLabel = document.createElement("label");
  noiseLabel.textContent = "Noise handling";
  noiseRow.appendChild(noiseLabel);
  const noiseSelect = document.createElement("select");
  for (const opt of [
    { value: "exclude",   label: "Exclude noise (default)" },
    { value: "asCluster", label: "Treat noise as a cluster" },
    { value: "penalise",  label: "Penalise (scale by 1 − noise fraction)" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value; o.textContent = opt.label;
    if (opt.value === noiseHandling) o.selected = true;
    noiseSelect.appendChild(o);
  }
  noiseSelect.addEventListener("change", () => { noiseHandling = noiseSelect.value; });
  noiseRow.appendChild(noiseSelect);
  const noiseHint = document.createElement("div");
  noiseHint.className = "cm-tab-slider-hint cm-tab-select-hint";
  noiseHint.textContent =
    "How -1 (noise) labels participate in the bootstrap-Jaccard score. " +
    "Exclude: silently drop noise points from both reference and bootstrap before matching — scores only the non-noise portion of the clustering. " +
    "Treat noise as a cluster: remap -1 to a synthetic 'noise cluster' id; noise-vs-noise then contributes to the bipartite match like any other cluster pair. Useful when comparing HDBSCAN modes where noiseMode = absorb vs singletons would otherwise score very differently for unrelated reasons. " +
    "Penalise: same matching as exclude, but the aggregate reproducibility numbers are multiplied by (1 − noise fraction) so a clustering that's 30% noise loses 30% of its stability score. Lets you compare clusterings with different noise levels on equal footing. " +
    "Scores under different modes are NOT directly comparable; pick a mode for a research question and stick to it.";
  noiseRow.appendChild(noiseHint);
  settings.appendChild(noiseRow);

  // Scorer dropdown — pluggable metric the sweep ranks by.
  const scorerRow = document.createElement("div");
  scorerRow.className = "cm-tab-select-row";
  const scorerLabel = document.createElement("label");
  scorerLabel.textContent = "Ranked by";
  scorerRow.appendChild(scorerLabel);
  const scorerSelect = document.createElement("select");

  // §6.18.10 B11 — drop "Automatic" in real-data mode; force an
  // explicit pick. Toy mode keeps Automatic since ARI vs ground
  // truth is the obvious answer. "Cluster richness" relabelled to
  // surface the trade-off ("Cluster count × reproducibility").
  // The dropdown is rebuilt when the data-source mode changes (via
  // the subscribe at the bottom of buildOptimiseTab) so toggling
  // toy ↔ real updates the available options without re-opening
  // the modal.
  const isRealMode = () => {
    const ds = getState().dataSource;
    return ds && ds.mode === "real";
  };
  function buildScorerOptions() {
    scorerSelect.innerHTML = "";
    const opts = [];
    if (!isRealMode()) opts.push({ value: "auto", label: "Automatic (ARI vs ground truth)" });
    opts.push({ value: "ari",         label: "Match to known groups (ARI)" });
    opts.push({ value: "richness",    label: "Cluster count × reproducibility" });
    opts.push({ value: "numClusters", label: "Number of clusters" });
    opts.push({ value: "stability",   label: "Cluster reproducibility (mean Jaccard)" });
    // If the previously-selected scorer is no longer available (e.g.
    // user picked "auto" then switched to real mode), fall back to
    // "richness" — the closest equivalent default for real data.
    if (!opts.some(o => o.value === scorerId)) scorerId = "richness";
    for (const opt of opts) {
      const o = document.createElement("option");
      o.value = opt.value; o.textContent = opt.label;
      if (opt.value === scorerId) o.selected = true;
      scorerSelect.appendChild(o);
    }
  }
  buildScorerOptions();
  scorerSelect.addEventListener("change", () => { scorerId = scorerSelect.value; });
  scorerRow.appendChild(scorerSelect);
  const scorerHint = document.createElement("div");
  scorerHint.className = "cm-tab-slider-hint cm-tab-select-hint";
  scorerHint.textContent =
    "Match to known groups compares your clustering against ground-truth labels — only works when those labels exist (e.g. the toy generator's origins; shown alongside the Bayes-optimal ceiling). " +
    "Cluster count × reproducibility multiplies cluster count by mean Jaccard — balanced across both extremes (one mega-cluster vs many noise-fragments). " +
    "Number of clusters ranks purely by how many groups the algorithm produced (informative when you trust the algorithm and want to push toward more clusters; doesn't filter out noise-fragmentation). " +
    "Cluster reproducibility re-clusters resampled data and asks how similar the partitions are — beware it rewards trivially-coarse partitions (a 1-cluster solution scores ~1.0). " +
    "In real-data mode (no ground truth) we don't auto-pick because each scorer answers a different question; pick the one matching your research aim.";
  scorerRow.appendChild(scorerHint);
  settings.appendChild(scorerRow);

  // Subscribe to state changes so toggling toy ↔ real refreshes the
  // available scorer options without forcing the user to close/reopen
  // the modal.
  let lastMode = getState().dataSource && getState().dataSource.mode;
  subscribe((state) => {
    const m = state.dataSource && state.dataSource.mode;
    if (m !== lastMode) {
      lastMode = m;
      buildScorerOptions();
    }
  });

  // Run row. Single button: queues a sweep job + closes the modal.
  // Mid-flight progress + results live in the bottom busy bar and the
  // panel picker respectively — the modal is config-only now.
  const runRow = document.createElement("div");
  runRow.className = "cm-tab-runrow";
  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "cm-tab-run";
  runBtn.textContent = "Queue sweep";
  const status = document.createElement("span");
  status.className = "cm-tab-status";
  runRow.appendChild(runBtn);
  runRow.appendChild(status);
  settings.appendChild(runRow);
  host.appendChild(settings);

  // Note: the inline result table that used to live here was removed
  // 2026-05-26 (workflow-tree-redesign Phase 1 slice B). Saved sweeps
  // surface in the panel picker under "Validation runs"; the
  // validation-run-optimise panel renders them (and, in live mode,
  // the latest sweep). Cached-result restore on tab open is also
  // gone — the modal is purely a config surface.

  // ── Run handler (workflow-tree-redesign Phase 1 slice B). ──────────
  // Snapshot all inputs at click time, build a self-contained job fn
  // that closes over the snapshot (never reads global state at run
  // time), enqueue it through queue.js, then close the modal. The
  // bottom busy bar shows progress (queue.js mirrors its running job
  // into state.busy). On completion, the sweep auto-saves as a
  // ValidationRun — the user picks it up from the panel picker
  // ("Validation runs" section).
  runBtn.addEventListener("click", () => {
    const s = getState();
    if (!s.genResult || !s.dimredResult) {
      status.textContent = "Apply a clustering first.";
      return;
    }
    const algos = allAlgos.filter(a => enabled.get(a.id));
    if (algos.length === 0) { status.textContent = "Pick at least one algorithm."; return; }

    // Validate target-range bounds before enqueue so the user sees the
    // error here rather than via a silent failed job.
    if (sweepMode === "target" && !(targetMax >= targetMin && targetMin >= 1)) {
      status.textContent = `invalid range [${targetMin}, ${targetMax}]`;
      return;
    }

    // Resolve the scorer (validate ARI availability before enqueue).
    let scorer = null;
    if (sweepMode !== "target") {
      scorer = pickScorer(scorerId, s, B, noiseHandling);
      if (!scorer) { status.textContent = "ARI requires toy mode (no ground truth in real data)."; return; }
    }

    // ── Snapshot. Everything the sweep reads, captured now. ───────────
    const snapshot = {
      // Identity refs — the sweep closes over them; future workflow-
      // tree work will replace these with the active branch's data.
      genResult:            s.genResult,
      dimredResult:         s.dimredResult,
      dimredResultPreFusion: s.dimredResultPreFusion || null,
      // Sweep settings.
      algos,
      sweepMode,
      scorer,
      B,
      noiseHandling,
      // Target-range knobs.
      targetMin, targetMax, phase1Count, refineStep,
      targetBoot,
      sweepAgainst,
      // For the saved ValidationRun's inputs snapshot.
      dataSourceMode:       (s.dataSource && s.dataSource.mode) || "toy",
      dataSourceConfig:     (s.dataSource && s.dataSource.configs && s.dataSource.configs[s.dataSource.mode]) || {},
      layerParamsSnapshot:  s.layerParams,
      scorerId, sweepMode_str: sweepMode,
      // branchId is null today — Phase 2's workflow-tree work populates
      // this with the active branch's id so saved results stay tagged
      // and follow branch-delete semantics.
      branchId:             null,
    };

    // ── Label + enqueue. ─────────────────────────────────────────────
    const algoTag = snapshot.algos.length === 1 ? snapshot.algos[0].id : `${snapshot.algos.length} algos`;
    const modeTag = snapshot.sweepMode === "target"
      ? `target [${snapshot.targetMin}, ${snapshot.targetMax}]`
      : snapshot.sweepMode;
    const subsetTag = snapshot.dataSourceMode === "real"
      ? (snapshot.dataSourceConfig.subset || "real")
      : `toy n=${snapshot.genResult.nodes.length}`;
    const label = `Optimise · ${algoTag} · ${modeTag} · ${subsetTag}`;

    // Phase 2 slice 2.4 — create a tree step for this sweep as a child
    // of the clustering step (its analytical parent). Queue runner
    // mirrors job lifecycle onto the step; the chart renders a spinner
    // on running, a position badge on pending.
    let stepId = null;
    const clusteringSteps = listSteps({ type: "clustering" });
    const parentClusteringId = clusteringSteps.length > 0
      ? clusteringSteps[clusteringSteps.length - 1].id
      : null;
    if (parentClusteringId) {
      try {
        stepId = createStep({
          type:     "optimise",
          label,
          params: {
            algorithms:    snapshot.algos.map(a => a.id),
            scorerId:      snapshot.scorerId,
            sweepMode:     snapshot.sweepMode,
            B:             snapshot.B,
            noiseHandling: snapshot.noiseHandling,
          },
          parentId: parentClusteringId,
        });
      } catch (e) {
        // If step creation fails (e.g. workflow not migrated), fall
        // back to a stepless job — the legacy auto-save still works.
        console.warn("[optimise-tab] createStep failed; running stepless:", e);
        stepId = null;
      }
    }

    const { promise } = enqueueJob({
      type:  "optimise",
      label,
      fn:    (ctx) => runOptimiseJob(snapshot, ctx),
      stepId,
    });

    // Detach handling: on success, auto-save the result. On failure or
    // cancel, log + leave it — nothing to display because the modal is
    // already closed.
    promise.then(
      (outcome) => persistSweepOutcome(outcome, snapshot, label),
      (err) => {
        if (err && err.name === "AbortError") return;   // cancelled — silent
        console.error("[optimise-tab] sweep job failed:", err);
      },
    );

    closeModal();
  });

  return {
    // No mid-flight cancel inside the modal anymore — the job lives on
    // the global queue. Cancel comes from the bottom bar / panel later.
    onTabHidden: () => {},
  };
}

// ── Job runner ───────────────────────────────────────────────────────
// Pure: reads only from `snapshot` + the registry. No state-of-the-
// world dependency. ctx.signal threads through every async hop.
async function runOptimiseJob(snapshot, ctx) {
  const { signal, setPhase } = ctx;
  if (snapshot.sweepMode === "target") {
    // Resolve which dim-reduction(s) the sweep targets — same logic as
    // the legacy in-modal Run handler.
    const hasPre = !!snapshot.dimredResultPreFusion;
    const effectiveAgainst = (snapshot.sweepAgainst !== "post" && !hasPre) ? "post" : snapshot.sweepAgainst;
    const passes = effectiveAgainst === "both"
      ? [
          { tag: "post", dimred: snapshot.dimredResult },
          { tag: "pre",  dimred: snapshot.dimredResultPreFusion },
        ]
      : effectiveAgainst === "pre"
        ? [{ tag: "pre",  dimred: snapshot.dimredResultPreFusion }]
        : [{ tag: "post", dimred: snapshot.dimredResult }];

    const mergedRanked = [];
    const mergedPhase1 = [];
    const mergedPhase2 = [];
    let mergedHitCount = 0;
    let mergedUsedFallback = false;
    for (let pi = 0; pi < passes.length; pi++) {
      if (signal.aborted) break;
      const pass = passes[pi];
      const subOutcome = await runTargetRangeSweep({
        algorithms:   snapshot.algos,
        genResult:    snapshot.genResult,
        dimredResult: pass.dimred,
        n:            snapshot.genResult.nodes.length,
        targetMin:    snapshot.targetMin,
        targetMax:    snapshot.targetMax,
        phase1Count:  snapshot.phase1Count,
        refineStep:   snapshot.refineStep,
        runBootstrap: snapshot.targetBoot,
        bootstrapOpts:{ B: snapshot.B, noiseHandling: snapshot.noiseHandling },
        seed:         42 + (pi * 1009),
        onProgress: (phase, i, total, lbl) => {
          const passLabel = passes.length > 1 ? `[${pass.tag}] ` : "";
          setPhase(`${passLabel}${phase} · ${i}/${total} · ${lbl}`);
        },
        abortSignal: signal,
      });
      for (const r of subOutcome.ranked) r.source = pass.tag;
      for (const e of subOutcome.phase1) e.source = pass.tag;
      for (const e of subOutcome.phase2) e.source = pass.tag;
      mergedRanked.push(...subOutcome.ranked);
      mergedPhase1.push(...subOutcome.phase1);
      mergedPhase2.push(...subOutcome.phase2);
      mergedHitCount     += subOutcome.hitCount || 0;
      mergedUsedFallback = mergedUsedFallback || !!subOutcome.usedFallback;
    }
    mergedRanked.sort((a, b) => {
      if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
      const ap = Number.isFinite(a.primary) ? a.primary : -Infinity;
      const bp = Number.isFinite(b.primary) ? b.primary : -Infinity;
      if (bp !== ap) return bp - ap;
      return (b.secondary || 0) - (a.secondary || 0);
    });
    return {
      ranked:       mergedRanked,
      phase1:       mergedPhase1,
      phase2:       mergedPhase2,
      hitCount:     mergedHitCount,
      usedFallback: mergedUsedFallback,
      totalConfigs: mergedPhase1.length + mergedPhase2.length,
      completed:    mergedPhase1.length + mergedPhase2.length,
      _sweepAgainst: effectiveAgainst,
    };
  }
  // Resolution / full sweep.
  return await sweepAcrossAlgorithms({
    algorithms:    snapshot.algos,
    genResult:     snapshot.genResult,
    dimredResult:  snapshot.dimredResult,
    scorer:        snapshot.scorer,
    resolutionOnly: (snapshot.sweepMode === "resolution"),
    onProgress: (i, total, lbl) => { setPhase(`${i}/${total} · ${lbl}`); },
    abortSignal: signal,
  });
}

// On successful completion, push the outcome into the legacy
// state.evalResults.optimise slot (the validation-run-optimise panel's
// live mode reads it) AND save as a ValidationRun (Phase 1 slice B
// auto-save replaces the old manual Save-this-run button). Both
// receive cr-stripped rows; v1 persisted rows re-infer on Apply
// rather than skip-infer.
function persistSweepOutcome(outcome, snapshot, label) {
  const effectiveScorer = snapshot.sweepMode === "target"
    ? {
        id:    snapshot.targetBoot ? "target+bootstrap" : "target",
        label: snapshot.targetBoot ? "target range + reproducibility" : "target range (proximity)",
      }
    : snapshot.scorer;

  const persistedRanked = outcome.ranked.map(r => {
    const { _cr, ...rest } = r;
    return rest;
  });

  const settings = {
    B:             snapshot.B,
    scorerId:      snapshot.scorerId,
    sweepMode:     snapshot.sweepMode,
    noiseHandling: snapshot.noiseHandling,
    algorithms:    snapshot.algos.map(a => a.id),
    ...(snapshot.sweepMode === "target"
      ? {
          targetMin:    snapshot.targetMin,
          targetMax:    snapshot.targetMax,
          phase1Count:  snapshot.phase1Count,
          refineStep:   snapshot.refineStep,
          runBootstrap: snapshot.targetBoot,
          sweepAgainst: outcome._sweepAgainst || snapshot.sweepAgainst,
        }
      : {}),
  };

  setOptimiseResult({
    scoreVersion: SCORE_VERSION,
    ranked:       persistedRanked,
    totalConfigs: outcome.totalConfigs,
    completed:    outcome.completed,
    scorerId:     effectiveScorer.id,
    scorerLabel:  effectiveScorer.label,
    settings,
    runtimeSec:   null,   // not tracked in the job-runner path; the
                          // job-level runtime sits on the ValidationRun
    timestamp:    new Date().toISOString(),
  });

  // Auto-save as a ValidationRun. branchId stays null until Phase 2's
  // workflow tree starts populating it.
  try {
    saveValidationRun({
      type:  "optimise",
      label,
      inputs: {
        dataSourceId:        snapshot.dataSourceMode,
        dataSourceConfig:    snapshot.dataSourceConfig,
        layerParamsSnapshot: snapshot.layerParamsSnapshot,
      },
      settings,
      results: {
        ranked:          persistedRanked,
        totalConfigs:    outcome.totalConfigs,
        completed:       outcome.completed,
        scorerId:        effectiveScorer.id,
        scorerLabel:     effectiveScorer.label,
        hitCount:        outcome.hitCount,
        usedFallback:    outcome.usedFallback,
        phase2CacheHits: outcome.phase2CacheHits,
      },
      scoreVersion: SCORE_VERSION,
      runtimeSec:   null,
      // Phase-2 wiring point. Always null until the workflow tree lands.
      branchId:     null,
    });
  } catch (e) {
    console.error("[optimise-tab] auto-save of sweep result failed:", e);
  }
}

// Pick the active scorer based on user choice + data-source mode.
// Returns null when the chosen scorer is unsupported (e.g. ARI under
// real mode where there's no ground truth).
function pickScorer(scorerId, state, B, noiseHandling) {
  const isReal = state.dataSource && state.dataSource.mode === "real";
  const bootOpts = { B, noiseHandling };
  if (scorerId === "auto") {
    // Toy → ARI (ground truth available). Real → cluster richness
    // (balanced metric — count × reproducibility — chosen as default
    // after the stability-alone scorer over-rewarded trivial coarse
    // partitions).
    return isReal ? clusterRichnessScorer(bootOpts) : ariScorer(extractGroundTruth(state));
  }
  if (scorerId === "richness")    return clusterRichnessScorer(bootOpts);
  if (scorerId === "numClusters") return numClustersScorer();
  if (scorerId === "stability")   return stabilityScorer(bootOpts);
  if (scorerId === "ari") {
    if (isReal) return null;
    return ariScorer(extractGroundTruth(state));
  }
  return null;
}

function extractGroundTruth(state) {
  const nodes = state.genResult && state.genResult.nodes;
  if (!nodes) return null;
  const gt = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const oid = nodes[i].originId;
    gt[i] = (oid == null) ? -1 : oid;
  }
  return gt;
}

// renderResults + scorer column logic + cell formatters live in
// optimise-results-renderer.js; the validation-run-optimise panel
// imports them. The modal no longer renders results inline as of
// workflow-tree-redesign Phase 1 slice B (2026-05-26) — results
// auto-save to validationRuns and surface in the panel picker.
// `showSaveRunButton` + `formatDistributionStats` were dropped
// alongside that change.

function slider(labelText, min, max, step, init, onInput, hint) {
  const row = document.createElement("div");
  row.className = "cm-tab-slider-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  row.appendChild(lab);
  const input = document.createElement("input");
  input.type = "range";
  input.min  = String(min);
  input.max  = String(max);
  input.step = String(step);
  input.value = String(init);
  row.appendChild(input);
  const readout = document.createElement("span");
  readout.className = "cm-tab-slider-readout";
  readout.textContent = String(init);
  row.appendChild(readout);
  if (hint) {
    const h = document.createElement("div");
    h.className = "cm-tab-slider-hint";
    h.textContent = hint;
    row.appendChild(h);
  }
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    readout.textContent = String(v);
    onInput(v);
  });
  return row;
}

// Small number-input helper used by the target-range cluster-count
// inputs (two side-by-side fields, no slider — exact values matter).
function numberInput(initial, min, max, onChange) {
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = String(min);
  inp.max = String(max);
  inp.value = String(initial);
  inp.style.width = "70px";
  inp.style.padding = "2px 4px";
  inp.style.background = "var(--bg-2)";
  inp.style.color = "var(--text)";
  inp.style.border = "1px solid var(--bg-3)";
  inp.style.borderRadius = "3px";
  inp.style.fontFamily = "inherit";
  inp.style.fontSize = "inherit";
  inp.addEventListener("change", () => {
    let v = parseInt(inp.value, 10);
    if (!Number.isFinite(v)) v = initial;
    if (v < min) v = min;
    if (v > max) v = max;
    inp.value = String(v);
    onChange(v);
  });
  return inp;
}
