import { describe, expect, test } from 'bun:test';

import { splitBrowserTabsForSession } from './sessionTabs';

const tab = (id: string, ownerSessionId: string | null, mode = 'browser') => ({ id, mode, ownerSessionId });

describe('splitBrowserTabsForSession', () => {
  test('shows the chat on screen its own Browser tabs and parks the others\'', () => {
    const split = splitBrowserTabsForSession(
      [tab('file', null, 'file'), tab('a1', 'ses_a'), tab('b1', 'ses_b')],
      [tab('b2', 'ses_b'), tab('a2', 'ses_a')],
      'ses_a',
      true,
    );
    expect(split).toEqual({
      tabs: [tab('file', null, 'file'), tab('a1', 'ses_a'), tab('a2', 'ses_a')],
      parked: [tab('b1', 'ses_b'), tab('b2', 'ses_b')],
    });
  });

  test('gives an unowned Browser tab to the chat on screen only in its own directory', () => {
    expect(splitBrowserTabsForSession([tab('new', null)], [], 'ses_a', true)).toEqual({ tabs: [tab('new', 'ses_a')], parked: [] });
    expect(splitBrowserTabsForSession([tab('new', null)], [], 'ses_a', false)).toBeNull();
  });

  test('leaves a draft with the unowned tabs and changes nothing that is already in place', () => {
    expect(splitBrowserTabsForSession([tab('new', null)], [tab('a1', 'ses_a')], null, true)).toBeNull();
    expect(splitBrowserTabsForSession([tab('a1', 'ses_a')], [tab('b1', 'ses_b')], 'ses_a', true)).toBeNull();
  });
});

describe('following the agent', () => {
  test('is on per chat by default and off only for the chats that turned it off', async () => {
    const { isFollowingBrowserAgent } = await import('@/stores/useUIStore');
    expect(isFollowingBrowserAgent([], 'ses_a')).toBe(true);
    expect(isFollowingBrowserAgent(['ses_b'], 'ses_a')).toBe(true);
    expect(isFollowingBrowserAgent(['ses_a'], 'ses_a')).toBe(false);
    expect(isFollowingBrowserAgent([], null)).toBe(false);
  });
});
