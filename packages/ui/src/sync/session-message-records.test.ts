import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { buildSessionMessageRecordsSnapshot } from './sync-context';
import { INITIAL_STATE, type State } from './types';

const message = (id: string, role: 'user' | 'assistant', parentID?: string): Message => ({
  id,
  role,
  sessionID: 'ses_1',
  ...(parentID ? { parentID } : {}),
  time: { created: 1 },
} as Message);

const textPart = (id: string, text: string): Part => ({
  id,
  type: 'text',
  text,
} as Part);

const state = (partial: Partial<State>): State => ({
  ...INITIAL_STATE,
  ...partial,
});

describe('buildSessionMessageRecordsSnapshot', () => {
  test('shows an optimistic replacement after its session revert marker is cleared', () => {
    const beforeRevert = message('user_1', 'user');
    const reverted = message('user_2', 'user');
    const optimisticReplacement = message('user_3', 'user');
    const previous = buildSessionMessageRecordsSnapshot(
      state({
        session: [{ id: 'ses_1', revert: { messageID: 'user_2' } } as State['session'][number]],
        message: { ses_1: [beforeRevert, reverted] },
      }),
      'ses_1',
    );

    const next = buildSessionMessageRecordsSnapshot(
      state({
        session: [{ id: 'ses_1' } as State['session'][number]],
        message: { ses_1: [beforeRevert, reverted, optimisticReplacement] },
      }),
      'ses_1',
      previous,
    );

    expect(previous.list.map((record) => record.info.id)).toEqual(['user_1']);
    expect(next.list.map((record) => record.info.id)).toContain('user_3');
  });

  test('only suspends part updates for the active streaming message', () => {
    const user = message('user_1', 'user');
    const assistant1 = message('assistant_1', 'assistant', 'user_1');
    const assistant2 = message('assistant_2', 'assistant', 'user_1');
    const messages = [user, assistant1, assistant2];
    const assistant1InitialParts = [textPart('assistant_1_initial', 'initial')];
    const assistant2InitialParts = [textPart('assistant_2_initial', 'initial')];

    const previous = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: {
          assistant_1: assistant1InitialParts,
          assistant_2: assistant2InitialParts,
        },
      }),
      'ses_1',
      undefined,
      true,
      'assistant_1',
    );

    const assistant1FinalParts = [textPart('assistant_1_final', 'final')];
    const assistant2LiveParts = [textPart('assistant_2_live', 'live')];
    const next = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: {
          assistant_1: assistant1FinalParts,
          assistant_2: assistant2LiveParts,
        },
      }),
      'ses_1',
      previous,
      true,
      'assistant_2',
    );

    expect(next.byId.get('assistant_1')?.parts).toBe(assistant1FinalParts);
    expect(next.byId.get('assistant_2')?.parts).toBe(assistant2InitialParts);
  });
});
