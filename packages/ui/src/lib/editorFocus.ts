/**
 * Whether a key event comes from a CodeMirror editor running the Vim keymap.
 *
 * The Vim extension mounts its status bar (`.cm-vim-panel`) inside the
 * editor, so the marker reflects the editor's live configuration rather than
 * a settings value that may not apply to this particular editor. Escape is
 * how Vim leaves INSERT mode; capture-phase shortcut handlers must let it
 * reach the editor instead of closing the panel or arming an abort.
 */
export const isVimEditorEventTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  const editor = target.closest('.cm-editor');
  return Boolean(editor?.isConnected && editor.querySelector('.cm-vim-panel'));
};

// `data-editor-overlay` marks UI the editor opens over itself (symbol list,
// go to line); it owns Escape too.
const EDITOR_OVERLAY_ATTRIBUTE = 'data-editor-overlay';

/**
 * Whether a key event comes from a CodeMirror editor or from an overlay the
 * editor opened. Escape belongs to them there (closing the search panel,
 * collapsing several cursors to one, closing the overlay), so panel-level
 * Escape handlers must not act on it.
 */
export const isEditorEventTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(`.cm-editor, [${EDITOR_OVERLAY_ATTRIBUTE}]`));
};
