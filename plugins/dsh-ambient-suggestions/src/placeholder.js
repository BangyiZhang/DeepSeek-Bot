const owners = new WeakMap();

/** Resolve only the composer's subtree containing this session's dock anchor. */
function composerRoot(anchor) {
  for (let node = anchor?.parentElement; node && node !== node.ownerDocument.body; node = node.parentElement) {
    if (node.querySelector('[data-composer-card]')) return node;
  }
  return null;
}

/** Show real preview text with per-session ownership and synchronous disposal. */
export function bindPredictivePlaceholder({ root = document, anchor, sessionId, prediction, inputActions }) {
  let placeholder;
  let editor;
  let originalText;
  let stopped = false;
  const token = {};
  const label = `✨ ${prediction} (Tab)`;
  const scope = anchor ? composerRoot(anchor) : root;
  if (!scope) return () => {};

  function clear() {
    editor?.removeEventListener("keydown", onKeyDown, true);
    editor?.removeEventListener("input", onInput, true);
    if (placeholder && owners.get(placeholder)?.token === token) {
      if (placeholder.textContent === label) placeholder.textContent = originalText;
      placeholder.removeAttribute("data-ambient-preview");
      placeholder.removeAttribute("data-ambient-session");
      placeholder.removeAttribute("data-predicted-text");
      placeholder.closest('[data-composer-card]')?.removeAttribute("data-has-prediction");
      owners.delete(placeholder);
    }
    placeholder = undefined;
    editor = undefined;
  }
  function dispose() {
    stopped = true;
    observer.disconnect();
    clear();
  }
  function onInput() {
    if ((editor?.innerText || editor?.textContent || "").length) dispose();
  }
  function onKeyDown(event) {
    if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || stopped) return;
    if (owners.get(placeholder)?.token !== token || (editor.innerText || editor.textContent || "").trim()) return;
    if (typeof inputActions?.insertText !== "function") return;
    event.preventDefault();
    event.stopPropagation();
    const insertion = inputActions.captureInsertion();
    dispose();
    inputActions.insertText(prediction, insertion);
  }
  function reconcile() {
    if (stopped || (anchor && (!anchor.isConnected || anchor.getAttribute("data-ambient-anchor") !== sessionId))) {
      dispose();
      return;
    }
    const candidates = [...scope.querySelectorAll('[data-composer-placeholder="true"]')];
    const visible = candidates.filter((node) => node.getClientRects().length > 0);
    const nextPlaceholder = visible.length === 1 ? visible[0] : candidates.length === 1 ? candidates[0] : null;
    const nextEditor = nextPlaceholder?.parentElement?.querySelector('[role="textbox"][contenteditable="true"], [contenteditable="true"]');
    if (nextPlaceholder === placeholder && nextEditor === editor) return;
    clear();
    if (!nextPlaceholder) return;
    // A new session cancels the old observer before acquiring the shared DOM node.
    owners.get(nextPlaceholder)?.dispose();
    nextPlaceholder.removeAttribute("data-predicted-text");
    nextPlaceholder.closest('[data-composer-card]')?.removeAttribute("data-has-prediction");
    if (!prediction || !nextEditor || (nextEditor.innerText || nextEditor.textContent || "").length) return;
    placeholder = nextPlaceholder;
    editor = nextEditor;
    originalText = placeholder.textContent;
    owners.set(placeholder, { token, dispose });
    placeholder.textContent = label;
    placeholder.setAttribute("data-ambient-preview", "true");
    placeholder.setAttribute("data-ambient-session", sessionId ?? "");
    editor.addEventListener("keydown", onKeyDown, true);
    editor.addEventListener("input", onInput, true);
  }
  const observer = new MutationObserver(reconcile);
  observer.observe(scope.documentElement ?? scope, { childList: true, characterData: true, subtree: true });
  reconcile();
  return dispose;
}
