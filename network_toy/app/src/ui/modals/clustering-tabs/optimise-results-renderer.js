// Optimise results table renderer.
//
// Renders an Optimise sweep outcome (the `ranked` rows + the scorer
// that produced them) into a sortable table with per-row Apply.
// Same renderer used by:
//   - the in-modal Optimise tab (live results after a sweep completes)
//   - the validation-run-optimise panel (saved runs from §6.19)
//
// Inputs:
//   host       — the DOM element to render into. innerHTML is replaced.
//   outcome    — { ranked: [...], totalConfigs, completed, ... }.
//                Each row carries algoId, params, primary, secondary,
//                numClusters, extra (scorer-specific aggregate).
//   scorer     — { id, label }. id picks the scorer-specific column set
//                ("ari", "richness", "stability", "numClusters",
//                "target", "target+bootstrap").
//   onApplyRow — (row, levelIdx) => void. Called when a row's Apply
//                button is clicked. The row object is the full ranked
//                entry (including _cr if present); levelIdx is the
//                index from the per-row level picker (or 0).
//   getLevels  — () => [{uid, index, scope, method}] or null. When
//                non-null, each row shows a level-picker dropdown
//                ("L0 / L1 / + New level"); when null, a single
//                "Apply" button replaces the L0.
//
// Extracted from optimise-tab.js under §6.19.2 so the saved-run panel
// can share the same renderer without coupling the panel to the modal.

export function renderResults(host, outcome, scorer, onApplyRow, getLevels = null) {
  host.innerHTML = "";
  const head = document.createElement("h4");
  head.className = "cm-tab-section-title";
  head.textContent = "Results";
  host.appendChild(head);

  // Tag rows with their primary-rank position; never re-numbered on sort.
  const rows = outcome.ranked.map((r, idx) => ({ ...r, primaryRank: idx + 1 }));

  // Build column definitions per scorer. Each column declares:
  //   key      — used for sort + cell lookup
  //   label    — header text
  //   align    — left / right
  //   sortable — clickable header
  //   value(r) — extracts the sortable value from a row
  //   render(r)— returns HTML/string for the cell
  // When the target-range sweep ran in "both" mode, each row carries a
  // `source` tag indicating which dim-reduction it came from. Show a
  // Source column so the user can compare post-fusion vs pre-fusion
  // params side-by-side. Auto-hides when all rows share the same source
  // (or none at all — e.g. resolution/full grid sweeps).
  const sources = new Set(rows.map(r => r.source).filter(Boolean));
  const showSourceCol = sources.size > 1;

  const baseCols = [
    {
      key: "rank", label: "#", align: "right", sortable: true,
      value: r => r.primaryRank,
      render: r => String(r.primaryRank),
    },
    {
      key: "algo", label: "Algorithm", align: "left", sortable: true,
      value: r => r.algoLabel,
      render: r => r.algoLabel,
    },
    ...(showSourceCol ? [{
      key: "source", label: "Source", align: "left", sortable: true,
      value: r => r.source || "",
      render: r => r.source === "pre" ? "pre-fusion" : r.source === "post" ? "post-fusion" : "—",
    }] : []),
    {
      key: "params", label: "Params", align: "left", sortable: false,
      value: r => 0,
      render: r => `<code class="cm-tab-params">${formatParams(r.params)}</code>`,
    },
    {
      key: "clusters", label: "Clusters", align: "right", sortable: true,
      value: r => r.numClusters,
      render: r => String(r.numClusters),
    },
  ];

  const scorerCols = scorerSpecificCols(scorer);
  // Existing levels (lazy: fresh on every render in case the cluster
  // config changed under us). When getLevels is null we fall back to a
  // single "Apply" button per row (legacy behaviour).
  const levels = getLevels ? getLevels() : null;
  const applyCol = {
    key: "apply", label: "", align: "right", sortable: false,
    value: r => 0,
    render: () => {
      if (!levels || levels.length === 0) {
        return `<button type="button" class="cm-tab-apply">Apply</button>`;
      }
      // Per-row dropdown listing existing levels + "+ New". The
      // selected index is read at click time so users can pick a row,
      // pick a level, then click Apply.
      const optsHtml = levels.map((l, i) =>
        `<option value="${i}">L${i}${l.scope === "within-parent" ? " (within parent)" : ""}</option>`
      ).join("");
      const newIdx = levels.length;
      return `
        <select class="cm-tab-apply-level" title="Which clustering level should this config land on?">
          ${optsHtml}
          <option value="${newIdx}">+ New level</option>
        </select>
        <button type="button" class="cm-tab-apply">Apply</button>
      `;
    },
  };
  const cols = [...baseCols, ...scorerCols, applyCol];

  // Default sort = primary scorer's value (= rank ascending).
  let sortKey = "rank";
  let sortDir = "asc";

  const table = document.createElement("table");
  table.className = "cm-tab-table cm-tab-table-wide cm-tab-table-sortable";
  host.appendChild(table);

  function rebuild() {
    table.innerHTML = "";

    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    for (const col of cols) {
      const th = document.createElement("th");
      th.textContent = col.label;
      th.style.textAlign = col.align;
      if (col.sortable) {
        th.classList.add("sortable");
        if (col.key === sortKey) th.classList.add("sorted-" + sortDir);
        th.addEventListener("click", () => {
          if (sortKey === col.key) {
            sortDir = sortDir === "asc" ? "desc" : "asc";
          } else {
            sortKey = col.key;
            // Numeric columns default to descending (biggest first).
            const sample = col.value(rows[0]);
            sortDir = typeof sample === "number" ? "desc" : "asc";
          }
          rebuild();
        });
      }
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    const sortedRows = rows.slice().sort((a, b) => {
      const col = cols.find(c => c.key === sortKey);
      if (!col) return 0;
      const av = col.value(a), bv = col.value(b);
      if (av === bv) return 0;
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      return sortDir === "asc" ? 1 : -1;
    });

    const tbody = document.createElement("tbody");
    for (const r of sortedRows) {
      const tr = document.createElement("tr");
      tr.className = "cm-tab-row";
      for (const col of cols) {
        const td = document.createElement("td");
        td.style.textAlign = col.align;
        td.innerHTML = col.render(r);
        tr.appendChild(td);
      }
      tr.querySelector(".cm-tab-apply").addEventListener("click", () => {
        // If the per-row dropdown is present, read its selected index;
        // otherwise default to L0 (legacy "replace whole config").
        const sel = tr.querySelector(".cm-tab-apply-level");
        const levelIdx = sel ? parseInt(sel.value, 10) : 0;
        onApplyRow(r, Number.isFinite(levelIdx) ? levelIdx : 0);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  rebuild();
}

// Columns specific to the active scorer.
function scorerSpecificCols(scorer) {
  if (scorer.id === "richness") {
    return [
      {
        key: "macro", label: "Reprod. (macro)", align: "right", sortable: true,
        value: r => Number.isFinite(r.secondary) ? r.secondary : -Infinity,
        render: r => formatScalar(r.secondary),
      },
      {
        key: "unweighted", label: "Reprod. (per-cluster)", align: "right", sortable: true,
        value: r => readUnweighted(r),
        render: r => formatScalar(readUnweighted(r)),
      },
      {
        key: "breakdown", label: "Stability", align: "left", sortable: false,
        value: r => 0,
        render: r => renderHennigBar(r),
      },
      {
        key: "richness", label: "Richness", align: "right", sortable: true,
        value: r => Number.isFinite(r.primary) ? r.primary : -Infinity,
        render: r => formatScalar(r.primary),
      },
    ];
  }
  if (scorer.id === "stability") {
    return [
      {
        key: "macro", label: "Reprod. (macro)", align: "right", sortable: true,
        value: r => Number.isFinite(r.primary) ? r.primary : -Infinity,
        render: r => formatScalar(r.primary),
      },
      {
        key: "unweighted", label: "Reprod. (per-cluster)", align: "right", sortable: true,
        value: r => Number.isFinite(r.secondary) ? r.secondary : -Infinity,
        render: r => formatScalar(r.secondary),
      },
      {
        key: "breakdown", label: "Stability", align: "left", sortable: false,
        value: r => 0,
        render: r => renderHennigBar(r),
      },
    ];
  }
  // Target-range modes: primary is either proximity-to-mid (1/(1+d))
  // or mean Jaccard (when bootstrap was enabled). Show the right
  // label so the column header isn't confusing.
  if (scorer.id === "target") {
    return [{
      key: "proximity", label: "Proximity", align: "right", sortable: true,
      value: r => Number.isFinite(r.primary) ? r.primary : -Infinity,
      render: r => formatScalar(r.primary),
    }];
  }
  if (scorer.id === "target+bootstrap") {
    return [{
      key: "meanJ", label: "Reproducibility", align: "right", sortable: true,
      value: r => Number.isFinite(r.primary) ? r.primary : -Infinity,
      render: r => formatScalar(r.primary),
    }];
  }
  // numClusters scorer: clusters column already shows the primary.
  return [];
}

export function formatScalar(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(2);
  return v.toFixed(3);
}
export function formatPct(v) {
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(0)}%`;
}
export function formatParams(p) {
  return Object.entries(p).map(([k, v]) => `${k}=${formatVal(v)}`).join(" ");
}
function formatVal(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

// Pull the cluster-count-weighted "per-cluster" Jaccard out of a row.
// stabilityScorer puts it directly on row.secondary; richnessScorer
// uses row.secondary for the macro Jaccard but stashes the unweighted
// reading inside row.extra.aggregate.meanJaccard_unweighted. We try
// the explicit field first and fall back to the extras path.
function readUnweighted(r) {
  if (r.extra && r.extra.aggregate && Number.isFinite(r.extra.aggregate.meanJaccard_unweighted)) {
    return r.extra.aggregate.meanJaccard_unweighted;
  }
  return NaN;
}

// Inline Hennig stability breakdown bar — coloured segments for stable
// / doubtful / unstable proportions per the bootstrap aggregate, with
// a hover title that lists the raw counts. Replaces the previous
// "Stable %" headline number (§6.18.7 B4) which compressed the same
// information into one figure and lost the trade-off.
function renderHennigBar(r) {
  const agg = r.extra && r.extra.aggregate;
  if (!agg || !Number.isFinite(agg.nClusters) || agg.nClusters <= 0) return "—";
  const total = agg.nStable + agg.nDoubtful + agg.nUnstable;
  if (total <= 0) return "—";
  const sPct = (agg.nStable   / total) * 100;
  const dPct = (agg.nDoubtful / total) * 100;
  const uPct = (agg.nUnstable / total) * 100;
  const title = `${agg.nStable} stable · ${agg.nDoubtful} doubtful · ${agg.nUnstable} unstable (Hennig: stable ≥ 0.85, doubtful 0.60–0.85, unstable < 0.60)`;
  return `
    <span class="cm-hennig-bar" title="${escapeAttr(title)}">
      <span class="cm-hennig-seg cm-hennig-stable"   style="width:${sPct.toFixed(2)}%"></span>
      <span class="cm-hennig-seg cm-hennig-doubtful" style="width:${dPct.toFixed(2)}%"></span>
      <span class="cm-hennig-seg cm-hennig-unstable" style="width:${uPct.toFixed(2)}%"></span>
    </span>
  `;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
