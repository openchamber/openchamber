import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Part } from '@/lib/opencode/model';
import type { MessagePageItem } from '@/lib/opencode/messagePaging';

// Pages are selected by cursor index so the walk can be pinned without the flat
// records. See issue #4816: the first user message can sit past the first page.
type Page = { items: MessagePageItem[]; cursor: { next?: string } };
let pages: Page[] = [];
const calls: Array<{ cursor?: string; order?: 'asc' | 'desc'; limit?: number }> = [];

const opencodeModule = await import('@/lib/opencode/client');
// Spread the real module so its other exports stay resolvable for the imports
// `laneData` pulls in transitively; only `getSessionMessages` is overridden.
mock.module('@/lib/opencode/client', () => ({
  ...opencodeModule,
  opencodeClient: {
    ...opencodeModule.opencodeClient,
    getSessionMessages: async (
      _sessionId: string,
      options?: { cursor?: string; order?: 'asc' | 'desc'; limit?: number },
    ): Promise<Page> => {
      calls.push({ cursor: options?.cursor, order: options?.order, limit: options?.limit });
      return pages[Number(options?.cursor ?? '0')];
    },
  },
}));

const plumbing = (id: string): MessagePageItem => ({
  info: { id, sessionID: 'ses_1', role: 'synthetic', text: '', time: { created: 1 } },
  parts: [],
});
const user = (id: string, text: string): MessagePageItem => ({
  info: { id, sessionID: 'ses_1', role: 'user', time: { created: 1 } },
  parts: [{ id: `${id}_text`, sessionID: 'ses_1', messageID: id, type: 'text', text } satisfies Part],
});

describe('loadLaneFirstPrompt', () => {
  beforeEach(() => {
    pages = [];
    calls.length = 0;
  });

  test('finds the first user message past the first page of plumbing records', async () => {
    const { loadLaneFirstPrompt } = await import('./laneData');
    pages = [
      { items: [plumbing('p1'), plumbing('p2')], cursor: { next: '1' } },
      { items: [user('u1', 'Do the thing')], cursor: {} },
    ];

    const prompt = await loadLaneFirstPrompt('ses_1', '/repo');

    expect(prompt?.messageId).toBe('u1');
    expect(prompt?.text).toBe('Do the thing');
    expect(calls[0]?.order).toBe('asc');
  });

  test('returns null when no user message exists at all', async () => {
    const { loadLaneFirstPrompt } = await import('./laneData');
    pages = [{ items: [plumbing('p1')], cursor: {} }];

    expect(await loadLaneFirstPrompt('ses_1', '/repo')).toBeNull();
  });
});
