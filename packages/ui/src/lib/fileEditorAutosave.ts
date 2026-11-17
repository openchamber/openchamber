export type FileEditorAutosaveGate = {
  autoSaveEnabled: boolean;
  isDirty: boolean;
  canWrite: boolean;
  isSaving: boolean;
  fileLoading: boolean;
  selectedFilePath: string | null | undefined;
  loadedFilePath: string | null;
  isNonEditableBinary: boolean;
  wouldEmptyFile: boolean;
};

export function shouldScheduleFileAutosave(gate: FileEditorAutosaveGate): boolean {
  if (!gate.autoSaveEnabled || !gate.isDirty || !gate.canWrite || gate.isSaving) {
    return false;
  }
  if (gate.fileLoading || gate.isNonEditableBinary || gate.wouldEmptyFile) {
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
