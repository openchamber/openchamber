import { describe, expect, test } from 'bun:test';

import { useGuestBadgeStore } from './badge-store.ts';

describe('useGuestBadgeStore', () => {
  test('keeps counts per guest, treats null and zero as clear, and skips no-op writes', () => {
    useGuestBadgeStore.setState({ countByGuest: {} });
    const store = useGuestBadgeStore.getState();
    store.setBadge('tasks-demo', 3);
    store.setBadge('other', 1);
    expect(useGuestBadgeStore.getState().countByGuest).toEqual({ 'tasks-demo': 3, other: 1 });

    const before = useGuestBadgeStore.getState().countByGuest;
    store.setBadge('tasks-demo', 3);
    expect(useGuestBadgeStore.getState().countByGuest).toBe(before);

    store.setBadge('tasks-demo', 0);
    expect(useGuestBadgeStore.getState().countByGuest).toEqual({ other: 1 });
    store.setBadge('other', null);
    expect(useGuestBadgeStore.getState().countByGuest).toEqual({});

    const empty = useGuestBadgeStore.getState().countByGuest;
    store.clearBadge('missing');
    expect(useGuestBadgeStore.getState().countByGuest).toBe(empty);
  });
});
