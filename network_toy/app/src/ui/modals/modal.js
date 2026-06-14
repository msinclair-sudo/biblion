// Generic modal infrastructure.
//
// Usage:
//   const m = openModal({
//     title:   "Add panel",
//     body:    domNodeOrFunction,
//     actions: [{ label: "Cancel", onClick: () => true }],
//     onClose: () => { ... },
//   });
//   m.close();
//
// Behaviours:
//   - Mounts into #modal-root
//   - Backdrop click closes
//   - Escape key closes
//   - Action onClick may return `true` to close, `false` to keep open;
//     undefined === true (close) for ergonomics
//
// Pattern is intentionally minimal — no z-index stacking magic, no
// focus trap. Build those in if/when modals nest or accessibility
// audits demand them.

let modalCounter = 0;

export function openModal({ title = "", body = null, actions = [], onClose = null } = {}) {
  const root = document.getElementById("modal-root");
  if (!root) throw new Error("modal-root element missing from index.html");

  const id = ++modalCounter;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.dataset.modalId = String(id);

  const dialog = document.createElement("div");
  dialog.className = "modal-dialog";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  // Header
  const header = document.createElement("div");
  header.className = "modal-header";
  const titleEl = document.createElement("div");
  titleEl.className = "modal-title";
  titleEl.textContent = title;
  header.appendChild(titleEl);
  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => close());
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  // Body
  const bodyEl = document.createElement("div");
  bodyEl.className = "modal-body";
  if (body instanceof Node) {
    bodyEl.appendChild(body);
  } else if (typeof body === "function") {
    body(bodyEl);
  } else if (typeof body === "string") {
    bodyEl.textContent = body;
  }
  dialog.appendChild(bodyEl);

  // Footer (actions)
  if (actions && actions.length > 0) {
    const footer = document.createElement("div");
    footer.className = "modal-footer";
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.className = "modal-action" + (a.primary ? " primary" : "");
      btn.textContent = a.label;
      if (a.disabled) btn.disabled = true;
      btn.addEventListener("click", () => {
        const result = a.onClick ? a.onClick() : undefined;
        if (result !== false) close();
      });
      footer.appendChild(btn);
    }
    dialog.appendChild(footer);
  }

  // Backdrop click closes
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  // ESC closes (top modal only)
  function escHandler(e) {
    if (e.key !== "Escape") return;
    const all = root.querySelectorAll(".modal-backdrop");
    if (all.length === 0) return;
    if (all[all.length - 1] === backdrop) close();
  }
  document.addEventListener("keydown", escHandler);

  root.appendChild(backdrop);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", escHandler);
    backdrop.remove();
    if (onClose) {
      try { onClose(); } catch (e) { console.error(e); }
    }
  }

  return { close, dialog, body: bodyEl };
}

export function closeAllModals() {
  const root = document.getElementById("modal-root");
  if (!root) return;
  // Cloning to avoid mutate-while-iterate; modal `close()` removes the element.
  const all = [...root.querySelectorAll(".modal-backdrop")];
  for (const m of all) m.remove();
}
