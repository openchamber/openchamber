import { describe, expect, test } from 'bun:test';

import { buildCommandPaletteFileSearchKey, scoreCommandPaletteFiles } from './commandPaletteFilesState';

describe('commandPaletteFilesState', () => {
  test('does not build a file search key without a root or query', () => {
    expect(buildCommandPaletteFileSearchKey(null, 'alpha')).toBe('');
    expect(buildCommandPaletteFileSearchKey('/project', '')).toBe('');
  });

  test('hides stale file results until the debounced search key catches up', () => {
    const fileResults = [{ name: 'alpha.ts', path: '/project/alpha.ts', relativePath: 'alpha.ts' }];
    const freshKey = buildCommandPaletteFileSearchKey('/project', 'alpha');
    const staleKey = buildCommandPaletteFileSearchKey('/project', 'alp');

    expect(scoreCommandPaletteFiles(fileResults, 'alpha', freshKey, staleKey)).toEqual([]);
    expect(scoreCommandPaletteFiles(fileResults, 'alpha', freshKey, freshKey)).toHaveLength(1);
  });
});
