import { describe, expect, test } from 'bun:test';

import { hasFileStatChanged } from './fileStatChange';

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
