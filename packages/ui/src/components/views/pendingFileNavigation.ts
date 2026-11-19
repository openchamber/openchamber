type PendingFileNavigationInput = {
  selectedPath: string | null;
  targetPath: string;
  targetShown: boolean;
  targetSettled: boolean;
  showsText: boolean;
  canEdit: boolean;
  textViewMode: 'edit' | 'view';
};

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
