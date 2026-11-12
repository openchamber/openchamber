import { describe, expect, test } from 'bun:test';

import { pendingFileNavigationStep } from './pendingFileNavigation';

const step = (overrides: Partial<Parameters<typeof pendingFileNavigationStep>[0]>) => pendingFileNavigationStep({
  selectedPath: '/tmp/x/file.ts',
  targetPath: '/tmp/x/file.ts',
  targetShown: true,
  targetSettled: true,
  showsText: true,
  canEdit: true,
  textViewMode: 'edit',
  ...overrides,
});

describe('pendingFileNavigationStep', () => {
  test('a new jump selects its file', () => {
    expect(step({ selectedPath: '/repo/alpha.txt', targetShown: false })).toBe('select-target');
  });

  test('after its file was on screen, another selected tab is left alone', () => {
    expect(step({ selectedPath: '/repo/alpha.txt' })).toBe('wait');
    expect(step({ selectedPath: null })).toBe('wait');
  });

  test('waits while its file loads', () => {
    expect(step({ targetSettled: false })).toBe('wait');
  });

  test('ends on a file that shows no text', () => {
    expect(step({ showsText: false })).toBe('end');
  });

  test('jumps in a read-only editor', () => {
    expect(step({ canEdit: false })).toBe('jump');
  });

  test('switches an editable file to the editor, and ends on a read-only one without it', () => {
    expect(step({ textViewMode: 'view' })).toBe('show-editor');
    expect(step({ textViewMode: 'view', canEdit: false })).toBe('end');
  });
});
