// Read-a-paper modal — shows one selected paper's abstract at a time, with
// Prev/Next navigation across the list the caller hands in (the Selected-papers
// panel passes its currently-shown rows so nav walks exactly the visible set).
//
// The row objects carry title/year/venue/authors (joinPaperRow), but NOT the
// abstract — that comes from the live snapshot DB, fetched lazily by nodeId.
// Nav lives inside the body, not the footer: openModal builds footer actions
// once and never re-evaluates their `disabled`, so we'd lose control of the
// Prev/Next enabled state there.

import { openModal } from "./modal.js";
import { getNodeRecord } from "../../datasource/sqlite.js";

export function openAbstractModal(rows, startIndex = 0) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return null;
  let idx = Math.max(0, Math.min(startIndex, list.length - 1));

  const body = document.createElement("div");
  body.className = "abstract-modal-body";

  const titleEl = document.createElement("div");
  titleEl.className = "abstract-modal-title";
  const metaEl = document.createElement("div");
  metaEl.className = "abstract-modal-meta";
  const textEl = document.createElement("div");
  textEl.className = "abstract-modal-text";

  const nav = document.createElement("div");
  nav.className = "abstract-modal-nav";
  const prevBtn = mkNavBtn("‹ Prev");
  const counter = document.createElement("span");
  counter.className = "abstract-modal-counter";
  const nextBtn = mkNavBtn("Next ›");
  nav.append(prevBtn, counter, nextBtn);

  body.append(nav, titleEl, metaEl, textEl);

  function render() {
    const row = list[idx];
    const rec = getNodeRecord(row.nodeId) || {};
    titleEl.textContent = row.title || rec.title || "Untitled";

    const meta = [];
    if (row.authors) meta.push(row.authors);
    if (row.year != null) meta.push(String(row.year));
    if (row.venue) meta.push(row.venue);
    metaEl.textContent = meta.join(" · ");
    metaEl.style.display = meta.length ? "" : "none";

    const abstract = rec.abstract;
    textEl.textContent = abstract && abstract.trim()
      ? abstract
      : "No abstract available for this paper.";
    textEl.classList.toggle("empty", !(abstract && abstract.trim()));

    counter.textContent = `${idx + 1} of ${list.length}`;
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === list.length - 1;
  }

  prevBtn.addEventListener("click", () => { if (idx > 0) { idx--; render(); } });
  nextBtn.addEventListener("click", () => {
    if (idx < list.length - 1) { idx++; render(); }
  });

  render();

  return openModal({
    title: "Abstract",
    body,
    actions: [{ label: "Close" }],
  });
}

function mkNavBtn(text) {
  const b = document.createElement("button");
  b.className = "cart-btn";
  b.textContent = text;
  return b;
}
