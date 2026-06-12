import { describe, expect, test } from 'bun:test';

import {
  completeExtQualifier,
  filterByExtensions,
  isTypingExtQualifier,
  parseExtQualifiers,
  parseFileSearchQualifiers,
  removeExtQualifier,
  removePathQualifier,
  resolvePathScopedDirectory,
  suggestExtensions,
} from './fileFilterQualifiers';

describe('parseExtQualifiers', () => {
  test('extracts a single extension at the start of the query', () => {
    expect(parseExtQualifiers('ext:ts auth')).toEqual({
      cleanQuery: 'auth',
      extensions: ['ts'],
    });
  });

  test('extracts comma-separated extensions and normalizes casing and dots', () => {
    expect(parseExtQualifiers('ext:.TS,tsx login')).toEqual({
      cleanQuery: 'login',
      extensions: ['ts', 'tsx'],
    });
  });

  test('extracts a qualifier from the middle of the query', () => {
    expect(parseExtQualifiers('hello ext:md world')).toEqual({
      cleanQuery: 'hello world',
      extensions: ['md'],
    });
  });

  test('leaves ext without a value as normal query text', () => {
    expect(parseExtQualifiers('ext:')).toEqual({
      cleanQuery: 'ext:',
      extensions: [],
    });
  });

  test('parses multiple ext: qualifiers in the same query', () => {
    expect(parseExtQualifiers('ext:ts ext:tsx auth')).toEqual({
      cleanQuery: 'auth',
      extensions: ['ts', 'tsx'],
    });
  });

  test('deduplicates identical extensions from multiple qualifiers', () => {
    expect(parseExtQualifiers('ext:ts ext:ts auth')).toEqual({
      cleanQuery: 'auth',
      extensions: ['ts'],
    });
  });

  test('parses ext: qualifier at the end of the query', () => {
    expect(parseExtQualifiers('auth ext:ts')).toEqual({
      cleanQuery: 'auth',
      extensions: ['ts'],
    });
  });
});

describe('filterByExtensions', () => {
  test('preserves hit shape while filtering by extension', () => {
    const hits = [
      { name: 'a.ts', path: '/repo/a.ts', extension: 'ts' },
      { name: 'b.md', path: '/repo/b.md', extension: 'md' },
    ];

    expect(filterByExtensions(hits, ['ts'])).toEqual([
      { name: 'a.ts', path: '/repo/a.ts', extension: 'ts' },
    ]);
  });
});

describe('parseFileSearchQualifiers', () => {
  test('extracts path qualifier and strips it from the clean query', () => {
    expect(parseFileSearchQualifiers('path:src auth')).toEqual({
      cleanQuery: 'auth',
      extensions: [],
      pathScope: 'src',
    });
  });

  test('combines path and extension qualifiers', () => {
    expect(parseFileSearchQualifiers('path:packages/ui ext:ts auth')).toEqual({
      cleanQuery: 'auth',
      extensions: ['ts'],
      pathScope: 'packages/ui',
    });
  });

  test('normalizes repeated slashes in path scope', () => {
    expect(parseFileSearchQualifiers('path:packages//ui auth')).toEqual({
      cleanQuery: 'auth',
      extensions: [],
      pathScope: 'packages/ui',
    });
  });

  test('keeps path without value as normal query text', () => {
    expect(parseFileSearchQualifiers('path:')).toEqual({
      cleanQuery: 'path:',
      extensions: [],
    });
  });
});

describe('removePathQualifier', () => {
  test('removes path qualifier and preserves remaining query', () => {
    expect(removePathQualifier('path:src auth')).toBe('auth');
  });

  test('removes path qualifier while preserving ext qualifier', () => {
    expect(removePathQualifier('path:src ext:ts auth')).toBe('ext:ts auth');
  });
});

describe('resolvePathScopedDirectory', () => {
  test('joins a safe relative scope to the current directory', () => {
    expect(resolvePathScopedDirectory('/repo', 'src/components')).toBe('/repo/src/components');
  });

  test('returns current directory when path scope is undefined', () => {
    expect(resolvePathScopedDirectory('/repo', undefined)).toBe('/repo');
  });

  test('rejects absolute path scopes', () => {
    expect(resolvePathScopedDirectory('/repo', '/tmp')).toBeNull();
  });

  test('rejects traversal segments', () => {
    expect(resolvePathScopedDirectory('/repo', '../secret')).toBeNull();
    expect(resolvePathScopedDirectory('/repo', 'src/../secret')).toBeNull();
  });
});

describe('isTypingExtQualifier', () => {
  test('true when cursor is directly after ext:', () => {
    expect(isTypingExtQualifier('ext:')).toBe(true);
  });

  test('true when mid-typing an extension value', () => {
    expect(isTypingExtQualifier('ext:ts')).toBe(true);
  });

  test('true when mid-typing a comma-separated list', () => {
    expect(isTypingExtQualifier('ext:ts,')).toBe(true);
  });

  test('false when ext: is followed by a space-terminated value', () => {
    expect(isTypingExtQualifier('ext:ts auth')).toBe(false);
  });

  test('false when ext is not a qualifier', () => {
    expect(isTypingExtQualifier('text:hello')).toBe(false);
  });

  test('false for a normal query', () => {
    expect(isTypingExtQualifier('auth')).toBe(false);
  });
});

describe('completeExtQualifier', () => {
  test('inserts extension when ext: has no value yet', () => {
    expect(completeExtQualifier('ext: auth', 'ts')).toBe('ext:ts auth');
  });

  test('replaces partial extension text', () => {
    expect(completeExtQualifier('ext:t auth', 'tsx')).toBe('ext:tsx auth');
  });

  test('appends to existing comma-separated values', () => {
    expect(completeExtQualifier('ext:ts, auth', 'tsx')).toBe('ext:ts,tsx auth');
  });

  test('deduplicates when extension is already in the list', () => {
    expect(completeExtQualifier('ext:ts,tsx auth', 'ts')).toBe('ext:ts,tsx auth');
  });

  test('handles ext: at the end of the query', () => {
    expect(completeExtQualifier('auth ext:', 'md')).toBe('auth ext:md');
  });

  test('normalizes dotted extension input', () => {
    expect(completeExtQualifier('ext: auth', '.tsx')).toBe('ext:tsx auth');
  });
});

describe('suggestExtensions', () => {
  test('ranks extensions by frequency', () => {
    const hits = [
      { extension: 'ts' }, { extension: 'ts' }, { extension: 'ts' },
      { extension: 'tsx' }, { extension: 'tsx' },
      { extension: 'json' },
    ];
    expect(suggestExtensions(hits, '')).toEqual(['ts', 'tsx', 'json']);
  });

  test('filters by prefix', () => {
    const hits = [
      { extension: 'ts' }, { extension: 'tsx' }, { extension: 'json' },
    ];
    expect(suggestExtensions(hits, 't')).toEqual(['ts', 'tsx']);
  });

  test('returns empty array for empty hits', () => {
    expect(suggestExtensions([], 'ts')).toEqual([]);
  });

  test('returns at most 5 suggestions', () => {
    const hits = [
      { extension: 'a' }, { extension: 'b' }, { extension: 'c' },
      { extension: 'd' }, { extension: 'e' }, { extension: 'f' },
    ];
    expect(suggestExtensions(hits, '').length).toBe(5);
  });
});

describe('removeExtQualifier', () => {
  test('removes one value from a comma-separated qualifier', () => {
    expect(removeExtQualifier('ext:ts,tsx auth', 'ts')).toBe('ext:tsx auth');
  });

  test('removes the qualifier entirely when no extensions remain', () => {
    expect(removeExtQualifier('ext:ts auth', 'ts')).toBe('auth');
  });

  test('removes extension with dotted input (.TSX matches tsx)', () => {
    expect(removeExtQualifier('ext:ts,tsx auth', '.TSX')).toBe('ext:ts auth');
  });

  test('preserves remaining extensions when removing from the middle', () => {
    expect(removeExtQualifier('ext:tsx,ts,json auth', 'ts')).toBe('ext:tsx,json auth');
  });

  test('removes the first extension in a comma-separated list', () => {
    expect(removeExtQualifier('ext:ts,tsx auth', 'ts')).toBe('ext:tsx auth');
  });

  test('removes the last extension in a comma-separated list', () => {
    expect(removeExtQualifier('ext:ts,tsx auth', 'tsx')).toBe('ext:ts auth');
  });
});
