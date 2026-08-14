import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { State } from './types';

import { EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT, buildUserMessageHistorySnapshot } from './user-message-history';

const message = (id: string, role: 'user' | 'assistant', created = 1): Message => ({
  id,
  role,
  sessionID: 'ses_1',
  time: { created },
} as Message);

const textPart = (id: string, text: string): Part => ({
  id,
  type: 'text',
  text,
} as Part);

const state = (partial: Partial<State>): Pick<State, 'session' | 'message' | 'part'> => ({
  session: [],
  message: {},
  part: {},
  ...partial,
});

describe('buildUserMessageHistorySnapshot', () => {
  test('returns a shared empty snapshot without a session id', () => {
    expect(buildUserMessageHistorySnapshot(state({}), '')).toBe(EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT);
  });

  test('keeps history stable when assistant parts change', () => {
    const user = message('user_1', 'user');
    const assistant = message('assistant_1', 'assistant');
    const userParts = [textPart('part_user', 'hello')];
    const first = buildUserMessageHistorySnapshot(
      state({
        message: { ses_1: [user, assistant] },
        part: { user_1: userParts, assistant_1: [textPart('part_a', 'stream')] },
      }),
      'ses_1',
    );

    const second = buildUserMessageHistorySnapshot(
      state({
        message: { ses_1: [user, assistant] },
        part: { user_1: userParts, assistant_1: [textPart('part_a2', 'streaming')] },
      }),
      'ses_1',
      first,
    );

    expect(second).toBe(first);
    expect(second.history).toEqual(['hello']);
  });

  test('updates history when a user part changes', () => {
    const user = message('user_1', 'user');
    const first = buildUserMessageHistorySnapshot(
      state({
        message: { ses_1: [user] },
        part: { user_1: [textPart('part_user', 'hello')] },
      }),
      'ses_1',
    );

    const second = buildUserMessageHistorySnapshot(
      state({
        message: { ses_1: [user] },
        part: { user_1: [textPart('part_user_updated', 'updated')] },
      }),
      'ses_1',
      first,
    );

    expect(second).not.toBe(first);
    expect(second.history).toEqual(['updated']);
  });

  test('excludes user messages hidden by session revert state', () => {
    const beforeRevert = message('user_1', 'user');
    const reverted = message('user_2', 'user');

    const snapshot = buildUserMessageHistorySnapshot(
      state({
        session: [{ id: 'ses_1', revert: { messageID: 'user_2' } } as State['session'][number]],
        message: { ses_1: [beforeRevert, reverted] },
        part: {
          user_1: [textPart('part_user_1', 'kept')],
          user_2: [textPart('part_user_2', 'reverted')],
        },
      }),
      'ses_1',
    );

    expect(snapshot.history).toEqual(['kept']);
  });

  test('uses message sequence rather than id order for revert filtering', () => {
    const beforeWrap = message('msg_fffffffff0010000000000000A', 'user', 1_786_706_395_135);
    const reverted = message('msg_0000000000010000000000000A', 'user', 1_786_706_395_136);

    const snapshot = buildUserMessageHistorySnapshot(
      state({
        session: [{ id: 'ses_1', revert: { messageID: reverted.id } } as State['session'][number]],
        message: { ses_1: [beforeWrap, reverted] },
        part: {
          [beforeWrap.id]: [textPart('part_before', 'kept')],
          [reverted.id]: [textPart('part_reverted', 'reverted')],
        },
      }),
      'ses_1',
    );

    expect(snapshot.history).toEqual(['kept']);
  });
});
