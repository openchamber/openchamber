import { describe, expect, test } from 'bun:test';

import { useGuestItemStore } from './item-store.ts';

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

    expect(useGuestItemStore.getState().takePendingItem('tasks-demo')).toEqual(item);
    expect(useGuestItemStore.getState().takePendingItem('tasks-demo')).toBeNull();
    expect(useGuestItemStore.getState().pendingItemByGuest.other).toMatchObject({ id: 'X-1' });
  });

  test('a later item for the same guest replaces the earlier one', () => {
    useGuestItemStore.setState({ pendingItemByGuest: {} });
    useGuestItemStore.getState().setPendingItem('tasks-demo', item);
    useGuestItemStore.getState().setPendingItem('tasks-demo', { ...item, id: 'DEMO-2' });
    expect(useGuestItemStore.getState().takePendingItem('tasks-demo')).toMatchObject({ id: 'DEMO-2' });
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
    expect(useGuestItemStore.getState().takePendingItem('tasks-demo')).toEqual(messageItem);
  });
});
