import { describe, expect, test } from 'bun:test';

import { hasFileStatChanged, MIN_MTIME_CHANGE_MS } from './fileStatChange';

describe('hasFileStatChanged', () => {
  test('ignores sub-millisecond mtime jitter on an unmodified file (issue #1489)', () => {
    const previous = { path: '/f.ts', size: 100, mtimeMs: 1700000000123.456 };
    const latest = { path: '/f.ts', size: 100, mtimeMs: 1700000000123.4561 };
    expect(hasFileStatChanged(previous, latest)).toBe(false);
  });

  test('detects a size change even when mtime is unchanged', () => {
    const previous = { size: 100, mtimeMs: 1700000000123 };
    const latest = { size: 120, mtimeMs: 1700000000123 };
    expect(hasFileStatChanged(previous, latest)).toBe(true);
  });

  test('detects an mtime move of at least the threshold at the same size', () => {
    const previous = { size: 100, mtimeMs: 1700000000123 };
    const latest = { size: 100, mtimeMs: 1700000000123 + MIN_MTIME_CHANGE_MS };
    expect(hasFileStatChanged(previous, latest)).toBe(true);
  });

  test('ignores an mtime move below the threshold at the same size', () => {
    const previous = { size: 100, mtimeMs: 1700000000123 };
    const latest = { size: 100, mtimeMs: 1700000000123 + MIN_MTIME_CHANGE_MS / 2 };
    expect(hasFileStatChanged(previous, latest)).toBe(false);
  });

  test('does not reload on missing mtime when the size is unchanged', () => {
    const previous = { size: 100 };
    const latest = { size: 100, mtimeMs: 1700000000123 };
    expect(hasFileStatChanged(previous, latest)).toBe(false);
  });
});
