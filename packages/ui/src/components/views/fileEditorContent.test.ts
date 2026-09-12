import { expect, test } from 'bun:test';
import { shouldAllowFileDraftSave, shouldScheduleFileAutosave } from '@/lib/fileEditorAutosave';
import { LARGE_FILE_CHAR_THRESHOLD, initialFileTextMode, makeFileContentCacheKey, prepareFileEditorContent, serializeEditorContent } from './fileEditorContent';

test('large text starts in preview but an explicit edit choice remains available', () => {
  const boundary = 'x'.repeat(LARGE_FILE_CHAR_THRESHOLD);
  expect(initialFileTextMode(boundary)).toBe('edit');
  expect(initialFileTextMode(`${boundary}x`)).toBe('view');
  expect(initialFileTextMode(`${boundary}x`, 'edit')).toBe('edit');
  expect(initialFileTextMode('small', 'view')).toBe('view');
});

test('large drafts preserve the tail and line endings through editing and saving', () => {
  const raw = `header\r\n${'Рядок українською\r\n'.repeat(20_000)}TAIL\r\n`;
  const prepared = prepareFileEditorContent(raw);
  expect(prepared.content.length).toBeGreaterThan(LARGE_FILE_CHAR_THRESHOLD);
  expect(prepared.content.endsWith('TAIL\n')).toBe(true);
  expect(serializeEditorContent(prepared.content, prepared.lineEnding)).toBe(raw);
  const draft = prepared.content.replace('TAIL\n', 'EDITED TAIL\n');
  const gate = {
    selectedFilePath: '/repo/large.ts', loadedFilePath: '/repo/large.ts', fileLoading: false,
    isDirty: draft !== prepared.content, draftContent: draft, fileContent: prepared.content, isNonEditableBinary: false,
  };
  expect(shouldAllowFileDraftSave(gate)).toBe(true);
  expect(serializeEditorContent(draft, prepared.lineEnding)).toBe(raw.replace('TAIL\r\n', 'EDITED TAIL\r\n'));
  expect(shouldScheduleFileAutosave({ ...gate, autoSaveEnabled: true, canWrite: true, isSaving: false, isDirty: false })).toBe(false);
  expect(shouldAllowFileDraftSave({ ...gate, loadedFilePath: '/repo/another.ts' })).toBe(false);
  expect(shouldAllowFileDraftSave({ ...gate, isNonEditableBinary: true })).toBe(false);
});

test('preview cache invalidates on a same-length edit away from the first and last lines', () => {
  const prefix = 'x'.repeat(LARGE_FILE_CHAR_THRESHOLD);
  const suffix = 'z'.repeat(1000);
  const original = `${prefix}first${suffix}`;
  const edited = `${prefix}other${suffix}`;
  expect(original.length).toBe(edited.length);
  expect(makeFileContentCacheKey(original) === makeFileContentCacheKey(edited)).toBe(false);
  expect(makeFileContentCacheKey(original)).toBe(makeFileContentCacheKey(original));
});
