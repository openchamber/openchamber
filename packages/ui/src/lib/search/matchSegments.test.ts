import { describe, expect, test } from 'bun:test';

import { matchSegments, rangesWithin } from './matchSegments';

describe('matchSegments', () => {
  test('splits a line around its matches', () => {
    expect(matchSegments('needle twice: needle', [[0, 6], [14, 20]])).toEqual([
      { text: 'needle', matched: true },
      { text: ' twice: ', matched: false },
      { text: 'needle', matched: true },
    ]);
    expect(matchSegments('const needle;', [[6, 12]])).toEqual([
      { text: 'const ', matched: false },
      { text: 'needle', matched: true },
      { text: ';', matched: false },
    ]);
  });

  test('keeps the whole line when there is nothing to mark', () => {
    expect(matchSegments('plain', [])).toEqual([{ text: 'plain', matched: false }]);
    expect(matchSegments('', [[0, 3]])).toEqual([]);
  });

  test('tolerates overlapping and out-of-range offsets', () => {
    expect(matchSegments('abcdef', [[1, 4], [2, 5], [10, 12]])).toEqual([
      { text: 'a', matched: false },
      { text: 'bcd', matched: true },
      { text: 'e', matched: true },
      { text: 'f', matched: false },
    ]);
  });
});

describe('rangesWithin', () => {
  test('keeps the ranges inside a field, relative to its start', () => {
    expect(rangesWithin([[0, 2], [6, 8]], 5, 10)).toEqual([[1, 3]]);
  });

  test('clips a range that crosses the field edges', () => {
    expect(rangesWithin([[3, 7]], 5, 6)).toEqual([[0, 1]]);
    expect(rangesWithin([[3, 5]], 5, 9)).toEqual([]);
  });
});
