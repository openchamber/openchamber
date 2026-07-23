import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorktreeMock = vi.fn(async () => ({
  head: 'abc123',
  name: 'side-task',
  branch: 'openchamber/side-task',
  path: '/repo/worktrees/side-task',
}));
const sessionCreateMock = vi.fn(async () => ({ data: { id: 'ses_123' } }));
const sessionForkMock = vi.fn(async () => ({ data: { id: 'ses_fork', title: 'Forked session' } }));
const sessionMessagesMock = vi.fn(async () => ({ data: [] }));
const sessionCommandMock = vi.fn(async () => ({ data: {} }));
const commandListMock = vi.fn(async () => ({ data: [] }));
globalThis.__openchamberCreateWorktreeMock = createWorktreeMock;

let registerOpenChamberSessionRoutes;

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: () => ({
    session: {
      create: sessionCreateMock,
      fork: sessionForkMock,
      messages: sessionMessagesMock,
      command: sessionCommandMock,
    },
    command: {
      list: commandListMock,
    },
  }),
}));

vi.mock('../git/index.js', () => ({
  createWorktree: (...args) => globalThis.__openchamberCreateWorktreeMock(...args),
}));

const createApp = (overrides = {}, options = {}) => {
  const app = express();
  if (options.globalJson !== false) {
    app.use(express.json());
  }
  const calls = [];
  registerOpenChamberSessionRoutes(app, {
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'proj_1', path: '/repo/app' }] }),
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    waitForOpenCodeReady: vi.fn(async () => undefined),
    ...overrides,
  });
  return { app, calls };
};

describe('openchamber session routes', () => {
  beforeAll(async () => {
    ({ registerOpenChamberSessionRoutes } = await import('./routes.js'));
  });

  beforeEach(() => {
    createWorktreeMock.mockClear();
    sessionCreateMock.mockClear();
    sessionForkMock.mockClear();
    sessionMessagesMock.mockReset();
    sessionMessagesMock.mockResolvedValue({ data: [] });
    sessionCommandMock.mockReset();
    sessionCommandMock.mockResolvedValue({ data: {} });
    commandListMock.mockReset();
    commandListMock.mockResolvedValue({ data: [] });
  });

  it('creates a session for a directory', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'ses_123' }) }));
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', title: 'Side task' })
        .expect(200);

      expect(response.body.sessionId).toBeTruthy();
      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.directory).toBe('/repo/app');
      expect(response.body.promptDispatched).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session?directory=%2Frepo%2Fapp',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ directory: '/repo/app', title: 'Side task' }),
        }),
      );
      expect(sessionCreateMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses JSON body without global middleware', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'ses_123' }) }));
    try {
      const { app } = createApp({}, { globalJson: false });
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app' })
        .expect(200);

      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.directory).toBe('/repo/app');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits a session-created event after creating a session', async () => {
    const originalFetch = globalThis.fetch;
    const emitSessionCreatedEvent = vi.fn();
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'ses_123' }) }));
    try {
      const { app } = createApp({ emitSessionCreatedEvent });
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', title: 'Side task' })
        .expect(200);

      expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_123',
        directory: '/repo/app',
        title: 'Side task',
        promptDispatched: false,
        dispatchedAsCommand: false,
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves default model and agent when prompt omits them', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes('/prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      if (text.includes('/config/providers')) {
        return { ok: true, json: async () => ({ providers: [{ id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5' } } }] }) };
      }
      if (text.includes('/agent')) {
        return { ok: true, json: async () => [{ name: 'build', mode: 'primary' }] };
      }
      if (text.includes('/config')) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    globalThis.fetch = fetchMock;
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openai/gpt-5.5',
        defaultAgent: 'build',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    try {
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this' })
        .expect(200);

      expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
      expect(response.body.agent).toBe('build');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://opencode.test/config/providers?directory=%2Frepo%2Fapp',
        expect.any(Object),
      );
      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(JSON.parse(promptCall?.[1]?.body)).toMatchObject({
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
        agent: 'build',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('dispatches an initial prompt when model is provided', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
        .expect(200);

      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.promptDispatched).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_123/prompt_async?directory=%2Frepo%2Fapp',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates goal metadata before dispatching the initial goal prompt', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) return { ok: true, text: async () => '' };
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    const createSessionGoal = vi.fn(async () => undefined);
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp({ createSessionGoal });
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Finish and verify the migration',
          model: 'openai/gpt-5.5',
          goal: true,
          goalTokenBudget: 200000,
        })
        .expect(200);

      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      const promptPayload = JSON.parse(promptCall[1].body);
      expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_123',
        directory: '/repo/app',
        objective: 'Finish and verify the migration',
        tokenBudget: 200000,
        providerID: 'openai',
        modelID: 'gpt-5.5',
      }));
      expect(createSessionGoal.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder.at(-1));
      expect(promptPayload.parts).toEqual([
        { type: 'text', text: 'Finish and verify the migration' },
        expect.objectContaining({ type: 'text', synthetic: true }),
      ]);
      expect(response.body).toMatchObject({ goalEnabled: true, goalTokenBudget: 200000, promptDispatched: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects invalid goal requests before creating a session', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', goal: true })
        .expect(400, { error: 'prompt is required when goal is enabled' });
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run', goalTokenBudget: 200000 })
        .expect(400, { error: 'goalTokenBudget requires goal' });
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run', goal: true, goalTokenBudget: 999 })
        .expect(400, { error: 'goalTokenBudget must be an integer from 1000 to 100000000' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates a worktree before creating a session', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          worktree: { name: 'side-task', branchName: 'openchamber/side-task', startRef: 'main' },
          setUpstream: false,
          prompt: 'Run this',
          model: 'openai/gpt-5.5',
        })
        .expect(200);

      expect(createWorktreeMock).toHaveBeenCalledWith('/repo/app', {
        mode: 'new',
        name: 'side-task',
        branchName: 'openchamber/side-task',
        startRef: 'main',
        setUpstream: false,
      });
      expect(response.body.directory).toBe('/repo/worktrees/side-task');
      expect(response.body.worktree.path).toBe('/repo/worktrees/side-task');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_123/prompt_async?directory=%2Frepo%2Fworktrees%2Fside-task',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sends a goal prompt to an existing session after creating goal metadata', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    const createSessionGoal = vi.fn(async () => undefined);
    globalThis.fetch = fetchMock;
    try {
      sessionMessagesMock.mockResolvedValue({
        data: [{ info: { id: 'msg_before', role: 'assistant', time: { created: 10, completed: 20 } } }],
      });
      const { app } = createApp({ createSessionGoal });
      const response = await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({
          directory: '/repo/app',
          prompt: 'Apply and verify the review feedback',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
          goal: true,
          goalTokenBudget: 200000,
        })
        .expect(200);

      expect(response.body).toMatchObject({
        action: 'send',
        sessionId: 'ses_source',
        directory: '/repo/app',
        promptDispatched: true,
        goalEnabled: true,
        baselineAssistantMessageId: 'msg_before',
      });
      expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_source',
        directory: '/repo/app',
        objective: 'Apply and verify the review feedback',
      }));
      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(promptCall?.[0]).toBe('http://opencode.test/session/ses_source/prompt_async?directory=%2Frepo%2Fapp');
      expect(createSessionGoal.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder.at(-1));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('forks from a message, dispatches the prompt, and emits the new session', async () => {
    const originalFetch = globalThis.fetch;
    const emitSessionCreatedEvent = vi.fn();
    globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => '' }));
    try {
      const { app } = createApp({ emitSessionCreatedEvent });
      const response = await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({
          directory: '/repo/app',
          messageId: 'msg_branch_point',
          prompt: 'Try the alternative implementation',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
        })
        .expect(200);

      expect(sessionForkMock).toHaveBeenCalledWith({
        sessionID: 'ses_source',
        directory: '/repo/app',
        messageID: 'msg_branch_point',
      });
      expect(response.body).toMatchObject({
        action: 'fork',
        sourceSessionId: 'ses_source',
        sessionId: 'ses_fork',
        directory: '/repo/app',
        promptDispatched: true,
      });
      expect(sessionMessagesMock).toHaveBeenCalledWith({
        sessionID: 'ses_fork',
        directory: '/repo/app',
        limit: 100,
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_fork/prompt_async?directory=%2Frepo%2Fapp',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_fork',
        sourceSessionID: 'ses_source',
        directory: '/repo/app',
        promptDispatched: true,
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects send and fork requests without a prompt before calling OpenCode', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app' })
        .expect(400, { error: 'prompt is required' });
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app' })
        .expect(400, { error: 'prompt is required' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sessionForkMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports the forked session when prompt dispatch fails', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'dispatch failed' }));
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({
          directory: '/repo/app',
          prompt: 'Try another approach',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
        })
        .expect(500);

      expect(response.body).toMatchObject({
        partial: true,
        partialAction: 'fork-created',
        sessionId: 'ses_fork',
        directory: '/repo/app',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not apply a default variant to an explicitly requested model', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes('/prompt_async')) return { ok: true, text: async () => '' };
      if (text.includes('/config/providers')) {
        return {
          ok: true,
          json: async () => ({
            providers: [
              { id: 'openai', models: { requested: { id: 'requested' }, default: { id: 'default', variants: { high: {} } } } },
            ],
          }),
        };
      }
      if (text.includes('/agent')) return { ok: true, json: async () => [{ name: 'build', mode: 'primary' }] };
      if (text.includes('/config')) return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({ id: 'ses_123' }) };
    });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp({
        readSettingsFromDiskMigrated: async () => ({
          defaultModel: 'openai/default',
          defaultVariant: 'high',
          projects: [{ id: 'proj_1', path: '/repo/app' }],
        }),
      });
      await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app', prompt: 'Continue', model: 'openai/requested', agent: 'build' })
        .expect(200);

      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(JSON.parse(promptCall[1].body)).not.toHaveProperty('variant');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not retry a failed slash command as a normal prompt', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    commandListMock.mockResolvedValue({ data: [{ name: 'review' }] });
    sessionCommandMock.mockRejectedValue(new Error('command response failed'));
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({
          directory: '/repo/app',
          prompt: '/review fix this',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
        })
        .expect(500);

      expect(sessionCommandMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
