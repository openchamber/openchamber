import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { buildProjectionCacheKey } from './turnProjectionCache';
import type { ChatMessageEntry } from './types';

const createEntry = (text: string): ChatMessageEntry => ({
  info: { id: 'msg_1', role: 'assistant' } as Message,
  parts: [{ id: 'prt_1', type: 'text', text } as Part],
});

describe('turnProjectionCache', () => {
  test('keeps the cache key stable for unchanged message and part references', () => {
    const messages = [createEntry('hello')];

    const first = buildProjectionCacheKey('session_1', messages, false, false);
    const second = buildProjectionCacheKey('session_1', messages, false, false);

    expect(second).toBe(first);
  });

  test('changes the cache key when streaming replaces a part with the same id and count', () => {
    const before = [createEntry('hel')];
    const after = [
      {
        info: before[0].info,
        parts: [{ id: 'prt_1', type: 'text', text: 'hello' } as Part],
      },
    ];

    const beforeKey = buildProjectionCacheKey('session_1', before, false, false);
    const afterKey = buildProjectionCacheKey('session_1', after, false, false);

    expect(afterKey).not.toBe(beforeKey);
  });
});
