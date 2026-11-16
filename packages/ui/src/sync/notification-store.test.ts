import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { NotificationCenterEntry } from '@/lib/notificationCenter';
import * as transport from '@/lib/runtime-fetch';
import { useNotificationCenterStore } from '@/stores/useNotificationCenterStore';
import { markSessionRead, markSessionViewed } from './notification-store';

const deferred = <T>() => {
  let resolve: (value: T) => void = () => { throw new Error('Promise not initialized'); };
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

const entry = (id: string, sessionId: string): NotificationCenterEntry => ({
  id, sessionId, createdAt: 1, kind: 'ready', priority: 'normal', delivery: 'delivered',
  verdict: null, title: 'Ready', body: '', directory: '/repo', sessionName: null,
  requestId: null, action: null, readAt: null, resolvedAt: null,
});

afterEach(() => {
  useNotificationCenterStore.getState().resetForRuntime();
});

describe('session notification read integration', () => {
  test('preserves feed entries when the server refuses the read', async () => {
    // Given an unread feed entry and a rejected read request.
    const own = entry('own', 'ses_1');
    useNotificationCenterStore.setState({ status: 'ready', entries: [own] });
    const markRead = useNotificationCenterStore.getState().markRead;
    let pending = Promise.resolve();
    const read = spyOn(useNotificationCenterStore.getState(), 'markRead').mockImplementation((target) => {
      pending = markRead(target);
      return pending;
    });
    const fetch = spyOn(transport, 'runtimeFetch').mockImplementation((path) => Promise.resolve(
      path === '/api/notification-center/read' ? new Response('offline', { status: 503 }) : Response.json({}),
    ));
    try {
      // When viewing the session attempts to mark its feed read.
      markSessionViewed('ses_1');

      // Then the failed server write leaves the entry unread for a later retry.
      expect(read.mock.calls).toEqual([[{ sessionId: 'ses_1' }]]);
      await expect(pending).rejects.toThrow('503');
      expect(useNotificationCenterStore.getState().entries).toEqual([own]);
    } finally {
      read.mockRestore();
      fetch.mockRestore();
    }
  });

  for (const [name, mark] of [['view', markSessionViewed], ['explicit read', markSessionRead]] as const) {
    test(`marks the session's feed entries after confirmation on ${name}`, async () => {
      // Given unread feed entries and a server response held until confirmation.
      const own = entry('own', 'ses_1');
      const other = entry('other', 'ses_2');
      useNotificationCenterStore.setState({ status: 'ready', entries: [own, other] });
      const response = deferred<Response>();
      const changed = deferred<void>();
      const unsubscribe = useNotificationCenterStore.subscribe((state) => {
        if (state.entries[0]?.readAt === 5) changed.resolve();
      });
      const fetch = spyOn(transport, 'runtimeFetch').mockImplementation((path) => (
        path === '/api/notification-center/read' ? response.promise : Promise.resolve(Response.json({}))
      ));
      try {
        // When the session is viewed or explicitly marked read.
        mark('ses_1');

        // Then only its entries become read, after the server confirms.
        expect(fetch.mock.calls.filter(([path]) => path === '/api/notification-center/read')).toHaveLength(1);
        expect(useNotificationCenterStore.getState().entries[0]?.readAt).toBeNull();
        response.resolve(Response.json({ ids: ['own'], readAt: 5 }));
        await changed.promise;
        expect(useNotificationCenterStore.getState().entries).toEqual([{ ...own, readAt: 5 }, other]);
      } finally {
        unsubscribe();
        fetch.mockRestore();
      }
    });
  }
});
