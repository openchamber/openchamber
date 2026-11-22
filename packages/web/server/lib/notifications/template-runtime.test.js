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

  it('does not substitute another stopped assistant when the requested ID is absent', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{
      id: 'newer-message', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'unrelated answer' }],
    }], cursor: {} })));

    await expect(runtime.fetchLastAssistantMessageText('session-1', 'requested-message')).resolves.toBe('');
  });

  it('follows the cursor to find the requested message on a later page', async () => {
    const runtime = createRuntime();
    const newer = (id) => ({
      id, type: 'assistant', finish: 'stop', content: [{ type: 'text', text: `answer ${id}` }],
    });
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('cursor=page-2')) {
        return new Response(JSON.stringify({
          data: [{ id: 'requested-message', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'older answer' }] }],
          cursor: {},
        }));
      }
      return new Response(JSON.stringify({
        data: [newer('n1'), newer('n2'), newer('n3'), newer('n4'), newer('n5')],
        cursor: { next: 'page-2' },
      }));
    });

    await expect(runtime.fetchLastAssistantMessageText('session-1', 'requested-message')).resolves.toBe('older answer');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(String(globalThis.fetch.mock.calls[1][0])).toContain('cursor=page-2');
  });

  it('returns empty text when the requested message is absent after the final page', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('cursor=page-2')) {
        return new Response(JSON.stringify({
          data: [{ id: 'other-message', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'other answer' }] }],
          cursor: {},
        }));
      }
      return new Response(JSON.stringify({
        data: [{ id: 'newer-message', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'newer answer' }] }],
        cursor: { next: 'page-2' },
      }));
    });

    await expect(runtime.fetchLastAssistantMessageText('session-1', 'requested-message')).resolves.toBe('');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('stops the page walk at the page bound when the cursor never ends', async () => {
    const runtime = createRuntime();
    let pageNumber = 0;
    globalThis.fetch = vi.fn(async () => {
      pageNumber += 1;
      return new Response(JSON.stringify({
        data: [{ id: `page-${pageNumber}-message`, type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'x' }] }],
        cursor: { next: `page-${pageNumber + 1}` },
      }));
    });

    await expect(runtime.fetchLastAssistantMessageText('session-1', 'requested-message')).resolves.toBe('');
    expect(globalThis.fetch).toHaveBeenCalledTimes(10);
  });

  it('keeps newest stopped assistant fallback when no message ID is supplied', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{
      id: 'newer-message', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'latest answer' }],
    }], cursor: {} })));

    await expect(runtime.fetchLastAssistantMessageText('session-1')).resolves.toBe('latest answer');
  });

  it('returns empty text for empty or failed message pages', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async () => Response.json({ data: [], cursor: {} }));
    await expect(runtime.fetchLastAssistantMessageText('session-1', 'requested-message')).resolves.toBe('');
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 }));
    await expect(runtime.fetchLastAssistantMessageText('session-1', 'requested-message')).resolves.toBe('');
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

  it('does not cache an oversized session record as a successful empty read', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(new ReadableStream({}), {
          headers: { 'content-length': String(16 * 1024 * 1024 + 1) },
        });
      }
      return Response.json({ data: { id: 'ses_1', title: 'Nightly cleanup' } });
    });
    const runtime = createRuntime();

    await runtime.buildTemplateVariables({ properties: { info: {} } }, 'ses_1');
    const variables = await runtime.buildTemplateVariables({ properties: { info: {} } }, 'ses_1');

    expect(calls).toBe(2);
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
describe('notification template session caches stay bounded', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const sessionEvent = (id, title) => ({ type: 'session.updated', properties: { info: { id, title } } });

  it('evicts the oldest session titles past the cache limit and keeps recent ones', async () => {
    // Nothing is fetchable, so a session name can only come from the title cache.
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 }));
    const runtime = createRuntime();
    // The caches are capped at 500 entries (SESSION_CACHE_LIMIT): feed well
    // past it, then the first sessions must be gone and the last must remain.
    for (let index = 0; index < 600; index += 1) {
      runtime.maybeCacheSessionInfoFromEvent(sessionEvent(`ses_${index}`, `Title ${index}`));
    }

    const oldest = await runtime.buildTemplateVariables({ properties: { info: {} } }, 'ses_0');
    const newest = await runtime.buildTemplateVariables({ properties: { info: {} } }, 'ses_599');

    expect(oldest.session_name).not.toBe('Title 0');
    expect(newest.session_name).toBe('Title 599');
  });

  it('evicts the oldest fetched session infos past the cache limit and keeps recent ones cached', async () => {
    const fetches = new Map();
    globalThis.fetch = vi.fn(async (url) => {
      const id = decodeURIComponent(String(url).split('/api/session/')[1] ?? '');
      fetches.set(id, (fetches.get(id) ?? 0) + 1);
      return Response.json({ data: { id, title: `Fetched ${id}` } });
    });
    const runtime = createRuntime();
    for (let index = 0; index < 600; index += 1) {
      await runtime.buildTemplateVariables({ properties: { info: {} } }, `ses_${index}`);
    }
    expect(fetches.get('ses_0')).toBe(1);
    expect(fetches.get('ses_599')).toBe(1);

    // A recent session is still served from the info cache: no new fetch.
    await runtime.buildTemplateVariables({ properties: { info: {} } }, 'ses_599');
    expect(fetches.get('ses_599')).toBe(1);

    // The oldest session was evicted from both caches: it is fetched again.
    await runtime.buildTemplateVariables({ properties: { info: {} } }, 'ses_0');
    expect(fetches.get('ses_0')).toBe(2);
  });
});

describe('notification extraction surrogate-pair boundary (#1948)', () => {
  const EMOJI = '\u{1F600}';
  const runtime = createRuntime();

  it('parts path: a pair straddling the 1,000-char cut is dropped whole', () => {
    const out = runtime.extractLastMessageText({
      properties: { info: { parts: [{ type: 'text', text: `${'a'.repeat(999)}${EMOJI}${'b'.repeat(100)}` }] } },
    });
    expect(out).toBe('a'.repeat(999));
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('content-array path: a pair straddling the cut is dropped whole', () => {
    const out = runtime.extractLastMessageText({
      properties: { info: { content: [{ type: 'text', text: `${'a'.repeat(999)}${EMOJI}${'b'.repeat(100)}` }] } },
    });
    expect(out).toBe('a'.repeat(999));
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('a pair fitting whole inside the cut survives intact', () => {
    const out = runtime.extractLastMessageText({
      properties: { info: { parts: [{ type: 'text', text: `${'a'.repeat(998)}${EMOJI}${'b'.repeat(100)}` }] } },
    });
    expect(out).toBe(`${'a'.repeat(998)}${EMOJI}`);
  });

  it('a caller-chosen maxLength is pair-safe too', () => {
    const out = runtime.extractLastMessageText({
      properties: { info: { parts: [{ type: 'text', text: `${'a'.repeat(9)}${EMOJI}${'b'.repeat(50)}` }] } },
    }, 10);
    expect(out).toBe('a'.repeat(9));
  });
});
