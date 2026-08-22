const OPEN_DROPDOWN_SELECTOR = [
  '[data-slot="dropdown-menu-content"][data-open]',
  '[data-slot="select-content"][data-open]',
].join(',');

export function hasOpenDropdown(root: ParentNode = document): boolean {
  return Boolean(root.querySelector(OPEN_DROPDOWN_SELECTOR));
}

// Editable surfaces (the chat composer is a contenteditable CodeMirror view;
// CommitInput, searches and dialogs use textareas/inputs). Global shortcuts
// must not hijack keystrokes while the user is typing in one of these —
// mod+digit in particular is the browser's own tab-switching chord.
const EDITABLE_TARGET_SELECTOR = 'input, textarea, [contenteditable="true"]';

export function isTypingInEditableTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== 'function') {
    return false;
  }
  return Boolean(element.closest(EDITABLE_TARGET_SELECTOR));
}
