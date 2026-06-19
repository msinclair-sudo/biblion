// Edit-tags modal — change ONE paper's tags from the Selected-papers panel.
// Opened from a pinned row's "tags" button. Lists the paper's current tags as
// removable chips and offers an add row (label + category picker), writing
// through the same optimistic mutators the bulk toolbar uses (addTag/removeTag).
//
// The category picker is seeded from the panel toolbar's current category and
// auto-snaps to a label's existing category, so the controlled vocabulary stays
// consistent (mirrors selected-papers.js's toolbar logic).

import { openModal } from "./modal.js";
import { getState, addTag, removeTag } from "../state.js";

const ON_ERROR = (e) => window.alert(
  "Tag write failed (the dataset may be snapshot-only, or the DB is busy): "
  + (e.message || e));

export function openTagsModal(row, { defaultCategory = "", onChange } = {}) {
  if (!row || row.paperId == null) return null;
  const paperId = row.paperId;
  const refresh = () => { renderChips(); if (onChange) onChange(); };

  const body = document.createElement("div");
  body.className = "tags-modal-body";

  // ── current tags (chips) ─────────────────────────────────────────
  const chips = document.createElement("div");
  chips.className = "tags-modal-chips";
  body.appendChild(chips);

  function renderChips() {
    chips.innerHTML = "";
    const cur = (getState().tags || {})[paperId] || [];
    if (cur.length === 0) {
      const empty = document.createElement("span");
      empty.className = "tags-modal-empty";
      empty.textContent = "no tags yet";
      chips.appendChild(empty);
      return;
    }
    for (const tag of cur) {
      const chip = document.createElement("span");
      chip.className = "tags-modal-chip";
      chip.appendChild(document.createTextNode(tag));
      const rm = document.createElement("button");
      rm.className = "tags-modal-chip-rm";
      rm.setAttribute("aria-label", `Remove ${tag}`);
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        removeTag(paperId, tag, { onError: ON_ERROR });
        refresh();
      });
      chip.appendChild(rm);
      chips.appendChild(chip);
    }
  }

  // ── add row ──────────────────────────────────────────────────────
  const add = document.createElement("div");
  add.className = "tags-modal-add";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "add tag…";

  const cat = document.createElement("select");
  const vocab = getState().tagVocabulary || [];
  for (const [val, label] of [["", "(uncategorised)"], ...vocab.map(c => [c, c])]) {
    const o = document.createElement("option");
    o.value = val; o.textContent = label;
    cat.appendChild(o);
  }
  cat.value = defaultCategory || "";

  // Typing a label that already has a category snaps the picker to it.
  input.addEventListener("input", () => {
    const known = (getState().tagCategories || {})[input.value.trim()];
    if (known != null) cat.value = known;
  });

  function commit() {
    const tag = input.value.trim();
    if (!tag) return;
    addTag([paperId], tag, { category: cat.value, onError: ON_ERROR });
    input.value = "";
    input.focus();
    refresh();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  });

  const addBtn = document.createElement("button");
  addBtn.className = "cart-btn";
  addBtn.textContent = "Add";
  addBtn.addEventListener("click", commit);

  add.append(input, cat, addBtn);
  body.appendChild(add);

  renderChips();

  const title = row.title
    ? `Edit tags — ${row.title.length > 60 ? row.title.slice(0, 57) + "…" : row.title}`
    : "Edit tags";
  return openModal({ title, body, actions: [{ label: "Close" }] });
}
