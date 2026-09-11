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

  test('matches directory segments of the relative path, not just the basename', () => {
    const fileResults = [
      { name: 'index.md', path: '/kb/solo-is-a-team-size/index.md', relativePath: 'solo-is-a-team-size/index.md' },
      { name: 'index.md', path: '/kb/software-developer/index.md', relativePath: 'software-developer/index.md' },
    ];
    const key = buildCommandPaletteFileSearchKey('/kb', 'solo-is-a');

    const scored = scoreCommandPaletteFiles(fileResults, 'solo-is-a', key, key);
    expect(scored).toHaveLength(1);
    expect(scored[0].item.relativePath).toBe('solo-is-a-team-size/index.md');
  });

  test('ranks prefix path matches above later substring matches', () => {
    const fileResults = [
      { name: 'index.md', path: '/kb/notes/solo/index.md', relativePath: 'notes/solo/index.md' },
      { name: 'index.md', path: '/kb/solo-is-a-team-size/index.md', relativePath: 'solo-is-a-team-size/index.md' },
    ];
    const key = buildCommandPaletteFileSearchKey('/kb', 'solo');

    const scored = scoreCommandPaletteFiles(fileResults, 'solo', key, key);
    expect(scored[0].item.relativePath).toBe('solo-is-a-team-size/index.md');
  });
});
