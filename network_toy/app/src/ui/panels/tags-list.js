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

  // Filter bar (above the scrolling list, so it stays put). Typing filters tag
  // names case-insensitively; a non-empty filter force-expands every group so
  // matches are never hidden behind a collapsed header.
  const filterBar = document.createElement("div");
  filterBar.className = "tags-filter-bar";
  const filterInput = document.createElement("input");
  filterInput.className = "cart-filter";        // reuse styling
  filterInput.type = "text";
  filterInput.placeholder = "filter tags…";
  filterBar.appendChild(filterInput);
  root.appendChild(filterBar);

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
  let filterText = "";        // current filter query
  let sortMode = "name-asc";  // "name|count" + "-asc|desc"; sorts tags within a group
  const collapsed = new Set(); // collapsed group keys (categories AND genera)
  const seen = new Set();      // group keys we've encountered (for default-collapse)

  // Groups start collapsed: the first time a group key appears, collapse it.
  // Afterwards it's in `seen`, so a user expand/collapse sticks across renders.
  function ensureDefaultCollapsed(key) {
    if (!seen.has(key)) { seen.add(key); collapsed.add(key); }
  }

  filterInput.addEventListener("input", () => {
    filterText = filterInput.value;
    render();
  });

  // Sort bar — two clickable column controls (Name / Count). Click toggles the
  // direction when already the active key, else switches key (count defaults to
  // descending — "most-used first" — names to ascending).
  const sortBar = document.createElement("div");
  sortBar.className = "tags-sort-bar";
  sortBar.appendChild(Object.assign(document.createElement("span"),
    { className: "tags-sort-label", textContent: "Sort:" }));
  function mkSortBtn(key) {
    const b = document.createElement("button");
    b.className = "tags-sort-btn";
    b.addEventListener("click", () => {
      const [curKey, curDir] = sortMode.split("-");
      sortMode = curKey === key
        ? `${key}-${curDir === "asc" ? "desc" : "asc"}`
        : `${key}-${key === "count" ? "desc" : "asc"}`;
      render();
    });
    return b;
  }
  const nameBtn = mkSortBtn("name");
  const countBtn = mkSortBtn("count");
  sortBar.append(nameBtn, countBtn);
  root.insertBefore(sortBar, list);

  function paintSort() {
    const [key, dir] = sortMode.split("-");
    const arrow = dir === "asc" ? "▲" : "▼";
    nameBtn.textContent = "Name" + (key === "name" ? " " + arrow : "");
    countBtn.textContent = "Count" + (key === "count" ? " " + arrow : "");
    nameBtn.classList.toggle("active", key === "name");
    countBtn.classList.toggle("active", key === "count");
  }

  // First whitespace-delimited token of a binomial → genus ("Spodoptera
  // frugiperda" → "Spodoptera"; a genus-only tag stays itself).
  function genusOf(tag) {
    const t = tag.trim();
    const i = t.search(/\s/);
    return i === -1 ? t : t.slice(0, i);
  }

  function sortTags(arr, counts) {
    const [key, dir] = sortMode.split("-");
    const mul = dir === "asc" ? 1 : -1;
    return [...arr].sort((a, b) => {
      if (key === "count") {
        const d = counts.get(a) - counts.get(b);
        if (d) return d * mul;
        return a.toLowerCase().localeCompare(b.toLowerCase());   // tiebreak by name
      }
      return a.toLowerCase().localeCompare(b.toLowerCase()) * mul;
    });
  }

  function groupSum(tags, counts) {
    let s = 0;
    for (const t of tags) s += counts.get(t) || 0;
    return s;
  }

  // Sort [label, tags[]] group entries by the active sortMode, so the
  // collapsible group headers reorder the same way the tags inside them do.
  // Count keys off the aggregate occurrence sum; `pinLast` (e.g. "") is forced
  // to the bottom regardless of direction.
  function sortGroups(entries, counts, pinLast) {
    const [key, dir] = sortMode.split("-");
    const mul = dir === "asc" ? 1 : -1;
    return [...entries].sort(([la, ta], [lb, tb]) => {
      if (pinLast !== undefined) {
        if (la === pinLast) return 1;
        if (lb === pinLast) return -1;
      }
      if (key === "count") {
        const d = groupSum(ta, counts) - groupSum(tb, counts);
        if (d) return d * mul;
        return la.toLowerCase().localeCompare(lb.toLowerCase());   // tiebreak by name
      }
      return la.toLowerCase().localeCompare(lb.toLowerCase()) * mul;
    });
  }

  function toggle(key) {
    if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
    render();
  }

  // A collapsible group header. level 0 = category (sticky, uppercase),
  // level 1 = genus sub-group (indented, italic, not sticky).
  function groupHeader({ label, count, isCollapsed, level, italic, onToggle }) {
    const header = document.createElement("div");
    header.className =
      (level === 0 ? "tags-group-header" : "tags-subgroup-header") + " tags-group-toggle";
    const chev = document.createElement("span");
    chev.className = "tags-group-chevron";
    chev.textContent = isCollapsed ? "▸" : "▾";
    header.appendChild(chev);
    const lbl = document.createElement("span");
    if (italic) lbl.className = "tags-genus-name";
    lbl.textContent = `${label} (${count})`;
    header.appendChild(lbl);
    header.title = isCollapsed ? "Expand" : "Collapse";
    header.addEventListener("click", onToggle);
    return header;
  }

  // Re-render fingerprint: the tag set OR the label->category assignments. The
  // latter changes when a tag is re-homed without the tag set itself changing.
  function sig(s) {
    return tagsSignature(s) + "|" + JSON.stringify(s.tagCategories || {});
  }

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

  function tagRow(tag, count, palette, indent = 0) {
    const row = document.createElement("div");
    row.className = "tags-row" + (indent ? " tags-row-indent" : "")
      + (tag === activeTag ? " tags-row-active" : "");

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

    const cnt = document.createElement("span");
    cnt.className = "tags-count";
    cnt.textContent = String(count);
    row.appendChild(cnt);

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
    return row;
  }

  function render() {
    const s = getState();
    const tags = s.tags || {};
    const cats = s.tagCategories || {};
    const counts = tagCounts(tags);
    const palette = tagColourMap(s);
    const q = filterText.trim().toLowerCase();

    const allNames = [...counts.keys()];
    const names = q ? allNames.filter(t => t.toLowerCase().includes(q)) : allNames;
    const hasAny = allNames.length > 0;

    list.innerHTML = "";
    filterBar.style.display = hasAny ? "" : "none";
    sortBar.style.display = hasAny ? "" : "none";
    empty.style.display = hasAny ? "none" : "block";
    list.style.display = hasAny ? "block" : "none";
    paintSort();

    // Group by category, ordered by the active sort (Count = aggregate
    // occurrence sum, Name = label), with uncategorised ("") pinned last. A
    // category header only shows when it has tags, so an empty dataset stays
    // clean.
    const byCat = new Map();
    for (const tag of names) {
      const c = cats[tag] || "";
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(tag);
    }

    // A non-empty filter force-expands every group so matches are never hidden.
    for (const [cat, group] of sortGroups([...byCat.entries()], counts, "")) {
      const cKey = "cat " + cat;
      ensureDefaultCollapsed(cKey);
      const cCollapsed = !q && collapsed.has(cKey);
      list.appendChild(groupHeader({
        label: cat || "Uncategorised", count: group.length,
        isCollapsed: cCollapsed, level: 0,
        onToggle: () => toggle(cKey),
      }));
      if (cCollapsed) continue;

      if (cat === "species") {
        // Species get a second level: collapsible genus sub-groups.
        const byGenus = new Map();
        for (const tag of group) {
          const g = genusOf(tag);
          if (!byGenus.has(g)) byGenus.set(g, []);
          byGenus.get(g).push(tag);
        }
        const genera = sortGroups([...byGenus.entries()], counts);
        for (const [g, gtagsRaw] of genera) {
          const gtags = sortTags(gtagsRaw, counts);
          const gKey = "gen " + g;
          ensureDefaultCollapsed(gKey);
          const gCollapsed = !q && collapsed.has(gKey);
          list.appendChild(groupHeader({
            label: g, count: gtags.length, isCollapsed: gCollapsed,
            level: 1, italic: true, onToggle: () => toggle(gKey),
          }));
          if (!gCollapsed) {
            for (const tag of gtags) list.appendChild(tagRow(tag, counts.get(tag), palette, 1));
          }
        }
      } else {
        for (const tag of sortTags(group, counts)) {
          list.appendChild(tagRow(tag, counts.get(tag), palette));
        }
      }
    }

    if (q && names.length === 0) {
      const none = document.createElement("div");
      none.className = "cart-empty";
      none.textContent = `No tags match “${filterText.trim()}”.`;
      list.appendChild(none);
    }
    lastSig = sig(s);
  }

  render();

  return {
    update(s) {
      // Re-render only when the tag set or categories actually changed.
      if (sig(s) !== lastSig) render();
    },
    destroy() {
      if (activeTag) { clearHighlight("tags"); activeTag = null; }
      container.innerHTML = "";
    },
  };
}
