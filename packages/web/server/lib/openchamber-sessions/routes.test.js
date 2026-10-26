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
const worktreeBootstrapStore = { read: vi.fn(), write: vi.fn(), remove: vi.fn() };
const hydrateWorktreeCheckoutMock = vi.fn(async () => ({ status: 'not-needed', submodules: [], lfs: [] }));
// `@opencode/client` unwraps single-record responses, so these mocks return
// the record itself; only the paged/list endpoints keep a `{ data }` envelope.
const sessionCreateMock = vi.fn(async () => ({ id: 'ses_123' }));
const sessionForkMock = vi.fn(async () => ({ id: 'ses_fork', title: 'Forked session' }));
const sessionMessagesMock = vi.fn(async () => ({ data: [] }));
const sessionGetMock = vi.fn(async ({ sessionID }) => ({ id: sessionID, location: { directory: '/repo/app' } }));
const sessionUpdateMock = vi.fn(async () => undefined);
const sessionMoveMock = vi.fn(async () => undefined);
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
const defaultPrimaryWorktreeRoot = async (directory) => ({ root: directory === '/repo/worktrees/side-task' ? '/repo/app' : directory });
const resolvePrimaryWorktreeRootMock = vi.fn(defaultPrimaryWorktreeRoot);
globalThis.__openchamberResolvePrimaryWorktreeRootMock = resolvePrimaryWorktreeRootMock;

let registerOpenChamberSessionRoutes;
let createOpenChamberSessionService;
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
          move: sessionMoveMock,
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
  resolvePrimaryWorktreeRoot: (...args) => globalThis.__openchamberResolvePrimaryWorktreeRootMock(...args),
  // Only moving a session into a worktree reaches these; the route tests
  // inject their own through the service dependencies.
  removeWorktree: vi.fn(),
  getBranches: vi.fn(),
  stashPush: vi.fn(),
  getPathsWithoutChanges: vi.fn(async () => []),
  stashApply: vi.fn(),
  stashDrop: vi.fn(),
  listStashes: vi.fn(),
  validateWorktreeDirectory: vi.fn(async () => ({ valid: true, insideWorktreeRoot: true })),
  resolveWorktreeTopLevel: vi.fn(async (directory) => ({ root: directory, prefix: '' })),
}));

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
    updateSessionMetadata: async (id, decide) => {
      const current = entries.get(id) ?? {};
      // A decide returns a merge patch, or null to leave the record alone —
      // the same contract the real store gives its decides.
      const patch = decide(current);
      if (!patch) return { metadata: current, changed: false };
      const merged = merge(current, patch);
      if (Object.keys(merged).length === 0) entries.delete(id);
      else entries.set(id, merged);
      return { metadata: merged, changed: true };
    },
  };
};

/**
 * The archive file holds state OpenCode cannot take (deleted directories). The
 * tests use an in-memory store with the same contract as `archive-store.js`.
 */
const createMemoryArchiveStore = () => {
  const entries = new Map();
  let failFor = new Set();
  return {
    failIds: (ids) => { failFor = new Set(ids); },
    entries,
    getAll: async () => Object.fromEntries(entries),
    list: async () => Object.fromEntries(entries),
    entry: async (id) => entries.get(id),
    forget: async (ids) => {
      for (const id of ids) entries.delete(id);
      return { failedIds: [] };
    },
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
        entries.set(id, null);
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
    worktreeBootstrapStore,
    hydrateWorktreeCheckout: hydrateWorktreeCheckoutMock,
    ...overrides,
  });
  return { app, calls, archiveStore, sessionMetadataStore, broadcastGlobalUiEvent };
};

describe('openchamber session routes', () => {
  beforeAll(async () => {
    ({ registerOpenChamberSessionRoutes, createOpenChamberSessionService } = await import('./routes.js'));
    ({ createSessionMetadataStore, createOpenCodeSessionMetadata } = await import('./session-metadata-store.js'));
  });

  beforeEach(() => {
    resolvePrimaryWorktreeRootMock.mockReset();
    resolvePrimaryWorktreeRootMock.mockImplementation(defaultPrimaryWorktreeRoot);
    createWorktreeMock.mockClear();
    hydrateWorktreeCheckoutMock.mockClear();
    getWorktreeBootstrapStatusMock.mockClear();
    getWorktreeBootstrapStatusMock.mockImplementation(async () => ({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
      updatedAt: Date.now(),
    }));
    sessionCreateMock.mockClear();
    sessionUpdateMock.mockReset();
    sessionUpdateMock.mockImplementation(async () => undefined);
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
    const tagged = (tag) => Object.assign(new Error(tag), { _tag: tag });

    it('archives every id on OpenCode and leaves the announcement to OpenCode', async () => {
      const { app, archiveStore, broadcastGlobalUiEvent } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', 'ses_b'], archivedAt: 1700 })
        .expect(200);

      expect(response.body).toEqual({
        archived: [{ id: 'ses_a', archivedAt: 1700 }, { id: 'ses_b', archivedAt: 1700 }],
        failedIds: [],
      });
      expect(sessionUpdateMock).toHaveBeenCalledWith({ sessionID: 'ses_a', archived: true });
      expect(sessionUpdateMock).toHaveBeenCalledWith({ sessionID: 'ses_b', archived: true });
      await expect(archiveStore.getAll()).resolves.toEqual({});
      expect(broadcastGlobalUiEvent).not.toHaveBeenCalled();
    });

    it('keeps a session whose directory is gone in the archive file, and reports one OpenCode refused', async () => {
      sessionUpdateMock.mockImplementation(async ({ sessionID }) => {
        if (sessionID === 'ses_gone') throw tagged('LocationNotFoundError');
        if (sessionID === 'ses_missing') throw tagged('SessionNotFoundError');
      });
      const { app, archiveStore, broadcastGlobalUiEvent } = createApp();

      const response = await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', 'ses_gone', 'ses_missing'], archivedAt: 1700 })
        .expect(200);

      expect(response.body.archived.map((session) => session.id)).toEqual(['ses_a', 'ses_gone']);
      expect(response.body.failedIds).toEqual(['ses_missing']);
      await expect(archiveStore.getAll()).resolves.toEqual({ ses_gone: 1700 });
      expect(broadcastGlobalUiEvent.mock.calls.map(([event]) => event)).toEqual([
        { type: 'openchamber:session-archived', properties: { sessionID: 'ses_gone', archivedAt: 1700 } },
      ]);
    });

    it('does not announce a session the file failed to store', async () => {
      sessionUpdateMock.mockRejectedValue(tagged('LocationNotFoundError'));
      const archiveStore = createMemoryArchiveStore();
      archiveStore.failIds(['ses_b']);
      const { app, broadcastGlobalUiEvent } = createApp({ archiveStore });

      const response = await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', 'ses_b'] })
        .expect(200);

      expect(response.body.failedIds).toEqual(['ses_b']);
      expect(broadcastGlobalUiEvent.mock.calls.map(([event]) => event.properties.sessionID)).toEqual(['ses_a']);
    });

    it('restores on OpenCode and drops the entry the file still had', async () => {
      const archiveStore = createMemoryArchiveStore();
      archiveStore.entries.set('ses_a', 1700);
      const { app } = createApp({ archiveStore });

      const response = await request(app)
        .post('/api/openchamber/sessions/unarchive')
        .send({ ids: ['ses_a'] })
        .expect(200);

      expect(response.body).toEqual({ restored: [{ id: 'ses_a', archivedAt: null }], failedIds: [] });
      expect(sessionUpdateMock).toHaveBeenCalledWith({ sessionID: 'ses_a', archived: false });
      await expect(archiveStore.getAll()).resolves.toEqual({});
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

    it('answers SESSION_DIRECTORY_MISSING when OpenCode refuses the write because the folder is gone', async () => {
      const locationNotFound = Object.assign(new Error('Location not found: /repo/wt-gone'), {
        _tag: 'LocationNotFoundError',
        location: { directory: '/repo/wt-gone' },
      });
      const persistSessionMetadata = vi.fn(async () => { throw locationNotFound; });
      const { app } = createApp({ persistSessionMetadata });

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { work: { state: 'done' } } } })
        .expect(409);

      expect(response.body).toEqual({ error: 'Location not found: /repo/wt-gone', code: 'SESSION_DIRECTORY_MISSING' });
    });

    it('keeps any other failed write a plain error without the folder code', async () => {
      const persistSessionMetadata = vi.fn(async () => { throw new Error('OpenCode is down'); });
      const { app } = createApp({ persistSessionMetadata });

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { work: { state: 'done' } } } })
        .expect(500);

      expect(response.body).toEqual({ error: 'OpenCode is down' });
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

  describe('session links the UI owns', () => {
    const agentEntry = {
      id: 'acme/app#7', number: 7, title: 'Add search', url: 'https://github.com/acme/app/pull/7', kind: 'pull', linkedAt: 5,
    };
    const uiEntry = {
      id: 'linear:ENG-12', identifier: 'ENG-12', title: 'Spec', url: 'https://linear.app/acme/issue/eng-12', kind: 'linear', linkedAt: 9,
    };

    it('appends to the links already on the record and announces the merged metadata', async () => {
      const { app, sessionMetadataStore, broadcastGlobalUiEvent } = createApp();
      // As if an agent's `session.link` had already written this session.
      sessionMetadataStore.entries.set('ses_a', { openchamber: { linked_issues: [agentEntry] } });

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/links')
        .send({ entries: [uiEntry], linked: true, directory: '/repo/app' })
        .expect(200);

      expect(response.body.metadata.openchamber.linked_issues).toEqual([agentEntry, uiEntry]);
      await expect(sessionMetadataStore.get('ses_a')).resolves.toEqual(response.body.metadata);
      expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
        type: 'openchamber:session-metadata',
        properties: { sessionID: 'ses_a', metadata: response.body.metadata },
      });
    });

    it('keeps a link an agent made after the UI last read the session', async () => {
      // The real store over OpenCode: the record the decide step reads is the
      // one OpenCode holds when the write turn comes — including an agent
      // link the UI has never seen. The client sends only the operation, so
      // no snapshot of it can replace that record's list.
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-routes-links-'));
      const { app } = createApp({
        sessionMetadataStore: createSessionMetadataStore({
          dataDir,
          openCode: createOpenCodeSessionMetadata({
            buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
            getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
          }),
        }),
      });
      sessionGetMock.mockImplementation(async ({ sessionID }) => ({
        id: sessionID,
        location: { directory: '/repo/app' },
        // Written by the agent's `session.link` between the UI's last read
        // and this request.
        metadata: { openchamber: { linked_issues: [agentEntry] } },
      }));

      try {
        const response = await request(app)
          .post('/api/openchamber/sessions/ses_v1/links')
          .send({ entries: [uiEntry], linked: true, directory: '/repo/app' })
          .expect(200);

        expect(response.body.metadata.openchamber.linked_issues).toEqual([agentEntry, uiEntry]);
        expect(sessionUpdateMock).toHaveBeenCalledWith({
          sessionID: 'ses_v1',
          metadata: response.body.metadata,
        });
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it('refreshes a re-linked entry and keeps the rest of the list', async () => {
      const { app, sessionMetadataStore } = createApp();
      sessionMetadataStore.entries.set('ses_a', { openchamber: { linked_issues: [agentEntry, uiEntry] } });

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/links')
        .send({ entries: [{ ...agentEntry, title: 'Add search (renamed)' }], linked: true })
        .expect(200);

      expect(response.body.metadata.openchamber.linked_issues).toEqual([
        uiEntry,
        { ...agentEntry, title: 'Add search (renamed)' },
      ]);
    });

    it('unlinks by id and by the legacy number-and-address identity', async () => {
      const legacy = {
        id: 'team/repo#12', number: 12, title: 'Old', url: ' https://gitlab.com/team/repo/-/issues/12/ ', kind: 'issue', linkedAt: 1,
      };
      const { app, sessionMetadataStore } = createApp();
      sessionMetadataStore.entries.set('ses_a', { openchamber: { linked_issues: [agentEntry, uiEntry, legacy] } });

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/links')
        .send({
          entries: [
            { id: 'acme/app#7', title: 'Add search', url: 'https://github.com/acme/app/pull/7', kind: 'pull' },
            { id: 'owner/repo#12', number: 12, title: 'Old', url: 'https://gitlab.com/team/repo/-/issues/12', kind: 'issue' },
          ],
          linked: false,
        })
        .expect(200);

      expect(response.body.metadata.openchamber.linked_issues).toEqual([uiEntry]);
    });

    it('applies a batch in one write', async () => {
      const { app, broadcastGlobalUiEvent } = createApp();
      const second = { id: 'acme/app#8', number: 8, title: 'Second', url: 'https://github.com/acme/app/issues/8', kind: 'issue', linkedAt: 9 };

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/links')
        .send({ entries: [uiEntry, second], linked: true })
        .expect(200);

      expect(response.body.metadata.openchamber.linked_issues).toEqual([uiEntry, second]);
      expect(broadcastGlobalUiEvent).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid entry with 400 and writes nothing', async () => {
      const { app, sessionMetadataStore, broadcastGlobalUiEvent } = createApp();
      sessionMetadataStore.entries.set('ses_a', { openchamber: { linked_issues: [agentEntry] } });

      await request(app)
        .post('/api/openchamber/sessions/ses_a/links')
        .send({ entries: [{ id: 'x', title: 'No kind', url: 'https://x.dev/1' }], linked: true })
        .expect(400);
      await request(app)
        .post('/api/openchamber/sessions/ses_a/links')
        .send({ entries: [uiEntry] })
        .expect(400);
      await request(app)
        .post('/api/openchamber/sessions/ses_a/links')
        .send({ entries: 'nope', linked: true })
        .expect(400);

      await expect(sessionMetadataStore.get('ses_a'))
        .resolves.toEqual({ openchamber: { linked_issues: [agentEntry] } });
      expect(broadcastGlobalUiEvent).not.toHaveBeenCalled();
    });

    it('writes nothing when the operation changes no entry', async () => {
      const { app, broadcastGlobalUiEvent } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_a/links')
        .send({ entries: [{ id: 'acme/app#99', number: 99, title: 'T', url: 'https://github.com/acme/app/issues/99', kind: 'issue' }], linked: false })
        .expect(200, { metadata: {} });

      expect(broadcastGlobalUiEvent).not.toHaveBeenCalled();
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

  it('records on the prompt the session whose agent sent it, with its title', async () => {
    const { app } = createApp();
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({ id: sessionID, title: 'PR triage', location: { directory: '/repo/app' } }));
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5', promptedBySessionId: 'ses_origin' })
      .expect(200);

    expect(sessionPromptMock).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      text: 'Run this',
      metadata: { openchamber: { promptedBy: { sessionID: 'ses_origin', title: 'PR triage' } } },
    });
  });

  it('records the sender by id alone when its session cannot be read', async () => {
    const { app } = createApp();
    sessionGetMock.mockImplementation(async ({ sessionID }) => {
      if (sessionID === 'ses_origin') throw new Error('not found');
      return { id: sessionID, location: { directory: '/repo/app' } };
    });
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5', promptedBySessionId: 'ses_origin' })
      .expect(200);

    expect(sessionPromptMock).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      text: 'Run this',
      metadata: { openchamber: { promptedBy: { sessionID: 'ses_origin' } } },
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

  it('skips a model hidden in the picker when nothing names a model (#1801)', async () => {
    useCatalog({
      models: [{ id: 'big-pickle', modelID: 'big-pickle', providerID: 'opencode', variants: [] }, ...CATALOG_MODELS],
    });
    const hiddenModels = [{ providerID: 'opencode', modelID: 'big-pickle' }];
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({ hiddenModels, projects: [{ id: 'proj_1', path: '/repo/app' }] }),
    });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(200);
    expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });

    // A default the user chose stays, hidden or not.
    const { app: configured } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'opencode/big-pickle',
        hiddenModels,
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    const configuredResponse = await request(configured)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(200);
    expect(configuredResponse.body.model).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
  });

  it('starts on the model last picked in a chat when nothing names one (#1801)', async () => {
    useCatalog({
      models: [{ id: 'big-pickle', modelID: 'big-pickle', providerID: 'opencode', variants: [] }, ...CATALOG_MODELS],
    });
    const project = { projects: [{ id: 'proj_1', path: '/repo/app' }] };
    const create = async (settings, routing = {}) => {
      const { app } = createApp({ readSettingsFromDiskMigrated: async () => ({ ...project, ...settings }), ...routing });
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this' })
        .expect(200);
      return response.body.model;
    };

    expect(await create({ lastSelectedModel: 'anthropic/claude-sonnet-5' }))
      .toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5' });
    // Kept through a catalog gap, like a saved default.
    expect(await create({ lastSelectedModel: 'claude-code/opus' }))
      .toEqual({ providerID: 'claude-code', modelID: 'opus' });
    // A configured default outranks it.
    expect(await create({ lastSelectedModel: 'anthropic/claude-sonnet-5', defaultModel: 'openai/gpt-5.5' }))
      .toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    // Hidden since it was picked: skipped.
    expect(await create({
      lastSelectedModel: 'anthropic/claude-sonnet-5',
      hiddenModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet-5' }],
    })).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
    // Auto on a server without routing, or with routing that cannot run it
    // now: skipped instead of refusing the request.
    expect(await create({ lastSelectedModel: 'openchamber/auto' }))
      .toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
    const resolveAutoSelection = vi.fn(async () => ({ model: { providerID: 'openai', id: 'gpt-5.5' }, agent: 'build', decision: {} }));
    expect(await create({ lastSelectedModel: 'openchamber/auto' }, { resolveAutoSelection, isAutoReady: async () => false }))
      .toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
    expect(resolveAutoSelection).not.toHaveBeenCalled();
    expect(await create({ lastSelectedModel: 'openchamber/auto' }, { resolveAutoSelection, isAutoReady: async () => true }))
      .toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
  });

  it('runs a named agent on the model it is bound to when the prompt omits one', async () => {
    useCatalog({
      agents: [
        { id: 'build', name: 'Build', mode: 'primary' },
        { id: 'plan', name: 'Plan', mode: 'primary', model: { providerID: 'anthropic', id: 'claude-sonnet-5', variant: 'high' } },
      ],
    });
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openai/gpt-5.5',
        defaultAgent: 'build',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', agent: 'plan' })
      .expect(200);

    // The binding outranks the settings default, and its effort comes with it.
    expect(response.body.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5' });
    expect(response.body.variant).toBe('high');
    expect(sessionSwitchModelMock).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      model: { id: 'claude-sonnet-5', providerID: 'anthropic', variant: 'high' },
    });
    expect(sessionSwitchAgentMock).toHaveBeenCalledWith({ sessionID: 'ses_123', agent: 'plan' });
  });

  it('falls back to the defaults chain when the named agent binds no model', async () => {
    useCatalog({
      agents: [
        { id: 'build', name: 'Build', mode: 'primary' },
        { id: 'plan', name: 'Plan', mode: 'primary' },
      ],
    });
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openai/gpt-5.5',
        defaultAgent: 'build',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', agent: 'plan' })
      .expect(200);

    expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(response.body.agent).toBe('plan');
  });

  it('keeps an explicitly requested model over the named agent binding', async () => {
    useCatalog({
      agents: [
        { id: 'build', name: 'Build', mode: 'primary' },
        { id: 'plan', name: 'Plan', mode: 'primary', model: { providerID: 'anthropic', id: 'claude-sonnet-5' } },
      ],
    });
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5', agent: 'plan' })
      .expect(200);

    expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(response.body.agent).toBe('plan');
  });

  it('keeps the session\'s previous model when send names an agent that binds one', async () => {
    useCatalog({
      agents: [
        { id: 'build', name: 'Build', mode: 'primary' },
        { id: 'plan', name: 'Plan', mode: 'primary', model: { providerID: 'anthropic', id: 'claude-sonnet-5', variant: 'high' } },
      ],
    });
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      agent: 'build',
      model: { providerID: 'openai', id: 'gpt-5.5' },
      location: { directory: '/repo/app' },
    }));
    setSessionMessages([{ id: 'msg_before', type: 'assistant', time: { created: 10, completed: 20 } }]);

    // Send/fork keep the session's own selection; the binding only fills a
    // dispatch that has no model to reuse.
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: 'Continue where you left off', agent: 'plan' })
      .expect(200);

    expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(response.body.agent).toBe('plan');
    // The binding did not take over: no switch to its model, no inherited effort.
    expect(response.body.variant).toBeUndefined();
    expect(sessionSwitchModelMock).toHaveBeenCalledWith({
      sessionID: 'ses_source',
      model: { id: 'gpt-5.5', providerID: 'openai' },
    });
  });

  it('runs a sent-to session on the named agent binding when it has no model of its own', async () => {
    useCatalog({
      agents: [
        { id: 'build', name: 'Build', mode: 'primary' },
        { id: 'plan', name: 'Plan', mode: 'primary', model: { providerID: 'anthropic', id: 'claude-sonnet-5', variant: 'high' } },
      ],
    });
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: '/repo/app' },
    }));
    setSessionMessages([{ id: 'msg_before', type: 'assistant', time: { created: 10, completed: 20 } }]);

    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: 'Continue where you left off', agent: 'plan' })
      .expect(200);

    expect(response.body.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5' });
    expect(response.body.variant).toBe('high');
    expect(sessionSwitchModelMock).toHaveBeenCalledWith({
      sessionID: 'ses_source',
      model: { id: 'claude-sonnet-5', providerID: 'anthropic', variant: 'high' },
    });
  });

  it('falls back to the catalogue id when the picked model overrides its upstream name', async () => {
    useCatalog({
      models: [
        { id: 'derived-fast', modelID: 'vendor/base', providerID: 'custom-provider', variants: [] },
      ],
    });
    const { app } = createApp();

    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(200);

    expect(sessionSwitchModelMock).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      model: { id: 'derived-fast', providerID: 'custom-provider' },
    });
  });

  it('resolves a reference to the exact catalogue id before a derived entry sharing its upstream name', async () => {
    useCatalog({
      models: [
        { id: 'derived-fast', modelID: 'base', providerID: 'vendor', variants: [{ id: 'high' }] },
        { id: 'base', modelID: 'base', providerID: 'vendor', variants: [] },
      ],
    });
    const { app } = createApp();

    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'vendor/base', variant: 'high' })
      .expect(400);

    // The level belongs to the derived entry, so the base model refuses it.
    expect(JSON.stringify(response.body)).toContain("Unknown variant 'high' for model 'vendor/base'");
  });

  it('accepts a provider/id reference whose catalogue id differs from its upstream modelID', async () => {
    // OpenCode model references are `provider/id` (Model.Ref.parse). A custom
    // provider may override the upstream name, so `modelID` differs from `id`;
    // lookups must use the id, not the wire name.
    useCatalog({
      models: [
        {
          id: 'deepseek-flash',
          modelID: 'deepseek/deepseek-flash',
          providerID: 'deepseek-litellm',
          variants: [{ id: 'high' }],
        },
      ],
    });
    const { app } = createApp();

    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'deepseek-litellm/deepseek-flash' })
      .expect(200);

    expect(response.body.model).toEqual({ providerID: 'deepseek-litellm', modelID: 'deepseek-flash' });
    expect(sessionSwitchModelMock).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      model: { id: 'deepseek-flash', providerID: 'deepseek-litellm' },
    });
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

  it('rejects a successful HTML response instead of reporting the prompt as dispatched', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/prompt')) {
        return new Response('<!doctype html><title>OpenChamber</title>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      throw new Error('Unexpected transport request');
    });
    sessionPromptMock.mockImplementationOnce(async () => {
      const options = clientOptions.at(-1);
      await options.fetch(`${options.baseUrl}/api/session/ses_123/prompt`, { method: 'POST', body: '{"text":"Run this"}' });
    });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
        .expect(500);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    createWorktreeMock.mockImplementationOnce(async (_directory, _input, options) => {
      await options.hydrateCheckout({ directory: '/repo/worktrees/side-task', parentRemoteName: '' });
      return {
        head: 'abc123',
        name: 'side-task',
        branch: 'openchamber/side-task',
        path: '/repo/worktrees/side-task',
      };
    });
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
    }, {
      bootstrapStore: worktreeBootstrapStore,
      hydrateCheckout: expect.any(Function),
    });
    expect(hydrateWorktreeCheckoutMock).toHaveBeenCalledWith({
      directory: '/repo/worktrees/side-task',
      parentDirectory: '/repo/app',
      parentRemoteName: '',
    });
    expect(getWorktreeBootstrapStatusMock).toHaveBeenCalledWith(
      '/repo/worktrees/side-task',
      { bootstrapStore: worktreeBootstrapStore },
    );
    expect(response.body.directory).toBe('/repo/worktrees/side-task');
    expect(response.body.worktree.path).toBe('/repo/worktrees/side-task');
    expect(sessionCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      location: { directory: '/repo/worktrees/side-task' },
    }));
    expect(sessionPromptMock).toHaveBeenCalledWith({ sessionID: 'ses_123', text: 'Run this' });
  });

  it('starts the session in the project folder inside a new worktree and reports a folder the checkout lacks', async () => {
    createWorktreeMock.mockResolvedValue({
      head: 'abc123', name: 'side-task', branch: 'side-task', path: '/repo/worktrees/side-task',
    });
    const resolveWorktreeTopLevel = vi.fn(async (directory) => ({ root: '/repo', prefix: 'app' }));
    const validateWorktreeDirectory = vi.fn(async () => ({ valid: true, insideWorktreeRoot: true }));
    const { app } = createApp({ resolveWorktreeTopLevel, validateWorktreeDirectory });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', worktree: { name: 'side-task' } })
      .expect(200);

    const startDirectory = path.join('/repo/worktrees/side-task', 'app');
    expect(resolveWorktreeTopLevel).toHaveBeenCalledWith('/repo/app');
    expect(validateWorktreeDirectory).toHaveBeenCalledWith(startDirectory, '/repo/worktrees/side-task');
    expect(response.body.directory).toBe(startDirectory);
    expect(response.body.worktree.path).toBe('/repo/worktrees/side-task');
    expect(response.body).not.toHaveProperty('startDirectoryFallback');
    expect(sessionCreateMock).toHaveBeenCalledWith(expect.objectContaining({ location: { directory: startDirectory } }));

    validateWorktreeDirectory.mockResolvedValue({ valid: false, insideWorktreeRoot: false });
    const missing = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', worktree: { name: 'side-task' } })
      .expect(200);
    expect(missing.body.directory).toBe('/repo/worktrees/side-task');
    expect(missing.body.startDirectoryFallback).toBe('missing');
  });

  it('validates the requested agent in the project folder itself, not in a folder below it', async () => {
    const validateWorktreeDirectory = vi.fn(async () => ({ valid: true, insideWorktreeRoot: true }));
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'proj_ai', path: '/repo/ai' }] }),
      resolveWorktreeTopLevel: vi.fn(async () => ({ root: '/repo', prefix: 'ai' })),
      validateWorktreeDirectory,
    });
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ projectId: 'proj_ai', worktree: { name: 'side-task' }, prompt: 'Run this', model: 'openai/gpt-5.5' })
      .expect(200);

    const scopes = clientOptions.map((options) => JSON.stringify(options));
    expect(scopes.some((scope) => scope.includes('%2Frepo%2Fai"'))).toBe(true);
    expect(scopes.some((scope) => scope.includes('%2Fai%2Fai'))).toBe(false);
  });

  it('moves a session to the folder of the project that holds it, also from a subfolder, when projects share a repository', async () => {
    const resolveWorktreeTopLevel = vi.fn(async (directory) => ({ root: '/repo', prefix: directory.replace('/repo/', '') }));
    const service = createOpenChamberSessionService({
      readSettingsFromDiskMigrated: async () => ({ projects: [
        { id: 'proj_web', path: '/repo/web' },
        { id: 'proj_ai', path: '/repo/ai' },
      ] }),
      sanitizeProjects: (projects) => projects,
      validateDirectoryPath: async (directory) => ({ ok: true, directory }),
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: vi.fn(async () => undefined),
      worktreeBootstrapStore,
      hydrateWorktreeCheckout: hydrateWorktreeCheckoutMock,
      archiveStore: createMemoryArchiveStore(),
      sessionMetadataStore: createMemorySessionMetadataStore(),
      getBranches: vi.fn(async () => ({ all: [], defaultBranches: {} })),
      resolveWorktreeTopLevel,
      validateWorktreeDirectory: vi.fn(async () => ({ valid: true, insideWorktreeRoot: true })),
    });

    const result = await service.moveToWorktree('ses_1', { directory: '/repo/ai/src', worktree: { name: 'side-task', startRef: 'main' } });

    expect(resolveWorktreeTopLevel).toHaveBeenCalledWith('/repo/ai');
    expect(result.directory).toBe(path.join('/repo/worktrees/side-task', 'ai'));
    expect(result.worktree.path).toBe('/repo/worktrees/side-task');
    expect(sessionMoveMock).toHaveBeenCalledWith({ sessionID: 'ses_1', directory: path.join('/repo/worktrees/side-task', 'ai') });
  });

  it('moves a session from a folder of another worktree to the folder of its project, as the UI does', async () => {
    // `/repo/worktrees/wt-a/ai/src` is in no registered project path; its folder
    // `ai/src` in the primary checkout `/repo` belongs to `/repo/ai`, not `/repo`.
    resolvePrimaryWorktreeRootMock.mockImplementation(async (directory) => ({
      root: directory.startsWith('/repo/worktrees/') ? '/repo' : directory,
    }));
    const resolveWorktreeTopLevel = vi.fn(async (directory) => (
      directory === '/repo/worktrees/wt-a/ai/src'
        ? { root: '/repo/worktrees/wt-a', prefix: 'ai/src' }
        : { root: '/repo', prefix: directory.replace(/^\/repo\/?/, '') }
    ));
    const service = createOpenChamberSessionService({
      readSettingsFromDiskMigrated: async () => ({ projects: [
        { id: 'proj_repo', path: '/repo' },
        { id: 'proj_ai', path: '/repo/ai' },
      ] }),
      sanitizeProjects: (projects) => projects,
      validateDirectoryPath: async (directory) => ({ ok: true, directory }),
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: vi.fn(async () => undefined),
      worktreeBootstrapStore,
      hydrateWorktreeCheckout: hydrateWorktreeCheckoutMock,
      archiveStore: createMemoryArchiveStore(),
      sessionMetadataStore: createMemorySessionMetadataStore(),
      getBranches: vi.fn(async () => ({ all: [], defaultBranches: {} })),
      resolveWorktreeTopLevel,
      validateWorktreeDirectory: vi.fn(async () => ({ valid: true, insideWorktreeRoot: true })),
    });

    const result = await service.moveToWorktree('ses_1', { directory: '/repo/worktrees/wt-a/ai/src', worktree: { name: 'side-task', startRef: 'main' } });

    expect(resolveWorktreeTopLevel).toHaveBeenCalledWith('/repo/ai');
    expect(result.directory).toBe(path.join('/repo/worktrees/side-task', 'ai'));
    expect(sessionMoveMock).toHaveBeenCalledWith({ sessionID: 'ses_1', directory: path.join('/repo/worktrees/side-task', 'ai') });
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

  it('starts the session in a worktree made from a pull request', async () => {
    const createChangeRequestWorktree = vi.fn(async () => ({
      name: 'feature-fix', branch: 'feature/fix', path: '/repo/worktrees/feature-fix',
      provenance: { kind: 'contributor-fork' },
    }));
    const { app } = createApp({ createChangeRequestWorktree });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', pullRequest: 42, worktree: { name: 'review-42' }, prompt: 'Review it', model: 'openai/gpt-5.5' })
      .expect(200);

    expect(createChangeRequestWorktree).toHaveBeenCalledExactlyOnceWith({ directory: '/repo/app', number: 42, name: 'review-42' });
    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(getWorktreeBootstrapStatusMock.mock.invocationCallOrder[0])
      .toBeLessThan(sessionCreateMock.mock.invocationCallOrder[0]);
    expect(sessionCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      location: { directory: '/repo/worktrees/feature-fix' },
    }));
    expect(response.body.directory).toBe('/repo/worktrees/feature-fix');
    expect(response.body.worktree.branch).toBe('feature/fix');
  });

  it('refuses a pull request it cannot make a worktree for and creates no session', async () => {
    const notFound = Object.assign(new Error('Pull request #42 was not found in acme/app'), { status: 404 });
    const { app } = createApp({ createChangeRequestWorktree: vi.fn(async () => { throw notFound; }) });

    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', pullRequest: 42, prompt: 'Review it' })
      .expect(404, { error: 'Pull request #42 was not found in acme/app' });

    expect(sessionCreateMock).not.toHaveBeenCalled();
    expect(getWorktreeBootstrapStatusMock).not.toHaveBeenCalled();
  });

  it('refuses a pull request where contributor worktrees are not served, with no plain worktree instead', async () => {
    const { app } = createApp();

    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', pullRequest: 42 })
      .expect(501, { error: 'Worktrees from pull requests are not available here' });

    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(sessionCreateMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed pull request number or a start ref beside it', async () => {
    const createChangeRequestWorktree = vi.fn();
    const { app } = createApp({ createChangeRequestWorktree });

    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', pullRequest: '#42' })
      .expect(400, { error: 'pullRequest must be a pull or merge request number, such as 42' });
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', pullRequest: 42, worktree: { startRef: 'main' } })
      .expect(400, { error: 'pullRequest checks out the pull request\'s own branch; do not combine it with startRef or setUpstream' });

    expect(createChangeRequestWorktree).not.toHaveBeenCalled();
    expect(sessionCreateMock).not.toHaveBeenCalled();
  });

  it('does not treat a missing bootstrap record as ready', async () => {
    getWorktreeBootstrapStatusMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'failed',
        phase: 'directory-created',
        error: 'Bootstrap state is missing',
        updatedAt: Date.now(),
      });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'ses_123' }) }));
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', worktree: { name: 'side-task' } })
        .expect(500, { error: 'Worktree bootstrap failed: Bootstrap state is missing' });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it('writes standing project context into the session ahead of a dispatched slash command', async () => {
    commandListMock.mockResolvedValue({ data: [{ name: 'review', description: 'Review' }] });
    const sync = vi.fn(async () => true);

    const { app } = createApp({ sessionKnowledgeRuntime: { sync } });
    await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: '/review', model: 'openai/gpt-5.5', agent: 'build' })
      .expect(200);

    expect(sync).toHaveBeenCalledWith('ses_source', '/repo/app');
    expect(sync.mock.invocationCallOrder[0])
      .toBeLessThan(sessionCommandMock.mock.invocationCallOrder[0]);
    expect(sessionSyntheticMock).not.toHaveBeenCalled();
  });

  it.each([
    ['send', 'ses_source'],
    ['fork', 'ses_fork'],
  ])('syncs knowledge in the target session directory for %s', async (action, targetId) => {
    const sync = vi.fn(async () => true);
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({
      id: sessionID, location: { directory: '/repo/worktrees/target' },
    }));
    const { app } = createApp({ sessionKnowledgeRuntime: { sync } });
    await request(app)
      .post(`/api/openchamber/sessions/ses_source/${action}`)
      .send({ directory: '/repo/app', prompt: 'Continue', model: 'openai/gpt-5.5', agent: 'build' })
      .expect(200);
    expect(sync).toHaveBeenCalledExactlyOnceWith(targetId, '/repo/worktrees/target');
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(sessionPromptMock.mock.invocationCallOrder[0]);
  });

  it.each(['missing', 'failed'])('preserves knowledge and sends when the target directory read is %s', async (mode) => {
    const sync = vi.fn(async () => true);
    sessionGetMock.mockImplementation(async () => {
      if (mode === 'failed') throw new Error('session read failed');
      return { id: 'ses_source' };
    });
    const { app } = createApp({ sessionKnowledgeRuntime: { sync } });
    await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: 'Continue', model: 'openai/gpt-5.5', agent: 'build' })
      .expect(200);
    expect(sync).not.toHaveBeenCalled();
    expect(sessionPromptMock).toHaveBeenCalledWith({ sessionID: 'ses_source', text: 'Continue' });
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

  it('applies the config default model variant when the prompt omits a model', async () => {
    useCatalog({
      config: [{
        type: 'document',
        info: { model: { providerID: 'openai', model: 'gpt-5.5', variant: 'high' } },
      }],
    });
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(200);

    expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(sessionSwitchModelMock).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      model: { id: 'gpt-5.5', providerID: 'openai', variant: 'high' },
    });
  });

  it('applies the config default model variant from the string spelling', async () => {
    useCatalog({
      config: [{
        type: 'document',
        info: { model: 'openai/gpt-5.5#high' },
      }],
    });
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(200);

    expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(sessionSwitchModelMock).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      model: { id: 'gpt-5.5', providerID: 'openai', variant: 'high' },
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

describe('openchamber session service directory resolution', () => {
  const createService = async (overrides = {}) => {
    const { createOpenChamberSessionService } = await import('./routes.js');
    return createOpenChamberSessionService({
      archiveStore: createMemoryArchiveStore(),
      sessionMetadataStore: createMemorySessionMetadataStore(),
      readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'proj_1', path: '/repo/app' }] }),
      sanitizeProjects: (projects) => projects,
      validateDirectoryPath: async (directory) => ({ ok: true, directory }),
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      ...overrides,
    });
  };

  it('resolves a registered project to its directory', async () => {
    const service = await createService();
    await expect(service.resolveDirectory({ projectId: 'proj_1' })).resolves.toBe('/repo/app');
  });

  it('fails for an unknown project, a missing project folder, or unreadable settings', async () => {
    await expect((await createService()).resolveDirectory({ projectId: 'missing' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
    const goneFolder = await createService({ validateDirectoryPath: async () => ({ ok: false, error: 'Directory not found' }) });
    await expect(goneFolder.resolveDirectory({ projectId: 'proj_1' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'Directory not found' });
    const unreadable = await createService({ readSettingsFromDiskMigrated: async () => { throw new Error('settings unreadable'); } });
    await expect(unreadable.resolveDirectory({ projectId: 'proj_1' })).rejects.toThrow('settings unreadable');
  });

  it('rejects a slash command SDK failure without falling back to a prompt', async () => {
    sessionCommandMock.mockClear();
    sessionPromptMock.mockClear();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => selectionInputResponse(url));
    commandListMock.mockResolvedValue({ data: [{ name: 'review' }] });
    sessionCommandMock.mockRejectedValueOnce(new Error('command rejected'));
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
        })
        .expect(500);

      expect(sessionCommandMock).toHaveBeenCalledTimes(1);
      expect(sessionPromptMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
