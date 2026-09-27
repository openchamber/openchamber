import { describe, expect, it, vi } from 'vitest';
import { createPermissionAutoAcceptRuntime } from './runtime.js';

const createRuntime = ({ stored, fetchImpl, retryDelaysMs = [0], evaluatePermission, onPermissionReplied, resolveLegacyEnabledMode } = {}) => {
  let settings = stored ?? { permissionAutoAccept: { sessions: {} } };
  let eventHandler;
  let statusHandler;
  const runtime = createPermissionAutoAcceptRuntime({
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus(handler) { statusHandler = handler; return () => {}; },
    },
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSettingsFromDiskMigrated: async () => settings,
    persistSettings: async (changes) => { settings = { ...settings, ...changes }; },
    fetchImpl: fetchImpl ?? vi.fn(async () => new Response('[]')),
    retryDelaysMs,
    evaluatePermission,
    onPermissionReplied,
    resolveLegacyEnabledMode,
  });
  runtime.start();
  return {
    runtime,
    getSettings: () => settings,
    // The hub hands server-side subscribers already-translated events.
    emit: (payload, directory = '/project') => eventHandler({ payload, directory, translated: () => [payload] }),
    connect: () => statusHandler({ type: 'connect' }),
  };
};

const directoryHeader = (init) => {
  const value = init?.headers?.['x-opencode-directory'];
  return typeof value === 'string' ? decodeURIComponent(value) : null;
};

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe('permission auto-accept runtime', () => {
  it('persists explicit session modes across runtime restarts', async () => {
    const first = createRuntime();
    await first.runtime.setSessionPolicy('root', 'safety');
    await first.runtime.setSessionPolicy('manual', 'ask');

    const second = createRuntime({ stored: first.getSettings() });
    // `sessions` keeps the on/off shape older clients read.
    await expect(second.runtime.load()).resolves.toEqual({
      sessions: { root: true, manual: false },
      modes: { root: 'safety', manual: 'ask' },
      revision: 2,
    });
  });

  it('takes on/off from clients that predate the modes as auto and ask', async () => {
    const { runtime } = createRuntime();
    await runtime.setSessionPolicy('on', true);
    await runtime.setSessionPolicy('off', false);
    expect((await runtime.load()).modes).toEqual({ on: 'auto', off: 'ask' });
    await expect(runtime.setSessionPolicy('bad', 'always')).rejects.toThrow(TypeError);
  });

  it('converts a pre-modes policy once, as safety when the old safety net was on', async () => {
    const resolveLegacyEnabledMode = vi.fn(async () => 'safety');
    const { runtime, getSettings } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true, child: false }, revision: 3 } },
      resolveLegacyEnabledMode,
    });
    expect((await runtime.load()).modes).toEqual({ root: 'safety', child: 'ask' });
    expect(getSettings().permissionAutoAccept).toEqual({ sessions: { root: 'safety', child: 'ask' }, revision: 3 });

    const restarted = createRuntime({ stored: getSettings(), resolveLegacyEnabledMode });
    await restarted.runtime.load();
    expect(resolveLegacyEnabledMode).toHaveBeenCalledTimes(1);
  });

  it('writes the default mode onto a new top-level session only', async () => {
    const { runtime, emit, getSettings } = createRuntime();
    await runtime.load();
    getSettings().permissionDefaultMode = 'safety';
    emit({ type: 'session.created', properties: { info: { id: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root' } } });
    await flush();
    await expect(runtime.resolveSessionMode('root', '/project')).resolves.toBe('safety');
    expect((await runtime.load()).modes).toEqual({ root: 'safety' });
    // The subagent inherits instead.
    await expect(runtime.resolveSessionMode('child', '/project')).resolves.toBe('safety');
  });

  it('keeps a mode the creating flow already set over the default', async () => {
    const { runtime, emit, getSettings } = createRuntime();
    await runtime.setSessionPolicy('root', 'ask');
    getSettings().permissionDefaultMode = 'auto';
    emit({ type: 'session.created', properties: { info: { id: 'root' } } });
    await flush();
    await expect(runtime.resolveSessionMode('root', '/project')).resolves.toBe('ask');
  });

  it('increments the authoritative policy revision', async () => {
    const { runtime, getSettings } = createRuntime();

    await expect(runtime.setSessionPolicy('root', true)).resolves.toMatchObject({ revision: 1 });
    await expect(runtime.setSessionPolicy('child', false)).resolves.toMatchObject({ revision: 2 });
    expect(getSettings().permissionAutoAccept.revision).toBe(2);
  });

  it('uses nearest explicit ancestor policy for subagents', async () => {
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true, child: false } } },
    });
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'grandchild', parentID: 'child' } } });
    await expect(runtime.isSessionAutoAccepting('grandchild', '/project')).resolves.toBe(false);
    await runtime.setSessionPolicy('child', true);
    await expect(runtime.isSessionAutoAccepting('grandchild', '/project')).resolves.toBe(true);
  });

  it('keeps a subagent\'s lineage when a later partial update names only its title', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    const { runtime, emit } = createRuntime({ fetchImpl });
    await runtime.setSessionPolicy('root', true);
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root', directory: '/project' } } });
    // v2 renames arrive as partial session records without parentID.
    emit({ type: 'session.updated', properties: { info: { id: 'child', title: 'Subagent' } } });
    emit({ type: 'permission.asked', properties: { id: 'p1', sessionID: 'child', permission: 'bash', metadata: {} } });
    await flush();
    const replies = fetchImpl.mock.calls.map(([url]) => new URL(url).pathname).filter((path) => path.endsWith('/reply'));
    expect(replies).toEqual(['/api/session/child/permission/p1/reply']);
  });

  it('fetches missing subagent lineage before replying', async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === '/api/permission/request') return new Response('[]');
      if (path === '/api/session/child') return Response.json({ id: 'child', parentID: 'root', directory: '/project' });
      if (init.method === 'POST') return Response.json({});
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      fetchImpl,
    });
    await expect(runtime.processPermission({ id: 'perm', sessionID: 'child' }, '/project')).resolves.toBe(true);
    // v2 scopes a permission reply under its session.
    expect(fetchImpl.mock.calls.some(([url, init]) => new URL(url).pathname === '/api/session/child/permission/perm/reply' && init.method === 'POST')).toBe(true);
  });

  it('retries a transient reply failure and deduplicates concurrent events', async () => {
    let replyAttempts = 0;
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === '/api/permission/request') return new Response('[]');
      if (path === '/api/session/root/permission/perm/reply' && init.method === 'POST') {
        replyAttempts += 1;
        return replyAttempts === 1 ? new Response('', { status: 503 }) : Response.json({});
      }
      return Response.json({ id: 'root' });
    });
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      fetchImpl,
      retryDelaysMs: [0, 0],
    });
    const permission = { id: 'perm', sessionID: 'root' };
    const first = runtime.processPermission(permission, '/project');
    const second = runtime.processPermission(permission, '/project');
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(replyAttempts).toBe(2);
  });

  it('reconciles pending permissions after reconnect', async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === '/api/permission/request') return Response.json([{ id: 'pending', sessionID: 'root' }]);
      if (path === '/api/session/root/permission/pending/reply' && init.method === 'POST') return Response.json({});
      return Response.json({ id: 'root' });
    });
    const { connect } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      fetchImpl,
    });
    connect();
    await flush();
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/api/session/root/permission/pending/reply')).toBe(true);
  });

  it('accepts existing pending permissions when a session policy is enabled', async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path === '/api/permission/request') {
        return directoryHeader(init) === '/project'
          ? Response.json([
            { id: 'root-pending', sessionID: 'root' },
            { id: 'other-pending', sessionID: 'other' },
          ])
          : Response.json([]);
      }
      if (path === '/api/session/root/permission/root-pending/reply' && init.method === 'POST') return Response.json({});
      if (path === '/api/session/other') return Response.json({ id: 'other' });
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({ fetchImpl });

    await runtime.setSessionPolicy('root', true, '/project');

    const replyPaths = fetchImpl.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url]) => new URL(url).pathname);
    expect(replyPaths).toEqual(['/api/session/root/permission/root-pending/reply']);
    // OpenCode 2.x scopes the pending list by header, not by query.
    expect(fetchImpl.mock.calls.some(([, init]) => directoryHeader(init) === '/project')).toBe(true);
    expect(await runtime.load()).toEqual({ sessions: { root: true }, modes: { root: 'auto' }, revision: 1 });
  });

  it('leaves a request held by the safety net unanswered and forgets it once replied', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]'));
    const verdicts = { held: { action: 'hold', score: 0.9, kind: 'git_history' }, safe: { action: 'accept', score: 0.1 } };
    const evaluatePermission = vi.fn(async (permission) => verdicts[permission.id]);
    const onPermissionReplied = vi.fn();
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: 'safety' } } },
      fetchImpl,
      evaluatePermission,
      onPermissionReplied,
    });
    await runtime.load();

    emit({ type: 'permission.asked', properties: { id: 'held', sessionID: 'root', permission: 'bash', metadata: {} } });
    emit({ type: 'permission.asked', properties: { id: 'safe', sessionID: 'root', permission: 'bash', metadata: {} } });
    await flush();

    const replies = fetchImpl.mock.calls.filter(([url]) => String(url).includes('/reply'));
    expect(replies.map(([url]) => String(url))).toEqual(['http://opencode.test/api/session/root/permission/safe/reply']);
    expect(directoryHeader(replies[0]?.[1])).toBe('/project');
    expect(evaluatePermission).toHaveBeenCalledTimes(2);

    // Notifications skip only the request that was answered.
    await expect(runtime.isPermissionAutoAnswered('root', '/project', 'safe')).resolves.toBe(true);
    await expect(runtime.isPermissionAutoAnswered('root', '/project', 'held')).resolves.toBe(false);

    emit({ type: 'permission.replied', properties: { sessionID: 'root', requestID: 'held', reply: 'once' } });
    expect(onPermissionReplied).toHaveBeenCalledWith('held');
  });

  it('never consults the safety net in an auto session', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]'));
    const evaluatePermission = vi.fn(async () => ({ action: 'hold' }));
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: 'auto' } } },
      fetchImpl,
      evaluatePermission,
    });
    await runtime.load();
    emit({ type: 'permission.asked', properties: { id: 'p', sessionID: 'root', permission: 'bash', metadata: {} } });
    await flush();
    expect(evaluatePermission).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/permission/p/reply'))).toBe(true);
    await expect(runtime.isPermissionAutoAnswered('root', '/project', 'p')).resolves.toBe(true);
  });

  it('leaves a safety request for the user when the safety net gives no verdict', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]'));
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: 'safety' } } },
      fetchImpl,
      evaluatePermission: async () => ({ action: 'hold', skipped: 'Jev timed out' }),
    });
    await runtime.load();
    emit({ type: 'permission.asked', properties: { id: 'p', sessionID: 'root', permission: 'bash', metadata: {} } });
    await flush();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/reply'))).toBe(false);
  });

  it('does not consult the safety net for sessions that are not auto-accepting', async () => {
    const evaluatePermission = vi.fn(async () => ({ action: 'hold' }));
    const { runtime, emit } = createRuntime({ evaluatePermission });
    await runtime.load();
    emit({ type: 'permission.asked', properties: { id: 'p', sessionID: 'manual', permission: 'bash', metadata: {} } });
    await flush();
    expect(evaluatePermission).not.toHaveBeenCalled();
  });
});
