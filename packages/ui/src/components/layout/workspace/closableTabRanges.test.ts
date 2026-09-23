import { describe, expect, test } from 'bun:test';

import { closableTabRanges } from './closableTabRanges';

const CHAT = 'chat';

describe('closableTabRanges', () => {
  test('ranges skip the unclosable conversation tab', () => {
    const ranges = closableTabRanges([CHAT, 'a', 'b', 'c'], 'b', CHAT);

    expect(ranges.toLeft).toEqual(['a']);
    expect(ranges.toRight).toEqual(['c']);
  });

  test('the first closable tab has nothing to its left, even after the conversation', () => {
    const ranges = closableTabRanges([CHAT, 'a', 'b'], 'a', CHAT);

    expect(ranges.toLeft).toEqual([]);
    expect(ranges.toRight).toEqual(['b']);
  });

  test('never includes the clicked tab', () => {
    for (const id of ['a', 'b', 'c']) {
      const { toLeft, toRight } = closableTabRanges([CHAT, 'a', 'b', 'c'], id, CHAT);
      expect([...toLeft, ...toRight]).not.toContain(id);
    }
  });

  test('from the conversation tab, every closable tab is to its right', () => {
    const ranges = closableTabRanges([CHAT, 'a', 'b'], CHAT, CHAT);

    expect(ranges.toLeft).toEqual([]);
    expect(ranges.toRight).toEqual(['a', 'b']);
  });

  test('a strip without the conversation behaves as before', () => {
    const ranges = closableTabRanges(['a', 'b', 'c'], 'b', CHAT);

    expect(ranges.toLeft).toEqual(['a']);
    expect(ranges.toRight).toEqual(['c']);
  });
});
