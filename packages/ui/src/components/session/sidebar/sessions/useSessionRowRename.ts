import React from 'react';

type SessionRowRenameInput = {
  isEditing: boolean;
  sessionRowKey: string;
  editTitle: string;
  handleSaveEdit: (titleOverride?: string) => void;
};

export function useSessionRowRename({ isEditing, sessionRowKey, editTitle, handleSaveEdit }: SessionRowRenameInput) {
  const handleSaveEditRef = React.useRef(handleSaveEdit);
  handleSaveEditRef.current = handleSaveEdit;
  const renameDraft = editTitle;
  const renameDraftRef = React.useRef(renameDraft);
  renameDraftRef.current = renameDraft;
  const renameTargetRef = React.useRef<string | null>(null);
  const pendingRenameSelectRef = React.useRef(false);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  React.useEffect(() => {
    if (!isEditing) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      // SAFETY: DOM mousedown targets are Nodes; closest is used only when the target is an Element.
      const target = e.target instanceof HTMLElement ? e.target : null;
      const withinRenameForm = target?.closest?.(`[data-session-rename-form="${CSS.escape(sessionRowKey)}"]`);
      if (formRef.current && !withinRenameForm) {
        handleSaveEditRef.current(renameDraftRef.current);
      }
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [isEditing, sessionRowKey]);

  React.useLayoutEffect(() => {
    if (!isEditing) {
      if (renameTargetRef.current === sessionRowKey) {
        renameTargetRef.current = null;
      }
      return;
    }
    if (renameTargetRef.current === sessionRowKey) return;
    renameTargetRef.current = sessionRowKey;
    pendingRenameSelectRef.current = true;
  }, [editTitle, isEditing, sessionRowKey]);

  React.useLayoutEffect(() => {
    if (!isEditing || !pendingRenameSelectRef.current) return;
    const input = renameInputRef.current;
    if (!input || input.value !== editTitle) return;
    pendingRenameSelectRef.current = false;
    input.focus();
    input.select();
  }, [editTitle, isEditing, renameDraft]);

  return { formRef, renameInputRef };
}
