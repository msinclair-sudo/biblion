// Panel: fusion / cross-source partition comparison (§6.19 step 8 +
// workflow-tree slice 2.10).
//
// Quantifies how much two clusterings of the same network disagree.
// Two binding modes:
//
//   - **Saved** (slice 2.10): bound to a `fusionComparison` card
//     (config.stepId) or a saved validationRun (config.runId). The
//     runner precomputed the comparison per level into
//     result.comparison.perLevel; the panel just renders it. The two
//     sources are an arbitrary ref + cand clustering (labelA / labelB).
//
//   - **Live** (the original §6.19 path): no binding → compares the
//     current post-fusion clustering (`state.clusterLevels`) against the
//     pre-fusion one (`state.clusterLevelsPreFusion`). When the latter
//     is null (toy mode, or fusion=identity) it shows an empty hint.
//     This is the pre/post-fusion special case; "ref" = pre, "cand" =
//     post.
//
// Surface (both modes):
//   - Level picker (when multiple levels exist).
//   - Aggregate metric strip: ARI · NMI · macro Jaccard ·
//     n clusters A/B · noise A/B · n reorganised.
//   - Sortable per-cluster table: ref-id → best-matched cand-id +
//     Jaccard + member count + retained / lost + biggest-share cand.
//   - Top-N movers list: papers whose ref-cluster peers were most
//     thoroughly dispersed in the cand partition.
//
// The comparison maths lives in eval/fusion-compare.js
// (compareFusionPartitions) and is source-agnostic — it takes any two
// equal-length ClusterResults.

import { getState, subscribe, setSelection } from "../state.js";
// (compareFusionPartitions import removed — the live pre/post mode that called
//  it is gone; saved comparisons arrive pre-computed in the card result.)
import { getStep, listSteps }                from "../workflow.js";

export const ID          = "fusion-comparison";
export const LABEL       = "Fusion comparison";
export const DESCRIPTION = "How much do two clusterings of the same network disagree? ARI / NMI / macro Jaccard between a reference and candidate partition, per-cluster best-match table, biggest-mover papers. Pre/post-fusion live, or any two cluster cards via a fusionComparison card.";
export const SINGLETON   = true;

export function mount(container, _state, config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-fc";
  container.appendChild(wrap);

  const stepId = (config && config.stepId) || null;
  const runId  = (config && config.runId)  || null;

  // Memoise the heavy LIVE comparison across irrelevant state ticks. The
  // (preUid, postUid, level) triple identifies a comparison uniquely;
  // any selection / blend / viewer change shouldn't re-run it. Saved
  // mode is already precomputed so it doesn't use this cache.
  let cachedKey  = null;
  let cachedFC   = null;
  let selectedLevel = 0;
  let sortKey    = "preId";
  let sortDir    = "asc";

  // Resolve the binding: explicit stepId/runId win; else auto-pick the
  // latest done fusionComparison card / saved run; else fall to the live
  // pre/post-fusion comparison. Auto-pick keeps the panel useful when
  // dropped in without config but never overrides an explicit binding.
  function resolveSource() {
    if (stepId) {
      const s = getStep(stepId);
      if (s && s.type === "fusionComparison" && s.result && s.result.comparison) {
        return savedSource(s.label, s.result);
      }
      return { kind: "missing", id: stepId };
    }
    if (runId) {
      const r = (getState().validationRuns || []).find(x => x.id === runId);
      if (r && r.results && r.results.comparison) return savedSource(r.label, r.results);
      return { kind: "missing", id: runId };
    }
    const cards = listSteps({ type: "fusionComparison" })
      .filter(s => s.status === "done" && s.result && s.result.comparison);
    if (cards.length > 0) {
      const c = cards[cards.length - 1];
      return savedSource(c.label, c.result);
    }
    const runs = (getState().validationRuns || [])
      .filter(r => r.type === "fusionComparison" && r.results && r.results.comparison);
    if (runs.length > 0) {
      const r = runs[runs.length - 1];
      return savedSource(r.label, r.results);
    }
    return { kind: "live" };
  }

  function savedSource(label, blob) {
    const cmp = blob.comparison || {};
    return {
      kind:     "saved",
      label:    label || "fusion comparison",
      perLevel: Array.isArray(cmp.perLevel) ? cmp.perLevel : [],
      labelA:   blob.refLabel  || "ref",
      labelB:   blob.candLabel || "cand",
    };
  }

  function render() {
    wrap.innerHTML = "";
    const src = resolveSource();

    // ── Header ──
    const header = document.createElement("div");
    header.className = "panel-fc-header";
    const title = document.createElement("div");
    title.className = "panel-fc-title";
    title.textContent = src.kind === "saved" ? src.label : "Fusion comparison";
    header.appendChild(title);
    wrap.appendChild(header);

    // cards.md placeholder banner — comparison only valid with matched
    // clustering settings. Sits above every render path so it can't be
    // missed.
    const warnBanner = document.createElement("div");
    warnBanner.className = "panel-fc-warn-banner";
    warnBanner.textContent =
      "⚠ Placeholder · pending further work. Only meaningful when both " +
      "clusterings used the SAME algorithm and parameters.";
    wrap.appendChild(warnBanner);

    // Missing binding (a stepId/runId that no longer resolves).
    if (src.kind === "missing") {
      const empty = document.createElement("div");
      empty.className = "panel-fc-empty";
      empty.textContent = `Bound comparison "${src.id}" no longer exists. Open the panel picker (+) to choose another.`;
      wrap.appendChild(empty);
      return;
    }

    // Determine the level count + a getter for the FusionCompareResult
    // at a given level, abstracting saved vs live.
    let nLevels, getFc, labelA, labelB;
    if (src.kind === "saved") {
      nLevels = src.perLevel.length;
      labelA  = src.labelA;
      labelB  = src.labelB;
      getFc   = (lvl) => src.perLevel[lvl] || null;
      if (nLevels === 0) {
        const empty = document.createElement("div");
        empty.className = "panel-fc-empty";
        empty.textContent = "(comparison has no levels)";
        wrap.appendChild(empty);
        return;
      }
    } else {
      // No saved comparison bound. The old "live pre/post-fusion" mode (read
      // state.clusterLevelsPreFusion) is gone — pre/post-fusion is now a
      // workflow FORK. Compare the two fusion branches via a Fusion comparison
      // card (it wires the two clusterings as refIds).
      const empty = document.createElement("div");
      empty.className = "panel-fc-empty";
      empty.textContent = "No comparison bound. To compare pre- vs post-fusion, " +
        "run a dim-reduction with graph-diffusion fusion (forks into pre/post " +
        "branches), cluster each, then add a Fusion comparison card to compare " +
        "the two — or compare any two clusterings the same way.";
      wrap.appendChild(empty);
      return;
    }

    if (selectedLevel >= nLevels) selectedLevel = 0;

    // Level picker (only when multiple levels exist).
    if (nLevels > 1) {
      const picker = document.createElement("div");
      picker.className = "panel-fc-levelpicker";
      const lbl = document.createElement("label");
      lbl.textContent = "Level:";
      picker.appendChild(lbl);
      const sel = document.createElement("select");
      for (let i = 0; i < nLevels; i++) {
        const o = document.createElement("option");
        o.value = String(i); o.textContent = `L${i}`;
        if (i === selectedLevel) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        selectedLevel = parseInt(sel.value, 10);
        render();
      });
      picker.appendChild(sel);
      header.appendChild(picker);
    }

    let fc;
    try {
      fc = getFc(selectedLevel);
    } catch (e) {
      console.error("[fusion-comparison] compare failed:", e);
      const err = document.createElement("div");
      err.className = "panel-fc-empty";
      err.textContent = `Comparison error: ${e.message || e}`;
      wrap.appendChild(err);
      return;
    }
    if (!fc) {
      const empty = document.createElement("div");
      empty.className = "panel-fc-empty";
      empty.textContent = `(no cluster data at L${selectedLevel})`;
      wrap.appendChild(empty);
      return;
    }

    // ── Aggregate strip ──
    const aggRow = document.createElement("div");
    aggRow.className = "panel-fc-agg";
    aggRow.innerHTML = `
      <span><b>ARI</b> ${fmtScalar(fc.aggregate.ari)}</span>
      <span><b>NMI</b> ${fmtScalar(fc.aggregate.nmi_arith)}</span>
      <span><b>macro J</b> ${fmtScalar(fc.aggregate.macroJaccard)}</span>
      <span><b>clusters</b> ${fc.aggregate.nClustersPre} → ${fc.aggregate.nClustersPost}</span>
      <span><b>noise</b> ${fmtScalar(fc.aggregate.noiseFractionPre)} → ${fmtScalar(fc.aggregate.noiseFractionPost)}</span>
      <span><b>reorganised</b> ${fc.aggregate.nReorganised} <span class="panel-fc-hint">(retention &lt; 0.5)</span></span>
    `;
    wrap.appendChild(aggRow);

    const interpretation = document.createElement("div");
    interpretation.className = "panel-fc-interpretation";
    interpretation.textContent = interpretMetrics(fc.aggregate, labelA, labelB);
    wrap.appendChild(interpretation);

    // ── Per-cluster table ──
    const tableTitle = document.createElement("div");
    tableTitle.className = "panel-fc-section";
    tableTitle.textContent = `Per ${labelA} cluster · best match → ${labelB}`;
    wrap.appendChild(tableTitle);

    const table = document.createElement("table");
    table.className = "panel-fc-table";
    wrap.appendChild(table);

    const cols = [
      { key: "preId",       label: labelA,            align: "right", value: r => r.preId },
      { key: "postId",      label: `→ ${labelB}`,     align: "right", value: r => r.postId },
      { key: "jaccard",     label: "Jaccard",   align: "right", value: r => r.jaccard,
        fmt: v => fmtScalar(v) },
      { key: "memberCount", label: "size",      align: "right", value: r => r.memberCount },
      { key: "retainedCount", label: "kept",    align: "right", value: r => r.retainedCount },
      { key: "lostCount",   label: "lost",      align: "right", value: r => r.lostCount },
      { key: "biggestPostShare", label: `biggest → ${labelB}`, align: "right",
        value: r => r.biggestPostShare.postId,
        fmt: (_v, r) => r.biggestPostShare.count > 0
          ? `${r.biggestPostShare.postId} (${r.biggestPostShare.count})`
          : "—" },
    ];

    function rebuildTable() {
      table.innerHTML = "";
      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      for (const col of cols) {
        const th = document.createElement("th");
        th.textContent = col.label;
        th.style.textAlign = col.align;
        th.classList.add("sortable");
        if (col.key === sortKey) th.classList.add("sorted-" + sortDir);
        th.addEventListener("click", () => {
          if (sortKey === col.key) sortDir = sortDir === "asc" ? "desc" : "asc";
          else { sortKey = col.key; sortDir = "asc"; }
          rebuildTable();
        });
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);

      const sorted = fc.perCluster.slice().sort((a, b) => {
        const col = cols.find(c => c.key === sortKey);
        const av = col.value(a), bv = col.value(b);
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (sortDir === "asc" ? 1 : -1);
      });

      const sel = getState().selection || {};
      const isSel = (r) =>
        sel.type === "cluster" && sel.level === selectedLevel && sel.id === r.preId;

      const tbody = document.createElement("tbody");
      for (const r of sorted) {
        const tr = document.createElement("tr");
        tr.className = "panel-fc-row";
        if (isSel(r)) tr.classList.add("selected");
        for (const col of cols) {
          const td = document.createElement("td");
          td.style.textAlign = col.align;
          const raw = col.value(r);
          td.textContent = col.fmt ? col.fmt(raw, r) : String(raw);
          tr.appendChild(td);
        }
        tr.addEventListener("click", () => {
          if (isSel(r)) setSelection({ type: null, id: null });
          else          setSelection({ type: "cluster", level: selectedLevel, id: r.preId });
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    rebuildTable();

    // ── Top movers list ──
    if (fc.topMovers.length > 0) {
      const moversTitle = document.createElement("div");
      moversTitle.className = "panel-fc-section";
      moversTitle.textContent = `Top movers · lowest retention (n=${fc.topMovers.length})`;
      wrap.appendChild(moversTitle);

      const moversTable = document.createElement("table");
      moversTable.className = "panel-fc-movers";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr>
        <th class="r">idx</th>
        <th class="r">${labelA} L${selectedLevel}</th>
        <th class="r">→ ${labelB} L${selectedLevel}</th>
        <th class="r">retention</th>
      </tr>`;
      moversTable.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const m of fc.topMovers) {
        const tr = document.createElement("tr");
        tr.className = "panel-fc-mover-row";
        tr.innerHTML = `
          <td class="r">${m.nodeIdx}</td>
          <td class="r">${m.preId}</td>
          <td class="r">${m.postId}</td>
          <td class="r">${fmtScalar(m.retention)}</td>
        `;
        tr.addEventListener("click", () => {
          const curSel = getState().selection || {};
          if (curSel.type === "node" && curSel.id === m.nodeIdx) {
            setSelection({ type: null, id: null });
          } else {
            setSelection({ type: "node", id: m.nodeIdx });
          }
        });
        tbody.appendChild(tr);
      }
      moversTable.appendChild(tbody);
      wrap.appendChild(moversTable);
    }
  }

  render();
  const unsub = subscribe(() => render());

  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}

// ── helpers ──

function fmtScalar(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(2);
  return v.toFixed(3);
}

function interpretMetrics(agg, labelA = "pre", labelB = "post") {
  if (!Number.isFinite(agg.ari)) return "(insufficient data for interpretation)";
  if (agg.ari > 0.85) {
    return `${cap(labelA)} and ${labelB} partitions agree strongly — little reorganisation between them.`;
  }
  if (agg.ari > 0.5) {
    return `Moderate disagreement. The ${labelB} partition moves the clustering somewhere genuinely different but the high-level structure is preserved.`;
  }
  return `Substantial reorganisation. The ${labelB} partition produces a meaningfully different topology than ${labelA} alone.`;
}

function cap(s) {
  return s && s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
