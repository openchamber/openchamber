import React from 'react';

type SessionRowRenameInput = {
  isEditing: boolean;
  sessionRowKey: string;
  editTitle: string;
  handleSaveEdit: (titleOverride?: string) => void;
};

/** The rename form's focus, selection and outside-click-to-save, for the row that is being renamed. */
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

  // Capture outside-clicks to save edits — immune to focus-race with onBlur.
  React.useEffect(() => {
    if (!isEditing) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      // Rename ownership is occurrence-keyed, so only this row's form keeps
      // the edit open when duplicate session rows exist elsewhere.
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

  // Entering rename mode selects the whole title, so the first keystroke
  // replaces it instead of appending to it. The selection waits for the commit
  // that actually renders `editTitle`: the draft state above is seeded when the
  // row mounts, so on a session whose title changed since then the input still
  // holds the old text during the commit that opens the form.
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
