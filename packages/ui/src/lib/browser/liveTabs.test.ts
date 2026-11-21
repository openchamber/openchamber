import { describe, expect, test } from 'bun:test';

import {
  clampLiveBrowserTabs,
  dropIdleAgentTabs,
  LIVE_BROWSER_TABS_DEFAULT,
  LIVE_BROWSER_TABS_MAX,
  LIVE_BROWSER_TABS_MIN,
  pickLiveBrowserTabs,
  touchRecentBrowserTab,
} from './liveTabs';

describe('touchRecentBrowserTab', () => {
  test('moves a used tab to the front and keeps each tab once', () => {
    expect(touchRecentBrowserTab(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(touchRecentBrowserTab([], 'a')).toEqual(['a']);
  });

  test('returns the same list when the tab is already the newest', () => {
    const recent = ['a', 'b'];
    expect(touchRecentBrowserTab(recent, 'a')).toBe(recent);
  });
});

describe('pickLiveBrowserTabs', () => {
  test('keeps the most recently used tabs up to the limit', () => {
    const open = new Set(['a', 'b', 'c', 'd']);
    expect([...pickLiveBrowserTabs(['d', 'c', 'b', 'a'], open, 2)]).toEqual(['d', 'c']);
  });

  test('skips closed tabs, so they do not hold a place', () => {
    const open = new Set(['a', 'c']);
    expect([...pickLiveBrowserTabs(['b', 'a', 'c'], open, 2)]).toEqual(['a', 'c']);
  });

  test('leaves a tab that was never used asleep', () => {
    expect(pickLiveBrowserTabs(['a'], new Set(['a', 'b']), 5).has('b')).toBe(false);
  });
});

describe('dropIdleAgentTabs', () => {
  test('drops only agent tabs used before the cutoff', () => {
    const agentTabs = new Set(['agent-old', 'agent-new']);
    const lastUsed = new Map([['agent-old', 10], ['agent-new', 100], ['user', 0]]);
    expect(dropIdleAgentTabs(['user', 'agent-old', 'agent-new'], agentTabs, lastUsed, 50)).toEqual(['user', 'agent-new']);
  });

  test('keeps an agent tab with no recorded use, and returns the same list when nothing is idle', () => {
    const recent = ['agent'];
    expect(dropIdleAgentTabs(recent, new Set(['agent']), new Map(), 50)).toBe(recent);
  });
});

describe('clampLiveBrowserTabs', () => {
  test('keeps the number inside the allowed range', () => {
    expect(clampLiveBrowserTabs(0)).toBe(LIVE_BROWSER_TABS_MIN);
    expect(clampLiveBrowserTabs(999)).toBe(LIVE_BROWSER_TABS_MAX);
    expect(clampLiveBrowserTabs(7.4)).toBe(7);
    expect(clampLiveBrowserTabs(Number.NaN)).toBe(LIVE_BROWSER_TABS_DEFAULT);
  });
});
