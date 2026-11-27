import { describe, expect, test } from 'bun:test';

import { requestGuestPanelItem, useGuestItemStore } from './item-store.ts';

const item = {
  providerId: 'tasks-demo',
  id: 'DEMO-1',
  title: 'Fix the login redirect loop',
  url: 'https://example.com/tasks/DEMO-1',
};

describe('useGuestItemStore', () => {
  test('hands an item to its guest once and leaves other guests alone', () => {
    useGuestItemStore.setState({ pendingItemByGuest: {} });
    useGuestItemStore.getState().setPendingItem('tasks-demo', item);
    useGuestItemStore.getState().setPendingItem('other', { ...item, providerId: 'other', id: 'X-1' });

    expect(useGuestItemStore.getState().takePendingItem('tasks-demo')?.item).toEqual(item);
    expect(useGuestItemStore.getState().takePendingItem('tasks-demo')).toBeNull();
    expect(useGuestItemStore.getState().takePendingItem('other')?.item).toMatchObject({ id: 'X-1' });
  });

  test('a later item for the same guest replaces the earlier one', () => {
    useGuestItemStore.setState({ pendingItemByGuest: {} });
    useGuestItemStore.getState().setPendingItem('tasks-demo', item);
    useGuestItemStore.getState().setPendingItem('tasks-demo', { ...item, id: 'DEMO-2' });
    expect(useGuestItemStore.getState().takePendingItem('tasks-demo')?.item).toMatchObject({ id: 'DEMO-2' });
  });

  test('carries a message item the same way as a chip', () => {
    useGuestItemStore.setState({ pendingItemByGuest: {} });
    const messageItem = {
      kind: 'message' as const,
      action: 'create-task',
      sessionId: 'ses-1',
      sessionTitle: 'Hello',
      directory: '/repo',
      messageId: 'msg-1',
      role: 'assistant' as const,
      text: 'Do it.',
    };
    useGuestItemStore.getState().setPendingItem('tasks-demo', messageItem);
    expect(useGuestItemStore.getState().takePendingItem('tasks-demo')?.item).toEqual(messageItem);
  });

  test('a scoped item stays with its intended panel owner', () => {
    useGuestItemStore.setState({ pendingItemByGuest: {} });
    useGuestItemStore.getState().setPendingItem('tasks-demo', item, 'first-owner');
    expect(useGuestItemStore.getState().takePendingItem('tasks-demo', 'second-owner')).toBeNull();
    expect(useGuestItemStore.getState().takePendingItem('tasks-demo', 'first-owner')?.item).toEqual(item);
  });

  test('a superseded SDK item does not report delivery', async () => {
    useGuestItemStore.setState({ pendingItemByGuest: {} });
    const first = requestGuestPanelItem('tasks-demo', item, 'owner');
    const second = requestGuestPanelItem('tasks-demo', { ...item, id: 'DEMO-2' }, 'owner');
    expect(await first).toBe(false);
    expect(useGuestItemStore.getState().takePendingItem('tasks-demo', 'owner')).toBeNull();
    const pending = useGuestItemStore.getState().pendingItemByGuest['tasks-demo'];
    expect(pending.item).toMatchObject({ id: 'DEMO-2' });
    pending.finish?.(true);
    expect(await second).toBe(true);
    expect(useGuestItemStore.getState().pendingItemByGuest['tasks-demo']).toBeUndefined();
  });
});
