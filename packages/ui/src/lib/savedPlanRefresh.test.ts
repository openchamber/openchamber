import { expect, test } from 'bun:test';
import { applySavedPlanRefresh, type SavedPlanBuffer } from './savedPlanRefresh';

const clean = (): SavedPlanBuffer => ({ content: '# Original', confirmedRaw: '# Original', editRevision: 0, savedRevision: 0, deleted: false });

test('a clean saved plan adopts peer markdown with the same title', () => {
  const buffer = clean();
  expect(applySavedPlanRefresh(buffer, '# Original\nPeer body')).toBe('updated');
  expect(buffer.content).toBe('# Original\nPeer body');
  expect(buffer.confirmedRaw).toBe(buffer.content);
});

test('a dirty draft keeps its text and its read-then-write precondition', () => {
  const buffer = { ...clean(), content: '# Draft', editRevision: 1 };
  expect(applySavedPlanRefresh(buffer, '# Peer')).toBe('dirty');
  expect(buffer.content).toBe('# Draft');
  expect(buffer.confirmedRaw).toBe('# Original');
});

test('deletion stops writes and preserves a dirty draft', () => {
  const buffer = { ...clean(), content: '# Draft', editRevision: 1 };
  expect(applySavedPlanRefresh(buffer, null)).toBe('deleted');
  expect(buffer.deleted).toBe(true);
  expect(buffer.content).toBe('# Draft');
  expect(applySavedPlanRefresh(buffer, '# Stale response')).toBe('dirty');
  expect(buffer.content).toBe('# Draft');
});

test('a completed local save permits later peer refreshes', () => {
  const buffer = { ...clean(), editRevision: 2, savedRevision: 2 };
  expect(applySavedPlanRefresh(buffer, '# Peer')).toBe('updated');
  expect(buffer.editRevision).toBe(2);
  expect(buffer.savedRevision).toBe(2);
});
