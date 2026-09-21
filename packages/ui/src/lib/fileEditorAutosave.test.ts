import { describe, expect, test } from 'bun:test';

import { shouldAllowFileDraftSave, shouldScheduleFileAutosave } from './fileEditorAutosave';

describe('shouldScheduleFileAutosave', () => {
  const ready = {
    autoSaveEnabled: true,
    isDirty: true,
    canWrite: true,
    isSaving: false,
    fileLoading: false,
    selectedFilePath: '/repo/a.txt',
    loadedFilePath: '/repo/a.txt',
    isNonEditableBinary: false,
  };

  test('schedules when dirty text file is fully loaded', () => {
    expect(shouldScheduleFileAutosave(ready)).toBe(true);
  });

  test('skips while loading or when loaded path mismatches selection', () => {
    expect(shouldScheduleFileAutosave({ ...ready, fileLoading: true })).toBe(false);
    expect(shouldScheduleFileAutosave({ ...ready, loadedFilePath: null })).toBe(false);
    expect(shouldScheduleFileAutosave({ ...ready, loadedFilePath: '/repo/other.txt' })).toBe(false);
  });

  test('skips when autosave disabled or file is binary', () => {
    expect(shouldScheduleFileAutosave({ ...ready, autoSaveEnabled: false })).toBe(false);
    expect(shouldScheduleFileAutosave({ ...ready, isNonEditableBinary: true })).toBe(false);
  });

  test('skips when not dirty, cannot write, or already saving', () => {
    expect(shouldScheduleFileAutosave({ ...ready, isDirty: false })).toBe(false);
    expect(shouldScheduleFileAutosave({ ...ready, canWrite: false })).toBe(false);
    expect(shouldScheduleFileAutosave({ ...ready, isSaving: true })).toBe(false);
  });
});

describe('shouldAllowFileDraftSave', () => {
  const ready = {
    selectedFilePath: '/repo/a.txt',
    loadedFilePath: '/repo/a.txt',
    fileLoading: false,
    isDirty: true,
    draftContent: 'edited',
    fileContent: 'original',
    isNonEditableBinary: false,
  };

  test('allows save for loaded dirty text', () => {
    expect(shouldAllowFileDraftSave(ready)).toBe(true);
  });

  test('refuses incomplete load or binary; clean draft is a successful no-op', () => {
    expect(shouldAllowFileDraftSave({ ...ready, fileLoading: true })).toBe(false);
    expect(shouldAllowFileDraftSave({ ...ready, loadedFilePath: null })).toBe(false);
    expect(shouldAllowFileDraftSave({ ...ready, isNonEditableBinary: true })).toBe(false);
    expect(shouldAllowFileDraftSave({ ...ready, isDirty: false })).toBe(true);
  });
});
