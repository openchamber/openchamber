import { describe, expect, test } from 'bun:test';
import type { AssistantFinish, Message, Part } from '@openchamber/ui/lib/opencode/model';
import type { MessagePageItem } from '@openchamber/ui/lib/opencode/messagePaging';
import type { FindPageItem } from './notificationMessage';

// See issue #4816: an explicit message id can age past the newest page, and a
// single newest-first page is not the whole history.

const text = (messageID: string, value: string): Part => ({ id: `${messageID}_text`, sessionID: 'ses_1', messageID, type: 'text', text: value });
const assistant = (id: string, value: string, finish?: AssistantFinish): MessagePageItem => {
  const info: Message = { id, sessionID: 'ses_1', role: 'assistant', agent: 'build', providerID: 'p', modelID: 'm', time: { created: 1 } };
  if (finish) info.finish = finish;
  return { info, parts: [text(id, value)] };
};
const user = (id: string): MessagePageItem => ({
  info: { id, sessionID: 'ses_1', role: 'user', time: { created: 1 } },
  parts: [],
});

type Reader = { find: FindPageItem; calls: number[] };

/** A reader over fixed pages; the walk applies `matches` across all of them. */
const readerOver = (pages: MessagePageItem[][]): Reader => {
  const calls: number[] = [];
  const find: FindPageItem = async (_sessionId, matches, options) => {
    // `options.limit` marks the newest-first path; a walk passes no limit.
    calls.push(options?.limit ?? 0);
    for (const page of pages) {
      const found = page.find(matches);
      if (found) return found;
    }
    return null;
  };
  return { find, calls };
};

describe('fetchLastAssistantMessageText', () => {
  test('finds an explicit assistant id that is not on the newest page', async () => {
    const { fetchLastAssistantMessageText } = await import('./notificationMessage');
    const { find } = readerOver([[user('u1')], [assistant('a_old', 'Older reply')]]);

    expect(await fetchLastAssistantMessageText(find, 'ses_1', 'a_old')).toBe('Older reply');
  });

  test('without an id, reads the newest finished assistant reply', async () => {
    const { fetchLastAssistantMessageText } = await import('./notificationMessage');
    const { find } = readerOver([[assistant('a_new', 'Newest reply', 'stop')]]);

    expect(await fetchLastAssistantMessageText(find, 'ses_1')).toBe('Newest reply');
  });

  test('returns an empty string when the id is absent everywhere', async () => {
    const { fetchLastAssistantMessageText } = await import('./notificationMessage');
    const { find } = readerOver([[user('u1')], [assistant('a1', 'x')]]);

    expect(await fetchLastAssistantMessageText(find, 'ses_1', 'missing')).toBe('');
  });

  test('returns an empty string without a session id', async () => {
    const { fetchLastAssistantMessageText } = await import('./notificationMessage');
    const { find, calls } = readerOver([[assistant('a1', 'x')]]);

    expect(await fetchLastAssistantMessageText(find, '')).toBe('');
    expect(calls).toHaveLength(0);
  });

  test('a reader failure reads as an empty string, never a throw', async () => {
    const { fetchLastAssistantMessageText } = await import('./notificationMessage');
    const find: FindPageItem = async () => { throw new Error('transport'); };

    expect(await fetchLastAssistantMessageText(find, 'ses_1', 'a1')).toBe('');
  });
});
