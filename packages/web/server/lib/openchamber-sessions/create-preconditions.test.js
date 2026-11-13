import { describe, expect, it, vi } from 'vitest';
import { createOpenChamberSessionService } from './routes.js';
import { getWorktreeBootstrapStatus } from '../git/service.js';

const directory = '/fixture/worktree';
const bound = { providerID: 'example', id: 'build-model', variant: 'high' };
const recent = { providerID: 'example', id: 'recent-model' };
const agents = [
  { id: 'build', name: 'Build', mode: 'primary', model: bound },
  { id: 'plan', name: 'Plan', mode: 'primary' },
];

const fixture = (overrides = {}) => {
  const records = new Map();
  const delivered = [];
  const sdk = {
    agent: { list: vi.fn(async () => ({ data: agents })) },
    config: { get: vi.fn(async () => [{ info: { default_agent: 'plan' } }]) },
    model: { list: vi.fn(async () => ({ data: [
      { ...bound, modelID: bound.id, variants: [{ id: 'high' }] },
      { ...recent, modelID: recent.id, variants: [] },
    ] })) },
    message: { list: vi.fn(async () => ({ data: [] })) },
    session: {
      create: vi.fn(async ({ location }) => {
        const session = { id: `ses_${records.size}`, location, agent: 'plan', model: recent };
        records.set(session.id, session);
        return session;
      }),
      get: vi.fn(async ({ sessionID }) => records.get(sessionID)),
      switchAgent: vi.fn(async ({ sessionID, agent }) => { records.get(sessionID).agent = agent; }),
      switchModel: vi.fn(async ({ sessionID, model }) => { records.get(sessionID).model = model; }),
      prompt: vi.fn(async ({ sessionID }) => {
        delivered.push(structuredClone(records.get(sessionID)));
        return { id: 'msg_queued' };
      }),
    },
  };
  const createWorktree = vi.fn(async () => ({ path: directory, name: 'task', branch: 'task' }));
  const createClient = vi.fn(() => sdk);
  const service = createOpenChamberSessionService({
    archiveStore: {}, sessionMetadataStore: {},
    readSettingsFromDiskMigrated: async () => ({
      projects: [{ id: 'test', path: '/fixture/project' }, { id: 'checkout', path: directory }],
      defaultAgent: 'build', lastSelectedModel: 'example/recent-model',
    }),
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `http://unused.invalid${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    createOpenCodeClient: createClient,
    createWorktree,
    getWorktreeBootstrapStatus: async () => ({ status: 'ready', phase: 'setup-ready' }),
    worktreeBootstrapStore: { read: async () => null, write: async () => {} },
    hydrateWorktreeCheckout: async () => {},
    resolveWorktreeTopLevel: async () => ({ prefix: '' }),
    ...overrides,
  });
  return { service, sdk, records, delivered, createWorktree, createClient };
};

const request = { projectId: 'test', worktree: { name: 'task' }, prompt: 'Only the test double receives this' };

describe('session creation preconditions', () => {
  it('uses the configured model for an explicit agent even when the saved default agent is missing', async () => {
    const f = fixture({
      readSettingsFromDiskMigrated: async () => ({ defaultAgent: 'deleted-agent', defaultModel: 'example/recent-model' }),
    });
    await f.service.create({ directory, agent: 'plan', prompt: request.prompt });
    expect(f.delivered).toMatchObject([{ agent: 'plan', model: recent }]);
  });

  it('names a missing default agent and explains how to fix it before creating a session', async () => {
    const f = fixture({
      readSettingsFromDiskMigrated: async () => ({ defaultAgent: 'deleted-agent', defaultModel: 'example/recent-model' }),
    });
    await expect(f.service.create({ directory, prompt: request.prompt })).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringMatching(/deleted-agent.*(?:change|update).*default agent.*(?:explicit|agent)/i),
    });
    expect(f.records.size).toBe(0);
    expect(f.delivered).toEqual([]);
  });

  it.each(['empty agents', 'failed agents', 'failed config', 'missing default agent'])(
    'creates nothing after %s and lets the caller retry the checkout', async (failure) => {
      const f = fixture();
      if (failure === 'empty agents') f.sdk.agent.list.mockResolvedValueOnce({ data: [] });
      else if (failure === 'failed agents') f.sdk.agent.list.mockRejectedValueOnce(new Error('starting'));
      else if (failure === 'failed config') f.sdk.config.get.mockRejectedValueOnce(new Error('starting'));
      else f.sdk.agent.list.mockResolvedValueOnce({ data: [agents[1]] });

      await expect(f.service.create(request)).rejects.toMatchObject({
        statusCode: 503, partial: true, partialAction: 'worktree-created', directory,
      });
      expect(f.sdk.agent.list).toHaveBeenCalledTimes(1);
      expect(f.sdk.config.get).toHaveBeenCalledTimes(1);
      expect(f.records.size).toBe(0);
      expect(f.sdk.session.switchModel).not.toHaveBeenCalled();
      expect(f.delivered).toEqual([]);

      const result = await f.service.create({ directory, prompt: request.prompt });
      expect(result).toMatchObject({ agent: 'build', variant: 'high', promptDispatched: true });
      expect(f.delivered).toMatchObject([{ agent: 'build', model: bound }]);
      expect(f.createWorktree).toHaveBeenCalledTimes(1);
      expect(f.sdk.agent.list).toHaveBeenCalledTimes(2);
      expect(f.createClient.mock.calls.every(([options]) => options.directory === directory)).toBe(true);
    },
  );

  it('resolves the selection before creating the session on a ready directory', async () => {
    const f = fixture();
    await f.service.create({ directory, prompt: request.prompt });
    expect(f.sdk.agent.list.mock.invocationCallOrder[0]).toBeLessThan(f.sdk.session.create.mock.invocationCallOrder[0]);
    expect(f.delivered).toMatchObject([{ agent: 'build', model: bound }]);
  });

  it('joins unfinished setup when the caller retries an existing directory', async () => {
    const started = Promise.withResolvers();
    const setup = Promise.withResolvers();
    const f = fixture({ waitForActiveWorktreeBootstrap: () => {
      started.resolve();
      return setup.promise;
    } });
    const pending = f.service.create({ directory, prompt: request.prompt });
    await started.promise;
    expect(f.records.size).toBe(0);
    expect(f.sdk.agent.list).not.toHaveBeenCalled();
    setup.resolve();
    await pending;
    expect(f.delivered).toMatchObject([{ agent: 'build', model: bound }]);
    expect(f.createWorktree).not.toHaveBeenCalled();
  });

  it('checks the real bootstrap record at the checkout root for a subdirectory retry', async () => {
    const subdirectory = `${directory}/ai`;
    const states = new Map([[directory, { status: 'failed', phase: 'git-ready', error: 'Setup failed' }]]);
    const read = vi.fn(async (key) => states.get(key) ?? null);
    const f = fixture({
      resolveWorktreeTopLevel: async () => ({ root: directory, prefix: 'ai' }),
      getWorktreeBootstrapStatus,
      worktreeBootstrapStore: { read, write: async () => {} },
    });
    await expect(f.service.create({ directory: subdirectory, prompt: request.prompt })).rejects.toMatchObject({
      statusCode: 500, message: 'Worktree bootstrap failed: Setup failed',
    });
    expect(read).toHaveBeenCalledWith(directory);
    expect(f.records.size).toBe(0);
    expect(f.sdk.agent.list).not.toHaveBeenCalled();

    states.set(directory, { status: 'ready', phase: 'setup-ready' });
    await f.service.create({ directory: subdirectory, prompt: request.prompt });
    expect(f.delivered).toMatchObject([{ location: { directory: subdirectory }, agent: 'build', model: bound }]);
    expect(f.createWorktree).not.toHaveBeenCalled();
  });

  it('joins the root setup task while preserving the requested session subdirectory', async () => {
    const started = Promise.withResolvers();
    const setup = Promise.withResolvers();
    const f = fixture({
      resolveWorktreeTopLevel: async () => ({ root: directory, prefix: 'ai' }),
      waitForActiveWorktreeBootstrap: (key) => {
        started.resolve(key);
        return key === directory ? setup.promise : Promise.resolve();
      },
    });
    const pending = f.service.create({ directory: `${directory}/ai`, prompt: request.prompt });
    try {
      expect(await started.promise).toBe(directory);
      expect(f.records.size).toBe(0);
      expect(f.sdk.agent.list).not.toHaveBeenCalled();
    } finally {
      setup.resolve();
      await pending;
    }
    expect(f.delivered).toMatchObject([{ location: { directory: `${directory}/ai` } }]);
  });

  it('does not depend on discovery when both model and agent are explicit', async () => {
    const f = fixture();
    f.sdk.agent.list.mockRejectedValue(new Error('unavailable'));
    f.sdk.config.get.mockRejectedValue(new Error('unavailable'));
    f.sdk.model.list.mockRejectedValue(new Error('unavailable'));
    await f.service.create({ ...request, agent: 'build', model: 'example/build-model', variant: 'high' });
    expect(f.delivered).toMatchObject([{ agent: 'build', model: bound }]);
    // The existing explicit-choice validation still runs once in the source directory.
    expect(f.sdk.agent.list).toHaveBeenCalledTimes(1);
  });
});
