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
