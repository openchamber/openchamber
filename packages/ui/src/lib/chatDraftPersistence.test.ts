import { beforeEach, describe, expect, test } from 'bun:test';

import {
  clearChatDraft,
  createChatDraftIdentity,
  readChatDraft,
  subscribeChatDraftDeletion,
  writeChatDraft,
} from './chatDraftPersistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

const storage = getDeferredSafeStorage();

describe('chatDraftPersistence', () => {
  beforeEach(() => {
    storage.removeItem('openchamber.chatDrafts.v2');
  });

  test('isolates drafts by runtime, directory, and session', () => {
    const first = createChatDraftIdentity('runtime-a', '/repo-a/', 'session-1')!;
    const second = createChatDraftIdentity('runtime-b', '/repo-a', 'session-1')!;
    const third = createChatDraftIdentity('runtime-a', '/repo-b', 'session-1')!;
    writeChatDraft(first, 'first', ['file.ts']);
    writeChatDraft(second, 'second', []);
    writeChatDraft(third, 'third', []);

    expect(readChatDraft(first)).toEqual({ text: 'first', confirmedMentions: new Set(['file.ts']) });
    expect(readChatDraft(second).text).toBe('second');
    expect(readChatDraft(third).text).toBe('third');
  });

  test('keeps new-session drafts separate from similarly named sessions', () => {
    const newSession = createChatDraftIdentity('runtime-a', '/repo', null)!;
    const namedSession = createChatDraftIdentity('runtime-a', '/repo', '__new__')!;

    writeChatDraft(newSession, 'new session', []);
    writeChatDraft(namedSession, 'named session', []);

    expect(readChatDraft(newSession).text).toBe('new session');
    expect(readChatDraft(namedSession).text).toBe('named session');
  });

  test('clears only the matching identity and notifies active composers', () => {
    const deleted = createChatDraftIdentity('runtime-a', '/repo-a', 'session-1')!;
    const retained = createChatDraftIdentity('runtime-a', '/repo-b', 'session-1')!;
    const notifications: string[] = [];
    const unsubscribe = subscribeChatDraftDeletion((identity) => notifications.push(identity.directory));
    writeChatDraft(deleted, 'delete', []);
    writeChatDraft(retained, 'retain', []);

    clearChatDraft(deleted, true);
    unsubscribe();

    expect(readChatDraft(deleted).text).toBe('');
    expect(readChatDraft(retained).text).toBe('retain');
    expect(notifications).toEqual(['/repo-a']);
  });

  test('bounds persisted drafts by recency', () => {
    for (let index = 0; index < 55; index += 1) {
      const identity = createChatDraftIdentity('runtime-a', '/repo', `session-${index}`)!;
      writeChatDraft(identity, `draft-${index}`, []);
    }

    const envelope = JSON.parse(storage.getItem('openchamber.chatDrafts.v2') ?? '{}') as { drafts?: object };
    expect(Object.keys(envelope.drafts ?? {})).toHaveLength(50);
  });
});
