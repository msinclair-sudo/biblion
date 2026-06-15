// Drag-to-resize table columns. Shared by the Cart and Selected-papers tables
// (and any other thead-based table that opts in).
//
// Call AFTER (re)building the <thead>, with the table already in the DOM (it
// measures natural column widths once). The table is switched to
// `table-layout: fixed` and given an explicit width = sum of column widths, so
// each column resizes INDEPENDENTLY and the surrounding scroll container scrolls
// horizontally — rather than the columns rescaling each other (what width:100%
// + auto layout would do).
//
// `widths` is a { [colKey]: px } store owned by the caller (panel-local, often
// persisted via setTabConfig). It's read to restore sizes and mutated on drag;
// `onResize(widths)` fires at drag end so the caller can persist.
//
//   makeColumnsResizable(tableEl, theadEl, {
//     keyOf:   (th) => th.dataset.colKey || null,   // null = non-resizable (e.g. checkbox col)
//     widths,                                        // { key: px }
//     onResize: (widths) => persist(widths),
//   })
export function makeColumnsResizable(table, thead, { keyOf, widths, onResize } = {}) {
  const ths = [...thead.querySelectorAll("th")];
  if (ths.length === 0) return;

  // Measure any column that doesn't yet have a stored width (first render).
  for (const th of ths) {
    const k = keyOf(th);
    if (k != null && widths[k] == null) {
      widths[k] = Math.round(th.getBoundingClientRect().width) || 80;
    }
  }

  // Switch to fixed layout and pin every column's width. Non-keyed columns
  // (checkbox / remove) keep their measured width but get no handle.
  table.style.tableLayout = "fixed";
  let total = 0;
  for (const th of ths) {
    const k = keyOf(th);
    const w = (k != null && widths[k] != null)
      ? widths[k]
      : Math.round(th.getBoundingClientRect().width) || 28;
    th.style.width = w + "px";
    total += w;
  }
  table.style.width = total + "px";

  // A grab handle on each resizable column's right edge.
  for (const th of ths) {
    const k = keyOf(th);
    if (k == null) continue;
    const handle = document.createElement("span");
    handle.className = "col-resize-handle";
    th.appendChild(handle);
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();                 // don't trigger the header's sort click
      const startX = e.clientX;
      const startW = widths[k];
      let totalAtStart = 0;
      for (const x of ths) totalAtStart += x.getBoundingClientRect().width;
      try { handle.setPointerCapture(e.pointerId); } catch { /* ok */ }

      const move = (ev) => {
        const w = Math.max(40, Math.round(startW + (ev.clientX - startX)));
        widths[k] = w;
        th.style.width = w + "px";
        table.style.width = (totalAtStart - startW + w) + "px";
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        try { handle.releasePointerCapture(e.pointerId); } catch { /* ok */ }
        if (onResize) onResize({ ...widths });
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    // A click on the handle must not sort the column.
    handle.addEventListener("click", (e) => e.stopPropagation());
  }
}
