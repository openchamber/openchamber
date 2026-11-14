import { describe, expect, mock, test } from 'bun:test';

import type { ReceivedPageItem } from '@/lib/received-pages/api';

/** The feed behind the rail's Pages icon and the list: when it reads the server's pages. */

type FeedEvent = { type: 'event-stream-ready' } | { type: 'received-page-changed'; receivedId: string };

const listeners = new Set<(event: FeedEvent) => void>();
const reads: Array<() => Promise<ReceivedPageItem[]>> = [];
const page: ReceivedPageItem = {
  receivedId: 'rp_1', host: 'share.openchamber.dev', title: 'Pick', status: 'open', kind: 'questionnaire', opened: true, wantsAnswer: true,
  expiresAt: null, attemptsLeft: null, createdAt: 1, answer: null,
};

mock.module('@/lib/received-pages/api', () => ({ fetchReceivedPages: () => (reads.shift() ?? (async () => []))() }));
mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: (event: FeedEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

const { ensureReceivedPagesFeed, useReceivedPagesStore } = await import('./receivedPagesStore');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const emit = (event: FeedEvent) => listeners.forEach((listener) => listener(event));

describe('the received pages feed', () => {
  test('reads again when the event stream first connects after a failed first read, and keeps rows when a later read fails', async () => {
    reads.push(async () => { throw new Error('server not up yet'); });
    reads.push(async () => [page]);
    ensureReceivedPagesFeed(false);
    await settle();
    expect(useReceivedPagesStore.getState()).toMatchObject({ pages: null, error: 'server not up yet' });

    emit({ type: 'event-stream-ready' });
    await settle();
    expect(useReceivedPagesStore.getState().pages).toHaveLength(1);

    reads.push(async () => { throw new Error('offline'); });
    emit({ type: 'received-page-changed', receivedId: 'rp_1' });
    await settle();
    expect(useReceivedPagesStore.getState()).toMatchObject({ error: 'offline' });
    expect(useReceivedPagesStore.getState().pages).toHaveLength(1);
  });
});
