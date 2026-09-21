import { describe, expect, test } from 'bun:test';
import {
  findFirstVisibleSessionSidebarRowIndex,
  getInitialSessionSidebarRowIndexes,
  mergeSessionSidebarVirtualIndexes,
} from './sessionSidebarVirtualization';

describe('SessionSidebarRows initialization', () => {
  test('never mounts the whole model before the scroll element is ready', () => {
    expect(getInitialSessionSidebarRowIndexes(25_000)).toHaveLength(24);
    expect(getInitialSessionSidebarRowIndexes(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test('the bounded window includes its last initial row', () => {
    expect(getInitialSessionSidebarRowIndexes(25_000).at(-1)).toBe(23);
  });

  test('ignores stale pinned indexes after a model shrink', () => {
    expect(mergeSessionSidebarVirtualIndexes([0, 1], new Set([2, 99, -1]), 3)).toEqual([0, 1, 2]);
  });

  test('advances at an exact row boundary', () => {
    expect(findFirstVisibleSessionSidebarRowIndex([
      { index: 0, end: 32 },
      { index: 1, end: 64 },
    ], 32)).toBe(1);
  });
});
