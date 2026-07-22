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

const taskPart = (id: string, sessionId?: string): Part => ({
  id,
  type: 'tool',
  tool: 'task',
  state: {
    status: 'running',
    metadata: sessionId ? { sessionId } : {},
  },
} as unknown as Part);

const state = (partial: Partial<State>): State => ({
  ...INITIAL_STATE,
  ...partial,
});

describe('buildSessionMessageRecordsSnapshot', () => {
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

  test('publishes task session identity while other streaming part updates are suspended', () => {
    const assistant = message('assistant_1', 'assistant');
    const initialParts = [taskPart('task_1')];
    const previous = buildSessionMessageRecordsSnapshot(
      state({ message: { ses_1: [assistant] }, part: { assistant_1: initialParts } }),
      'ses_1',
      undefined,
      true,
      assistant.id,
    );
    const identifiedParts = [taskPart('task_1', 'child_1')];

    const next = buildSessionMessageRecordsSnapshot(
      state({ message: { ses_1: [assistant] }, part: { assistant_1: identifiedParts } }),
      'ses_1',
      previous,
      true,
      assistant.id,
    );

    expect(next.byId.get(assistant.id)?.parts).toBe(identifiedParts);
  });
});
