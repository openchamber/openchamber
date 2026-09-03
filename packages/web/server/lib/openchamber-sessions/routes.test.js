import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorktreeMock = vi.fn(async () => ({
  head: 'abc123',
  name: 'side-task',
  branch: 'openchamber/side-task',
  path: '/repo/worktrees/side-task',
}));
const getWorktreeBootstrapStatusMock = vi.fn(async () => ({
  status: 'ready',
  phase: 'setup-ready',
  error: null,
  updatedAt: Date.now(),
}));
const sessionCreateMock = vi.fn(async () => ({ id: 'ses_123' }));
const sessionForkMock = vi.fn(async () => ({ id: 'ses_fork', title: 'Forked session' }));
const sessionMessagesMock = vi.fn(async () => ({ data: [] }));

let existingSessionMessages = [];
let dispatchedUserMessageSeq = 0;

// The service confirms a prompt landed by watching for a new user message, so
// the default mock behaves like OpenCode recording each dispatched prompt.
const setSessionMessages = (messages) => {
  existingSessionMessages = messages;
};

const recordedSessionMessages = async () => {
  dispatchedUserMessageSeq += 1;
  return {
    data: [
      ...existingSessionMessages,
      {
        info: {
          id: `msg_dispatched_${dispatchedUserMessageSeq}`,
          role: 'user',
          time: { created: 1000 + dispatchedUserMessageSeq },
        },
      },
    ],
  };
};

const sessionCommandMock = vi.fn(async () => ({ data: {} }));
const commandListMock = vi.fn(async () => ({ data: [] }));
const sendPromptMock = vi.fn(async () => true);
const listProvidersMock = vi.fn(async () => ({
  providers: [
    { id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5', variants: { high: {} } } } },
    { id: 'anthropic', models: { 'claude-sonnet-5': { id: 'claude-sonnet-5', variants: { high: {} } } } },
  ],
}));
const listAgentsMock = vi.fn(async () => [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }]);
const getConfigMock = vi.fn(async () => ({}));
const listMessagesMock = vi.fn(async (input) => {
  const response = await sessionMessagesMock(input);
  return { messages: Array.isArray(response?.data) ? response.data : [], cursor: undefined };
});
const openCodeApi = {
  createSession: sessionCreateMock,
  forkSession: sessionForkMock,
  listMessages: listMessagesMock,
  sendPrompt: sendPromptMock,
  runCommand: sessionCommandMock,
  listCommands: async (...args) => {
    const response = await commandListMock(...args);
    return Array.isArray(response?.data) ? response.data : [];
  },
  listProviders: listProvidersMock,
  listAgents: listAgentsMock,
  getConfig: getConfigMock,
  supportsSessionMetadata: () => true,
};
globalThis.__openchamberCreateWorktreeMock = createWorktreeMock;
globalThis.__openchamberGetWorktreeBootstrapStatusMock = getWorktreeBootstrapStatusMock;

let registerOpenChamberSessionRoutes;

vi.mock('../git/index.js', () => ({
  createWorktree: (...args) => globalThis.__openchamberCreateWorktreeMock(...args),
  getWorktreeBootstrapStatus: (...args) => globalThis.__openchamberGetWorktreeBootstrapStatusMock(...args),
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
    openCodeApi,
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
    getWorktreeBootstrapStatusMock.mockClear();
    getWorktreeBootstrapStatusMock.mockImplementation(async () => ({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
      updatedAt: Date.now(),
    }));
    sessionCreateMock.mockClear();
    sessionForkMock.mockClear();
    existingSessionMessages = [];
    dispatchedUserMessageSeq = 0;
    sessionMessagesMock.mockReset();
    sessionMessagesMock.mockImplementation(recordedSessionMessages);
    listMessagesMock.mockClear();
    sendPromptMock.mockReset();
    sendPromptMock.mockResolvedValue(true);
    listProvidersMock.mockReset();
    listProvidersMock.mockResolvedValue({
      providers: [
        { id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5', variants: { high: {} } } } },
        { id: 'anthropic', models: { 'claude-sonnet-5': { id: 'claude-sonnet-5', variants: { high: {} } } } },
      ],
    });
    listAgentsMock.mockReset();
    listAgentsMock.mockResolvedValue([{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }]);
    getConfigMock.mockReset();
    getConfigMock.mockResolvedValue({});
    sessionCommandMock.mockReset();
    sessionCommandMock.mockResolvedValue({ data: {} });
    commandListMock.mockReset();
    commandListMock.mockResolvedValue({ data: [] });
  });

  it('creates a session for a directory', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', title: 'Side task' })
      .expect(200);

    expect(response.body.sessionId).toBe('ses_123');
    expect(response.body.directory).toBe('/repo/app');
    expect(response.body.promptDispatched).toBe(false);
    expect(sessionCreateMock).toHaveBeenCalledWith({ directory: '/repo/app', title: 'Side task' });
  });

  it('preserves non-ASCII checkout paths at the API boundary', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/home/user/Masaüstü/projeler', title: 'Side task' })
      .expect(200);

    expect(sessionCreateMock).toHaveBeenCalledWith({
      directory: '/home/user/Masaüstü/projeler',
      title: 'Side task',
    });
  });

  it('parses JSON body without global middleware', async () => {
    const { app } = createApp({}, { globalJson: false });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app' })
      .expect(200);

    expect(response.body.sessionId).toBe('ses_123');
    expect(response.body.directory).toBe('/repo/app');
  });

  it('emits a session-created event after creating a session', async () => {
    const emitSessionCreatedEvent = vi.fn();
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
  });

  it('resolves default model and agent when prompt omits them', async () => {
    listProvidersMock.mockResolvedValue({
      providers: [{ id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5' } } }],
    });
    listAgentsMock.mockResolvedValue([{ name: 'build', mode: 'primary' }]);
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openai/gpt-5.5',
        defaultAgent: 'build',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(200);

    expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(response.body.agent).toBe('build');
    expect(listProvidersMock).toHaveBeenCalledWith('/repo/app');
    expect(sendPromptMock).toHaveBeenCalledWith(expect.objectContaining({
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
        agent: 'build',
    }));
  });

  it('dispatches an initial prompt when model is provided', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
      .expect(200);

    expect(response.body.sessionId).toBe('ses_123');
    expect(response.body.promptDispatched).toBe(true);
    expect(sendPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_123',
      directory: '/repo/app',
    }));
  });

  it('creates goal metadata before dispatching the initial goal prompt', async () => {
    const createSessionGoal = vi.fn(async () => undefined);
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

    expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: 'Finish and verify the migration',
      tokenBudget: 200000,
      providerID: 'openai',
      modelID: 'gpt-5.5',
    }));
    expect(createSessionGoal.mock.invocationCallOrder[0]).toBeLessThan(sendPromptMock.mock.invocationCallOrder[0]);
    expect(sendPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      parts: [
        { type: 'text', text: 'Finish and verify the migration' },
        expect.objectContaining({ type: 'text', synthetic: true }),
      ],
    }));
    expect(response.body).toMatchObject({ goalEnabled: true, goalTokenBudget: 200000, promptDispatched: true });
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
    expect(sendPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_123',
      directory: '/repo/worktrees/side-task',
    }));
  });

  it('waits for the worktree bootstrap to complete before creating the session', async () => {
    const statuses = [
      { status: 'pending', phase: 'directory-created', error: null, updatedAt: 1 },
      { status: 'pending', phase: 'git-ready', error: null, updatedAt: 2 },
      { status: 'ready', phase: 'setup-ready', error: null, updatedAt: 3 },
    ];
    getWorktreeBootstrapStatusMock.mockImplementation(async () => statuses.shift() || statuses[statuses.length - 1]);
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({
        directory: '/repo/app',
        worktree: { name: 'side-task' },
        prompt: 'Run this',
        model: 'openai/gpt-5.5',
      })
      .expect(200);

    expect(response.body.promptDispatched).toBe(true);
    expect(getWorktreeBootstrapStatusMock).toHaveBeenCalled();
    expect(sessionCreateMock).toHaveBeenCalled();
    expect(sendPromptMock).toHaveBeenCalled();
    expect(sessionCreateMock.mock.invocationCallOrder[0]).toBeLessThan(sendPromptMock.mock.invocationCallOrder[0]);
  });

  it('fails the create when the worktree bootstrap failed', async () => {
    getWorktreeBootstrapStatusMock.mockImplementation(async () => ({
      status: 'failed',
      phase: 'directory-created',
      error: 'branch already exists',
      updatedAt: Date.now(),
    }));
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions')
      .send({
        directory: '/repo/app',
        worktree: { name: 'side-task' },
        prompt: 'Run this',
        model: 'openai/gpt-5.5',
      })
      .expect(500, { error: 'Worktree bootstrap failed: branch already exists' });
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  it('sends a goal prompt to an existing session after creating goal metadata', async () => {
    const createSessionGoal = vi.fn(async () => undefined);
    setSessionMessages([{ info: { id: 'msg_before', role: 'assistant', time: { created: 10, completed: 20 } } }]);
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
    expect(sendPromptMock).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_source', directory: '/repo/app' }));
    expect(createSessionGoal.mock.invocationCallOrder[0]).toBeLessThan(sendPromptMock.mock.invocationCallOrder[0]);
  });

  it('uses the expanded slash-command template as the goal objective before command dispatch', async () => {
    const createSessionGoal = vi.fn(async () => undefined);
    commandListMock.mockResolvedValue({
      data: [{
        name: 'issue--to-pr',
        template: 'Take $ARGUMENTS from issue through a verified pull request. Confirm the PR covers $ARGUMENTS.',
      }],
    });
    const { app } = createApp({ createSessionGoal });
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({
        directory: '/repo/app',
        prompt: '/issue--to-pr LIN-123',
        model: 'openai/gpt-5.5',
        agent: 'build',
        goal: true,
      })
      .expect(200);

    expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Take LIN-123 from issue through a verified pull request. Confirm the PR covers LIN-123.',
    }));
    expect(sessionCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      command: 'issue--to-pr',
      arguments: 'LIN-123',
    }));
    expect(createSessionGoal.mock.invocationCallOrder[0]).toBeLessThan(sessionCommandMock.mock.invocationCallOrder[0]);
    expect(response.body).toMatchObject({ goalEnabled: true, dispatchedAsCommand: true });
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  it('reuses the previous session selection when send omits model, agent, and variant', async () => {
    setSessionMessages([
          {
            info: {
              id: 'msg_user',
              role: 'user',
              agent: 'plan',
              model: { providerID: 'anthropic', modelID: 'claude-sonnet-5', variant: 'high' },
              time: { created: 5 },
            },
          },
          { info: { id: 'msg_before', role: 'assistant', time: { created: 10, completed: 20 } } },
    ]);
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: 'Continue where you left off' })
      .expect(200);

    expect(response.body).toMatchObject({
      action: 'send',
      sessionId: 'ses_source',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
      agent: 'plan',
      variant: 'high',
      promptDispatched: true,
    });
    expect(sendPromptMock).toHaveBeenCalledWith(expect.objectContaining({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
        agent: 'plan',
        variant: 'high',
    }));
    expect(listProvidersMock).not.toHaveBeenCalled();
    expect(listAgentsMock).not.toHaveBeenCalled();
    expect(getConfigMock).not.toHaveBeenCalled();
  });

  it('forks from a message, dispatches the prompt, and emits the new session', async () => {
    const emitSessionCreatedEvent = vi.fn();
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
    expect(sendPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_fork',
      directory: '/repo/app',
    }));
    expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_fork',
        sourceSessionID: 'ses_source',
        directory: '/repo/app',
        promptDispatched: true,
    }));
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
    sendPromptMock.mockRejectedValue(new Error('dispatch failed'));
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
  });

  it('does not apply a default variant to an explicitly requested model', async () => {
    listProvidersMock.mockResolvedValue({
      providers: [
        { id: 'openai', models: { requested: { id: 'requested' }, default: { id: 'default', variants: { high: {} } } } },
      ],
    });
    listAgentsMock.mockResolvedValue([{ name: 'build', mode: 'primary' }]);
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

    expect(sendPromptMock.mock.calls[0][0]).not.toHaveProperty('variant');
  });

  it('rejects an unknown agent before creating a session or worktree', async () => {
    const { app } = createApp();
    await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Run this',
          agent: 'not-an-agent',
          worktree: { name: 'side-task' },
        })
        .expect(400, { error: "Unknown agent 'not-an-agent' for /repo/app" });

    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(sessionCreateMock).not.toHaveBeenCalled();
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown model and an unknown variant before dispatching', async () => {
    const { app } = createApp();
    await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-nope' })
        .expect(400, { error: "Unknown model 'openai/gpt-nope' for /repo/app" });
    await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5', variant: 'ultra' })
        .expect(400, { error: "Unknown variant 'ultra' for model 'openai/gpt-5.5'" });

    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  it('reports promptDispatched false when the accepted prompt never reaches the session', async () => {
    sessionMessagesMock.mockResolvedValue({ data: [] });
    const { app } = createApp();
    const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
        .expect(200);

    expect(response.body.sessionId).toBe('ses_123');
    expect(response.body.promptDispatched).toBe(false);
    expect(response.body.promptError).toBeTruthy();
  }, 20_000);

  it('does not retry a failed slash command as a normal prompt', async () => {
    commandListMock.mockResolvedValue({ data: [{ name: 'review' }] });
    sessionCommandMock.mockRejectedValue(new Error('command response failed'));
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
    expect(sendPromptMock).not.toHaveBeenCalled();
  });
});
