// Tags list — a single-column roster of every tag applied to papers in the
// active dataset, with a per-tag count, a colour swatch (matching the "tag"
// colour mode), and a remove control.
//
// Tags live in state.tags (keyed by paperId) and round-trip to the project's
// live DB; this panel only reads that slot and drives the highlight channel.
// Clicking a tag highlights its papers in the viewers (toggle); the × removes
// the tag from every paper (one batched write-through). Auto-opened by the
// Selected-papers panel when the first tag of a session is applied.

import { getState, removeTagEverywhere, addHighlight, clearHighlight } from "../state.js";
import { getNodeByPaperId } from "../../datasource/sqlite.js";
import { tagColourMap, tagsSignature } from "../viewer-shared/colour-modes.js";

export const ID = "tags-list";
export const LABEL = "Tags";
export const DESCRIPTION =
  "Every tag applied to papers in this dataset, with counts. Click a tag to highlight its papers; × removes the tag from all of them. Tags are saved to the biblion database and exported as BibTeX keywords.";
export const SINGLETON = true;   // one tags list per project

// { tag: count } from the paperId→tags map.
function tagCounts(tags) {
  const counts = new Map();
  for (const pid in tags) {
    for (const t of tags[pid]) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

export function mount(container, _state, _config = {}, _tabContext = null) {
  container.innerHTML = "";
  const root = document.createElement("div");
  root.className = "cart-root";              // reuse the cart panel's layout
  container.appendChild(root);

  const list = document.createElement("div");
  list.className = "tags-list";
  root.appendChild(list);

  const empty = document.createElement("div");
  empty.className = "cart-empty";
  empty.textContent =
    "No tags yet — add one from the Selected-papers panel (“Tag all” / “Tag tick-marked”).";
  root.appendChild(empty);

  let activeTag = null;       // tag currently driving the highlight channel
  let lastSig = null;

  function highlightTag(tag, tags) {
    if (activeTag === tag) {  // toggle off
      activeTag = null;
      clearHighlight("tags");
      return;
    }
    const colour = tagColourMap(getState()).get(tag);
    const nodeIds = [];
    for (const pid in tags) {
      if (!tags[pid].includes(tag)) continue;
      const nid = getNodeByPaperId(Number(pid));
      if (nid != null) nodeIds.push(nid);
    }
    activeTag = tag;
    addHighlight("tags", nodeIds, colour);
  }

  function render() {
    const tags = getState().tags || {};
    const counts = tagCounts(tags);
    const names = [...counts.keys()].sort();
    const palette = tagColourMap(getState());

    list.innerHTML = "";
    empty.style.display = names.length ? "none" : "block";
    list.style.display = names.length ? "block" : "none";

    for (const tag of names) {
      const row = document.createElement("div");
      row.className = "tags-row" + (tag === activeTag ? " tags-row-active" : "");

      const sw = document.createElement("span");
      sw.className = "tags-swatch";
      sw.style.background = palette.get(tag) || "#888";
      row.appendChild(sw);

      const label = document.createElement("span");
      label.className = "tags-name";
      label.textContent = tag;
      label.title = "Highlight papers tagged “" + tag + "”";
      label.addEventListener("click", () => { highlightTag(tag, getState().tags || {}); render(); });
      row.appendChild(label);

      const count = document.createElement("span");
      count.className = "tags-count";
      count.textContent = String(counts.get(tag));
      row.appendChild(count);

      const rm = document.createElement("button");
      rm.className = "cart-rm-btn";
      rm.textContent = "×";
      rm.title = "Remove this tag from all papers";
      rm.addEventListener("click", () => {
        if (tag === activeTag) { activeTag = null; clearHighlight("tags"); }
        removeTagEverywhere(tag, {
          onError: (e) => window.alert("Tag removal failed: " + (e.message || e)),
        });
      });
      row.appendChild(rm);

      list.appendChild(row);
    }
    lastSig = tagsSignature(getState());
  }

  render();

  return {
    update(s) {
      // Re-render only when the tag set actually changed (cheap fingerprint).
      if (tagsSignature(s) !== lastSig) render();
    },
    destroy() {
      if (activeTag) { clearHighlight("tags"); activeTag = null; }
      container.innerHTML = "";
    },
  };
}
