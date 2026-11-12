import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessagePageItem } from './messagePaging';

// Pages are selected by cursor index, so a walk can be pinned without the flat
// records. A page's `next` is the next page's cursor; the last page has none.
type Page = { items: MessagePageItem[]; cursor: { next?: string } };
let pages: Page[] = [];
const calls: Array<{ cursor?: string; order?: 'asc' | 'desc'; limit?: number }> = [];

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getSessionMessages: async (
      _sessionId: string,
      options?: { cursor?: string; order?: 'asc' | 'desc'; limit?: number },
    ): Promise<Page> => {
      calls.push({ cursor: options?.cursor, order: options?.order, limit: options?.limit });
      return pages[Number(options?.cursor ?? '0')];
    },
  },
}));

const user = (id: string): MessagePageItem => ({
  info: { id, sessionID: 'ses_1', role: 'user', time: { created: 1 } },
  parts: [],
});
const plumbing = (id: string): MessagePageItem => ({
  info: { id, sessionID: 'ses_1', role: 'synthetic', text: '', time: { created: 1 } },
  parts: [],
});

describe('findMessagePageItem', () => {
  beforeEach(() => {
    pages = [];
    calls.length = 0;
  });

  test('finds a record past the first page', async () => {
    const { findMessagePageItem } = await import('./messagePaging');
    pages = [
      { items: [plumbing('p1'), plumbing('p2')], cursor: { next: '1' } },
      { items: [user('u1')], cursor: {} },
    ];

    const found = await findMessagePageItem('ses_1', (item) => item.info.role === 'user', { order: 'asc', limit: 10 });

    expect(found?.info.id).toBe('u1');
    expect(calls.map((call) => call.cursor)).toEqual([undefined, '1']);
    expect(calls[0]?.order).toBe('asc');
  });

  test('stops on a repeated cursor instead of looping', async () => {
    const { findMessagePageItem } = await import('./messagePaging');
    pages = [
      { items: [plumbing('p1')], cursor: { next: '1' } },
      { items: [plumbing('p2')], cursor: { next: '1' } },
    ];

    const found = await findMessagePageItem('ses_1', (item) => item.info.role === 'user');

    expect(found).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test('returns null when the history runs out', async () => {
    const { findMessagePageItem } = await import('./messagePaging');
    pages = [{ items: [plumbing('p1')], cursor: {} }];

    expect(await findMessagePageItem('ses_1', (item) => item.info.role === 'user')).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
