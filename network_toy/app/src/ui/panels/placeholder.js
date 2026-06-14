// Placeholder panel — used for slots whose real panel module
// hasn't been built yet. Renders a centred message with a hint
// about which slice of the build will fill it in.
//
// Conforms to the panel contract: { mount(container, state) }
// returning { update(state), destroy() }.

export const ID = "placeholder";

export function mount(container, state, config = {}) {
  const label = config.label || "Panel";
  const hint  = config.hint  || "Not yet implemented.";

  container.innerHTML = "";
  const root = document.createElement("div");
  root.className = "placeholder-panel";
  root.innerHTML = `
    <div class="placeholder-title">${escapeHtml(label)}</div>
    <div class="placeholder-hint">${escapeHtml(hint)}</div>
  `;
  container.appendChild(root);

  return {
    update(_state) { /* nothing to update */ },
    destroy() { container.innerHTML = ""; },
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
