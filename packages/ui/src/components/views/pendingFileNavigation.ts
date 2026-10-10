type PendingFileNavigationInput = {
  selectedPath: string | null;
  targetPath: string;
  /** The target file has been the selected file since this jump was requested. */
  targetShown: boolean;
  /** The target file finished loading, or failed to. */
  targetSettled: boolean;
  /** The target shows as text: no read error, not an image, PDF or binary. */
  showsText: boolean;
  canEdit: boolean;
  textViewMode: 'edit' | 'view';
};

/**
 * What a pending line jump does next. It selects its file only until that
 * file has been on screen; a different selection after that is the user's own
 * tab switch, so the jump waits for its file to come back. A read-only file
 * jumps in its read-only editor; without an editor on screen the jump ends,
 * so the file is never hidden behind the waiting mask.
 */
export const pendingFileNavigationStep = ({
  selectedPath,
  targetPath,
  targetShown,
  targetSettled,
  showsText,
  canEdit,
  textViewMode,
}: PendingFileNavigationInput): 'select-target' | 'wait' | 'end' | 'show-editor' | 'jump' => {
  if (selectedPath !== targetPath) return targetShown ? 'wait' : 'select-target';
  if (!targetSettled) return 'wait';
  if (!showsText) return 'end';
  if (textViewMode === 'edit') return 'jump';
  return canEdit ? 'show-editor' : 'end';
};
