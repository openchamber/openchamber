import { describe, expect, test } from 'bun:test';

import { findMatchRanges } from './markdownPreviewFind';

describe('findMatchRanges', () => {
  test('returns no ranges for an empty or whitespace-only query', () => {
    expect(findMatchRanges('hello world', '')).toEqual([]);
    expect(findMatchRanges('hello world', '   ')).toEqual([]);
  });

  test('returns no ranges when the query does not occur', () => {
    expect(findMatchRanges('hello world', 'nope')).toEqual([]);
  });

  test('finds all non-overlapping occurrences', () => {
    expect(findMatchRanges('the quick brown fox jumps over the lazy dog', 'the')).toEqual([
      { start: 0, end: 3 },
      { start: 31, end: 34 },
    ]);
  });

  test('matches case-insensitively', () => {
    expect(findMatchRanges('Hello HELLO hello', 'hello')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  test('scans non-overlapping matches like standard find-in-page', () => {
    expect(findMatchRanges('aaaa', 'aaa')).toEqual([{ start: 0, end: 3 }]);
  });

  test('trims the query before matching', () => {
    expect(findMatchRanges('alpha beta', '  beta  ')).toEqual([{ start: 6, end: 10 }]);
  });

  test('handles a query longer than the text', () => {
    expect(findMatchRanges('abc', 'abcdef')).toEqual([]);
  });
});
