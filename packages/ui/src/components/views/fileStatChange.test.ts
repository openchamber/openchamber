import { describe, expect, test } from 'bun:test';

import { hasFileStatChanged, openFilePollStep } from './fileStatChange';

const step = (overrides: Partial<Parameters<typeof openFilePollStep>[0]>) => openFilePollStep({
  stat: 'found',
  showsFailure: false,
  sawMissing: false,
  hasUnsavedChanges: false,
  ...overrides,
});

describe('openFilePollStep (issue 4477)', () => {
  test('a loaded file that exists goes on to change detection', () => {
    expect(step({})).toBe('check-changes');
  });

  test('a file deleted while open shows the error unless it has unsaved edits', () => {
    expect(step({ stat: 'missing' })).toBe('show-missing');
    expect(step({ stat: 'missing', hasUnsavedChanges: true })).toBe('none');
  });

  test('other metadata failures change nothing', () => {
    expect(step({ stat: 'failed' })).toBe('none');
    expect(step({ stat: 'failed', showsFailure: true, sawMissing: true })).toBe('none');
  });

  test('a failed file reloads only after the poll saw it missing and then found it', () => {
    expect(step({ showsFailure: true, sawMissing: true })).toBe('reload');
    // A file that exists but keeps failing to read is never reloaded in a loop.
    expect(step({ showsFailure: true })).toBe('none');
  });

  test('a failed file that is still missing keeps its error without a reload', () => {
    expect(step({ stat: 'missing', showsFailure: true, sawMissing: true })).toBe('show-missing');
  });
});

describe('hasFileStatChanged', () => {
  test('ignores sub-millisecond mtime jitter on an unchanged file (issue #1489)', () => {
    expect(hasFileStatChanged(
      { size: 100, mtimeMs: 1700000000123.456 },
      { size: 100, mtimeMs: 1700000000123.4561 },
    )).toBe(false);
  });

  test('detects size changes and meaningful mtime changes', () => {
    expect(hasFileStatChanged({ size: 100, mtimeMs: 1 }, { size: 101, mtimeMs: 1 })).toBe(true);
    expect(hasFileStatChanged({ size: 100, mtimeMs: 1 }, { size: 100, mtimeMs: 2 })).toBe(true);
  });
});
