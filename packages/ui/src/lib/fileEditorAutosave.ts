export type FileEditorAutosaveGate = {
  autoSaveEnabled: boolean;
  isDirty: boolean;
  canWrite: boolean;
  isSaving: boolean;
  fileLoading: boolean;
  selectedFilePath: string | null | undefined;
  loadedFilePath: string | null;
  /** True when the selected file must never be written as text (binary / non-editable). */
  isNonEditableBinary: boolean;
};

/**
 * Whether the FilesView autosave effect should schedule a debounced save.
 * Incomplete loads and binary files must never trigger a write.
 */
export function shouldScheduleFileAutosave(gate: FileEditorAutosaveGate): boolean {
  if (!gate.autoSaveEnabled || !gate.isDirty || !gate.canWrite || gate.isSaving) {
    return false;
  }
  if (gate.fileLoading || gate.isNonEditableBinary) {
    return false;
  }
  if (!gate.selectedFilePath || gate.loadedFilePath !== gate.selectedFilePath) {
    return false;
  }
  return true;
}

export type FileEditorSaveDraftGate = {
  selectedFilePath: string | null | undefined;
  loadedFilePath: string | null;
  fileLoading: boolean;
  isDirty: boolean;
  draftContent: string;
  fileContent: string;
  isNonEditableBinary: boolean;
};

/**
 * Whether saveDraft may proceed.
 * - Clean drafts return true ("nothing to save" is success) so callers like the
 *   unsaved-changes dialog and Ctrl+S do not treat a no-op as failure.
 * - Incomplete loads and binary targets return false (refused).
 */
export function shouldAllowFileDraftSave(gate: FileEditorSaveDraftGate): boolean {
  if (!gate.selectedFilePath) {
    return false;
  }
  if (!gate.isDirty) {
    return true;
  }
  if (gate.fileLoading || gate.loadedFilePath !== gate.selectedFilePath || gate.isNonEditableBinary) {
    return false;
  }
  if (gate.draftContent === '' && gate.fileContent !== '' && gate.loadedFilePath !== gate.selectedFilePath) {
    return false;
  }
  return true;
}
