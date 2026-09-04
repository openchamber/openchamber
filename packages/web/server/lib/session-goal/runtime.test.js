import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionGoalRuntime } from './runtime.js';

const SESSION_ID = 'ses_parent';
const CHILD_ID = 'ses_child';
const DIRECTORY = '/workspace';

const goal = {
  id: 'goal_1',
  objective: 'Finish the task',
  status: 'active',
  turnsUsed: 1,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  id: SESSION_ID,
  directory: DIRECTORY,
  metadata: { openchamber: { goal } },
};

const createApi = (overrides = {}) => {
  let metadata = structuredClone(session.metadata);
  const calls = [];
  const api = {
    supportsSessionMetadata: () => true,
    getSession: async (sessionID) => {
      calls.push(`session:${sessionID}`);
      return { ...session, metadata };
    },
    getSessionStatus: async (sessionID) => {
      calls.push(`status:${sessionID}`);
      return { kind: 'authoritative', status: { type: 'idle' } };
    },
    listSessionChildren: async (sessionID) => {
      calls.push(`children:${sessionID}`);
      return [];
    },
    listMessages: async (input) => {
      calls.push(`messages:${input.sessionID}`);
      return { messages: [] };
    },
    mergeSessionMetadata: async (sessionID, _directory, mutate) => {
      calls.push(`metadata:${sessionID}`);
      metadata = await mutate(metadata);
      return metadata;
    },
    sendPrompt: async () => true,
    ...overrides,
  };
  return { api, calls, getMetadata: () => metadata };
};

const startIdleTick = async (openCodeApi) => {
  const getSmallModelService = vi.fn();
  const runtime = createSessionGoalRuntime({
    openCodeApi,
    getSmallModelService,
    isEnabled: () => true,
    idleQuietMs: 10,
  });
  runtime.processPayload({
    type: 'session.status',
    properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
  });
  await vi.runOnlyPendingTimersAsync();
  return { runtime, getSmallModelService };
};

describe('session goal live activity gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for the next parent idle when the parent resumed during the quiet window', async () => {
    const { api, calls } = createApi({
      getSessionStatus: async (sessionID) => {
        calls.push(`status:${sessionID}`);
        return { kind: 'authoritative', status: { type: 'busy' } };
      },
    });
    const { runtime, getSmallModelService } = await startIdleTick(api);

    expect(calls).toEqual([`session:${SESSION_ID}`, `status:${SESSION_ID}`]);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
    runtime.stop();
  });

  it('waits for the parent result cycle while a direct child is working', async () => {
    const { api, calls } = createApi({
      listSessionChildren: async (sessionID) => {
        calls.push(`children:${sessionID}`);
        return [{ id: CHILD_ID, parentID: SESSION_ID }];
      },
      getSessionStatus: async (sessionID) => {
        calls.push(`status:${sessionID}`);
        return { kind: 'authoritative', status: { type: sessionID === CHILD_ID ? 'busy' : 'idle' } };
      },
    });
    const { runtime, getSmallModelService } = await startIdleTick(api);

    expect(calls).toEqual([
      `session:${SESSION_ID}`,
      `status:${SESSION_ID}`,
      `children:${SESSION_ID}`,
      `status:${CHILD_ID}`,
    ]);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(4);
    runtime.stop();
  });

  it('retries the quiet window when live status cannot be read', async () => {
    const { api, calls } = createApi({
      getSessionStatus: async (sessionID) => {
        calls.push(`status:${sessionID}`);
        return { kind: 'unavailable', error: new Error('unavailable') };
      },
    });
    const { runtime, getSmallModelService } = await startIdleTick(api);

    expect(calls).toEqual([`session:${SESSION_ID}`, `status:${SESSION_ID}`]);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([
      `session:${SESSION_ID}`,
      `status:${SESSION_ID}`,
      `session:${SESSION_ID}`,
      `status:${SESSION_ID}`,
    ]);
    runtime.stop();
  });

  it('audits normally when the idle parent has no working children', async () => {
    const { api, getMetadata } = createApi({
      listMessages: async () => ({
        messages: [{
          info: {
            id: 'msg_assistant',
            sessionID: SESSION_ID,
            role: 'assistant',
            providerID: 'provider',
            modelID: 'model',
            time: { completed: 2 },
            tokens: { input: 1, output: 1, cache: { read: 0 } },
          },
          parts: [{ type: 'text', text: 'The task is verified complete.' }],
        }],
      }),
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Task verified complete"}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    const runtime = createSessionGoalRuntime({
      openCodeApi: api,
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    const writtenGoal = getMetadata().openchamber.goal;
    expect(writtenGoal).toMatchObject({
      status: 'complete',
      evaluationProviderID: 'provider',
      evaluationModelID: 'model',
    });
    runtime.stop();
  });
});
