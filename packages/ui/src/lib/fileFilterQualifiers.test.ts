import { describe, expect, test } from 'bun:test';

import { filterByExtensions, parseExtQualifiers, removeExtQualifier } from './fileFilterQualifiers';

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
