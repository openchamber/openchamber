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

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const requestPath = (input) => new URL(typeof input === 'string' ? input : input.url).pathname;

const startIdleTick = async (fetchImpl) => {
  const getSmallModelService = vi.fn();
  vi.stubGlobal('fetch', fetchImpl);
  const runtime = createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
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

const assistantMessage = (id, infoOverrides = {}) => ({
  info: {
    id,
    sessionID: SESSION_ID,
    role: 'assistant',
    providerID: 'provider',
    modelID: 'model',
    time: { created: 2, completed: 2 },
    tokens: { input: 1, output: 1, cache: { read: 0 } },
    ...infoOverrides,
  },
  parts: [{ type: 'text', text: 'The agent made progress.' }],
});

const createRuntimeHarness = ({ messages, messageFactory, goalOverrides = {}, maxAutoTurns = 20 }) => {
  const requests = [];
  let messageFetchCount = 0;
  const activeSession = {
    ...session,
    metadata: { openchamber: { goal: { ...goal, ...goalOverrides } } },
  };
  const service = {
    generateSmallModelText: vi.fn(async () => ({
      text: '{"verdict":"continue","note":"More work remains"}',
      providerID: 'provider',
      modelID: 'model',
    })),
  };
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const pathname = requestPath(input);
    requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
    if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
      activeSession.metadata = JSON.parse(init.body).metadata;
      return jsonResponse(activeSession);
    }
    if (pathname === `/session/${SESSION_ID}`) return jsonResponse(activeSession);
    if (pathname === '/session/status') return jsonResponse({});
    if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
    if (pathname === `/session/${SESSION_ID}/message`) {
      const nextMessages = messageFactory ? messageFactory(messageFetchCount) : messages;
      messageFetchCount += 1;
      return jsonResponse(nextMessages);
    }
    if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse({ ok: true });
    throw new Error(`Unexpected request: ${pathname}`);
  });
  vi.stubGlobal('fetch', fetchImpl);
  const runtime = createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService: async () => service,
    isEnabled: () => true,
    idleQuietMs: 10,
    maxAutoTurns,
  });
  return { runtime, requests, service, activeSession };
};

const runIdleTick = async (runtime) => {
  runtime.processPayload({
    type: 'session.status',
    properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
  });
  await vi.runOnlyPendingTimersAsync();
};

const lastPatchedGoal = (requests) => {
  const patches = requests.filter((request) => request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH');
  expect(patches.length).toBeGreaterThan(0);
  return JSON.parse(patches.at(-1).body).metadata.openchamber.goal;
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
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(2);
    runtime.stop();
  });

  it('waits for the parent result cycle while a direct child is working', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [CHILD_ID]: { type: 'busy' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([{ id: CHILD_ID, parentID: SESSION_ID }]);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
    ]);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(3);
    runtime.stop();
  });

  it('retries the quiet window when live status cannot be read', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ error: 'unavailable' }, 503);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}`,
      '/session/status',
    ]);
    runtime.stop();
  });

  it('audits normally when the idle parent has no working children', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        return jsonResponse([{
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
        }]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Task verified complete"}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
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
    const patch = requests.find((request) => request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH');
    expect(patch).toBeDefined();
    const writtenGoal = JSON.parse(patch.body).metadata.openchamber.goal;
    expect(writtenGoal).toMatchObject({
      status: 'complete',
      evaluationProviderID: 'provider',
      evaluationModelID: 'model',
    });
    runtime.stop();
  });

  it('skips audit and sends continuation prompt when assistant message finishes with length stop', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse({ ok: true });
      if (pathname === `/session/${SESSION_ID}/message`) {
        return jsonResponse([{
          info: {
            id: 'msg_assistant_len',
            sessionID: SESSION_ID,
            role: 'assistant',
            providerID: 'provider',
            modelID: 'model',
            finish: 'length',
            time: { completed: 2 },
            tokens: { input: 100, output: 4096, reasoning: 4096, cache: { read: 0 } },
          },
          parts: [{ type: 'reasoning', text: 'Drafting extensive implementation...' }],
        }]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(),
    };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    // Audit must be skipped on length-truncated turn
    expect(service.generateSmallModelText).not.toHaveBeenCalled();

    // Goal accounting is persisted and turnsUsed incremented
    const patch = requests.find((request) => request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH');
    expect(patch).toBeDefined();
    const writtenGoal = JSON.parse(patch.body).metadata.openchamber.goal;
    expect(writtenGoal).toMatchObject({
      status: 'active',
      turnsUsed: 2,
    });

    // Continuation prompt is dispatched
    const promptAsync = requests.find((request) => request.pathname === `/session/${SESSION_ID}/prompt_async` && request.method === 'POST');
    expect(promptAsync).toBeDefined();
    const promptBody = JSON.parse(promptAsync.body);
    expect(promptBody.parts[0].text).toContain('Continue working toward the active session goal.');
    runtime.stop();
  });

  it('skips audit and sends continuation prompt when assistant message carries MessageOutputLengthError', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse({ ok: true });
      if (pathname === `/session/${SESSION_ID}/message`) {
        return jsonResponse([{
          info: {
            id: 'msg_assistant_len_err',
            sessionID: SESSION_ID,
            role: 'assistant',
            providerID: 'provider',
            modelID: 'model',
            error: { name: 'MessageOutputLengthError', message: 'Maximum token limit reached' },
            time: { completed: 2 },
            tokens: { input: 100, output: 4096, reasoning: 4096, cache: { read: 0 } },
          },
          parts: [{ type: 'reasoning', text: 'Drafting extensive implementation...' }],
        }]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(),
    };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    // Audit must be skipped on MessageOutputLengthError
    expect(service.generateSmallModelText).not.toHaveBeenCalled();

    // Goal remains active and turnsUsed incremented
    const patch = requests.find((request) => request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH');
    expect(patch).toBeDefined();
    const writtenGoal = JSON.parse(patch.body).metadata.openchamber.goal;
    expect(writtenGoal).toMatchObject({
      status: 'active',
      turnsUsed: 2,
    });

    // Continuation prompt is dispatched
    const promptAsync = requests.find((request) => request.pathname === `/session/${SESSION_ID}/prompt_async` && request.method === 'POST');
    expect(promptAsync).toBeDefined();
    runtime.stop();
  });

  it.each([
    { name: 'APIError', error: { name: 'APIError', message: 'provider failed' } },
    { name: 'StructuredOutputError', error: { name: 'StructuredOutputError', message: 'invalid output' } },
    { name: 'unnamed errors', error: {} },
  ])('blocks a length finish when the assistant also has a non-length $name', async ({ error }) => {
    const { runtime, requests, service } = createRuntimeHarness({
      messages: [assistantMessage('msg_assistant_error', { finish: 'length', error })],
    });

    await runIdleTick(runtime);

    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.some((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toBe(false);
    expect(lastPatchedGoal(requests)).toMatchObject({
      status: 'blocked',
      statusReason: error.name || 'assistant turn failed',
    });
    runtime.stop();
  });

  it('blocks after two consecutive length-truncated agent turns without persisting a counter, regardless of message IDs', async () => {
    const firstLength = assistantMessage('z', { finish: 'length', time: { created: 10, completed: 11 } });
    const summary = assistantMessage('summary', { summary: true, time: { created: 15, completed: 16 } });
    const secondLength = assistantMessage('a', { finish: 'length', time: { created: 20, completed: 21 } });
    const { runtime, requests, service } = createRuntimeHarness({
      messageFactory: (fetchCount) => fetchCount < 2 ? [firstLength] : [firstLength, summary, secondLength],
    });

    await runIdleTick(runtime);
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.filter((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toHaveLength(1);
    expect(lastPatchedGoal(requests)).toMatchObject({
      status: 'blocked',
      statusReason: 'repeated output truncation',
    });
    runtime.stop();
  });

  it('allows one explicit Resume after repeated truncation, then blocks another cutoff', async () => {
    const first = assistantMessage('first', { finish: 'length', time: { created: 10, completed: 11 } });
    const second = assistantMessage('second', { finish: 'length', time: { created: 20, completed: 21 } });
    const messages = [first, second];
    const { runtime, requests, activeSession } = createRuntimeHarness({ messages });
    try {
      await runIdleTick(runtime);
      expect(lastPatchedGoal(requests).status).toBe('blocked');
      expect(requests.filter((request) => request.pathname.endsWith('/prompt_async'))).toHaveLength(0);
      Object.assign(activeSession.metadata.openchamber.goal, { status: 'active', statusReason: 'resumed', turnsUsed: 0 });
      await runIdleTick(runtime);
      expect(lastPatchedGoal(requests)).toMatchObject({ status: 'active', statusReason: '', turnsUsed: 1 });
      expect(requests.filter((request) => request.pathname.endsWith('/prompt_async'))).toHaveLength(1);
      messages.push(assistantMessage('third', { finish: 'length', time: { created: 30, completed: 31 } }));
      await runIdleTick(runtime);
      expect(lastPatchedGoal(requests)).toMatchObject({ status: 'blocked', statusReason: 'repeated output truncation' });
      expect(requests.filter((request) => request.pathname.endsWith('/prompt_async'))).toHaveLength(1);
    } finally {
      runtime.stop();
    }
  });

  it.each([
    { tokenBudget: 1, error: undefined, expectedStatus: 'budgetLimited' },
    { tokenBudget: null, error: { name: 'APIError' }, expectedStatus: 'blocked' },
  ])('keeps $expectedStatus protection on explicit Resume', async ({ tokenBudget, error, expectedStatus }) => {
    const { runtime, requests } = createRuntimeHarness({
      goalOverrides: { statusReason: 'resumed', tokenBudget },
      messages: [assistantMessage('resumed', { finish: 'length', error })],
    });
    try {
      await runIdleTick(runtime);
      expect(lastPatchedGoal(requests).status).toBe(expectedStatus);
      expect(requests.filter((request) => request.pathname.endsWith('/prompt_async'))).toHaveLength(0);
    } finally {
      runtime.stop();
    }
  });

  it('continues after a truncated agent turn followed by a length-finished summary', async () => {
    const firstLength = assistantMessage('agent-length', { finish: 'length', time: { created: 10, completed: 11 } });
    const summary = assistantMessage('summary', {
      summary: true,
      finish: 'length',
      time: { created: 15, completed: 16 },
    });
    const { runtime, requests, service } = createRuntimeHarness({
      messageFactory: (fetchCount) => fetchCount < 2 ? [firstLength] : [firstLength, summary],
    });

    await runIdleTick(runtime);
    await runIdleTick(runtime);

    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.filter((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toHaveLength(2);
    expect(lastPatchedGoal(requests)).toMatchObject({ status: 'active' });
    runtime.stop();
  });

  it('does not infer a repeated streak when a completed assistant timestamp is missing', async () => {
    const firstLength = assistantMessage('z', { finish: 'length', time: { completed: 11 } });
    const secondLength = assistantMessage('a', { finish: 'length', time: { created: 20, completed: 21 } });
    const { runtime, requests, service } = createRuntimeHarness({
      messageFactory: (fetchCount) => fetchCount < 2 ? [firstLength] : [firstLength, secondLength],
    });

    await runIdleTick(runtime);
    await runIdleTick(runtime);

    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.filter((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toHaveLength(2);
    expect(lastPatchedGoal(requests)).toMatchObject({ status: 'active' });
    runtime.stop();
  });

  it('ignores a missing timestamp on an older assistant when known post-goal turns establish a streak', async () => {
    const olderLength = assistantMessage('legacy', { finish: 'length', time: { completed: 5 } });
    const firstLength = assistantMessage('z', { finish: 'length', time: { created: 10, completed: 11 } });
    const secondLength = assistantMessage('a', { finish: 'length', time: { created: 20, completed: 21 } });
    const { runtime, requests, service } = createRuntimeHarness({
      goalOverrides: { createdAt: 6 },
      messageFactory: (fetchCount) => fetchCount < 2 ? [firstLength] : [olderLength, firstLength, secondLength],
    });

    await runIdleTick(runtime);
    await runIdleTick(runtime);

    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.filter((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toHaveLength(1);
    expect(lastPatchedGoal(requests)).toMatchObject({
      status: 'blocked',
      statusReason: 'repeated output truncation',
    });
    runtime.stop();
  });

  it('does not count a previous truncated turn created at the goal boundary', async () => {
    const firstLength = assistantMessage('before-boundary', { finish: 'length', time: { created: 10, completed: 11 } });
    const secondLength = assistantMessage('after-boundary', { finish: 'length', time: { created: 20, completed: 21 } });
    const { runtime, requests, service } = createRuntimeHarness({
      goalOverrides: { createdAt: 10 },
      messageFactory: (fetchCount) => fetchCount < 2 ? [firstLength] : [firstLength, secondLength],
    });

    await runIdleTick(runtime);
    await runIdleTick(runtime);

    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.filter((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toHaveLength(2);
    expect(lastPatchedGoal(requests)).toMatchObject({ status: 'active' });
    runtime.stop();
  });

  it('allows length recovery after an ordinary assistant turn breaks the streak', async () => {
    const firstLength = assistantMessage('msg_length_before_normal', { finish: 'length' });
    const normal = assistantMessage('msg_normal');
    const secondLength = assistantMessage('msg_length_after_normal', { finish: 'length' });
    const { runtime, requests, service } = createRuntimeHarness({
      messageFactory: (fetchCount) => fetchCount < 2
        ? [firstLength]
        : [firstLength, normal, secondLength],
    });

    await runIdleTick(runtime);
    await runIdleTick(runtime);

    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.filter((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toHaveLength(2);
    expect(lastPatchedGoal(requests)).toMatchObject({ status: 'active' });
    runtime.stop();
  });

  it('keeps MessageAbortedError pause behavior instead of continuing', async () => {
    const { runtime, requests, service } = createRuntimeHarness({
      messages: [assistantMessage('msg_aborted', { error: { name: 'MessageAbortedError' } })],
    });

    await runIdleTick(runtime);

    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.some((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toBe(false);
    expect(lastPatchedGoal(requests)).toMatchObject({
      status: 'paused',
      statusReason: 'paused after abort',
    });
    runtime.stop();
  });

  it('checks the token budget before allowing length recovery', async () => {
    const { runtime, requests, service } = createRuntimeHarness({
      goalOverrides: { tokenBudget: 5 },
      messages: [assistantMessage('msg_budget_length', {
        finish: 'length',
        tokens: { input: 3, output: 3, cache: { read: 0 } },
      })],
    });

    await runIdleTick(runtime);

    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.some((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toBe(false);
    expect(lastPatchedGoal(requests)).toMatchObject({ status: 'budgetLimited' });
    runtime.stop();
  });

  it('checks the auto-continuation cap before allowing length recovery', async () => {
    const { runtime, requests, service } = createRuntimeHarness({
      maxAutoTurns: 1,
      messages: [assistantMessage('msg_cap_length', { finish: 'length' })],
    });

    await runIdleTick(runtime);

    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.some((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toBe(false);
    expect(lastPatchedGoal(requests)).toMatchObject({
      status: 'blocked',
      statusReason: 'auto-continuation limit reached',
    });
    runtime.stop();
  });
});
