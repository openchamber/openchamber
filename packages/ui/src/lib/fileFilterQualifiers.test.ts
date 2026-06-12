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
});
