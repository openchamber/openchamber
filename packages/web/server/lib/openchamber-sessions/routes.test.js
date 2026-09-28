import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
// `@opencode/client` unwraps single-record responses, so these mocks return
// the record itself; only the paged/list endpoints keep a `{ data }` envelope.
const sessionCreateMock = vi.fn(async () => ({ id: 'ses_123' }));
const sessionForkMock = vi.fn(async () => ({ id: 'ses_fork', title: 'Forked session' }));
const sessionMessagesMock = vi.fn(async () => ({ data: [] }));
const sessionGetMock = vi.fn(async ({ sessionID }) => ({ id: sessionID, location: { directory: '/repo/app' } }));
const sessionUpdateMock = vi.fn(async () => undefined);
const sessionPromptMock = vi.fn(async () => ({ id: 'msg_dispatched' }));
const sessionSyntheticMock = vi.fn(async () => ({ id: 'msg_synthetic' }));
const sessionSwitchModelMock = vi.fn(async () => undefined);
const sessionSwitchAgentMock = vi.fn(async () => undefined);
const modelListMock = vi.fn(async () => ({ data: [] }));
const agentListMock = vi.fn(async () => ({ data: [] }));
const configGetMock = vi.fn(async () => ([]));

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
        id: `msg_dispatched_${dispatchedUserMessageSeq}`,
        type: 'user',
        time: { created: 1000 + dispatchedUserMessageSeq },
      },
    ],
  };
};

// v2 serves one flat model catalogue and a flat agent list through the client,
// so the selection inputs are stubbed on the client mocks rather than on fetch.
const CATALOG_MODELS = [
  { id: 'gpt-5.5', modelID: 'gpt-5.5', providerID: 'openai', variants: [{ id: 'high' }] },
  { id: 'claude-sonnet-5', modelID: 'claude-sonnet-5', providerID: 'anthropic', variants: [{ id: 'high' }] },
];
const CATALOG_AGENTS = [
  { id: 'build', name: 'Build', mode: 'primary', hidden: false },
  { id: 'plan', name: 'plan', mode: 'primary', hidden: false },
];
const useCatalog = ({ models = CATALOG_MODELS, agents = CATALOG_AGENTS, config = [] } = {}) => {
  modelListMock.mockImplementation(async () => ({ data: models }));
  agentListMock.mockImplementation(async () => ({ data: agents }));
  configGetMock.mockImplementation(async () => config);
};

const sessionCommandMock = vi.fn(async () => undefined);
const commandListMock = vi.fn(async () => ({ data: [] }));
globalThis.__openchamberCreateWorktreeMock = createWorktreeMock;
globalThis.__openchamberGetWorktreeBootstrapStatusMock = getWorktreeBootstrapStatusMock;

let registerOpenChamberSessionRoutes;
let createSessionMetadataStore;
let createOpenCodeSessionMetadata;

// Every `OpenCode.make` call is recorded so tests can assert on the scoping
// headers the routes build.
const clientOptions = [];

vi.mock('@opencode/client', () => ({
  OpenCode: {
    make: (options) => {
      clientOptions.push(options);
      return {
        session: {
          create: sessionCreateMock,
          fork: sessionForkMock,
          get: sessionGetMock,
          update: sessionUpdateMock,
          command: sessionCommandMock,
          prompt: sessionPromptMock,
          synthetic: sessionSyntheticMock,
          switchModel: sessionSwitchModelMock,
          switchAgent: sessionSwitchAgentMock,
        },
        message: { list: sessionMessagesMock },
        command: { list: commandListMock },
        model: { list: modelListMock },
        agent: { list: agentListMock },
        config: { get: configGetMock },
      };
    },
  },
}));

vi.mock('../git/index.js', () => ({
  createWorktree: (...args) => globalThis.__openchamberCreateWorktreeMock(...args),
  getWorktreeBootstrapStatus: (...args) => globalThis.__openchamberGetWorktreeBootstrapStatusMock(...args),
  resolvePrimaryWorktreeRoot: async (directory) => ({ root: directory === '/repo/worktrees/side-task' ? '/repo/app' : directory }),
}));

/**
 * Archive state is OpenChamber's own now, so the routes take a store rather
 * than talking to OpenCode. The tests use an in-memory one with the same
 * contract as `archive-store.js`.
 */
const createMemorySessionMetadataStore = () => {
  const entries = new Map();
  const merge = (current, patch) => {
    const base = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete base[key];
      else if (value && typeof value === 'object' && !Array.isArray(value)) base[key] = merge(base[key], value);
      else base[key] = value;
    }
    return base;
  };
  return {
    entries,
    failFor: null,
    get: async (id) => entries.get(id) ?? {},
    has: async (id) => entries.has(id),
    getAll: async () => Object.fromEntries(entries),
    setSessionMetadata: async (id, patch) => {
      const merged = merge(entries.get(id), patch);
      if (Object.keys(merged).length === 0) entries.delete(id);
      else entries.set(id, merged);
      return merged;
    },
  };
};

const createMemoryArchiveStore = () => {
  const entries = new Map();
  let failFor = new Set();
  return {
    failIds: (ids) => { failFor = new Set(ids); },
    entries,
    getAll: async () => Object.fromEntries(entries),
    list: async () => Object.fromEntries(entries),
    isArchived: async (id) => entries.has(id),
    archivedAt: async (id) => entries.get(id) ?? null,
    archive: async (ids, archivedAt) => {
      const stamp = Number.isSafeInteger(archivedAt) && archivedAt > 0 ? archivedAt : 1;
      const archived = [];
      const failedIds = [];
      for (const id of ids) {
        if (failFor.has(id)) { failedIds.push(id); continue; }
        entries.set(id, stamp);
        archived.push({ id, archivedAt: stamp });
      }
      return { archived, failedIds };
    },
    unarchive: async (ids) => {
      const restored = [];
      const failedIds = [];
      for (const id of ids) {
        if (failFor.has(id)) { failedIds.push(id); continue; }
        entries.delete(id);
        restored.push({ id, archivedAt: null });
      }
      return { restored, failedIds };
    },
  };
};

const createApp = (overrides = {}, options = {}) => {
  const app = express();
  if (options.globalJson !== false) {
    app.use(express.json());
  }
  const calls = [];
  const archiveStore = overrides.archiveStore ?? createMemoryArchiveStore();
  const sessionMetadataStore = overrides.sessionMetadataStore ?? createMemorySessionMetadataStore();
  const broadcastGlobalUiEvent = overrides.broadcastGlobalUiEvent ?? vi.fn();
  registerOpenChamberSessionRoutes(app, {
    archiveStore,
    sessionMetadataStore,
    broadcastGlobalUiEvent,
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'proj_1', path: '/repo/app' }] }),
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    waitForOpenCodeReady: vi.fn(async () => undefined),
    ...overrides,
  });
  return { app, calls, archiveStore, sessionMetadataStore, broadcastGlobalUiEvent };
};

describe('openchamber session routes', () => {
  beforeAll(async () => {
    ({ registerOpenChamberSessionRoutes } = await import('./routes.js'));
    ({ createSessionMetadataStore, createOpenCodeSessionMetadata } = await import('./session-metadata-store.js'));
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
    sessionUpdateMock.mockClear();
    sessionForkMock.mockClear();
    existingSessionMessages = [];
    dispatchedUserMessageSeq = 0;
    sessionMessagesMock.mockReset();
    sessionMessagesMock.mockImplementation(recordedSessionMessages);
    sessionCommandMock.mockReset();
    sessionCommandMock.mockResolvedValue({ data: {} });
    clientOptions.length = 0;
    commandListMock.mockReset();
    commandListMock.mockResolvedValue({ data: [] });
    sessionGetMock.mockReset();
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({ id: sessionID, location: { directory: '/repo/app' } }));
    sessionPromptMock.mockReset();
    sessionPromptMock.mockImplementation(async () => ({ id: 'msg_dispatched' }));
    sessionSyntheticMock.mockReset();
    sessionSyntheticMock.mockImplementation(async () => ({ id: 'msg_synthetic' }));
    sessionSwitchModelMock.mockReset();
    sessionSwitchModelMock.mockImplementation(async () => undefined);
    sessionSwitchAgentMock.mockReset();
    sessionSwitchAgentMock.mockImplementation(async () => undefined);
    modelListMock.mockReset();
    modelListMock.mockImplementation(async () => ({ data: [] }));
    agentListMock.mockReset();
    agentListMock.mockImplementation(async () => ({ data: [] }));
    configGetMock.mockReset();
    useCatalog();
  });

  describe('archiving a batch of sessions', () => {
    it('archives every id and reports what it stored', async () => {
      const { app, archiveStore, broadcastGlobalUiEvent } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', 'ses_b'], archivedAt: 1700 })
        .expect(200);

      expect(response.body.archived).toEqual([
        { id: 'ses_a', archivedAt: 1700 },
        { id: 'ses_b', archivedAt: 1700 },
      ]);
      expect(response.body.failedIds).toEqual([]);
      await expect(archiveStore.getAll()).resolves.toEqual({ ses_a: 1700, ses_b: 1700 });
      expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
        type: 'openchamber:session-archived',
        properties: { sessionID: 'ses_a', archivedAt: 1700 },
      });
    });

    it('keeps archiving after a failed session and reports it as failed', async () => {
      const archiveStore = createMemoryArchiveStore();
      archiveStore.failIds(['ses_b']);
      const { app } = createApp({ archiveStore });

      const response = await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', 'ses_b', 'ses_c'] })
        .expect(200);

      expect(response.body.archived.map((session) => session.id)).toEqual(['ses_a', 'ses_c']);
      expect(response.body.failedIds).toEqual(['ses_b']);
    });

    it('does not announce a session it failed to store', async () => {
      const archiveStore = createMemoryArchiveStore();
      archiveStore.failIds(['ses_b']);
      const { app, broadcastGlobalUiEvent } = createApp({ archiveStore });

      await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', 'ses_b'] })
        .expect(200);

      const announced = broadcastGlobalUiEvent.mock.calls.map(([event]) => event.properties.sessionID);
      expect(announced).toEqual(['ses_a']);
    });

    it('restores a batch and announces the cleared state', async () => {
      const { app, archiveStore, broadcastGlobalUiEvent } = createApp();
      await request(app).post('/api/openchamber/sessions/archive').send({ ids: ['ses_a'] }).expect(200);
      broadcastGlobalUiEvent.mockClear();

      const response = await request(app)
        .post('/api/openchamber/sessions/unarchive')
        .send({ ids: ['ses_a'] })
        .expect(200);

      expect(response.body.restored).toEqual([{ id: 'ses_a', archivedAt: null }]);
      expect(response.body.failedIds).toEqual([]);
      await expect(archiveStore.getAll()).resolves.toEqual({});
      expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
        type: 'openchamber:session-archived',
        properties: { sessionID: 'ses_a', archivedAt: null },
      });
    });

    it('rejects an empty batch, an oversized batch, and non-string ids', async () => {
      const { app, archiveStore } = createApp();

      await request(app).post('/api/openchamber/sessions/archive').send({ ids: [] }).expect(400);
      await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: Array.from({ length: 501 }, (_, index) => `ses_${index}`) })
        .expect(400);
      await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', ''] })
        .expect(400);
      await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a'], archivedAt: -1 })
        .expect(400);
      await request(app).post('/api/openchamber/sessions/unarchive').send({ ids: [] }).expect(400);

      await expect(archiveStore.getAll()).resolves.toEqual({});
    });
  });

  describe('session metadata OpenChamber owns', () => {
    it('merges a patch onto the OpenCode record and writes it back with PATCH', async () => {
      sessionGetMock.mockImplementationOnce(async ({ sessionID }) => ({
        id: sessionID,
        location: { directory: '/repo/app' },
        metadata: { openchamber: { kind: 'review', assist: { recap: 'from v1' } } },
      }));
      // The real store over the same mocked client the routes use.
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-routes-metadata-'));
      const { app } = createApp({
        sessionMetadataStore: createSessionMetadataStore({
          dataDir,
          openCode: createOpenCodeSessionMetadata({
            buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
            getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
          }),
        }),
      });

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_v1/metadata')
        .send({ patch: { openchamber: { goal: { status: 'active' } } } })
        .expect(200);

      const merged = { openchamber: { kind: 'review', assist: { recap: 'from v1' }, goal: { status: 'active' } } };
      expect(response.body.metadata).toEqual(merged);
      expect(sessionUpdateMock).toHaveBeenCalledWith({ sessionID: 'ses_v1', metadata: merged });
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it('merge-patches metadata, returns the merged object, and announces it', async () => {
      const { app, sessionMetadataStore, broadcastGlobalUiEvent } = createApp();

      await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { assist: { recap: 'first' } } } })
        .expect(200);

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { goal: { status: 'active' } } } })
        .expect(200);

      // The second write must not erase the first: OpenCode's PATCH merged, so
      // this does too.
      expect(response.body).toEqual({
        metadata: { openchamber: { assist: { recap: 'first' }, goal: { status: 'active' } } },
      });
      await expect(sessionMetadataStore.get('ses_a')).resolves.toEqual(response.body.metadata);
      expect(broadcastGlobalUiEvent).toHaveBeenLastCalledWith({
        type: 'openchamber:session-metadata',
        properties: { sessionID: 'ses_a', metadata: response.body.metadata },
      });
    });

    it('deletes a key when the patch value is null', async () => {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { goal: { id: 'g1' }, assist: { recap: 'r' } } } })
        .expect(200);

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { assist: null } } })
        .expect(200);

      expect(response.body).toEqual({ metadata: { openchamber: { goal: { id: 'g1' } } } });
    });

    it('reads back what it stored, per session', async () => {
      const { app } = createApp();
      await request(app).post('/api/openchamber/sessions/ses_a/metadata').send({ patch: { a: 1 } }).expect(200);

      await expect(request(app).get('/api/openchamber/sessions/ses_a/metadata').expect(200))
        .resolves.toMatchObject({ body: { metadata: { a: 1 } } });
      await expect(request(app).get('/api/openchamber/sessions/ses_b/metadata').expect(200))
        .resolves.toMatchObject({ body: { metadata: {} } });
    });

    it('rejects a missing or non-object patch', async () => {
      const { app, broadcastGlobalUiEvent } = createApp();

      await request(app).post('/api/openchamber/sessions/ses_a/metadata').send({}).expect(400);
      await request(app).post('/api/openchamber/sessions/ses_a/metadata').send({ patch: 'nope' }).expect(400);
      await request(app).post('/api/openchamber/sessions/ses_a/metadata').send({ patch: ['a'] }).expect(400);

      expect(broadcastGlobalUiEvent).not.toHaveBeenCalled();
    });

    it('routes every write through the server-owned writer when one is injected', async () => {
      const persistSessionMetadata = vi.fn(async () => ({ openchamber: { goal: { status: 'active' } } }));
      const { app, sessionMetadataStore } = createApp({ persistSessionMetadata });

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { goal: { status: 'active' } } }, directory: '/repo/app' })
        .expect(200);

      expect(persistSessionMetadata).toHaveBeenCalledWith(
        'ses_a',
        { openchamber: { goal: { status: 'active' } } },
        { directory: '/repo/app' },
      );
      expect(response.body.metadata).toEqual({ openchamber: { goal: { status: 'active' } } });
      // The injected writer owns the store; the route must not write twice.
      await expect(sessionMetadataStore.get('ses_a')).resolves.toEqual({});
    });
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
    expect(sessionCreateMock).toHaveBeenCalledWith({
      location: { directory: '/repo/app' },
      title: 'Side task',
    });
  });

  it('percent-encodes the directory header for non-ASCII checkout paths', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/home/user/Masaüstü/projeler', title: 'Side task' })
      .expect(200);

    expect(clientOptions.at(-1)?.headers['x-opencode-directory'])
      .toBe(encodeURIComponent('/home/user/Masaüstü/projeler'));
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

  it('resolves a default agent stored by v1 under its display name', async () => {
    useCatalog({ agents: [{ id: 'build', name: 'Build', mode: 'primary' }, { id: 'plan', name: 'Plan', mode: 'primary' }] });
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultAgent: 'Plan',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });

    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(200);

    expect(response.body.agent).toBe('plan');
  });

  it('resolves default model and agent when prompt omits them', async () => {
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
    expect(modelListMock).toHaveBeenCalled();
    expect(sessionSwitchModelMock).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      model: { id: 'gpt-5.5', providerID: 'openai' },
    });
    expect(sessionSwitchAgentMock).toHaveBeenCalledWith({ sessionID: 'ses_123', agent: 'build' });
  });

  it('resolves an Auto default through the routing hook before switching the session', async () => {
    useCatalog();
    const resolveAutoSelection = vi.fn(async () => ({
      model: { providerID: 'openai', id: 'gpt-5.5', variant: 'high' },
      agent: 'plan',
      decision: {},
    }));
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openchamber/auto',
        defaultAgent: 'build',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
      resolveAutoSelection,
    });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(200);

    expect(resolveAutoSelection).toHaveBeenCalledWith({
      sessionId: 'ses_123',
      directory: '/repo/app',
      model: { providerID: 'openchamber', id: 'auto' },
      agent: 'build',
      requestText: 'Run this',
    });
    expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(response.body.agent).toBe('plan');
    expect(sessionSwitchModelMock).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      model: { id: 'gpt-5.5', providerID: 'openai', variant: 'high' },
    });
    expect(sessionSwitchAgentMock).toHaveBeenCalledWith({ sessionID: 'ses_123', agent: 'plan' });
  });

  it('refuses an Auto default when routing is not wired in', async () => {
    useCatalog();
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openchamber/auto',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/not available/);
    expect(sessionSwitchModelMock).not.toHaveBeenCalled();
  });

  it.each([
    ['', { projectId: 'proj_1' }],
    ['', { directory: '/repo/app', worktree: { name: 'side-task' } }],
    ['', { directory: '/repo/worktrees/side-task' }],
    ['/ses_existing/send', { directory: '/repo/worktrees/side-task' }],
    ['/ses_existing/fork', { directory: '/repo/worktrees/side-task' }],
  ])('prefers project defaults for %s with %j', async (endpoint, scope) => {
    useCatalog();
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openai/gpt-5.5',
        defaultAgent: 'build',
        projects: [{ id: 'proj_1', path: '/repo/app', defaultAgent: 'plan' }],
      }),
    });

    const response = await request(app)
      .post(`/api/openchamber/sessions${endpoint}`)
      .send({ ...scope, prompt: 'Run this' })
      .expect(200);

    expect(response.body.agent).toBe('plan');
    // v2 puts the agent on the session, not in the prompt body.
    expect(sessionSwitchAgentMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'plan' }));
  });

  it('dispatches an initial prompt when model is provided', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
      .expect(200);

    expect(response.body.sessionId).toBe('ses_123');
    expect(response.body.promptDispatched).toBe(true);
    expect(sessionPromptMock).toHaveBeenCalledWith({ sessionID: 'ses_123', text: 'Run this' });
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
    expect(createSessionGoal.mock.invocationCallOrder[0])
      .toBeLessThan(sessionPromptMock.mock.invocationCallOrder[0]);
    // v2 cannot append to a message, so the goal reminder follows the prompt as
    // its own synthetic message.
    expect(sessionPromptMock).toHaveBeenCalledWith({ sessionID: 'ses_123', text: 'Finish and verify the migration' });
    expect(sessionSyntheticMock).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_123', resume: false }));
    expect(sessionPromptMock.mock.invocationCallOrder[0])
      .toBeLessThan(sessionSyntheticMock.mock.invocationCallOrder[0]);
    expect(response.body).toMatchObject({ goalEnabled: true, goalTokenBudget: 200000, promptDispatched: true });
  });

  it('rejects invalid goal requests before creating a session', async () => {
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

    expect(sessionCreateMock).not.toHaveBeenCalled();
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
    expect(sessionCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      location: { directory: '/repo/worktrees/side-task' },
    }));
    expect(sessionPromptMock).toHaveBeenCalledWith({ sessionID: 'ses_123', text: 'Run this' });
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
    expect(getWorktreeBootstrapStatusMock.mock.invocationCallOrder[0])
      .toBeLessThan(sessionCreateMock.mock.invocationCallOrder[0]);
    expect(sessionCreateMock.mock.invocationCallOrder[0])
      .toBeLessThan(sessionPromptMock.mock.invocationCallOrder[0]);
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

    expect(sessionPromptMock).not.toHaveBeenCalled();
  });

  it('sends a goal prompt to an existing session after creating goal metadata', async () => {
    const createSessionGoal = vi.fn(async () => undefined);
    setSessionMessages([{ id: 'msg_before', type: 'assistant', time: { created: 10, completed: 20 } }]);

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
    expect(sessionPromptMock).toHaveBeenCalledWith({
      sessionID: 'ses_source',
      text: 'Apply and verify the review feedback',
    });
    expect(createSessionGoal.mock.invocationCallOrder[0])
      .toBeLessThan(sessionPromptMock.mock.invocationCallOrder[0]);
  });

  it('dispatches a slash command and keeps the typed prompt as the goal objective', async () => {
    // v2 no longer publishes a command's template (`CommandInfo` is just name
    // and description), so the objective is what the user typed.
    const createSessionGoal = vi.fn(async () => undefined);
    commandListMock.mockResolvedValue({ data: [{ name: 'issue--to-pr', description: 'Issue to PR' }] });

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
      objective: '/issue--to-pr LIN-123',
    }));
    expect(sessionCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'issue--to-pr',
      text: 'LIN-123',
    }));
    expect(createSessionGoal.mock.invocationCallOrder[0])
      .toBeLessThan(sessionCommandMock.mock.invocationCallOrder[0]);
    expect(response.body).toMatchObject({ goalEnabled: true, dispatchedAsCommand: true });
    expect(sessionPromptMock).not.toHaveBeenCalled();
  });

  it('admits standing project context ahead of a dispatched slash command', async () => {
    commandListMock.mockResolvedValue({ data: [{ name: 'review', description: 'Review' }] });
    const recordDelivered = vi.fn(async () => undefined);
    const sessionKnowledgeRuntime = {
      resolvePendingForSession: vi.fn(async () => ({ text: 'Memory guidance', signature: 'sig_1' })),
      recordDelivered,
    };

    const { app } = createApp({ sessionKnowledgeRuntime });
    await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: '/review', model: 'openai/gpt-5.5', agent: 'build' })
      .expect(200);

    expect(sessionSyntheticMock).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Memory guidance',
      resume: false,
    }));
    expect(sessionSyntheticMock.mock.invocationCallOrder[0])
      .toBeLessThan(sessionCommandMock.mock.invocationCallOrder[0]);
    expect(recordDelivered).toHaveBeenCalledWith('ses_source', '/repo/app', 'sig_1');
  });

  it('reuses the previous session selection when send omits model, agent, and variant', async () => {
    // v2 keeps the selection on the session record, so the history is no longer
    // walked for it.
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      agent: 'plan',
      model: { providerID: 'anthropic', id: 'claude-sonnet-5', variant: 'high' },
      location: { directory: '/repo/app' },
    }));
    setSessionMessages([{ id: 'msg_before', type: 'assistant', time: { created: 10, completed: 20 } }]);

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
    // The default-selection catalogue must not be consulted.
    expect(modelListMock).not.toHaveBeenCalled();
    expect(agentListMock).not.toHaveBeenCalled();
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
      before: 'msg_branch_point',
    });
    expect(response.body).toMatchObject({
      action: 'fork',
      sourceSessionId: 'ses_source',
      sessionId: 'ses_fork',
      directory: '/repo/app',
      promptDispatched: true,
    });
    expect(sessionPromptMock).toHaveBeenCalledWith({ sessionID: 'ses_fork', text: 'Try the alternative implementation' });
    expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_fork',
      sourceSessionID: 'ses_source',
      directory: '/repo/app',
      promptDispatched: true,
    }));
  });

  it('strips source-owned links from a fork before dispatching', async () => {
    sessionForkMock.mockImplementationOnce(async () => ({
      id: 'ses_fork',
      title: 'Forked session',
      metadata: { openchamber: { btwSessionID: 'ses_btw', reviewSessionID: 'ses_review', assist: { recap: 'kept' } } },
    }));
    const { app, sessionMetadataStore } = createApp();
    sessionMetadataStore.entries.set('ses_fork', {
      openchamber: { btwSessionID: 'ses_btw', reviewSessionID: 'ses_review', assist: { recap: 'kept' } },
    });
    await request(app)
      .post('/api/openchamber/sessions/ses_source/fork')
      .send({ directory: '/repo/app', prompt: 'Carry on', model: 'openai/gpt-5.5', agent: 'build' })
      .expect(200);

    expect(sessionMetadataStore.entries.get('ses_fork')).toEqual({ openchamber: { assist: { recap: 'kept' } } });
  });

  it('rejects send and fork requests without a prompt before calling OpenCode', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app' })
      .expect(400, { error: 'prompt is required' });
    await request(app)
      .post('/api/openchamber/sessions/ses_source/fork')
      .send({ directory: '/repo/app' })
      .expect(400, { error: 'prompt is required' });

    expect(sessionForkMock).not.toHaveBeenCalled();
    expect(sessionPromptMock).not.toHaveBeenCalled();
  });

  it('reports the forked session when prompt dispatch fails', async () => {
    sessionPromptMock.mockRejectedValue(new Error('dispatch failed'));

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
    useCatalog({
      models: [
        { id: 'requested', modelID: 'requested', providerID: 'openai', variants: [] },
        { id: 'default', modelID: 'default', providerID: 'openai', variants: [{ id: 'high' }] },
      ],
    });
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

    expect(sessionSwitchModelMock).toHaveBeenCalledWith({
      sessionID: 'ses_source',
      model: { id: 'requested', providerID: 'openai' },
    });
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
    expect(sessionPromptMock).not.toHaveBeenCalled();
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

    expect(sessionPromptMock).not.toHaveBeenCalled();
  });

  it('reports promptDispatched false when the accepted prompt returns no queued message', async () => {
    // v2 answers a prompt with the inbox item it recorded; no id means nothing
    // is queued, so the dispatch must not be reported as done.
    sessionPromptMock.mockResolvedValue({});

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
    expect(sessionPromptMock).not.toHaveBeenCalled();
  });
});
