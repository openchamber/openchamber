import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionGoalRuntime } from './runtime.js';

const SESSION_ID = 'ses_parent';
const CHILD_ID = 'ses_child';
const DIRECTORY = '/workspace';
const readGoalObjective = vi.fn(async () => null);

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

const requestPath = (input) => new URL(input?.url ?? input).pathname;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const startIdleTick = async (fetchImpl, options = {}) => {
  const getSmallModelService = vi.fn();
  vi.stubGlobal('fetch', fetchImpl);
  const runtime = createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService,
    isEnabled: () => true,
    idleQuietMs: 10,
    ...options,
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
    readGoalObjective.mockReset();
    readGoalObjective.mockResolvedValue(null);
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
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' }, [CHILD_ID]: { type: 'busy' } });
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
    }), { retryDelaysMs: [10, 20], maxRetryAttempts: 2 });

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}`,
      '/session/status',
    ]);
    await vi.advanceTimersByTimeAsync(20);
    expect(paths.filter((path) => path === '/session/status')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(paths.filter((path) => path === '/session/status')).toHaveLength(3);
    runtime.stop();
  });

  it.each([null, [], { [SESSION_ID]: null }, { [SESSION_ID]: { type: 'unknown' } }])('treats %j status responses as unknown and retries', async (malformedStatus) => {
    let statusAttempts = 0;
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') {
        statusAttempts += 1;
        return statusAttempts === 1 ? jsonResponse(malformedStatus) : jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(statusAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(statusAttempts).toBe(2);
    runtime.stop();
  });

  it('recovers when a target status event is unknown before a valid idle event', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    const audit = vi.fn(async () => ({
      text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
    }));
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Verified.' }],
    };
    let statusAttempts = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') {
        statusAttempts += 1;
        return statusAttempts === 1
          ? jsonResponse({ [SESSION_ID]: { type: 'mystery' } })
          : jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'mystery' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(audit).not.toHaveBeenCalled();

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(audit).toHaveBeenCalledOnce();
    expect(currentGoal.status).toBe('complete');
    runtime.stop();
  });

  it('keeps an unknown unrelated status event isolated from the target session', async () => {
    const audit = vi.fn(async () => ({
      text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
    }));
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Verified.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
       if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_unrelated', status: { type: 'mystery' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(audit).toHaveBeenCalledOnce();
    expect(currentGoal.status).toBe('complete');
    runtime.stop();
  });

  it('ignores malformed unrelated status entries while preserving a valid target status', async () => {
    const audit = vi.fn(async () => ({ text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model' }));
    let currentGoal = goal;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({
        [SESSION_ID]: { type: 'idle' },
        unrelated: { type: 'unknown' },
      });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Verified.' }],
      }]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(audit).toHaveBeenCalledOnce();
    expect(currentGoal.status).toBe('complete');
    runtime.stop();
  });

  it.each([null, {}])('treats %j session responses as unknown and retries', async (malformedSession) => {
    let sessionAttempts = 0;
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}`) {
        sessionAttempts += 1;
        return sessionAttempts === 1 ? jsonResponse(malformedSession) : jsonResponse(session);
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(sessionAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionAttempts).toBe(2);
    runtime.stop();
  });

  it('retries an id-only session response while an active goal is known', async () => {
    let sessionReads = 0;
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    const audit = vi.fn(async () => ({
      text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
    }));
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Verified.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        return sessionReads === 1
          ? jsonResponse({ id: SESSION_ID })
          : jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });

    runtime.processPayload({ type: 'session.updated', properties: { info: { ...session } } });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(sessionReads).toBe(1);
    expect(audit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);

    expect(audit).toHaveBeenCalledOnce();
    expect(currentGoal.status).toBe('complete');
    expect(sessionReads).toBe(3);
    runtime.stop();
  });

  it('accepts an id-only session response when no active goal is known', async () => {
    let sessionReads = 0;
    const audit = vi.fn();
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        return jsonResponse({ id: SESSION_ID });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(100);

    expect(sessionReads).toBe(1);
    expect(audit).not.toHaveBeenCalled();
    runtime.stop();
  });

  it.each([null, {}])('retries a terminal goal write after a malformed authoritative session response (%j)', async (malformedSession) => {
    let sessionReads = 0;
    let currentGoal = goal;
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        return sessionReads === 2
          ? jsonResponse(malformedSession)
          : jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Verified.' }],
      }]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
      })),
    };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10);
    expect(currentGoal).toMatchObject({ status: 'complete', statusReason: 'verified by audit' });
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    runtime.stop();
  });

  it.each([
    {
      status: 'complete',
      audit: { text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model' },
      statusReason: 'verified by audit',
    },
    {
      status: 'budgetLimited',
      goal: { tokenBudget: 1 },
      statusReason: 'token budget reached',
    },
    {
      status: 'blocked',
      assistantError: { name: 'ProviderError' },
      statusReason: 'ProviderError',
    },
  ])('reconciles a committed $status settlement after its PATCH response is lost exactly once', async ({ status, audit, goal: goalOverrides = {}, assistantError, statusReason }) => {
    let currentGoal = { ...goal, ...goalOverrides, lastAccountedMessageID: '' };
    let patchAttempts = 0;
    let promptAttempts = 0;
    const emitGoalNotification = vi.fn();
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 },
        tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: status === 'complete' ? 'Verified.' : 'More work remains.' }],
    };
    if (assistantError) assistant.info.error = assistantError;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        patchAttempts += 1;
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        throw new Error('terminal response lost');
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: vi.fn(async () => audit),
      }),
      emitGoalNotification,
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(patchAttempts).toBe(1);
    expect(emitGoalNotification).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(emitGoalNotification).toHaveBeenCalledOnce());
    expect(currentGoal).toMatchObject({ status, statusReason });
    expect(patchAttempts).toBe(1);
    expect(promptAttempts).toBe(0);

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(patchAttempts).toBe(1);
    expect(promptAttempts).toBe(0);
    expect(emitGoalNotification).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it.each([
    {
      status: 'complete',
      audit: { text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model' },
      statusReason: 'verified by audit',
    },
    {
      status: 'budgetLimited',
      goal: { tokenBudget: 1 },
      statusReason: 'token budget reached',
    },
    {
      status: 'blocked',
      assistantError: { name: 'ProviderError' },
      statusReason: 'ProviderError',
    },
  ])('reconciles a committed $status settlement from session.updated exactly once', async ({ status, audit, goal: goalOverrides = {}, assistantError, statusReason }) => {
    let currentGoal = { ...goal, ...goalOverrides, lastAccountedMessageID: '' };
    let patchAttempts = 0;
    let promptAttempts = 0;
    const emitGoalNotification = vi.fn();
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 },
        tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: status === 'complete' ? 'Verified.' : 'More work remains.' }],
    };
    if (assistantError) assistant.info.error = assistantError;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        patchAttempts += 1;
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        throw new Error('terminal response lost');
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: vi.fn(async () => audit),
      }),
      emitGoalNotification,
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(patchAttempts).toBe(1);
    expect(emitGoalNotification).not.toHaveBeenCalled();

    const settlementEvent = {
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          time: { updated: 4 },
          metadata: { openchamber: { goal: currentGoal } },
        },
      },
    };
    runtime.processPayload(settlementEvent);
    expect(emitGoalNotification).toHaveBeenCalledOnce();
    expect(currentGoal).toMatchObject({ status, statusReason });

    runtime.processPayload(settlementEvent);
    await vi.advanceTimersByTimeAsync(100);
    expect(patchAttempts).toBe(1);
    expect(promptAttempts).toBe(0);
    expect(emitGoalNotification).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it.each([
    {
      status: 'complete',
      audit: { text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model' },
      statusReason: 'verified by audit',
    },
    {
      status: 'budgetLimited',
      goal: { tokenBudget: 1 },
      statusReason: 'token budget reached',
    },
    {
      status: 'blocked',
      assistantError: { name: 'ProviderError' },
      statusReason: 'ProviderError',
    },
  ])('does not finalize $status twice when its event arrives before PATCH success', async ({ status, audit, goal: goalOverrides = {}, assistantError, statusReason }) => {
    let currentGoal = { ...goal, ...goalOverrides, lastAccountedMessageID: '' };
    const terminalPatch = deferred();
    let patchAttempts = 0;
    let promptAttempts = 0;
    const emitGoalNotification = vi.fn();
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 },
        tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: status === 'complete' ? 'Verified.' : 'More work remains.' }],
    };
    if (assistantError) assistant.info.error = assistantError;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        patchAttempts += 1;
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return terminalPatch.promise;
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: vi.fn(async () => audit),
      }),
      emitGoalNotification,
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(patchAttempts).toBe(1);
    expect(emitGoalNotification).not.toHaveBeenCalled();

    runtime.processPayload({
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          time: { updated: 4 },
          metadata: { openchamber: { goal: currentGoal } },
        },
      },
    });
    expect(emitGoalNotification).toHaveBeenCalledOnce();
    expect(currentGoal).toMatchObject({ status, statusReason });

    terminalPatch.resolve(jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } }));
    await flushMicrotasks();
    expect(patchAttempts).toBe(1);
    expect(promptAttempts).toBe(0);
    expect(emitGoalNotification).toHaveBeenCalledOnce();

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(patchAttempts).toBe(1);
    expect(promptAttempts).toBe(0);
    expect(emitGoalNotification).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('re-arms when the authoritative session fetch fails', async () => {
    let sessionAttempts = 0;
    const paths = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) {
        sessionAttempts += 1;
        return sessionAttempts === 1 ? jsonResponse({ error: 'unavailable' }, 503) : jsonResponse(session);
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(10);
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      `/session/${SESSION_ID}`,
      '/session/status',
    ]);
    runtime.stop();
  });

  it.each([
    ['session', `/session/${SESSION_ID}`],
    ['status', '/session/status'],
    ['children', `/session/${SESSION_ID}/children`],
    ['message', `/session/${SESSION_ID}/message`],
  ])('bounds %s fetch retries with exponential delays', async (_label, failingPath) => {
    let failures = 0;
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      if (pathname === failingPath) {
        if (failures < 3) {
          failures += 1;
          return jsonResponse({ error: 'unavailable' }, 503);
        }
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10, 20],
      maxRetryAttempts: 2,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    expect(failures).toBe(3);
    const requestsAfterExhaustion = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl.mock.calls).toHaveLength(requestsAfterExhaustion);
    runtime.stop();
  });

  it.each([
    ['fetchSession', `/session/${SESSION_ID}`],
    ['fetchSessionStatuses', '/session/status'],
    ['children', `/session/${SESSION_ID}/children`],
    ['fetchRecentMessages', `/session/${SESSION_ID}/message`],
  ])('terminalizes an active goal after %s retry exhaustion without a reservation', async (_label, failingPath) => {
    let currentGoal = { ...goal, updatedAt: 1 };
    let failures = 0;
    let blockedWrites = 0;
    let promptAttempts = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === failingPath && (init.method ?? 'GET') === 'GET' && failures < 3) {
        failures += 1;
        return jsonResponse({ error: 'unavailable' }, 503);
      }
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (currentGoal.status === 'blocked') blockedWrites += 1;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return new Response(null, { status: 204 });
      }
      if (pathname === `/session/${SESSION_ID}/message`) {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: vi.fn(),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxRetryAttempts: 2,
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 1 }, metadata: { openchamber: { goal: currentGoal } } } },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    expect(failures).toBe(3);
    expect(currentGoal).toMatchObject({
      status: 'blocked',
      statusReason: 'fetch retry limit reached',
    });
    expect(blockedWrites).toBe(1);
    expect(promptAttempts).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const requestsAfterSettlement = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl.mock.calls).toHaveLength(requestsAfterSettlement);
    expect(currentGoal.status).toBe('blocked');
    runtime.stop();
  });

  it('does not overwrite a newer goal revision during fetch-exhaustion terminalization', async () => {
    const originalGoal = { ...goal, updatedAt: 1 };
    const newerGoal = { ...originalGoal, statusReason: 'resumed', updatedAt: 2 };
    let currentGoal = originalGoal;
    let sessionReads = 0;
    let statusFailures = 0;
    let blockedWrites = 0;
    let promptAttempts = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        blockedWrites += 1;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        if (sessionReads === 5) currentGoal = newerGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') {
        if (statusFailures < 3) {
          statusFailures += 1;
          return jsonResponse({ error: 'unavailable' }, 503);
        }
        return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: vi.fn(),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxRetryAttempts: 2,
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 1 }, metadata: { openchamber: { goal: originalGoal } } } },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    expect(currentGoal).toEqual(newerGoal);
    expect(blockedWrites).toBe(0);
    expect(promptAttempts).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    runtime.stop();
  });

  it('reconciles a reservation-free blocked terminalization after its PATCH response is lost', async () => {
    let currentGoal = { ...goal, updatedAt: 1 };
    let statusFailures = 0;
    let blockedWrites = 0;
    let promptAttempts = 0;
    const emitGoalNotification = vi.fn();
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'blocked') {
          blockedWrites += 1;
          currentGoal = nextGoal;
          throw new Error('blocked terminal response lost');
        }
        currentGoal = nextGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') {
        if (statusFailures < 3) {
          statusFailures += 1;
          return jsonResponse({ error: 'unavailable' }, 503);
        }
        return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: vi.fn(),
      emitGoalNotification,
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxRetryAttempts: 2,
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 1 }, metadata: { openchamber: { goal: currentGoal } } } },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    await vi.waitFor(() => expect(emitGoalNotification).toHaveBeenCalledOnce());
    expect(currentGoal).toMatchObject({
      status: 'blocked',
      statusReason: 'fetch retry limit reached',
    });
    expect(blockedWrites).toBe(1);
    expect(promptAttempts).toBe(0);

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(blockedWrites).toBe(1);
    expect(promptAttempts).toBe(0);
    expect(emitGoalNotification).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('bounds reservation-free terminalization when the blocked PATCH stays unavailable', async () => {
    let currentGoal = { ...goal, updatedAt: 1 };
    let statusFailures = 0;
    let blockedWrites = 0;
    let promptAttempts = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        blockedWrites += 1;
        throw new Error('blocked write unavailable');
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') {
        if (statusFailures < 3) {
          statusFailures += 1;
          return jsonResponse({ error: 'unavailable' }, 503);
        }
        return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: vi.fn(),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxRetryAttempts: 1,
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 1 }, metadata: { openchamber: { goal: currentGoal } } } },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    expect(currentGoal.status).toBe('active');
    expect(blockedWrites).toBe(2);
    expect(promptAttempts).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const requestsAfterExhaustion = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl.mock.calls).toHaveLength(requestsAfterExhaustion);
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

  it('propagates the last assistant provider, model, agent, and variant to continuation dispatch', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let continuationBody;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant',
        providerID: 'provider-from-message', modelID: 'model-from-message',
        agent: 'agent-from-message', variant: 'variant-from-message',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        continuationBody = JSON.parse(init.body);
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const audit = vi.fn(async () => ({
      text: '{"verdict":"continue","note":"More work remains"}', providerID: 'audit-provider', modelID: 'audit-model',
    }));
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(continuationBody).toMatchObject({
      model: { providerID: 'provider-from-message', modelID: 'model-from-message' },
      agent: 'agent-from-message',
      variant: 'variant-from-message',
    });
    runtime.stop();
  });

  it('accounts and dispatches continuation for a file-backed goal with empty metadata objective', async () => {
    const fileObjective = 'Complete the objective from the persisted file.';
    readGoalObjective.mockResolvedValue(fileObjective);
    let currentGoal = {
      ...goal,
      objective: '',
      objectiveFile: true,
      turnsUsed: 1,
      lastAccountedMessageID: '',
    };
    const assistant = {
      info: {
        id: 'msg_assistant',
        sessionID: SESSION_ID,
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        time: { completed: 2 },
        tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse(null);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      readGoalObjective,
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    await flushMicrotasks();

    const prompt = requests.find((request) => request.pathname.endsWith('/prompt_async'));
    expect(prompt).toBeDefined();
    expect(JSON.parse(prompt.body).parts[0].text).toContain(fileObjective);
    expect(currentGoal).toMatchObject({ turnsUsed: 2, lastAccountedMessageID: 'msg_assistant' });
    runtime.stop();
  });

  it('bounds missing file-backed objective retries and settles the goal as blocked', async () => {
    let currentGoal = {
      ...goal,
      objective: '',
      objectiveFile: true,
      turnsUsed: 1,
      lastAccountedMessageID: '',
    };
    let objectiveReads = 0;
    let blockedWrites = 0;
    let promptAttempts = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (currentGoal.status === 'blocked') blockedWrites += 1;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = { generateSmallModelText: vi.fn() };
    readGoalObjective.mockImplementation(async () => {
      objectiveReads += 1;
      return null;
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      readGoalObjective,
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxRetryAttempts: 2,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(objectiveReads).toBe(3);
    expect(currentGoal).toMatchObject({
      status: 'blocked',
      statusReason: 'objective file unavailable',
    });
    expect(blockedWrites).toBe(1);
    expect(promptAttempts).toBe(0);
    const attemptsAfterSettlement = objectiveReads;
    await vi.advanceTimersByTimeAsync(100);
    expect(objectiveReads).toBe(attemptsAfterSettlement);
    runtime.stop();
  });

  it('settles an assistant error as blocked without an audit', async () => {
    let currentGoal = goal;
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant_error', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 2 }, error: { name: 'ProviderError' },
        },
      }]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = { generateSmallModelText: vi.fn() };
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

    expect(currentGoal).toMatchObject({ status: 'blocked', statusReason: 'ProviderError' });
    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    expect(requests.some((request) => request.pathname.endsWith('/prompt_async'))).toBe(false);
    runtime.stop();
  });

  it('requires three consecutive blocked audit verdicts before settling', async () => {
    let currentGoal = { ...goal, blockedStreak: 0, lastAccountedMessageID: '' };
    let auditCalls = 0;
    let dispatchAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Blocked for now.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => {
        auditCalls += 1;
        return { text: '{"verdict":"blocked","note":"Need user input"}', providerID: 'provider', modelID: 'model' };
      }),
    };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    const idle = {
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    };
    runtime.processPayload(idle);
    await vi.runOnlyPendingTimersAsync();
    expect(currentGoal).toMatchObject({ status: 'active', blockedStreak: 1, turnsUsed: 2 });
    expect(dispatchAttempts).toBe(1);

    runtime.processPayload(idle);
    await vi.advanceTimersByTimeAsync(10);
    expect(currentGoal).toMatchObject({ status: 'active', blockedStreak: 2, turnsUsed: 3 });
    expect(dispatchAttempts).toBe(2);

    runtime.processPayload(idle);
    await vi.advanceTimersByTimeAsync(10);
    expect(currentGoal).toMatchObject({ status: 'blocked', blockedStreak: 0, statusReason: 'Need user input' });
    expect(auditCalls).toBe(3);
    expect(dispatchAttempts).toBe(2);
    runtime.stop();
  });

  it('allows one audit failure before blocking on the second consecutive failure', async () => {
    let currentGoal = { ...goal, auditFailStreak: 0, lastAccountedMessageID: '' };
    let dispatchAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Audit may be unavailable.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = { generateSmallModelText: vi.fn(async () => null) };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    const idle = {
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    };
    runtime.processPayload(idle);
    await vi.runOnlyPendingTimersAsync();
    expect(currentGoal).toMatchObject({ status: 'active', auditFailStreak: 1, turnsUsed: 2 });
    expect(dispatchAttempts).toBe(1);

    runtime.processPayload(idle);
    await vi.advanceTimersByTimeAsync(10);
    expect(currentGoal).toMatchObject({ status: 'blocked', auditFailStreak: 0, statusReason: 'progress audit unavailable' });
    expect(service.generateSmallModelText).toHaveBeenCalledTimes(2);
    expect(dispatchAttempts).toBe(1);
    runtime.stop();
  });

  it('keeps the idle timer when a replayed user message is older than the arm point', async () => {
    const audit = vi.fn(async () => ({
      text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
    }));
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Verified.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    vi.setSystemTime(1_000);
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    runtime.processPayload({
      type: 'message.updated',
      properties: { info: { id: 'msg_old', sessionID: SESSION_ID, role: 'user', time: { created: 999 } } },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(audit).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('invalidates an in-flight tick when a genuinely newer user message arrives', async () => {
    const audit = deferred();
    const requests = [];
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Still working.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(() => audit.promise) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    vi.setSystemTime(1_000);
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(requests).toContainEqual({ pathname: `/session/${SESSION_ID}/message`, method: 'GET' });

    runtime.processPayload({
      type: 'message.updated',
      properties: { info: { id: 'msg_new', sessionID: SESSION_ID, role: 'user', time: { created: 1_011 } } },
    });
    audit.resolve({ text: '{"verdict":"continue","note":"Keep going"}' });
    await flushMicrotasks();

    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    expect(requests.some((request) => request.pathname.endsWith('/prompt_async'))).toBe(false);
    runtime.stop();
  });

  it.each([
    ['an old user message', 1_009],
    ['a timestamp-less user message', null],
  ])('does not cancel an in-flight audit for %s', async (_label, messageCreatedAt) => {
    const audit = deferred();
    const requests = [];
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Verified.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(() => audit.promise) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    vi.setSystemTime(1_000);
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    const replayedMessageInfo = {
      id: 'msg_replayed', sessionID: SESSION_ID, role: 'user',
    };
    if (messageCreatedAt !== null) replayedMessageInfo.time = { created: messageCreatedAt };
    runtime.processPayload({
      type: 'message.updated',
      properties: { info: replayedMessageInfo },
    });
    audit.resolve({ text: '{"verdict":"complete","note":"Verified"}' });
    await flushMicrotasks();
    await vi.runOnlyPendingTimersAsync();

    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    runtime.stop();
  });

  it('invalidates an in-flight tick when an abort is accepted', async () => {
    const audit = deferred();
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant',
          sessionID: SESSION_ID,
          role: 'assistant',
          providerID: 'provider',
          modelID: 'model',
          time: { completed: 2 },
          tokens: { input: 1, output: 1, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Still working.' }],
      }]);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(() => audit.promise),
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
    await vi.advanceTimersByTimeAsync(10);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();

    runtime.processPayload({
      type: 'message.updated',
      properties: { info: { role: 'assistant', sessionID: SESSION_ID, error: { name: 'MessageAbortedError' } } },
    });
    audit.resolve({ text: '{"verdict":"continue","note":"Keep going"}' });
    await flushMicrotasks();
    await vi.runOnlyPendingTimersAsync();

    const patches = requests
      .filter((request) => request.method === 'PATCH')
      .map((request) => JSON.parse(request.body).metadata.openchamber.goal);
    expect(patches.some((writtenGoal) => writtenGoal.status === 'paused')).toBe(true);
    expect(requests.some((request) => request.pathname.endsWith('/prompt_async'))).toBe(false);
    runtime.stop();
  });

  it('rebinds a pending abort across busy/retry generations before idle', async () => {
    const audit = deferred();
    const abortSession = deferred();
    let sessionReads = 0;
    let currentGoal = goal;
    const requests = [];
    const assistant = {
      info: {
        id: 'msg_assistant',
        sessionID: SESSION_ID,
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        time: { completed: 2 },
        tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Still working.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        if (sessionReads === 2) return abortSession.promise;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse(null);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = { generateSmallModelText: vi.fn(() => audit.promise) };
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
    await vi.advanceTimersByTimeAsync(10);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();

    runtime.processPayload({
      type: 'message.updated',
      properties: { info: { role: 'assistant', sessionID: SESSION_ID, error: { name: 'MessageAbortedError' } } },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'busy' }, directory: DIRECTORY },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'retry' }, directory: DIRECTORY },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });

    audit.resolve({ text: '{"verdict":"continue","note":"Keep going"}' });
    abortSession.resolve(jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } }));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);

    expect(currentGoal).toMatchObject({ status: 'paused', statusReason: 'paused after abort' });
    expect(requests.some((request) => request.pathname.endsWith('/prompt_async'))).toBe(false);
    runtime.stop();
  });

  it.each([null, {}])('keeps pending abort state after a malformed session response (%j)', async (malformedSession) => {
    let sessionReads = 0;
    let currentGoal = goal;
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        return sessionReads === 1
          ? jsonResponse(malformedSession)
          : jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });
    runtime.processPayload({
      type: 'message.updated',
      properties: { info: { role: 'assistant', sessionID: SESSION_ID, error: { name: 'MessageAbortedError' } } },
    }, DIRECTORY);
    await flushMicrotasks();
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10);
    expect(currentGoal).toMatchObject({ status: 'paused', statusReason: 'paused after abort' });
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    runtime.stop();
  });

  it('invalidates an in-flight audit when busy status arrives', async () => {
    const audit = deferred();
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Still working.' }],
      }]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = { generateSmallModelText: vi.fn(() => audit.promise) };
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
    await vi.advanceTimersByTimeAsync(10);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'busy' }, directory: DIRECTORY },
    });
    audit.resolve({ text: '{"verdict":"continue","note":"Keep going"}' });
    await flushMicrotasks();

    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    expect(requests.some((request) => request.pathname.endsWith('/prompt_async'))).toBe(false);
    runtime.stop();
  });

  it('checks authoritative status again immediately before dispatch', async () => {
    let statusCalls = 0;
    const requests = [];
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Still working.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') {
        statusCalls += 1;
          return jsonResponse(statusCalls === 3 ? { [SESSION_ID]: { type: 'busy' } } : { [SESSION_ID]: { type: 'idle' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"Keep going"}', providerID: 'provider', modelID: 'model',
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

    expect(statusCalls).toBe(3);
    expect(requests.some((request) => request.pathname.endsWith('/prompt_async'))).toBe(false);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    runtime.stop();
  });

  it('invalidates in-flight work when a fresh goal replaces the current goal', async () => {
    const audit = deferred();
    const requests = [];
    const replacement = { ...goal, id: 'goal_2', turnsUsed: 0, createdAt: 3, updatedAt: 3 };
    let activeGoal = goal;
    let statusCalls = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: activeGoal } } });
      }
      if (pathname === '/session/status') {
        statusCalls += 1;
         return jsonResponse(statusCalls === 1 ? { [SESSION_ID]: { type: 'idle' } } : { [SESSION_ID]: { type: 'busy' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Still working.' }],
      }]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = { generateSmallModelText: vi.fn(() => audit.promise) };
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
    await vi.advanceTimersByTimeAsync(10);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();

    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, metadata: { openchamber: { goal: replacement } } } },
    });
    activeGoal = replacement;
    audit.resolve({ text: '{"verdict":"continue","note":"Keep going"}' });
    await flushMicrotasks();

    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    expect(requests.some((request) => request.pathname.endsWith('/prompt_async'))).toBe(false);
    await vi.runOnlyPendingTimersAsync();
    expect(statusCalls).toBe(2);
    runtime.stop();
  });

  it.each(['clear', 'pause', 'replacement'])('ignores a stale %s after a newer goal mutation and keeps its timer', async (kind) => {
    const newerGoal = { ...goal, id: 'goal_new', turnsUsed: 0, createdAt: 2, updatedAt: 20 };
    const staleGoal = kind === 'pause'
      ? { ...goal, status: 'paused', statusReason: 'paused by user', updatedAt: 10 }
      : { ...goal, id: 'goal_old', createdAt: 1, updatedAt: 10 };
    const paths = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: newerGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
      kickoffQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 20 }, metadata: { openchamber: { goal: newerGoal } } } },
    });
    runtime.processPayload({
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          time: { updated: 10 },
          metadata: kind === 'clear'
            ? { openchamber: {} }
            : { openchamber: { goal: staleGoal } },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    runtime.stop();
  });

  it.each(['clear', 'replacement'])('ignores a timestamp-less stale %s after a newer timestamped goal', async (kind) => {
    const newerDirectory = '/workspace-new';
    const staleDirectory = '/workspace-old';
    const newerGoal = { ...goal, id: 'goal_new', turnsUsed: 0, createdAt: 2, updatedAt: 20 };
    const staleGoal = { ...goal, id: 'goal_old', turnsUsed: 0, createdAt: 1, updatedAt: 10 };
    const targetRequests = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}`) {
        targetRequests.push(new URL(input).searchParams.get('directory'));
        return jsonResponse({
          ...session,
          directory: newerDirectory,
          metadata: { openchamber: { goal: newerGoal } },
        });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
      kickoffQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          directory: newerDirectory,
          time: { updated: 20 },
          metadata: { openchamber: { goal: newerGoal } },
        },
      },
    });
    runtime.processPayload({
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          directory: staleDirectory,
          metadata: kind === 'clear'
            ? { openchamber: {} }
            : { openchamber: { goal: staleGoal } },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(targetRequests).toEqual([newerDirectory]);
    runtime.stop();
  });

  it('rejects a stale clear after a newer replacement while an audit is in flight', async () => {
    const audit = deferred();
    const newerGoal = { ...goal, id: 'goal_new', turnsUsed: 0, createdAt: 2, updatedAt: 20 };
    let currentGoal = goal;
    let statusCalls = 0;
    const paths = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') {
        statusCalls += 1;
        return jsonResponse(statusCalls === 1 ? { [SESSION_ID]: { type: 'idle' } } : { [SESSION_ID]: { type: 'busy' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'More work remains.' }],
      }]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = { generateSmallModelText: vi.fn(() => audit.promise) };
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
    await vi.advanceTimersByTimeAsync(10);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();

    currentGoal = newerGoal;
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 20 }, metadata: { openchamber: { goal: newerGoal } } } },
    });
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 10 }, metadata: { openchamber: {} } } },
    });
    audit.resolve({ text: '{"verdict":"continue","note":"Keep going"}' });
    await flushMicrotasks();
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();

    expect(paths.filter((path) => path === `/session/${SESSION_ID}`)).toHaveLength(2);
    expect(statusCalls).toBe(2);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('prevents writes and dispatch after stop during in-flight work', async () => {
    const audit = deferred();
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
        },
      }]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = { generateSmallModelText: vi.fn(() => audit.promise) };
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
    await vi.advanceTimersByTimeAsync(10);
    runtime.stop();
    audit.resolve({ text: '{"verdict":"continue","note":"Keep going"}' });
    await flushMicrotasks();

    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    expect(requests.some((request) => request.pathname.endsWith('/prompt_async'))).toBe(false);
  });

  it('prevents a metadata settlement write after stop', async () => {
    const settlementSession = deferred();
    let sessionReads = 0;
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        return sessionReads === 2 ? settlementSession.promise : jsonResponse(session);
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Verified.' }],
      }]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    runtime.stop();
    settlementSession.resolve(jsonResponse(session));
    await flushMicrotasks();

    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
  });

  it('prevents continuation dispatch after stop during its authoritative check', async () => {
    const dispatchSession = deferred();
    let sessionReads = 0;
    let promptAttempts = 0;
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        return sessionReads === 3 ? dispatchSession.promise : jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    runtime.stop();
    dispatchSession.resolve(jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } }));
    await flushMicrotasks();

    expect(promptAttempts).toBe(0);
  });

  it('does not inherit the length breaker across a fresh goal identity', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    const replacement = { ...goal, id: 'goal_2', turnsUsed: 1, createdAt: 3, updatedAt: 3, lastAccountedMessageID: '' };
    let messageReads = 0;
    let promptAttempts = 0;
    const lengthMessage = (id) => ({
      info: {
        id, sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
         finish: 'length', time: { completed: 2 }, tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'The answer was truncated.' }],
    });
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageReads += 1;
         return jsonResponse([lengthMessage(messageReads <= 3 ? 'msg_length_1' : 'msg_length_2')]);
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
      kickoffQuietMs: 10,
    });
    const idle = { type: 'session.status', properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY } };
    runtime.processPayload(idle);
    await vi.runOnlyPendingTimersAsync();
    expect(promptAttempts).toBe(1);

    currentGoal = replacement;
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, metadata: { openchamber: { goal: replacement } } } },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(promptAttempts).toBe(2);
    expect(currentGoal.status).toBe('active');
    runtime.stop();
  });

  it('rejects a runtime commit when the goal status changed during its tick', async () => {
    let sessionReads = 0;
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        const currentGoal = sessionReads > 1 ? { ...goal, status: 'paused' } : goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant',
          sessionID: SESSION_ID,
          role: 'assistant',
          providerID: 'provider',
          modelID: 'model',
          time: { completed: 2 },
          tokens: { input: 1, output: 1, cache: { read: 0 } },
        },
      }]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Verified"}',
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
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    runtime.stop();
  });

  it.each([
    ['objective', { objective: 'A different objective' }],
    ['budget', { tokenBudget: 200 }],
    ['file flag', { objectiveFile: true }],
    ['creation time', { createdAt: 99 }],
  ])('rejects terminal writes after same-ID %s mutation', async (_label, mutation) => {
    let sessionReads = 0;
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        const currentGoal = sessionReads > 1 ? { ...goal, ...mutation } : goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Verified.' }],
      }]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
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

    expect(sessionReads).toBe(2);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    runtime.stop();
  });

  it('re-arms a failed message fetch after the in-flight tick clears', async () => {
    const paths = [];
    let messageAttempts = 0;
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageAttempts += 1;
        return messageAttempts === 1 ? jsonResponse({ error: 'unavailable' }, 503) : jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
      `/session/${SESSION_ID}/message`,
    ]);
    await vi.advanceTimersByTimeAsync(10);
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
      `/session/${SESSION_ID}/message`,
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
      `/session/${SESSION_ID}/message`,
    ]);
    runtime.stop();
  });

  it('re-arms a failed child-session fetch without treating it as no children', async () => {
    let childAttempts = 0;
    const paths = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) {
        childAttempts += 1;
        return childAttempts === 1 ? jsonResponse({ error: 'unavailable' }, 503) : jsonResponse([]);
      }
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
    ]);
    await vi.advanceTimersByTimeAsync(10);
    expect(paths.at(-1)).toBe(`/session/${SESSION_ID}/message`);
    expect(childAttempts).toBe(2);
    runtime.stop();
  });

  it('replaces an existing idle timer with the explicit resume kickoff', async () => {
    const paths = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10_000,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, metadata: { openchamber: { goal: { ...goal, statusReason: 'resumed' } } } } },
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(paths).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    runtime.stop();
  });

  it('keeps the short Resume timer when a delayed idle event arrives', async () => {
    const paths = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 15_000,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, metadata: { openchamber: { goal: { ...goal, statusReason: 'resumed' } } } } },
    });
    await vi.advanceTimersByTimeAsync(200);
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    runtime.stop();
  });

  it('retries a failed continuation without reserving the same tail twice', async () => {
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let dispatchAttempts = 0;
    const requests = [];
    const assistant = {
      info: {
        id: 'msg_assistant',
        sessionID: SESSION_ID,
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        time: { completed: 2 },
        tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Still working.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        if (dispatchAttempts === 1) throw new Error('temporary dispatch failure');
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}',
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
    expect(dispatchAttempts).toBe(1);
    expect(currentGoal.turnsUsed).toBe(2);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();

     await vi.advanceTimersByTimeAsync(10);
     expect(dispatchAttempts).toBe(1);
     expect(currentGoal).toMatchObject({ status: 'blocked', statusReason: 'continuation admission unresolved' });
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(2);
    runtime.stop();
  });

  it.each([null, {}])('preserves the accounting reservation after a malformed continuation session response (%j)', async (malformedSession) => {
    let sessionReads = 0;
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let dispatchAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        if (sessionReads === 3) return jsonResponse(malformedSession);
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}',
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
      retryDelaysMs: [10],
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(dispatchAttempts).toBe(0);
    expect(currentGoal).toMatchObject({ turnsUsed: 2, lastAccountedMessageID: 'msg_assistant' });

    await vi.advanceTimersByTimeAsync(10);
    expect(dispatchAttempts).toBe(1);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('keeps an accepted accounting PATCH and prompt retry idempotent', async () => {
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let patchAttempts = 0;
    let dispatchAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        patchAttempts += 1;
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (patchAttempts === 1) throw new Error('accepted PATCH response lost');
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        if (dispatchAttempts === 1) throw new Error('prompt response lost');
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}',
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
      retryDelaysMs: [10, 20],
      maxDispatchAttempts: 3,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(patchAttempts).toBe(1);
    expect(currentGoal.turnsUsed).toBe(2);

    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(dispatchAttempts).toBe(1));
    expect(patchAttempts).toBe(2);
    expect(currentGoal).toMatchObject({ status: 'blocked', statusReason: 'continuation admission unresolved' });
    runtime.stop();
  });

  it('settles an active goal as blocked after dispatch retries are exhausted', async () => {
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let dispatchAttempts = 0;
    let blockedWrites = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (currentGoal.status === 'blocked') blockedWrites += 1;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        if (dispatchAttempts <= 2) throw new Error('dispatch unavailable');
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}',
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
      retryDelaysMs: [10, 10],
      maxDispatchAttempts: 2,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(10);

    expect(dispatchAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'blocked', statusReason: 'continuation admission unresolved' });
    expect(blockedWrites).toBe(1);

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(dispatchAttempts).toBe(1);
    expect(blockedWrites).toBe(1);

    const resumedGoal = { ...currentGoal, status: 'active', statusReason: 'resumed' };
    currentGoal = resumedGoal;
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, metadata: { openchamber: { goal: resumedGoal } } } },
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(dispatchAttempts).toBe(2);
    expect(currentGoal).toMatchObject({ status: 'blocked', turnsUsed: 3 });
    expect(blockedWrites).toBe(2);
    runtime.stop();
  });

  it('settles and releases a reservation after bounded missing provider/model dispatch failures', async () => {
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let statusCalls = 0;
    let promptAttempts = 0;
    let blockedWrites = 0;
    const assistant = {
      info: {
        id: 'msg_assistant',
        sessionID: SESSION_ID,
        role: 'assistant',
        time: { completed: 2 },
        tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (currentGoal.status === 'blocked') blockedWrites += 1;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') {
        statusCalls += 1;
        return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}',
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
      retryDelaysMs: [10],
      maxDispatchAttempts: 2,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(currentGoal).toMatchObject({
      status: 'active',
      turnsUsed: 1,
      lastAccountedMessageID: '',
    });
    expect(statusCalls).toBeLessThanOrEqual(6);
    expect(promptAttempts).toBe(0);
    expect(blockedWrites).toBe(0);

    // Drain the bounded dispatch/configuration retry and its rollback before
    // mutating the goal again or letting teardown run.
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    expect(currentGoal).toMatchObject({
      status: 'active',
      turnsUsed: 1,
      lastAccountedMessageID: '',
    });

    // A settled reservation must not poison an explicit Resume. Make the
    // resumed tail dispatchable; a stale reservation would hit the old retry
    // limit instead of creating the next bounded continuation.
    currentGoal = { ...currentGoal, status: 'active', statusReason: 'resumed' };
    assistant.info.providerID = 'provider';
    assistant.info.modelID = 'model';
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, metadata: { openchamber: { goal: currentGoal } } } },
    });
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();
    expect(promptAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 2 });
    expect(blockedWrites).toBe(0);
    runtime.stop();
  });

  it('preserves an accepted accounting reservation across busy/retry events before later idle', async () => {
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let patchAttempts = 0;
    let dispatchAttempts = 0;
    let acceptedPrompt = false;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        patchAttempts += 1;
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        if (dispatchAttempts === 1) {
          acceptedPrompt = true;
          throw new Error('accepted prompt response lost');
        }
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}',
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
      retryDelaysMs: [10, 20],
      maxDispatchAttempts: 3,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(acceptedPrompt).toBe(true);
    expect(dispatchAttempts).toBe(1);
    expect(patchAttempts).toBe(2);
    expect(currentGoal).toMatchObject({ turnsUsed: 2, tokensUsed: 2, lastAccountedMessageID: 'msg_assistant' });

    for (const type of ['busy', 'retry']) {
      runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: SESSION_ID, status: { type }, directory: DIRECTORY },
      });
    }
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(dispatchAttempts).toBe(1);
    expect(patchAttempts).toBe(2);
    expect(currentGoal).toMatchObject({ turnsUsed: 2, tokensUsed: 2, lastAccountedMessageID: 'msg_assistant' });
    runtime.stop();
  });

  it('accounts assistant snapshots by created time, not lexical message id', async () => {
    const oldMessage = {
      info: {
        id: 'msg_z',
        sessionID: SESSION_ID,
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        time: { created: 10, completed: 11 },
        tokens: { input: 5, output: 5, cache: { read: 0 } },
      },
    };
    const newMessage = {
      info: {
        id: 'msg_a',
        sessionID: SESSION_ID,
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        time: { created: 20, completed: 21 },
        tokens: { input: 20, output: 10, cache: { read: 0 } },
      },
    };
    const currentGoal = {
      ...goal,
      turnsUsed: 1,
      tokensUsed: 10,
      lastAccountedMessageID: oldMessage.info.id,
    };
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([newMessage, oldMessage]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Verified"}',
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
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(JSON.parse(patch.body).metadata.openchamber.goal).toMatchObject({
      status: 'complete',
      tokensUsed: 30,
      lastAccountedMessageID: 'msg_a',
    });
    runtime.stop();
  });

  it('classifies the baseline by created time when creation and completion cross the goal', async () => {
    const currentGoal = { ...goal, createdAt: 100, tokensUsed: 0, lastAccountedMessageID: '' };
    const messages = [
      {
        info: {
          id: 'msg_pre_goal', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { created: 90, completed: 110 }, tokens: { input: 30, output: 10, cache: { read: 0 } },
        },
      },
      {
        info: {
          id: 'msg_post_goal', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { created: 120, completed: 95 }, tokens: { input: 70, output: 20, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Work remains.' }],
      },
    ];
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
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

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(JSON.parse(patch.body).metadata.openchamber.goal).toMatchObject({
      status: 'complete',
      tokensBaseline: 40,
      tokensUsed: 50,
      lastAccountedMessageID: 'msg_post_goal',
    });
    runtime.stop();
  });

  it('preserves accounting when the cursor is outside the bounded message page', async () => {
    const currentGoal = {
      ...goal,
      turnsUsed: 1,
      tokensUsed: 17,
      lastAccountedMessageID: 'msg_not_in_page',
    };
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([{
        info: {
          id: 'msg_new',
          sessionID: SESSION_ID,
          role: 'assistant',
          providerID: 'provider',
          modelID: 'model',
          time: { created: 20, completed: 21 },
          tokens: { input: 200, output: 100, cache: { read: 0 } },
        },
      }]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Verified"}',
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
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(JSON.parse(patch.body).metadata.openchamber.goal).toMatchObject({
      status: 'complete',
      tokensUsed: 17,
      lastAccountedMessageID: 'msg_not_in_page',
    });
    runtime.stop();
  });

  it('keeps equal and missing timestamp messages in API order without producing NaN chronology', async () => {
    const messages = [
      {
        info: {
          id: 'msg_z_old', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { created: 100, completed: 101 }, tokens: { input: 5, output: 0, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Old turn.' }],
      },
      {
        info: {
          id: 'msg_z_equal', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { created: 200, completed: 201 }, tokens: { input: 7, output: 0, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Equal z.' }],
      },
      {
        info: {
          id: 'msg_a_equal', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { created: 200, completed: 201 }, tokens: { input: 11, output: 0, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Equal a.' }],
      },
      {
        info: {
          id: 'msg_z_missing', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 301 }, tokens: { input: 13, output: 0, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Missing z.' }],
      },
      {
        info: {
          id: 'msg_a_missing', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { completed: 302 }, tokens: { input: 17, output: 0, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Missing a.' }],
      },
    ];
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async (input) => {
         expect(input.prompt).toContain('Missing a.');
        return { text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model' };
      }),
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
    const patch = requests.find((request) => request.method === 'PATCH');
     expect(JSON.parse(patch.body).metadata.openchamber.goal).toMatchObject({ status: 'complete', tokensUsed: 17 });
    runtime.stop();
  });

  it('uses API order for equal timestamps when selecting the tail and audit input', async () => {
    const currentGoal = { ...goal, tokensUsed: 0, lastAccountedMessageID: '' };
    const messages = [
      {
        info: {
          id: 'msg_z_equal', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { created: 200, completed: 201 }, tokens: { input: 7, output: 0, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'First API result.' }],
      },
      {
        info: {
          id: 'msg_a_equal', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
          time: { created: 200, completed: 201 }, tokens: { input: 11, output: 0, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Last API result.' }],
      },
    ];
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async ({ prompt }) => {
        expect(prompt).toContain('Last API result.');
        expect(prompt).not.toContain('First API result.');
        return { text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model' };
      }),
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

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(JSON.parse(patch.body).metadata.openchamber.goal).toMatchObject({
      status: 'complete',
      tokensUsed: 11,
      lastAccountedMessageID: 'msg_a_equal',
    });
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('conservatively holds the baseline when a full page hides pre-goal history', async () => {
    const currentGoal = { ...goal, tokensUsed: 0, lastAccountedMessageID: '' };
    const messages = Array.from({ length: 40 }, (_, index) => ({
      info: {
        id: `msg_${index.toString(36)}`,
        sessionID: SESSION_ID,
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        time: { created: 10 + index, completed: 11 + index },
        tokens: { input: 100 + index, output: 10, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: `Post-goal turn ${index}.` }],
    }));
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
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
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(JSON.parse(patch.body).metadata.openchamber.goal).toMatchObject({
      status: 'complete',
      tokensUsed: 0,
      lastAccountedMessageID: '',
    });
    runtime.stop();
  });

  it('keeps summary segmentation while using the non-summary execution model', async () => {
    const currentGoal = {
      ...goal,
      turnsUsed: 1,
      tokensUsed: 0,
      lastAccountedMessageID: 'msg_before',
    };
    const regular = {
      info: {
        id: 'msg_regular',
        sessionID: SESSION_ID,
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        time: { created: 10, completed: 11 },
        tokens: { input: 8, output: 2, cache: { read: 0 } },
      },
    };
    const summary = {
      info: {
        id: 'msg_summary',
        sessionID: SESSION_ID,
        role: 'assistant',
        summary: true,
        time: { created: 20, completed: 21 },
        tokens: { input: 0, output: 0, cache: { read: 0 } },
      },
    };
    const cursor = {
      info: {
        id: 'msg_before',
        sessionID: SESSION_ID,
        role: 'user',
        time: { created: 1 },
      },
    };
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
       if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([summary, regular, cursor]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse(null);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(JSON.parse(patch.body).metadata.openchamber.goal).toMatchObject({
      tokensCommitted: 10,
      tokensUsed: 10,
      lastAccountedMessageID: 'msg_summary',
    });
    runtime.stop();
  });

  it('does not duplicate a tick when idle events repeat before kickoff', async () => {
    const paths = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    const idlePayload = {
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    };
    runtime.processPayload(idlePayload);
    runtime.processPayload(idlePayload);
    await vi.runOnlyPendingTimersAsync();
    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    runtime.stop();
  });

  it('does not arm a duplicate kickoff after an identical Resume has settled', async () => {
    const resumedGoal = { ...goal, statusReason: 'resumed' };
    let currentGoal = resumedGoal;
    const requests = [];
    const assistant = {
      info: {
        id: 'msg_assistant',
        sessionID: SESSION_ID,
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        time: { completed: 2 },
        tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Verified.' }],
    };
    const resumePayload = {
      type: 'session.updated',
      properties: { info: { ...session, metadata: { openchamber: { goal: resumedGoal } } } },
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Verified"}',
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

    runtime.processPayload(resumePayload);
    await vi.advanceTimersByTimeAsync(250);
    expect(currentGoal).toMatchObject({ status: 'complete' });
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    const requestCountAfterKickoff = requests.length;

    runtime.processPayload(resumePayload);
    await vi.advanceTimersByTimeAsync(250);

    expect(requests).toHaveLength(requestCountAfterKickoff);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('suppresses exact duplicate Resume events but re-arms a distinct file-backed edit', async () => {
    let currentGoal = {
      ...goal,
      objective: '',
      objectiveFile: true,
      statusReason: 'resumed',
      updatedAt: 10,
    };
    const firstResume = currentGoal;
    const secondResume = { ...currentGoal, statusReason: 'resumed', updatedAt: 11 };
    const requests = [];
    const assistant = {
      info: {
        id: 'msg_assistant',
        sessionID: SESSION_ID,
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        time: { completed: 2 },
        tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Verified.' }],
    };
    const makeResumePayload = (resumeGoal, updated) => ({
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          time: { updated },
          metadata: { openchamber: { goal: resumeGoal } },
        },
      },
    });
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async ({ prompt }) => ({
        text: '{"verdict":"complete","note":"Verified"}',
        providerID: 'provider',
        modelID: 'model',
        prompt,
      })),
    };
    readGoalObjective
      .mockResolvedValueOnce('First file-backed objective')
      .mockResolvedValueOnce('First file-backed objective')
      .mockResolvedValueOnce('First file-backed objective')
      .mockResolvedValueOnce('Second file-backed objective')
      .mockResolvedValueOnce('Second file-backed objective')
      .mockResolvedValueOnce('Second file-backed objective');
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      readGoalObjective,
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    const firstPayload = makeResumePayload(firstResume, 100);
    runtime.processPayload(firstPayload);
    await vi.advanceTimersByTimeAsync(250);
    expect(currentGoal).toMatchObject({ status: 'complete' });
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    const requestCountAfterFirstResume = requests.length;

    runtime.processPayload(firstPayload);
    await vi.advanceTimersByTimeAsync(250);
    expect(requests).toHaveLength(requestCountAfterFirstResume);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();

    currentGoal = secondResume;
    const secondPayload = makeResumePayload(secondResume, 101);
    runtime.processPayload(secondPayload);
    await vi.advanceTimersByTimeAsync(250);
    expect(service.generateSmallModelText).toHaveBeenCalledTimes(2);
    expect(service.generateSmallModelText.mock.calls[1][0].prompt).toContain('Second file-backed objective');

    const requestCountAfterSecondResume = requests.length;
    runtime.processPayload(secondPayload);
    await vi.advanceTimersByTimeAsync(250);
    expect(requests).toHaveLength(requestCountAfterSecondResume);
    expect(service.generateSmallModelText).toHaveBeenCalledTimes(2);
    runtime.stop();
  });

  it('rolls back accounting when the user moves the tail before dispatch', async () => {
    let currentGoal = {
      ...goal,
      turnsUsed: 1,
      tokensUsed: 7,
      tokensBaseline: 2,
      tokensCommitted: 3,
      lastAccountedMessageID: 'msg_before',
    };
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    let messageReads = 0;
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageReads += 1;
        return jsonResponse(messageReads === 1 ? [assistant] : [{
          info: { id: 'msg_user', sessionID: SESSION_ID, role: 'user', time: { created: 3 } },
        }]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();

    expect(currentGoal).toMatchObject({
      turnsUsed: 1,
      tokensUsed: 7,
      tokensBaseline: 2,
      tokensCommitted: 3,
      lastAccountedMessageID: 'msg_before',
    });
    expect(requests.some((request) => request.pathname.endsWith('/prompt_async'))).toBe(false);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(2);
    runtime.stop();
  });

  it('keeps a reservation and retries resolution when both rollback writes fail', async () => {
    const before = {
      ...goal,
      turnsUsed: 1,
      tokensUsed: 7,
      tokensBaseline: 2,
      tokensCommitted: 3,
      lastAccountedMessageID: 'msg_before',
    };
    let currentGoal = before;
    let messageReads = 0;
    let rollbackAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const movedTail = {
      info: { id: 'msg_user', sessionID: SESSION_ID, role: 'user', time: { created: 3 } },
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'blocked' || nextGoal.turnsUsed === before.turnsUsed) {
          rollbackAttempts += 1;
          if (rollbackAttempts <= 2) throw new Error('rollback resolution unavailable');
        }
        currentGoal = nextGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageReads += 1;
        return jsonResponse(messageReads === 1 ? [assistant] : [movedTail]);
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) throw new Error('must not dispatch');
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxRetryAttempts: 2,
    });
    const idle = { type: 'session.status', properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY } };

    runtime.processPayload(idle);
    await vi.runOnlyPendingTimersAsync();
    expect(currentGoal.turnsUsed).toBe(2);
    expect(rollbackAttempts).toBe(2);
    expect(fetchImpl.mock.calls.some(([input]) => requestPath(input).endsWith('/prompt_async'))).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    expect(currentGoal).toMatchObject({
      status: 'active',
      turnsUsed: 1,
      tokensUsed: 7,
      tokensBaseline: 2,
      tokensCommitted: 3,
      lastAccountedMessageID: 'msg_before',
    });

    const requestsAfterResolution = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl.mock.calls.length).toBe(requestsAfterResolution);
    runtime.stop();
  });

  it('preserves a pending rollback reservation across pause and resume without duplicate accounting', async () => {
    const before = {
      ...goal,
      turnsUsed: 1,
      tokensUsed: 7,
      tokensBaseline: 2,
      tokensCommitted: 3,
      lastAccountedMessageID: 'msg_before',
    };
    let currentGoal = before;
    let messageReads = 0;
    let rollbackAttempts = 0;
    let accountingWrites = 0;
    let dispatchAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const movedTail = {
      info: { id: 'msg_user', sessionID: SESSION_ID, role: 'user', time: { created: 3 } },
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'active' && nextGoal.turnsUsed === before.turnsUsed + 1) {
          accountingWrites += 1;
        }
        if (nextGoal.status === 'blocked' || nextGoal.turnsUsed === before.turnsUsed) {
          rollbackAttempts += 1;
          if (rollbackAttempts <= 2) throw new Error('rollback resolution unavailable');
        }
        currentGoal = nextGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageReads += 1;
        return jsonResponse(messageReads === 1 ? [assistant] : [movedTail]);
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        throw new Error('stale continuation must not dispatch');
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxRetryAttempts: 2,
    });
    const idle = { type: 'session.status', properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY } };

    runtime.processPayload(idle);
    await vi.runOnlyPendingTimersAsync();
    expect(currentGoal.turnsUsed).toBe(2);
    expect(accountingWrites).toBe(1);
    expect(rollbackAttempts).toBe(2);

    const pausedGoal = { ...currentGoal, status: 'paused', statusReason: 'paused by user' };
    currentGoal = pausedGoal;
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 2 }, metadata: { openchamber: { goal: pausedGoal } } } },
    });

    const resumedGoal = { ...pausedGoal, status: 'active', statusReason: 'resumed', updatedAt: 3 };
    currentGoal = resumedGoal;
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 3 }, metadata: { openchamber: { goal: resumedGoal } } } },
    });
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    expect(rollbackAttempts).toBe(3);
    expect(accountingWrites).toBe(1);
    expect(dispatchAttempts).toBe(0);
    expect(currentGoal).toMatchObject({
      status: 'active',
      statusReason: 'resumed',
      turnsUsed: 1,
      tokensUsed: 7,
      tokensBaseline: 2,
      tokensCommitted: 3,
      lastAccountedMessageID: 'msg_before',
    });
    runtime.stop();
  });

  it('rebinds a pending rollback to the real Resume accounting state and continues once', async () => {
    const before = {
      ...goal,
      turnsUsed: 1,
      tokensUsed: 7,
      tokensBaseline: 0,
      tokensCommitted: 0,
      lastAccountedMessageID: '',
    };
    let currentGoal = before;
    let messageReads = 0;
    let rollbackFailuresRemaining = 2;
    let rollbackWrites = 0;
    let blockedFallbackWrites = 0;
    let accountingWrites = 0;
    let dispatchAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const movedTail = {
      info: { id: 'msg_user', sessionID: SESSION_ID, role: 'user', time: { created: 4 } },
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'active' && nextGoal.tokensUsed === 20) {
          accountingWrites += 1;
        } else if (rollbackFailuresRemaining > 0) {
          rollbackFailuresRemaining -= 1;
          if (nextGoal.status === 'blocked') blockedFallbackWrites += 1;
          else rollbackWrites += 1;
          throw new Error('rollback resolution unavailable');
        }
        currentGoal = nextGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageReads += 1;
        return jsonResponse(messageReads === 1 ? [assistant] : (messageReads === 2 ? [movedTail] : [assistant]));
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [1000],
      maxRetryAttempts: 1,
    });
    const idle = { type: 'session.status', properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY } };

    runtime.processPayload(idle);
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(currentGoal).toMatchObject({ turnsUsed: 2, tokensUsed: 20, lastAccountedMessageID: 'msg_assistant' });
    expect(rollbackFailuresRemaining).toBe(0);
    expect(rollbackWrites).toBe(1);
    expect(blockedFallbackWrites).toBe(1);

    const pausedGoal = { ...currentGoal, status: 'paused', statusReason: 'paused by user' };
    currentGoal = pausedGoal;
    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 2 }, metadata: { openchamber: { goal: pausedGoal } } } },
    });

    const resumedGoal = {
      ...pausedGoal,
      status: 'active',
      statusReason: 'resumed',
      tokensUsed: 0,
      tokensBaseline: 0,
      tokensCommitted: 0,
      turnsUsed: 0,
      lastAccountedMessageID: '',
      updatedAt: 3,
    };
    currentGoal = resumedGoal;
    runtime.processPayload({
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          time: { updated: 3 },
          metadata: { openchamber: { goal: resumedGoal } },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    expect(accountingWrites).toBe(2);
    expect(rollbackWrites).toBe(1);
    expect(blockedFallbackWrites).toBe(1);
    expect(dispatchAttempts).toBe(1);
    expect(currentGoal).toMatchObject({
      status: 'active',
      turnsUsed: 1,
      tokensUsed: 20,
      tokensBaseline: 0,
      tokensCommitted: 0,
      lastAccountedMessageID: 'msg_assistant',
    });
    runtime.stop();
  });

  it('notifies through settlement when rollback fallback blocks a goal and removes the reservation', async () => {
    const before = { ...goal, turnsUsed: 1, tokensUsed: 7, tokensBaseline: 2, tokensCommitted: 3, lastAccountedMessageID: 'msg_before' };
    let currentGoal = before;
    let messageReads = 0;
    let rollbackWrites = 0;
    let accountingAccepted = false;
    const emitGoalNotification = vi.fn();
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const movedTail = { info: { id: 'msg_user', sessionID: SESSION_ID, role: 'user', time: { created: 3 } } };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'active' && nextGoal.turnsUsed === before.turnsUsed && accountingAccepted) {
          rollbackWrites += 1;
          throw new Error('rollback unavailable');
        }
        if (nextGoal.status === 'active' && nextGoal.turnsUsed === before.turnsUsed + 1) accountingAccepted = true;
        currentGoal = nextGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageReads += 1;
        return jsonResponse(messageReads === 1 ? [assistant] : [movedTail]);
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) throw new Error('must not dispatch');
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      emitGoalNotification,
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(rollbackWrites).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'blocked', statusReason: 'continuation tail changed before dispatch' });
    expect(emitGoalNotification).toHaveBeenCalledOnce();
    expect(emitGoalNotification).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION_ID,
      status: 'blocked',
      goal: expect.objectContaining({ status: 'blocked' }),
    }));
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(emitGoalNotification).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('rolls back accepted accounting before pausing an aborted reservation', async () => {
    const latestMessages = deferred();
    let currentGoal = {
      ...goal,
      turnsUsed: 1,
      tokensUsed: 7,
      tokensBaseline: 2,
      tokensCommitted: 3,
      lastAccountedMessageID: 'msg_before',
    };
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 10, output: 4, cache: { read: 3, write: 1 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    let messageReads = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageReads += 1;
        if (messageReads === 1) return jsonResponse([assistant]);
        return latestMessages.promise;
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) throw new Error('must not dispatch');
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(currentGoal.turnsUsed).toBe(2);

    runtime.processPayload({
      type: 'message.updated',
      properties: { info: { role: 'assistant', sessionID: SESSION_ID, error: { name: 'MessageAbortedError' } } },
    }, DIRECTORY);
    latestMessages.resolve(jsonResponse([assistant]));
    await flushMicrotasks();
    await vi.runOnlyPendingTimersAsync();

    expect(currentGoal).toMatchObject({
      status: 'paused',
      turnsUsed: 1,
      tokensUsed: 7,
      tokensBaseline: 2,
      tokensCommitted: 3,
      lastAccountedMessageID: 'msg_before',
    });
    runtime.stop();
  });

  it('rejects a stale file-backed terminal result after the objective changes in flight', async () => {
    const audit = deferred();
    let fileObjective = 'Original objective';
    let currentGoal = { ...goal, objective: '', objectiveFile: true, lastAccountedMessageID: '' };
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'Verified.' }],
    };
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    readGoalObjective.mockImplementation(async () => fileObjective);
    vi.stubGlobal('fetch', fetchImpl);
    const service = { generateSmallModelText: vi.fn(() => audit.promise) };
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      readGoalObjective,
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    fileObjective = 'Changed objective';
    audit.resolve({ text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model' });
    await flushMicrotasks();

    expect(currentGoal.status).toBe('active');
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    expect(requests.some((request) => request.pathname.endsWith('/prompt_async'))).toBe(false);
    runtime.stop();
  });

  it('recovers from a length finish without an error marker', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_length_finish', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
         finish: 'length', time: { completed: 2 }, tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'The answer was truncated.' }],
    };
    const audit = vi.fn();
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(promptAttempts).toBe(1);
    expect(audit).not.toHaveBeenCalled();
    expect(currentGoal.status).toBe('active');
    runtime.stop();
  });

  it('recovers from a MessageOutputLengthError without a length finish marker', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_length_error', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, error: { name: 'MessageOutputLengthError' },
        tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'The answer was truncated.' }],
    };
    const audit = vi.fn();
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(promptAttempts).toBe(1);
    expect(audit).not.toHaveBeenCalled();
    expect(currentGoal.status).toBe('active');
    runtime.stop();
  });

  it('recovers from an output-length finish without auditing the incomplete reply', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_length', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        finish: 'length', time: { completed: 2 }, error: { name: 'MessageOutputLengthError' },
        tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'The answer was truncated.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const audit = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(currentGoal.status).toBe('active');
    expect(currentGoal.turnsUsed).toBe(2);
    expect(promptAttempts).toBe(1);
    expect(audit).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('blocks after repeated output-length finishes', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let messageReads = 0;
    const assistant = (id) => ({
      info: {
        id, sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
         finish: 'length', time: { created: 2, completed: 2 }, tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'Still truncated.' }],
    });
    let promptAttempts = 0;
    const emitGoalNotification = vi.fn();
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageReads += 1;
         return jsonResponse([assistant(messageReads <= 3 ? 'msg_length_1' : 'msg_length_2')]);
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      emitGoalNotification,
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    const idle = { type: 'session.status', properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY } };
    runtime.processPayload(idle);
    await vi.runOnlyPendingTimersAsync();
    runtime.processPayload(idle);
    await vi.advanceTimersByTimeAsync(10);

     expect(promptAttempts).toBe(1);
     expect(currentGoal.status).toBe('blocked');
     expect(currentGoal.statusReason).toBe('repeated output truncation');
     expect(emitGoalNotification).toHaveBeenCalledOnce();
     expect(emitGoalNotification.mock.calls[0][0].goal.statusReason).toBe('repeated output truncation');
     runtime.stop();
  });

  it.each([
    ['token budget', { tokenBudget: 3 }, 'budgetLimited', 'token budget reached'],
    ['auto-continuation cap', { turnsUsed: 1 }, 'blocked', 'auto-continuation limit reached'],
  ])('keeps the %s terminal check ahead of the length breaker', async (_label, goalOverride, status, statusReason) => {
    let currentGoal = { ...goal, ...goalOverride, lastAccountedMessageID: '' };
    const assistant = {
      info: {
        id: 'msg_length', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        finish: 'length', time: { completed: 2 }, tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'Still truncated.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) throw new Error('must not dispatch');
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
      maxAutoTurns: goalOverride.turnsUsed === 1 ? 1 : 20,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(currentGoal).toMatchObject({ status, statusReason });
    runtime.stop();
  });

  it('gives a genuine assistant error precedence over a length finish', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    const assistant = {
      info: {
        id: 'msg_error', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        finish: 'length', time: { completed: 2 }, error: { name: 'ProviderError' },
      },
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(currentGoal).toMatchObject({ status: 'blocked', statusReason: 'ProviderError' });
    runtime.stop();
  });

  it('does not count a length-marked summary as a repeated truncation', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: 'msg_regular' };
    const regular = {
      info: {
        id: 'msg_regular', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 1, completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
    };
    const summary = {
      info: {
        id: 'msg_summary', sessionID: SESSION_ID, role: 'assistant', summary: true, finish: 'length',
        time: { created: 3, completed: 4 }, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      },
    };
    let promptAttempts = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([regular, summary]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(currentGoal.status).toBe('active');
    expect(promptAttempts).toBe(1);
    runtime.stop();
  });

  it('rolls back an undispatched reservation when authoritative status retries exhaust', async () => {
    const before = { ...goal, turnsUsed: 1, tokensUsed: 7, tokensBaseline: 2, tokensCommitted: 3, lastAccountedMessageID: '' };
    let currentGoal = before;
    let statusCalls = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 5, output: 2, cache: { read: 1, write: 1 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    let promptAttempts = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') {
        statusCalls += 1;
        return statusCalls === 1 ? jsonResponse({ [SESSION_ID]: { type: 'idle' } }) : jsonResponse(null, 503);
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        throw new Error('dispatch should not be reached');
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxRetryAttempts: 1,
    });
    const idle = { type: 'session.status', properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY } };
    runtime.processPayload(idle);
    await vi.runOnlyPendingTimersAsync();
    expect(currentGoal.turnsUsed).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    expect(statusCalls).toBeGreaterThanOrEqual(3);
    expect(promptAttempts).toBe(0);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 1, tokensUsed: 7, tokensBaseline: 2, tokensCommitted: 3 });
    runtime.stop();
  });

  it('retries malformed recent messages instead of treating them as an empty tail', async () => {
    let messageAttempts = 0;
    const audit = vi.fn();
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageAttempts += 1;
        return messageAttempts === 1 ? jsonResponse([{}]) : jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(messageAttempts).toBe(1);
    expect(audit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(messageAttempts).toBe(2);
    expect(audit).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('audits and dispatches when the parent and child are omitted from a valid idle status map', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    const audit = vi.fn(async () => ({
      text: '{"verdict":"continue","note":"More work remains"}',
      providerID: 'provider',
      modelID: 'model',
    }));
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([{ id: CHILD_ID, parentID: SESSION_ID }]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(audit).toHaveBeenCalledOnce();
    expect(promptAttempts).toBe(1);
    expect(currentGoal.turnsUsed).toBe(2);
    runtime.stop();
  });

  it('retries malformed child records instead of treating them as no children', async () => {
    let childAttempts = 0;
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) {
        childAttempts += 1;
        return childAttempts === 1 ? jsonResponse([{}]) : jsonResponse([]);
      }
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(childAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(childAttempts).toBe(2);
    runtime.stop();
  });

  it('includes reasoning and cache write tokens in authoritative totals', async () => {
    const currentGoal = { ...goal, tokensUsed: 0, lastAccountedMessageID: '' };
    const assistant = {
      info: {
        id: 'msg_tokens', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      },
      parts: [{ type: 'text', text: 'Verified.' }],
    };
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = { generateSmallModelText: vi.fn(async () => ({
      text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
    })) };
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
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(JSON.parse(patch.body).metadata.openchamber.goal).toMatchObject({ status: 'complete', tokensUsed: 15 });
    runtime.stop();
  });

  it('rolls back an undispatched reservation when pause arrives after accounting', async () => {
    const before = { ...goal, turnsUsed: 1, tokensUsed: 7, tokensBaseline: 2, tokensCommitted: 3, lastAccountedMessageID: 'msg_before' };
    let currentGoal = before;
    let runtime;
    let pauseEmitted = false;
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'active' && !pauseEmitted) {
          pauseEmitted = true;
          currentGoal = { ...nextGoal, status: 'paused', statusReason: 'paused by user' };
          runtime.processPayload({
            type: 'session.updated',
            properties: { info: { ...session, metadata: { openchamber: { goal: currentGoal } } } },
          });
          return jsonResponse({ ...session, metadata: { openchamber: { goal: nextGoal } } });
        }
        currentGoal = nextGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();

    expect(promptAttempts).toBe(0);
    await vi.waitFor(() => expect(currentGoal).toMatchObject({
      status: 'paused',
      turnsUsed: 1,
      tokensUsed: 7,
      tokensBaseline: 2,
      tokensCommitted: 3,
      lastAccountedMessageID: 'msg_before',
    }));
    runtime.stop();
  });

  it('rolls back an undispatched reservation when status invalidates final admission', async () => {
    const before = { ...goal, turnsUsed: 1, tokensUsed: 7, lastAccountedMessageID: '' };
    let currentGoal = before;
    let runtime;
    let sessionReads = 0;
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        if (sessionReads === 3) {
          runtime.processPayload({
            type: 'session.status',
            properties: { sessionID: SESSION_ID, status: { type: 'busy' }, directory: DIRECTORY },
          });
        }
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();

    expect(promptAttempts).toBe(0);
    expect(currentGoal).toMatchObject({ turnsUsed: 1, tokensUsed: 7, lastAccountedMessageID: '' });
    runtime.stop();
  });

  it('rolls back an undispatched reservation when the runtime stops after accounting', async () => {
    const before = { ...goal, turnsUsed: 1, tokensUsed: 7, lastAccountedMessageID: '' };
    let currentGoal = before;
    let runtime;
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        currentGoal = nextGoal;
        if (nextGoal.status === 'active' && nextGoal.turnsUsed === before.turnsUsed + 1) runtime.stop();
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(currentGoal).toMatchObject({ turnsUsed: 1, tokensUsed: 7 }));

    expect(promptAttempts).toBe(0);
  });

  it('blocks a replacement that still carries an indistinguishable old charge', async () => {
    const before = { ...goal, turnsUsed: 1, tokensUsed: 7, lastAccountedMessageID: '' };
    let currentGoal = before;
    let runtime;
    let promptAttempts = 0;
    let replacementEmitted = false;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'active' && !replacementEmitted) {
          replacementEmitted = true;
          currentGoal = {
            ...nextGoal,
            id: 'goal_replacement',
            objective: 'A replacement objective',
            createdAt: 99,
          };
          runtime.processPayload({
            type: 'session.updated',
            properties: { info: { ...session, metadata: { openchamber: { goal: currentGoal } } } },
          });
          return jsonResponse({ ...session, metadata: { openchamber: { goal: nextGoal } } });
        }
        currentGoal = nextGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(currentGoal).toMatchObject({
      id: 'goal_replacement',
      status: 'blocked',
      statusReason: 'continuation reservation could not be reconciled',
    }));

    expect(promptAttempts).toBe(0);
    runtime.stop();
  });

  it('starts a bounded restart scan and holds an ambiguous persisted accounting tail', async () => {
    const currentGoal = { ...goal, turnsUsed: 2, tokensUsed: 2, lastAccountedMessageID: 'msg_assistant' };
    let promptAttempts = 0;
    const directories = [DIRECTORY, '/workspace-two', '/workspace-three', '/workspace-four', '/workspace-five'];
    const scannedDirectories = [];
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === '/session') {
        scannedDirectories.push(new URL(input).searchParams.get('directory'));
        return jsonResponse(scannedDirectories.length === 1
          ? [{ ...session, metadata: { openchamber: { goal: currentGoal } } }]
          : []);
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      if (init.method === 'PATCH') return jsonResponse(session);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    await runtime.start({ listDirectories: async () => directories });
    await vi.runOnlyPendingTimersAsync();

    expect(scannedDirectories).toEqual(directories.slice(0, 4));
    expect(promptAttempts).toBe(0);
    expect(currentGoal).toMatchObject({ turnsUsed: 2, tokensUsed: 2, lastAccountedMessageID: 'msg_assistant' });
    runtime.stop();
  });

  it('retries startup recovery after the session list is unavailable', async () => {
    let scanAttempts = 0;
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === '/session') {
        scanAttempts += 1;
        return scanAttempts === 1
          ? jsonResponse({ error: 'OpenCode is still starting' }, 503)
          : jsonResponse([{ ...session, metadata: { openchamber: { goal: currentGoal } } }]);
      }
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      startupRecoveryDelaysMs: [10],
      maxStartupRecoveryAttempts: 1,
    });

    await runtime.start({ listDirectories: async () => [DIRECTORY] });
    expect(scanAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    await vi.runOnlyPendingTimersAsync();

    expect(scanAttempts).toBe(2);
    expect(promptAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 2, lastAccountedMessageID: 'msg_assistant' });
    runtime.stop();
  });

  it('retries startup recovery after the settings directory scan fails without SSE', async () => {
    let scanAttempts = 0;
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === '/session') {
        return jsonResponse([{ ...session, metadata: { openchamber: { goal: currentGoal } } }]);
      }
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      startupRecoveryDelaysMs: [10],
      maxStartupRecoveryAttempts: 1,
    });

    await runtime.start({
      listDirectories: async () => {
        scanAttempts += 1;
        return scanAttempts === 1 ? null : [DIRECTORY];
      },
    });
    expect(scanAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    await vi.runOnlyPendingTimersAsync();

    expect(scanAttempts).toBe(2);
    expect(promptAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 2, lastAccountedMessageID: 'msg_assistant' });
    runtime.stop();
  });

  it('retries startup recovery after array-shaped settings fail, then rearms an idle goal after readiness', async () => {
    let scanAttempts = 0;
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === '/session') {
        return jsonResponse([{ ...session, metadata: { openchamber: { goal: currentGoal } } }]);
      }
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      startupRecoveryDelaysMs: [10],
      maxStartupRecoveryAttempts: 1,
    });

    await runtime.start({
      listDirectories: async () => {
        scanAttempts += 1;
        if (scanAttempts === 1) throw new Error('Settings file is malformed (expected object payload)');
        return [DIRECTORY];
      },
    });
    expect(scanAttempts).toBe(1);

    await runtime.start({
      listDirectories: async () => {
        scanAttempts += 1;
        return [DIRECTORY];
      },
      resetRetryWindow: true,
    });
    await vi.runOnlyPendingTimersAsync();

    expect(scanAttempts).toBe(2);
    expect(promptAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 2, lastAccountedMessageID: 'msg_assistant' });
    runtime.stop();
  });

  it('retries terminalization after dispatch exhaustion without sending another prompt', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let dispatchAttempts = 0;
    let restoreAttempts = 0;
    let blockedWrites = 0;
    const emitGoalNotification = vi.fn();
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'blocked') {
          blockedWrites += 1;
          if (blockedWrites === 1) throw new Error('terminal blocked write unavailable');
          currentGoal = nextGoal;
          return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
        }
        if (nextGoal.turnsUsed < currentGoal.turnsUsed) {
          restoreAttempts += 1;
          throw new Error('terminal restore unavailable');
        }
        currentGoal = nextGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        return jsonResponse({ error: 'dispatch rejected' }, 400);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      emitGoalNotification,
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxDispatchAttempts: 2,
      maxRetryAttempts: 2,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(dispatchAttempts).toBe(1);
    expect(currentGoal.turnsUsed).toBe(2);

    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(dispatchAttempts).toBe(2);
    expect(currentGoal.status).toBe('active');
    expect(restoreAttempts).toBe(1);
    expect(blockedWrites).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(currentGoal).toMatchObject({
      status: 'blocked',
      statusReason: 'continuation dispatch retry limit reached before continuation dispatch',
    });
    expect(restoreAttempts).toBe(2);
    expect(blockedWrites).toBe(2);
    expect(emitGoalNotification).toHaveBeenCalledOnce();

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(dispatchAttempts).toBe(2);
    runtime.stop();
  });

  it('reconciles a committed blocked terminalization after its PATCH response is lost', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let dispatchAttempts = 0;
    let blockedWrites = 0;
    const emitGoalNotification = vi.fn();
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'blocked') {
          blockedWrites += 1;
          currentGoal = nextGoal;
          if (blockedWrites === 1) throw new Error('blocked terminal response lost');
        } else if (nextGoal.turnsUsed < currentGoal.turnsUsed) {
          throw new Error('terminal restore unavailable');
        } else {
          currentGoal = nextGoal;
        }
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        return jsonResponse({ error: 'dispatch rejected' }, 400);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      emitGoalNotification,
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxDispatchAttempts: 2,
      maxRetryAttempts: 2,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(dispatchAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    expect(dispatchAttempts).toBe(2);
    await vi.waitFor(() => expect(emitGoalNotification).toHaveBeenCalledOnce());
    expect(currentGoal.status).toBe('blocked');
    expect(blockedWrites).toBe(1);
    expect(emitGoalNotification).toHaveBeenCalledOnce();

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(dispatchAttempts).toBe(2);
    expect(blockedWrites).toBe(1);
    expect(emitGoalNotification).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('reconciles a blocked terminalization event before dropping its reservation', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let dispatchAttempts = 0;
    let blockedWrites = 0;
    let patchAttempts = 0;
    let runtime;
    const emitGoalNotification = vi.fn();
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        patchAttempts += 1;
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'blocked') {
          blockedWrites += 1;
          currentGoal = nextGoal;
          if (blockedWrites === 1) {
            runtime.processPayload({
              type: 'session.updated',
              properties: {
                info: {
                  ...session,
                  time: { updated: 2 },
                  metadata: { openchamber: { goal: currentGoal } },
                },
              },
            });
            throw new Error('blocked terminal response lost');
          }
        } else if (nextGoal.turnsUsed < currentGoal.turnsUsed) {
          throw new Error('terminal restore unavailable');
        } else {
          currentGoal = nextGoal;
        }
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        return jsonResponse({ error: 'dispatch rejected' }, 400);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      emitGoalNotification,
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxDispatchAttempts: 2,
      maxRetryAttempts: 2,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(dispatchAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();

    expect(dispatchAttempts).toBe(2);
    expect(currentGoal.status).toBe('blocked');
    expect(blockedWrites).toBe(1);
    const patchesAfterTerminalization = patchAttempts;

    await flushMicrotasks();

    expect(emitGoalNotification).toHaveBeenCalledOnce();
    expect(blockedWrites).toBe(1);
    expect(patchAttempts).toBe(patchesAfterTerminalization);

    await vi.advanceTimersByTimeAsync(100);
    expect(dispatchAttempts).toBe(2);
    expect(blockedWrites).toBe(1);
    expect(emitGoalNotification).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('does not let pending terminalization consume a fresh replacement kickoff', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    const replacement = {
      ...goal,
      id: 'goal_new',
      objective: 'Finish the replacement task',
      turnsUsed: 0,
      lastAccountedMessageID: 'msg_assistant',
      createdAt: 3,
      updatedAt: 3,
    };
    let dispatchAttempts = 0;
    let terminalizationWrites = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (nextGoal.status === 'blocked' || nextGoal.turnsUsed < currentGoal.turnsUsed) {
          terminalizationWrites += 1;
          throw new Error('old terminalization unavailable');
        }
        currentGoal = nextGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        return currentGoal.id === replacement.id
          ? new Response(null, { status: 204 })
          : jsonResponse({ error: 'dispatch rejected' }, 400);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxDispatchAttempts: 2,
      maxRetryAttempts: 2,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(dispatchAttempts).toBe(2);
    const oldTerminalizationWrites = terminalizationWrites;

    currentGoal = replacement;
    runtime.processPayload({
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          time: { updated: 3 },
          metadata: { openchamber: { goal: replacement } },
        },
      },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    expect(dispatchAttempts).toBe(3);
    expect(currentGoal).toMatchObject({ id: replacement.id, status: 'active', turnsUsed: 1 });
    expect(terminalizationWrites).toBe(oldTerminalizationWrites);
    runtime.stop();
  });

  it('rebinds a rejected terminalization reservation after Resume resets turns without losing kickoff', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let resumed = false;
    let dispatchAttempts = 0;
    let accountingWrites = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (!resumed && (nextGoal.status === 'blocked' || nextGoal.turnsUsed < currentGoal.turnsUsed)) {
          throw new Error('terminalization resolution unavailable');
        }
        if (nextGoal.turnsUsed === 2) accountingWrites += 1;
        if (resumed && nextGoal.turnsUsed === 1) accountingWrites += 1;
        currentGoal = nextGoal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        dispatchAttempts += 1;
        if (!resumed) return jsonResponse({ error: 'dispatch rejected' }, 400);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
      maxDispatchAttempts: 2,
      maxRetryAttempts: 2,
    });
    const idle = {
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    };

    runtime.processPayload(idle);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(dispatchAttempts).toBe(2);
    expect(currentGoal).toMatchObject({ turnsUsed: 2, lastAccountedMessageID: 'msg_assistant' });

    resumed = true;
    currentGoal = {
      ...currentGoal,
      status: 'active',
      statusReason: 'resumed',
      turnsUsed: 0,
      lastAccountedMessageID: 'msg_assistant',
      updatedAt: 3,
    };
    runtime.processPayload({
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          time: { updated: 3 },
          metadata: { openchamber: { goal: currentGoal } },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    expect(dispatchAttempts).toBe(3);
    expect(accountingWrites).toBe(2);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 1, lastAccountedMessageID: 'msg_assistant' });
    runtime.stop();
  });

  it('does not arm or run a stale restart candidate after a newer session update', async () => {
    const newerDirectory = '/workspace-new';
    const staleDirectory = '/workspace-old';
    const newerGoal = { ...goal, id: 'goal_new', turnsUsed: 0, createdAt: 2, updatedAt: 20 };
    const staleGoal = { ...goal, id: 'goal_old', turnsUsed: 0, createdAt: 1, updatedAt: 10 };
    const targetRequests = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      if (pathname === '/session') {
        return jsonResponse([{
          ...session,
          directory: staleDirectory,
          time: { updated: 10 },
          metadata: { openchamber: { goal: staleGoal } },
        }]);
      }
      if (pathname === `/session/${SESSION_ID}`) {
        targetRequests.push(new URL(input).searchParams.get('directory'));
        return jsonResponse({
          ...session,
          directory: newerDirectory,
          metadata: { openchamber: { goal: newerGoal } },
        });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
      kickoffQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          directory: newerDirectory,
          time: { updated: 20 },
          metadata: { openchamber: { goal: newerGoal } },
        },
      },
    });
    await runtime.start({ listDirectories: async () => [staleDirectory] });

    await vi.advanceTimersByTimeAsync(0);
    expect(targetRequests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10);
    expect(targetRequests).toEqual([newerDirectory]);
    runtime.stop();
  });

  it('recovers an active timer consumed while disabled without a new event', async () => {
    let enabled = true;
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    const audit = vi.fn(async () => ({
      text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
    }));
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => enabled,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 1 }, metadata: { openchamber: { goal: currentGoal } } } },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    enabled = false;
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(promptAttempts).toBe(0);

    enabled = true;
    runtime.onSettingsChanged();
    await vi.runOnlyPendingTimersAsync();

    expect(audit).toHaveBeenCalledOnce();
    expect(promptAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 2, lastAccountedMessageID: 'msg_assistant' });
    runtime.stop();
  });

  it('recovers a disabled restart scan after re-enabling without transcript activity', async () => {
    let enabled = false;
    let currentGoal = { ...goal, turnsUsed: 2, lastAccountedMessageID: 'msg_assistant' };
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === '/session') return jsonResponse([{ ...session, metadata: { openchamber: { goal: currentGoal } } }]);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => enabled,
      idleQuietMs: 10,
      retryDelaysMs: [10, 20],
      maxRetryAttempts: 2,
    });

    await runtime.start({ listDirectories: async () => [DIRECTORY] });
    expect(promptAttempts).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    enabled = true;
    runtime.onSettingsChanged();
    await vi.runOnlyPendingTimersAsync();

    expect(promptAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 3, lastAccountedMessageID: 'msg_assistant' });
    runtime.stop();
  });

  it('uses the transcript to block a second truncation after restart', async () => {
    let currentGoal = { ...goal, turnsUsed: 2, lastAccountedMessageID: 'msg_length_1' };
    const lengthMessage = (id) => ({
      info: {
        id, sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model', finish: 'length',
        time: { created: id.endsWith('1') ? 2 : 4, completed: id.endsWith('1') ? 3 : 5 },
        tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'Still truncated.' }],
    });
    let promptAttempts = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === '/session') return jsonResponse([{ ...session, metadata: { openchamber: { goal: currentGoal } } }]);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([lengthMessage('msg_length_1'), lengthMessage('msg_length_2')]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    await runtime.start({ listDirectories: async () => [DIRECTORY] });
    await vi.runOnlyPendingTimersAsync();

    expect(promptAttempts).toBe(0);
     expect(currentGoal.status).toBe('blocked');
     expect(currentGoal.statusReason).toBe('repeated output truncation');
    runtime.stop();
  });

  it('does not blindly resend after an accepted prompt loses its response', async () => {
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: promptAttempts > 0 ? { type: 'busy' } : { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        throw new Error('prompt response lost after admission');
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(promptAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 2 });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(promptAttempts).toBe(1);
    expect(currentGoal.turnsUsed).toBe(2);
    runtime.stop();
  });

  it('retries a prompt only after an explicit pre-admission rejection', async () => {
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return promptAttempts === 1 ? jsonResponse({ error: 'rejected before admission' }, 400) : jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(promptAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 2 });

    await vi.advanceTimersByTimeAsync(10);
    expect(promptAttempts).toBe(2);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 2 });
    runtime.stop();
  });

  it('settles an ambiguous prompt admission when authoritative status stays unknown', async () => {
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let statusCalls = 0;
    let promptAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') {
        statusCalls += 1;
        return statusCalls >= 4 ? jsonResponse(null) : jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    expect(promptAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'blocked', statusReason: 'continuation admission unresolved' });
    runtime.stop();
  });

  it('invalidates final admission on an explicit clear event without a goal payload', async () => {
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let promptAttempts = 0;
    let runtime;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    let statusCalls = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return currentGoal
          ? jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } })
          : jsonResponse({ ...session, metadata: { openchamber: {} } });
      }
      if (pathname === '/session/status') {
        statusCalls += 1;
        if (statusCalls === 3) {
          currentGoal = null;
          runtime.processPayload({
            type: 'session.updated',
            properties: { info: { ...session, metadata: {} } },
          });
        }
        return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    expect(promptAttempts).toBe(0);
    expect(currentGoal).toBeNull();
    runtime.stop();
  });

  it('accepts clear then idle as a legitimate no-goal response after active tracking and pending reservation', async () => {
    let currentGoal = { ...goal, turnsUsed: 1, lastAccountedMessageID: '' };
    let runtime;
    let statusCalls = 0;
    let sessionReads = 0;
    const requests = [];
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        return currentGoal
          ? jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } })
          : jsonResponse({ ...session, metadata: {} });
      }
      if (pathname === '/session/status') {
        statusCalls += 1;
        if (statusCalls === 3) {
          // Keep both the in-flight reservation and a pending idle re-arm
          // present when Clear invalidates the old goal.
          runtime.processPayload({
            type: 'session.status',
            properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
          });
          currentGoal = null;
          runtime.processPayload({
            type: 'session.updated',
            properties: { info: { ...session, time: { updated: 2 }, metadata: {} } },
          });
        }
        return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname} ${init.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
      retryDelaysMs: [10],
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: { info: { ...session, time: { updated: 1 }, metadata: { openchamber: { goal: currentGoal } } } },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(currentGoal).toBeNull();
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    expect(statusCalls).toBe(3);
    const readsAfterClear = sessionReads;
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionReads).toBe(readsAfterClear);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    runtime.stop();
  });

  it('rolls back accounting when a newer user message invalidates final admission', async () => {
    const before = { ...goal, turnsUsed: 1, tokensUsed: 7, lastAccountedMessageID: '' };
    let currentGoal = before;
    let runtime;
    let promptAttempts = 0;
    let messages = [];
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 10, output: 4, cache: { read: 2, write: 1 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    let statusCalls = 0;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') {
        statusCalls += 1;
        if (statusCalls === 3) {
          messages = [assistant, { info: { id: 'msg_user_new', sessionID: SESSION_ID, role: 'user', time: { created: 110 } } }];
          runtime.processPayload({
            type: 'message.updated',
            properties: { info: messages[1].info },
          }, DIRECTORY);
        }
        return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      }
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages.length ? messages : [assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    vi.setSystemTime(100);
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    expect(promptAttempts).toBe(0);
    expect(currentGoal).toMatchObject({ turnsUsed: 1, tokensUsed: 7, lastAccountedMessageID: '' });
    runtime.stop();
  });

  it('rebinds an undispatched reservation when a real edit preserves accounting', async () => {
    const before = { ...goal, turnsUsed: 1, tokensUsed: 7, lastAccountedMessageID: '' };
    let currentGoal = before;
    let runtime;
    let promptAttempts = 0;
    let edited = false;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 2, completed: 3 }, tokens: { input: 10, output: 4, cache: { read: 2, write: 1 } },
      },
      parts: [{ type: 'text', text: 'More work remains.' }],
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const nextGoal = JSON.parse(init.body).metadata.openchamber.goal;
        if (!edited && nextGoal.turnsUsed === 2) {
          edited = true;
          currentGoal = { ...nextGoal, objective: 'Edited objective', statusReason: 'resumed', updatedAt: 2 };
          runtime.processPayload({
            type: 'session.updated',
            properties: {
              info: {
                ...session,
                time: { updated: 2 },
                metadata: { openchamber: { goal: currentGoal } },
              },
            },
          });
        } else {
          currentGoal = nextGoal;
        }
        return jsonResponse({ ...session, metadata: { openchamber: { goal: nextGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"More work remains"}', providerID: 'provider', modelID: 'model',
      })) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    expect(promptAttempts).toBe(0);
    expect(currentGoal).toMatchObject({ objective: 'Edited objective', status: 'active', statusReason: 'resumed', turnsUsed: 2, tokensUsed: 17 });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
     await vi.advanceTimersByTimeAsync(100);
     expect(promptAttempts).toBe(1);
    expect(currentGoal.turnsUsed).toBe(2);
     runtime.stop();
  });

  it('does not count a pre-goal truncation toward the fresh goal breaker', async () => {
    let currentGoal = { ...goal, createdAt: 100, turnsUsed: 1, lastAccountedMessageID: 'msg_before' };
    let promptAttempts = 0;
    const lengthMessage = (id, created) => ({
      info: {
        id, sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model', finish: 'length',
        time: { created, completed: created + 1 }, tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'Still truncated.' }],
    });
    const messages = [lengthMessage('msg_old_length', 90), lengthMessage('msg_new_length', 110)];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(promptAttempts).toBe(1);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 2 });
    runtime.stop();
  });

  it('does not count assistant truncations with missing or non-finite creation times toward the breaker', async () => {
    let currentGoal = { ...goal, lastAccountedMessageID: '' };
    let messageReads = 0;
    let promptAttempts = 0;
    const assistant = (id, created) => {
      const info = {
        id, sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model', finish: 'length',
        time: { completed: 3 },
        tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      };
      if (created !== undefined) info.time.created = created;
      return { info, parts: [{ type: 'text', text: 'Still truncated.' }] };
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageReads += 1;
        const id = messageReads <= 3 ? 'msg_unknown_1' : 'msg_unknown_2';
        const created = messageReads <= 3 ? undefined : Number.NaN;
        return {
          ok: true,
          status: 200,
          json: async () => [assistant(id, created)],
        };
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptAttempts += 1;
        return jsonResponse(null);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn() }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    const idle = { type: 'session.status', properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY } };
    runtime.processPayload(idle);
    await vi.runOnlyPendingTimersAsync();
    runtime.processPayload(idle);
    await vi.advanceTimersByTimeAsync(10);

    expect(promptAttempts).toBe(2);
    expect(currentGoal).toMatchObject({ status: 'active', turnsUsed: 3 });
    runtime.stop();
  });

  it('keeps API order for missing timestamps without using IDs as chronology', async () => {
    const known = {
      info: {
        id: 'msg_known', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { created: 100, completed: 101 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'Known.' }],
    };
    const apiLast = {
      info: {
        id: 'msg_a_missing', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 202 }, tokens: { input: 11, output: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'API last.' }],
    };
    const earlierUnknown = {
      info: {
        id: 'msg_z_missing', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 201 }, tokens: { input: 7, output: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'API earlier.' }],
    };
    let currentGoal = { ...goal, lastAccountedMessageID: known.info.id };
    const messages = [known, earlierUnknown, apiLast];
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const audit = vi.fn(async ({ prompt }) => {
      expect(prompt).toContain('API last.');
      return { text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model' };
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: audit }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(audit).toHaveBeenCalledOnce();
    expect(JSON.parse(patch.body).metadata.openchamber.goal).toMatchObject({ status: 'complete', tokensUsed: 11, lastAccountedMessageID: 'msg_a_missing' });
    runtime.stop();
  });

  it('rechecks a file objective immediately before the final metadata write', async () => {
    let currentGoal = { ...goal, objective: '', objectiveFile: true, lastAccountedMessageID: '' };
    let objectiveReads = 0;
    let patchAttempts = 0;
    const assistant = {
      info: {
        id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', providerID: 'provider', modelID: 'model',
        time: { completed: 2 }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'Verified.' }],
    };
    readGoalObjective.mockImplementation(async () => {
      objectiveReads += 1;
      return objectiveReads < 3 ? 'Original objective' : 'Edited objective';
    });
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        patchAttempts += 1;
        currentGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: currentGoal } } });
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'idle' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistant]);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
      })) }),
      readGoalObjective,
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(objectiveReads).toBe(3);
    expect(patchAttempts).toBe(0);
    expect(currentGoal.status).toBe('active');
    runtime.stop();
  });
});
