import { describe, expect, it, vi } from 'vitest';
import { __testing, generateWalkthroughText } from './inference.js';
import { OPENCHAMBER_INTERNAL_SESSION_KIND } from '../opencode/internal-sessions.js';

const result = (data) => ({ data });

const waitFor = async (predicate, { timeout = 2_000, interval = 5 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};

const assistant = ({ promptId, structured, text, finish = 'stop', error, nestedSessionId = false }) => {
  const info = {
    id: 'msg_assistant',
    sessionID: 'ses_internal',
    role: 'assistant',
    parentID: promptId,
    finish,
    time: { created: 1, completed: 2 },
  };
  if (structured !== undefined) info.structured = structured;
  if (error) info.error = error;
  return [
    ...(text === undefined ? [] : [{
      type: 'message.part.updated',
      properties: {
        ...(!nestedSessionId && { sessionID: 'ses_internal' }),
        part: { id: 'part_text', sessionID: 'ses_internal', messageID: info.id, type: 'text', text },
        time: 1,
      },
    }]),
    {
      type: 'message.updated',
      properties: { ...(!nestedSessionId && { sessionID: 'ses_internal' }), info },
    },
  ];
};

const createEventQueue = (signal) => {
  const queued = [];
  const waiters = [];
  const push = (event) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(event);
    else queued.push(event);
  };
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (signal.aborted) throw signal.reason;
        const event = queued.length > 0
          ? queued.shift()
          : await new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            waiters.push(waiter);
            signal.addEventListener('abort', () => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              reject(signal.reason);
            }, { once: true });
          });
        yield event;
      }
    },
  };
  return { push, stream };
};

const createHarness = ({ deleteError = null, events, promptError = null } = {}) => {
  const create = vi.fn(async () => result({ id: 'ses_internal' }));
  let queue;
  const subscribe = vi.fn(async (_parameters, options) => {
    queue = createEventQueue(options.signal);
    return { stream: queue.stream };
  });
  const promptAsync = vi.fn(async (request) => {
    if (promptError) return promptError;
    const published = events?.(request) ?? assistant({ promptId: request.messageID, structured: { title: 'Change' } });
    queueMicrotask(() => published.forEach(queue.push));
    return {};
  });
  const abort = vi.fn(async () => result(true));
  const remove = vi.fn(async () => deleteError ? ({ error: deleteError, response: { status: 500 } }) : result(true));
  const list = vi.fn(async () => result([]));
  const client = {
    event: { subscribe },
    session: { create, promptAsync, abort, delete: remove },
    experimental: { session: { list } },
  };
  return { client, createClient: () => client, create, subscribe, promptAsync, abort, remove, list };
};

const generate = (harness, overrides = {}) => generateWalkthroughText({
  prompt: 'prompt',
  system: 'system',
  directory: '/repo',
  model: { providerID: 'plugin-provider', modelID: 'plugin-model' },
  responseSchema: { type: 'object' },
  timeoutMs: 1_000,
  baseUrl: 'http://opencode',
  createClient: harness.createClient,
  ...overrides,
});

describe('walkthrough OpenCode inference', () => {
  it('normalizes SDK endpoint and assistant error shapes', () => {
    const cases = [
      [{ name: 'MessageOutputLengthError', data: {} }, 'output-exhausted'],
      [{ name: 'ContextOverflowError', data: { message: 'context too long' } }, 'context-too-small'],
      [{ name: 'ProviderAuthError', data: { providerID: 'p', message: 'login required' } }, 'no-provider-login'],
      [{ name: 'StructuredOutputError', data: { message: 'could not match schema' } }, 'structured-output-unsupported'],
      [{ name: 'APIError', data: { message: 'response_format json_schema is not supported', statusCode: 400 } }, 'structured-output-unsupported'],
    ];
    for (const [payload, code] of cases) {
      expect(__testing.normalizedOpenCodeError(payload, 'test').code).toBe(code);
    }
    expect(__testing.normalizedOpenCodeError({
      name: 'StructuredOutputError', data: { message: 'could not match schema' },
    }, 'test').schemaRefusal).toBe(true);
    expect(__testing.normalizedOpenCodeError({
      name: 'APIError', data: { message: 'invalid model', statusCode: 400 },
    }, 'test')).toMatchObject({ status: 400, statusCode: 502 });
  });

  it('subscribes before prompting and returns structured output without polling messages', async () => {
    const harness = createHarness();

    await expect(generate(harness)).resolves.toEqual({ text: '{"title":"Change"}' });

    expect(harness.subscribe.mock.invocationCallOrder[0]).toBeLessThan(harness.promptAsync.mock.invocationCallOrder[0]);
    expect(harness.client.session.messages).toBeUndefined();
    expect(harness.client.session.status).toBeUndefined();
    expect(harness.create).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { openchamber: { internalSession: { kind: OPENCHAMBER_INTERNAL_SESSION_KIND, version: 1 } } },
      permission: [{ permission: '*', pattern: '*', action: 'deny' }],
    }), expect.anything());
    expect(harness.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.objectContaining({ bash: false, question: false, read: false, write: false }),
      format: { type: 'json_schema', schema: { type: 'object' } },
    }), expect.anything());
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it('correlates text parts to the assistant child and replaces repeated part updates', async () => {
    const harness = createHarness({
      events: (request) => [
        ...assistant({ promptId: 'other', structured: { ignored: true } }),
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'ses_internal',
            part: { id: 'part_text', sessionID: 'ses_internal', messageID: 'msg_assistant', type: 'text', text: 'old' },
            time: 1,
          },
        },
        ...assistant({ promptId: request.messageID, text: 'new' }),
      ],
    });

    await expect(generate(harness, { responseSchema: undefined })).resolves.toEqual({ text: 'new' });
  });

  it('correlates canonical message events whose session ID is nested in the payload', async () => {
    const harness = createHarness({
      events: (request) => assistant({
        promptId: request.messageID,
        text: 'nested event result',
        nestedSessionId: true,
      }),
    });

    await expect(generate(harness, { responseSchema: undefined })).resolves.toEqual({ text: 'nested event result' });
  });

  it('rejects message events whose outer and nested session IDs conflict', async () => {
    const harness = createHarness({
      events: (request) => [
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'ses_other',
            part: { id: 'part_wrong', sessionID: 'ses_internal', messageID: 'msg_assistant', type: 'text', text: 'wrong' },
          },
        },
        {
          type: 'message.updated',
          properties: {
            sessionID: 'ses_other',
            info: {
              id: 'msg_wrong',
              sessionID: 'ses_internal',
              role: 'assistant',
              parentID: request.messageID,
              structured: { title: 'Wrong' },
              finish: 'stop',
              time: { created: 1, completed: 2 },
            },
          },
        },
        ...assistant({ promptId: request.messageID, text: 'right', nestedSessionId: true }),
      ],
    });

    await expect(generate(harness, { responseSchema: undefined })).resolves.toEqual({ text: 'right' });
  });

  it('maps a correlated terminal assistant error', async () => {
    const harness = createHarness({
      events: (request) => assistant({
        promptId: request.messageID,
        error: { name: 'ProviderAuthError', data: { providerID: 'p', message: 'login required' } },
      }),
    });

    await expect(generate(harness)).rejects.toMatchObject({ code: 'no-provider-login', statusCode: 401 });
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it('maps output exhaustion from the terminal assistant event', async () => {
    const harness = createHarness({
      events: (request) => assistant({ promptId: request.messageID, text: '', finish: 'length' }),
    });

    await expect(generate(harness)).rejects.toMatchObject({ code: 'output-exhausted' });
  });

  it('aborts on explicit cancellation and still attempts deletion', async () => {
    const harness = createHarness({ events: () => [] });
    const controller = new AbortController();
    const running = generate(harness, { signal: controller.signal, timeoutMs: 5_000 });
    await waitFor(() => harness.promptAsync.mock.calls.length === 1);
    controller.abort();

    await expect(running).rejects.toThrow();
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it('aborts the OpenCode turn when the generation deadline expires', async () => {
    const harness = createHarness({ events: () => [] });

    await expect(generate(harness, { timeoutMs: 5 })).rejects.toThrow();
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it('maps a prompt endpoint error and cleans up the accepted turn', async () => {
    const harness = createHarness({
      promptError: {
        error: { name: 'ProviderAuthError', data: { providerID: 'p', message: 'login required' } },
        response: { status: 401 },
      },
    });

    await expect(generate(harness)).rejects.toMatchObject({ code: 'no-provider-login', statusCode: 401 });
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it('does not replace a successful result when cleanup fails', async () => {
    const harness = createHarness({ deleteError: new Error('cleanup failed') });
    await expect(generate(harness)).resolves.toEqual({ text: '{"title":"Change"}' });
  });

  it('deletes a marked orphan before generation', async () => {
    __testing.requireOrphanCleanup();
    const harness = createHarness();
    harness.list.mockResolvedValue(result([
      {
        id: 'ses_orphan',
        directory: '/repo',
        metadata: { openchamber: { internalSession: { kind: OPENCHAMBER_INTERNAL_SESSION_KIND } } },
      },
    ]));

    await generate(harness);

    expect(harness.abort.mock.calls.some(([request]) => request.sessionID === 'ses_orphan')).toBe(true);
    expect(harness.remove.mock.calls.some(([request]) => request.sessionID === 'ses_orphan')).toBe(true);
  });
});
