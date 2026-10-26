import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTemplateRuntime } from './template-runtime.js';

const originalFetch = globalThis.fetch;

const createRuntime = (settings = {}) => createNotificationTemplateRuntime({
  readSettingsFromDisk: async () => settings,
  persistSettings: vi.fn(async () => {}),
  buildOpenCodeUrl: (path) => path,
  getOpenCodeAuthHeaders: () => ({}),
  resolveGitBinaryForSpawn: () => 'git',
});

describe('notification template runtime zen models', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns no selectable zen models after provider retirement', async () => {
    const runtime = createRuntime();
    const models = await runtime.fetchFreeZenModels();

    expect(models).toEqual([]);
  });

  it('preserves stored zen model value for compatibility without validation', async () => {
    const runtime = createRuntime({ zenModel: 'trinity-large-preview-free' });

    await expect(runtime.resolveZenModel()).resolves.toBe('trinity-large-preview-free');
  });
});

describe('notification template message extraction', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('excludes reasoning parts from payload message text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { type: 'reasoning', text: 'private chain of thought' },
            { type: 'text', text: 'final answer' },
          ],
        },
      },
    })).toBe('final answer');
  });

  it('ignores untyped parts even when they contain text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { text: 'untyped text' },
            { content: 'untyped content' },
            { type: 'text', text: 'typed final answer' },
          ],
        },
      },
    })).toBe('typed final answer');
  });

  it('excludes reasoning parts when fetching assistant messages', async () => {
    const runtime = createRuntime();
    // v2 pages messages as `{ data, cursor }` and an assistant message is a
    // flat record carrying `content[]`.
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'msg-1',
          type: 'assistant',
          finish: 'stop',
          content: [
            { type: 'reasoning', text: 'private chain of thought' },
            { type: 'text', text: 'final answer' },
          ],
        },
      ],
      cursor: {},
    })));

    await expect(runtime.fetchLastAssistantMessageText('session-1', 'msg-1')).resolves.toBe('final answer');
  });
});

describe('notification template session info', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends OpenCode auth headers when fetching the session title', async () => {
    const seenHeaders = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      seenHeaders.push(init?.headers ?? {});
      return new Response(JSON.stringify({ id: 'ses_1', title: 'Nightly cleanup' }), { status: 200 });
    });
    const runtime = createNotificationTemplateRuntime({
      readSettingsFromDisk: async () => ({}),
      buildOpenCodeUrl: (path) => path,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic dGVzdDp0ZXN0' }),
      resolveGitBinaryForSpawn: () => 'git',
    });

    const variables = await runtime.buildTemplateVariables({ properties: { info: {} } }, 'ses_1');

    expect(seenHeaders[0]).toMatchObject({ Authorization: 'Basic dGVzdDp0ZXN0' });
    expect(variables.session_name).toBe('Nightly cleanup');
  });
});

describe('notification template project of the session', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const settings = {
    activeProjectId: 'open',
    projects: [
      { id: 'open', label: 'dotfiles', path: '/work/dotfiles' },
      { id: 'own', label: 'opencode-claude', path: '/work/opencode-claude' },
    ],
  };
  // What runtime.js builds from `session.idle`: no location on the event.
  const turnEnded = { properties: { sessionTitle: 'Fix login', turnEnded: true, info: { sessionID: 'ses_1', role: 'assistant', finish: 'stop' } } };

  it('names the session\'s project, not the one open in the UI, when a turn ends', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ id: 'ses_1', title: 'Fix login', location: { directory: '/work/opencode-claude' } }));
    const runtime = createRuntime(settings);

    const variables = await runtime.buildTemplateVariables(turnEnded, 'ses_1');

    expect(variables.project_name).toBe('opencode-claude');
    expect(variables.worktree).toBe('/work/opencode-claude');
  });

  it('takes the directory the event names without reading the session', async () => {
    globalThis.fetch = vi.fn();
    const runtime = createRuntime(settings);

    const variables = await runtime.buildTemplateVariables({ properties: { ...turnEnded.properties, directory: '/work/opencode-claude' } }, 'ses_1');

    expect(variables.project_name).toBe('opencode-claude');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  const createRuntimeWith = (deps) => createNotificationTemplateRuntime({
    readSettingsFromDisk: async () => settings,
    persistSettings: vi.fn(async () => {}),
    buildOpenCodeUrl: (path) => path,
    getOpenCodeAuthHeaders: () => ({}),
    resolveGitBinaryForSpawn: () => 'git',
    ...deps,
  });
  const turnEndedIn = (directory) => ({ properties: { ...turnEnded.properties, directory } });

  it('names the project of a worktree the session runs in, and keeps the worktree as {worktree}', async () => {
    const resolvePrimaryWorktreeRoot = vi.fn(async () => ({ root: '/work/opencode-claude' }));
    const runtime = createRuntimeWith({ resolvePrimaryWorktreeRoot });

    const variables = await runtime.buildTemplateVariables(turnEndedIn('/data/worktrees/fix-login'), 'ses_1');

    expect(resolvePrimaryWorktreeRoot).toHaveBeenCalledWith('/data/worktrees/fix-login');
    expect(variables.project_name).toBe('opencode-claude');
    expect(variables.worktree).toBe('/data/worktrees/fix-login');
  });

  it('names a directory registered as a project by that project without asking git', async () => {
    const resolvePrimaryWorktreeRoot = vi.fn();
    const runtime = createRuntimeWith({ resolvePrimaryWorktreeRoot });

    const variables = await runtime.buildTemplateVariables(turnEndedIn('/work/dotfiles'), 'ses_1');

    expect(variables.project_name).toBe('dotfiles');
    expect(resolvePrimaryWorktreeRoot).not.toHaveBeenCalled();
  });

  it('falls back to the folder name for a directory outside every project', async () => {
    const runtime = createRuntimeWith({ resolvePrimaryWorktreeRoot: async (directory) => ({ root: directory }) });

    const variables = await runtime.buildTemplateVariables(turnEndedIn('/tmp/scratch'), 'ses_1');

    expect(variables.project_name).toBe('scratch');
  });

  it('names a standalone chat Chats', async () => {
    const resolvePrimaryWorktreeRoot = vi.fn();
    const runtime = createRuntimeWith({ resolvePrimaryWorktreeRoot, chatRoots: ['/data/chats'] });

    const variables = await runtime.buildTemplateVariables(turnEndedIn('/data/chats/session-7bdcaff2'), 'ses_1');

    expect(variables.project_name).toBe('Chats');
    expect(variables.worktree).toBe('/data/chats/session-7bdcaff2');
    expect(resolvePrimaryWorktreeRoot).not.toHaveBeenCalled();
  });
});

describe('notification template session info for a chat of an isolated space', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const spaceSource = (title) => ({
    buildOpenCodeUrl: (path) => `http://space${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    fetchImpl: vi.fn(async () => Response.json({ data: { id: 'ses_1', title } })),
  });
  const renamed = (title) => ({ type: 'session.updated', properties: { info: { id: 'ses_1', title } } });

  it('never lets a space\'s event name a host chat', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ id: 'ses_1', title: 'Host chat' }));
    const runtime = createRuntime();

    runtime.maybeCacheSessionInfoFromEvent(renamed('Claimed by a space'), { spaceId: 'space1' });
    const variables = await runtime.buildTemplateVariables({ properties: { info: {} } }, 'ses_1');

    expect(variables.session_name).toBe('Host chat');
  });

  it('reads a space\'s chat inside the space, past what the host knows', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ id: 'ses_1', title: 'Host chat' }));
    const runtime = createRuntime();
    runtime.maybeCacheSessionInfoFromEvent(renamed('Host chat'));
    const source = spaceSource('Space chat');

    const variables = await runtime.buildTemplateVariables({ properties: { info: {} } }, 'ses_1', source);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const again = await runtime.buildTemplateVariables({ properties: { info: {} } }, 'ses_1');

    expect(variables.session_name).toBe('Space chat');
    expect(again.session_name).toBe('Host chat');
  });
});
