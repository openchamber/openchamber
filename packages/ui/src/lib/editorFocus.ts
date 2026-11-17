export const isVimEditorEventTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  const editor = target.closest('.cm-editor');
  return Boolean(editor?.isConnected && editor.querySelector('.cm-vim-panel'));
};

const EDITOR_OVERLAY_ATTRIBUTE = 'data-editor-overlay';

export const isEditorEventTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(`.cm-editor, [${EDITOR_OVERLAY_ATTRIBUTE}]`));
};
