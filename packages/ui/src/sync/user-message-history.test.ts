import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { State } from './types';

import { EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT, buildUserMessageHistorySnapshot } from './user-message-history';
import { buildSessionMessageRecordsSnapshot } from './sync-context';
import { addPostRevertBranchReplacement } from './message-visibility';

const message = (id: string, role: 'user' | 'assistant'): Message => ({
  id,
  role,
  sessionID: 'ses_1',
  time: { created: 1 },
} as Message);

const textPart = (id: string, text: string): Part => ({
  id,
  type: 'text',
  text,
} as Part);

const state = (partial: Partial<State>): Pick<State, 'session' | 'message' | 'part' | 'postRevertBranch'> => ({
  session: [],
  message: {},
  part: {},
  postRevertBranch: {},
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

  test('matches timeline visibility for a post-revert replacement branch', () => {
    const beforeRevert = message('msg_001', 'user');
    const reverted = message('msg_002', 'user');
    const discarded = message('msg_003', 'assistant');
    const replacement = message('msg_004', 'user');
    const replacementAssistant = message('msg_005', 'assistant');
    const input = state({
      session: [{ id: 'ses_1', revert: { messageID: 'msg_002' } } as State['session'][number]],
      message: { ses_1: [beforeRevert, reverted, discarded, replacement, replacementAssistant] },
      part: {
        msg_001: [textPart('part_1', 'kept')],
        msg_002: [textPart('part_2', 'discarded')],
        msg_004: [textPart('part_4', 'replacement')],
      },
      postRevertBranch: addPostRevertBranchReplacement({}, 'ses_1', 'msg_002', 'msg_004'),
    });

    const history = buildUserMessageHistorySnapshot(input, 'ses_1');
    const timeline = buildSessionMessageRecordsSnapshot(input as State, 'ses_1');
    const visibleUserIDs = timeline.list
      .filter((record) => record.info.role === 'user')
      .map((record) => record.info.id)
      .reverse();

    expect(timeline.list.map((record) => record.info.id)).toEqual(['msg_001', 'msg_004', 'msg_005']);
    expect(history.records.map((record) => record.message.id)).toEqual(visibleUserIDs);
    expect(history.history).toEqual(['replacement', 'kept']);
  });
});
