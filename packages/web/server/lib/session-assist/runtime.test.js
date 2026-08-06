import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionAssistRuntime } from './runtime.js';

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Condition-based waiting instead of fixed sleeps: the runtime arms timers
// (quietMs, retryQuietMs, startup delay), so assertions must wait for the
// observable request to appear rather than racing a clock.
const waitFor = async (predicate, timeoutMs = 1_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
};

const userMessage = (id, text) => ({
  info: { id, role: 'user', time: { created: 1 } },
  parts: [{ type: 'text', text }],
});

const emptyAssistantMessage = (id, overrides = {}) => ({
  info: {
    id,
    role: 'assistant',
    agent: 'build',
    providerID: 'provider',
    modelID: 'model',
    parentID: 'msg_u1',
    time: { created: 10, completed: 20 },
    finish: 'unknown',
    ...overrides,
  },
  parts: [
    { type: 'step-start' },
    { type: 'step-finish', reason: 'unknown' },
  ],
});

const unfinishedAssistantMessage = (id, overrides = {}) => ({
  info: {
    id,
    role: 'assistant',
    agent: 'build',
    providerID: 'provider',
    modelID: 'model',
    parentID: 'msg_u1',
    time: { created: 10 },
    ...overrides,
  },
  parts: [
    { type: 'step-start' },
    { type: 'tool', tool: 'bash', callID: 'call_00_1', state: { status: 'running', input: { command: 'sleep 999' } } },
  ],
});

const contentAssistantMessage = (id, overrides = {}) => ({
  info: {
    id,
    role: 'assistant',
    agent: 'build',
    providerID: 'provider',
    modelID: 'model',
    parentID: 'msg_u1',
    time: { created: 10, completed: 20 },
    finish: 'stop',
    ...overrides,
  },
  parts: [{ type: 'text', text: 'Real reply.' }],
});

describe('session assist runtime — failed-turn recovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENCHAMBER_DATA_DIR;
  });

  const buildRuntime = ({ fetchImpl, smallModelText, opts = {} } = {}) => {
    const runtime = createSessionAssistRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: vi.fn(async () => ({
          text: smallModelText ?? '{"recap":"Recap","suggestion":"Suggestion"}',
          providerID: 'smallp',
          modelID: 'smallm',
        })),
      }),
      quietMs: 5,
      retryQuietMs: 5,
      startupRecoveryDelayMs: 10_000_000,
      ...opts,
    });
    return runtime;
  };

  const hasPrompt = (requests) => requests.some((request) => request.path.endsWith('/prompt_async'));

  const idleStatuses = (sessionId) => ({ [sessionId]: { type: 'idle' } });

  it('retries an empty completed assistant turn via prompt_async and records the retry state', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1' });
      if (url.pathname === '/session/status') return json(idleStatuses('ses_1'));
      if (url.pathname === '/session/ses_1/message') {
        return json([userMessage('msg_u1', 'Continue the work'), emptyAssistantMessage('msg_e1')]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime();
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => hasPrompt(requests));

    const prompt = requests.find((request) => request.path.endsWith('/prompt_async'));
    expect(prompt).toBeTruthy();
    const payload = JSON.parse(prompt.body);
    expect(payload).toMatchObject({
      model: { providerID: 'provider', modelID: 'model' },
      agent: 'build',
    });
    expect(payload.parts[0].text).toContain('empty');
    const retryPatch = requests.find((request) => request.method === 'PATCH');
    expect(JSON.parse(retryPatch.body).metadata.openchamber.assistRetry).toMatchObject({
      count: 1,
      lastMessageID: 'msg_e1',
    });
    runtime.stop();
  });

  it('retries an unfinished assistant turn (serve died mid-stream) via the idle path', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1' });
      if (url.pathname === '/session/status') return json(idleStatuses('ses_1'));
      if (url.pathname === '/session/ses_1/message') {
        return json([userMessage('msg_u1', 'Continue the work'), unfinishedAssistantMessage('msg_u1f')]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime();
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => hasPrompt(requests));

    expect(hasPrompt(requests)).toBe(true);
    runtime.stop();
  });

  it('drops the retry when the session turns busy before the prompt', async () => {    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1' });
      if (url.pathname === '/session/status') return json({ ses_1: { type: 'busy' } });
      if (url.pathname === '/session/ses_1/message') {
        return json([userMessage('msg_u1', 'Continue the work'), emptyAssistantMessage('msg_e1')]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime();
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => requests.some((request) => request.method === 'PATCH'));
    await sleep(150);

    expect(hasPrompt(requests)).toBe(false);
    runtime.stop();
  });

  it('drops the retry when the session status cannot be confirmed', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1' });
      if (url.pathname === '/session/status') return new Response('boom', { status: 500 });
      if (url.pathname === '/session/ses_1/message') {
        return json([userMessage('msg_u1', 'Continue the work'), emptyAssistantMessage('msg_e1')]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime();
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => requests.some((request) => request.method === 'PATCH'));
    await sleep(150);

    expect(hasPrompt(requests)).toBe(false);
    runtime.stop();
  });

  it('escalates to an honest recap once retries are exhausted and sends no prompt', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') {
        return json({
          id: 'ses_1',
          metadata: { openchamber: { assistRetry: { count: 2, lastMessageID: 'msg_e1' } } },
        });
      }
      if (url.pathname === '/session/ses_1/message') {
        return json([userMessage('msg_u1', 'Continue the work'), emptyAssistantMessage('msg_e1')]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime({
      smallModelText: '{"recap":"Agent reply came back empty — provider limit","suggestion":"Continue the work."}',
    });
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => requests.some((request) => request.method === 'PATCH'));
    await sleep(150);

    expect(hasPrompt(requests)).toBe(false);
    const patches = requests.filter((request) => request.method === 'PATCH');
    const assistPatch = patches[patches.length - 1];
    expect(JSON.parse(assistPatch.body).metadata.openchamber.assist).toMatchObject({
      recap: 'Agent reply came back empty — provider limit',
      suggestion: 'Continue the work.',
      forMessageID: 'msg_e1',
    });
    runtime.stop();
  });

  it('resets the retry counter when the failed turn is a new message', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') {
        return json({
          id: 'ses_1',
          metadata: { openchamber: { assistRetry: { count: 2, lastMessageID: 'msg_old' } } },
        });
      }
      if (url.pathname === '/session/status') return json(idleStatuses('ses_1'));
      if (url.pathname === '/session/ses_1/message') {
        return json([userMessage('msg_u1', 'Continue the work'), emptyAssistantMessage('msg_new')]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime();
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => hasPrompt(requests));

    expect(hasPrompt(requests)).toBe(true);
    const retryPatch = requests.find((request) => request.method === 'PATCH');
    expect(JSON.parse(retryPatch.body).metadata.openchamber.assistRetry).toMatchObject({
      count: 1,
      lastMessageID: 'msg_new',
    });
    runtime.stop();
  });

  it('never retries a user-aborted turn', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1' });
      if (url.pathname === '/session/ses_1/message') {
        return json([
          userMessage('msg_u1', 'Continue the work'),
          emptyAssistantMessage('msg_ab', {
            error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
          }),
        ]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime();
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => requests.some((request) => request.method === 'PATCH'));
    await sleep(150);

    expect(hasPrompt(requests)).toBe(false);
    runtime.stop();
  });

  it('drops the retry when the session tail moves during the quiet window', async () => {
    const requests = [];
    let messageCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1' });
      if (url.pathname === '/session/ses_1/message') {
        messageCalls += 1;
        if (messageCalls === 1) {
          return json([userMessage('msg_u1', 'Continue the work'), emptyAssistantMessage('msg_e1')]);
        }
        return json([userMessage('msg_u2', 'Wait, actually…')]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime();
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => requests.some((request) => request.method === 'PATCH'));
    await sleep(150);

    expect(hasPrompt(requests)).toBe(false);
    runtime.stop();
  });

  it('keeps the plain recap path for a normal assistant turn (no prompt)', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1' });
      if (url.pathname === '/session/ses_1/message') {
        return json([userMessage('msg_u1', 'Continue the work'), contentAssistantMessage('msg_ok')]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime();
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => requests.some((request) => request.method === 'PATCH'));
    await sleep(100);

    expect(hasPrompt(requests)).toBe(false);
    const patches = requests.filter((request) => request.method === 'PATCH');
    expect(patches.length).toBe(1);
    expect(JSON.parse(patches[0].body).metadata.openchamber.assist).toMatchObject({
      recap: 'Recap',
      forMessageID: 'msg_ok',
    });
    runtime.stop();
  });

  it('falls back to a fixed-language honest recap when the small model fails', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') {
        return json({
          id: 'ses_1',
          metadata: { openchamber: { assistRetry: { count: 2, lastMessageID: 'msg_e1' } } },
        });
      }
      if (url.pathname === '/session/ses_1/message') {
        return json([userMessage('msg_u1', 'Continue the work'), emptyAssistantMessage('msg_e1')]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime({
      opts: {
        getSmallModelService: async () => ({
          generateSmallModelText: vi.fn(async () => {
            throw new Error('small model down');
          }),
        }),
      },
    });
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => requests.some((request) => request.method === 'PATCH'));
    await sleep(150);

    expect(hasPrompt(requests)).toBe(false);
    const patches = requests.filter((request) => request.method === 'PATCH');
    const assistPatch = patches[patches.length - 1];
    const assist = JSON.parse(assistPatch.body).metadata.openchamber.assist;
    expect(assist.recap).toContain('empty');
    expect(assist.suggestion).toContain('Continue');
    runtime.stop();
  });

  it('skips auto-retry when disabled in settings and writes the honest recap immediately', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-assist-test-'));
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ sessionAutoRetryEnabled: false }));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;

    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1' });
      if (url.pathname === '/session/ses_1/message') {
        return json([userMessage('msg_u1', 'Continue the work'), emptyAssistantMessage('msg_e1')]);
      }
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = buildRuntime({
      smallModelText: '{"recap":"Agent reply came back empty","suggestion":"Continue the work."}',
    });
    await runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    });
    await waitFor(() => requests.some((request) => request.method === 'PATCH'));
    await sleep(150);

    expect(hasPrompt(requests)).toBe(false);
    const patches = requests.filter((request) => request.method === 'PATCH');
    expect(JSON.parse(patches[0].body).metadata.openchamber.assist.recap).toContain('empty');
    runtime.stop();
  });

  describe('startup recovery scan', () => {
    it('retries a session stranded on an unfinished turn after a serve restart', async () => {
      const requests = [];
      const dirs = ['/repo'];
      vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
        if (url.pathname === '/session/status') return json(idleStatuses('ses_stranded'));
        if (url.pathname === '/session' && init.method === 'GET') {
          return json([{ id: 'ses_stranded', time: { updated: Date.now() } }]);
        }
        if (url.pathname === '/session/ses_stranded') return json({ id: 'ses_stranded' });
        if (url.pathname === '/session/ses_stranded/message') {
          return json([userMessage('msg_u1', 'Continue the work'), unfinishedAssistantMessage('msg_str')]);
        }
        if (url.pathname === '/session/ses_stranded/prompt_async') return json({});
        throw new Error(`Unexpected ${url.pathname}`);
      }));

      const runtime = buildRuntime({
        opts: { getStartupDirectories: async () => dirs },
      });
      await runtime.runStartupRecovery();
      await waitFor(() => hasPrompt(requests));

      expect(hasPrompt(requests)).toBe(true);
      const prompt = requests.find((request) => request.path.endsWith('/prompt_async'));
      expect(JSON.parse(prompt.body)).toMatchObject({ model: { providerID: 'provider', modelID: 'model' } });
      runtime.stop();
    });

    it('skips sessions that are busy', async () => {
      const requests = [];
      const dirs = ['/repo'];
      vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
        if (url.pathname === '/session/status') return json({ ses_busy: { type: 'busy' } });
        if (url.pathname === '/session' && init.method === 'GET') {
          return json([{ id: 'ses_busy', time: { updated: Date.now() } }]);
        }
        if (url.pathname === '/session/ses_busy/prompt_async') return json({});
        throw new Error(`Unexpected ${url.pathname}`);
      }));

      const runtime = buildRuntime({
        opts: { getStartupDirectories: async () => dirs },
      });
      await runtime.runStartupRecovery();
      await sleep(150);

      expect(hasPrompt(requests)).toBe(false);
      expect(requests.some((request) => request.path === '/session/ses_busy/message')).toBe(false);
      runtime.stop();
    });

    it('skips sessions whose last turn is normal', async () => {
      const requests = [];
      const dirs = ['/repo'];
      vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
        if (url.pathname === '/session/status') return json(idleStatuses('ses_ok'));
        if (url.pathname === '/session' && init.method === 'GET') {
          return json([{ id: 'ses_ok', time: { updated: Date.now() } }]);
        }
        if (url.pathname === '/session/ses_ok/message') {
          return json([userMessage('msg_u1', 'Continue the work'), contentAssistantMessage('msg_ok')]);
        }
        if (url.pathname === '/session/ses_ok/prompt_async') return json({});
        throw new Error(`Unexpected ${url.pathname}`);
      }));

      const runtime = buildRuntime({
        opts: { getStartupDirectories: async () => dirs },
      });
      await runtime.runStartupRecovery();
      await sleep(150);

      expect(hasPrompt(requests)).toBe(false);
      runtime.stop();
    });

    it('does nothing without startup directories', async () => {
      const fetchImpl = vi.fn();
      vi.stubGlobal('fetch', fetchImpl);
      const runtime = buildRuntime();
      await runtime.runStartupRecovery();
      await sleep(50);
      expect(fetchImpl).not.toHaveBeenCalled();
      runtime.stop();
    });

    it('debounces rapid triggers (serve restart storms) and re-scans after the interval', async () => {
      const requests = [];
      const dirs = ['/repo'];
      vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
        if (url.pathname === '/session/status') return json(idleStatuses('ses_x'));
        if (url.pathname === '/session' && init.method === 'GET') {
          return json([{ id: 'ses_x', time: { updated: Date.now() } }]);
        }
        if (url.pathname === '/session/ses_x/message') {
          return json([userMessage('msg_u1', 'Continue the work'), contentAssistantMessage('msg_ok')]);
        }
        throw new Error(`Unexpected ${url.pathname}`);
      }));

      const runtime = buildRuntime({
        opts: {
          getStartupDirectories: async () => dirs,
          startupRecoveryMinIntervalMs: 80,
        },
      });
      await runtime.runStartupRecovery();
      await runtime.runStartupRecovery();
      await runtime.runStartupRecovery();
      await sleep(120);
      await runtime.runStartupRecovery();
      await sleep(50);

      // First trigger scans; two immediate repeats are debounced; after the
      // interval a fresh scan runs again.
      const sessionListCalls = requests.filter(
        (request) => request.path === '/session' && (request.method ?? 'GET') === 'GET',
      );
      expect(sessionListCalls.length).toBe(2);
      runtime.stop();
    });
  });
});
