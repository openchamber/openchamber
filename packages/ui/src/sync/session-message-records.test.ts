import { describe, expect, test } from 'bun:test';
import type { Message, Part, Session } from '@/lib/opencode/model';

import { buildSessionMessageRecordsSnapshot } from './sync-context';
import { INITIAL_STATE, type State } from './types';

// v2 messages carry no `parentID`; the argument is kept only so the fixtures
// still read as "this reply belongs to that prompt".
const message = (id: string, role: 'user' | 'assistant', _parentID?: string, created = 1): Message =>
  role === 'user'
    ? { id, role, sessionID: 'ses_1', time: { created } }
    : { id, role, sessionID: 'ses_1', time: { created }, agent: 'build', providerID: 'provider', modelID: 'model' };

const textPart = (id: string, text: string): Part => ({
  id,
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'text',
  text,
});

const taskPart = (id: string, sessionId?: string): Part => ({
  id,
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'tool',
  callID: id,
  tool: 'task',
  state: {
    status: 'running',
    input: {},
    time: { start: 1 },
    metadata: sessionId ? { sessionId } : {},
  },
});

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_1',
  projectID: 'proj_1',
  directory: '/repo',
  title: 'Session',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...overrides,
});

const state = (partial: Partial<State>): State => ({
  ...INITIAL_STATE,
  ...partial,
});

describe('buildSessionMessageRecordsSnapshot', () => {
  test('renders and reverts a rollover-spanning transcript by array chronology', () => {
    const before = message('msg_ffffffffffffBefore', 'user', undefined, 100);
    const marker = message('msg_000000000000Marker', 'user', undefined, 200);
    const after = message('msg_000000000001After', 'assistant', marker.id, 300);

    const snapshot = buildSessionMessageRecordsSnapshot(
      state({
        session: [session({ revert: { messageID: marker.id } })],
        message: { ses_1: [before, marker, after] },
      }),
      'ses_1',
    );

    expect(snapshot.list.map((record) => record.info.id)).toEqual([before.id]);
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
