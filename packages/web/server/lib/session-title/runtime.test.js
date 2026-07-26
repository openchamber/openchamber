import { afterEach, describe, expect, it, mock } from 'bun:test';

import { createSessionTitleRuntime } from './runtime.js';

const SESSION_ID = 'ses_claude';
const DIRECTORY = '/workspace';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const originalFetch = globalThis.fetch;

const waitForRuntime = () => new Promise((resolve) => setTimeout(resolve, 20));

const userMessageEvent = (sessionId = SESSION_ID) => ({
  type: 'message.updated',
  properties: {
    info: {
      id: 'msg_user',
      sessionID: sessionId,
      role: 'user',
      time: { created: 1 },
    },
  },
});

const idleEvent = (sessionId = SESSION_ID) => ({
  type: 'session.status',
  properties: { sessionID: sessionId, status: { type: 'idle' }, directory: DIRECTORY },
});

const busyEvent = (sessionId = SESSION_ID) => ({
  type: 'session.status',
  properties: { sessionID: sessionId, status: { type: 'busy' }, directory: DIRECTORY },
});

const createRuntimeHarness = ({
  binding = { harnessId: 'claude-code' },
  session = { id: SESSION_ID, title: 'Untitled Session' },
  messages = [{
    info: { id: 'msg_user', sessionID: SESSION_ID, role: 'user' },
    parts: [{ type: 'text', text: 'Implement OAuth callback handling' }],
  }],
  generatedText = 'OAuth Callback Handling',
} = {}) => {
  const requests = [];
  const fetchImpl = mock(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    requests.push({ url, method: init.method ?? 'GET', body: init.body });
    if (url.pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
      return jsonResponse({ ...session, title: JSON.parse(init.body).title });
    }
    if (url.pathname === `/session/${SESSION_ID}`) {
      return jsonResponse(session);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  globalThis.fetch = fetchImpl;

  const service = {
    generateSmallModelText: mock(async () => ({
      text: generatedText,
      providerID: 'provider',
      modelID: 'model',
    })),
  };
  const getSmallModelService = mock(async () => service);
  const getHarnessRecentMessages = mock(() => messages);
  const getSessionBinding = mock(() => binding);
  const runtime = createSessionTitleRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
    getSmallModelService,
    getHarnessRecentMessages,
    getSessionBinding,
    quietMs: 0,
  });

  return {
    runtime,
    requests,
    service,
    getSmallModelService,
    getHarnessRecentMessages,
    getSessionBinding,
  };
};

describe('session title runtime', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  it('skips non-claude bindings', async () => {
    const { runtime, getSmallModelService, getSessionBinding } = createRuntimeHarness({
      binding: { harnessId: 'opencode' },
    });

    runtime.processHarnessPayload(userMessageEvent(), DIRECTORY);
    runtime.processHarnessPayload(idleEvent(), DIRECTORY);
    await waitForRuntime();

    expect(getSessionBinding).toHaveBeenCalled();
    expect(getSmallModelService).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('skips non-default titles', async () => {
    const { runtime, requests, getSmallModelService } = createRuntimeHarness({
      session: { id: SESSION_ID, title: 'Important migration plan' },
    });

    runtime.processHarnessPayload(userMessageEvent(), DIRECTORY);
    runtime.processHarnessPayload(idleEvent(), DIRECTORY);
    await waitForRuntime();

    expect(requests.map((request) => request.method)).toEqual(['GET']);
    expect(getSmallModelService).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('patches title on idle after user message using harness recent messages', async () => {
    const { runtime, requests, service, getHarnessRecentMessages } = createRuntimeHarness();

    runtime.processHarnessPayload(userMessageEvent(), DIRECTORY);
    runtime.processHarnessPayload(busyEvent(), DIRECTORY);
    runtime.processHarnessPayload(idleEvent(), DIRECTORY);
    await waitForRuntime();

    expect(getHarnessRecentMessages).toHaveBeenCalledWith(SESSION_ID);
    expect(service.generateSmallModelText).toHaveBeenCalledTimes(1);
    expect(service.generateSmallModelText.mock.calls[0][0].prompt).toContain('Implement OAuth callback handling');
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch.url.searchParams.get('directory')).toBe(DIRECTORY);
    expect(JSON.parse(patch.body)).toEqual({ title: 'OAuth Callback Handling' });
    runtime.stop();
  });

  it('does not double-title same session', async () => {
    const { runtime, requests, service } = createRuntimeHarness();

    runtime.processHarnessPayload(userMessageEvent(), DIRECTORY);
    runtime.processHarnessPayload(idleEvent(), DIRECTORY);
    await waitForRuntime();
    runtime.processHarnessPayload(idleEvent(), DIRECTORY);
    await waitForRuntime();

    expect(service.generateSmallModelText).toHaveBeenCalledTimes(1);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    runtime.stop();
  });
});
