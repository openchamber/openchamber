import { describe, expect, it, vi } from 'vitest';
import { createPermissionAutoAcceptRuntime } from './runtime.js';

const createRuntime = ({ stored, fetchImpl, retryDelaysMs = [0], protocol = 'legacy', authHeaders = {} } = {}) => {
  let settings = stored ?? { permissionAutoAccept: { sessions: {} } };
  let eventHandler;
  let statusHandler;
  const runtime = createPermissionAutoAcceptRuntime({
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus(handler) { statusHandler = handler; return () => {}; },
    },
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => authHeaders,
    getOpenCodeProtocol: () => protocol,
    readSettingsFromDiskMigrated: async () => settings,
    persistSettings: async (changes) => { settings = { ...settings, ...changes }; },
    fetchImpl: fetchImpl ?? vi.fn(async () => new Response('[]')),
    retryDelaysMs,
  });
  runtime.start();
  return {
    runtime,
    getSettings: () => settings,
    emit: (payload, directory = '/project') => eventHandler({ payload, directory }),
    connect: () => statusHandler({ type: 'connect' }),
  };
};

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe('permission auto-accept runtime', () => {
  it('persists explicit session policies across runtime restarts', async () => {
    const first = createRuntime();
    await first.runtime.setSessionPolicy('root', true);

    const second = createRuntime({ stored: first.getSettings() });
    await expect(second.runtime.load()).resolves.toEqual({
      sessions: { root: true },
      revision: 1,
    });
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

  it('fetches missing subagent lineage before replying', async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === '/permission') return new Response('[]');
      if (path === '/session/child') return Response.json({ id: 'child', parentID: 'root', directory: '/project' });
      if (init.method === 'POST') return Response.json({});
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      fetchImpl,
    });
    await expect(runtime.processPermission({ id: 'perm', sessionID: 'child' }, '/project')).resolves.toBe(true);
    expect(fetchImpl.mock.calls.some(([url, init]) => new URL(url).pathname === '/permission/perm/reply' && init.method === 'POST')).toBe(true);
  });

  it('replies to opencode2 permission events through the authoritative session route', async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (new URL(url).pathname === '/api/permission/request') return new Response('[]');
      return Response.json({});
    });
    const { emit } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { 'session/root': true } } },
      protocol: 'opencode2',
      authHeaders: { Authorization: 'Bearer upstream-secret' },
      fetchImpl,
    });

    emit({
      type: 'permission.asked',
      properties: { id: 'permission/one', sessionID: 'session/root' },
    });
    await flush();

    const replyCall = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(new URL(replyCall[0]).pathname).toBe('/api/session/session%2Froot/permission/permission%2Fone/reply');
    expect(Array.from(new URL(replyCall[0]).searchParams.entries())).toEqual([]);
    expect(replyCall[1].body).toBe('{"reply":"once"}');
    expect(replyCall[1].headers.Authorization).toBe('Bearer upstream-secret');
    expect(String(replyCall[0])).not.toContain('upstream-secret');
    expect(replyCall[1].body).not.toContain('upstream-secret');
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/api/permission/request')).toBe(true);
  });

  it('uses opencode2 session lookup while resolving missing lineage', async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === '/api/permission/request') return Response.json([]);
      if (path === '/api/session/child') return Response.json({ id: 'child', parentID: 'root', directory: '/project' });
      if (path === '/api/session/child/permission/perm/reply' && init.method === 'POST') return Response.json({});
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      protocol: 'opencode2',
      fetchImpl,
    });

    await expect(runtime.processPermission({ id: 'perm', sessionID: 'child' }, '/project')).resolves.toBe(true);
    const sessionCall = fetchImpl.mock.calls.find(([url]) => new URL(url).pathname === '/api/session/child');
    const replyCall = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(Array.from(new URL(sessionCall[0]).searchParams.entries())).toEqual([]);
    expect(Array.from(new URL(replyCall[0]).searchParams.entries())).toEqual([]);
  });

  it('uses the generated-client location query shape for scoped opencode2 pending requests', async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/permission/request') {
        return parsed.searchParams.get('location[directory]') === '/project'
          ? Response.json([{ id: 'pending', sessionID: 'root' }])
          : Response.json([]);
      }
      if (init.method === 'POST') return Response.json({});
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({ protocol: 'opencode2', fetchImpl });

    await runtime.setSessionPolicy('root', true, '/project');

    const pendingCall = fetchImpl.mock.calls.find(([url]) =>
      new URL(url).searchParams.has('location[directory]'));
    const replyCall = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(Array.from(new URL(pendingCall[0]).searchParams.entries())).toEqual([
      ['location[directory]', '/project'],
    ]);
    expect(Array.from(new URL(replyCall[0]).searchParams.entries())).toEqual([]);
  });

  it('retries a transient reply failure and deduplicates concurrent events', async () => {
    let replyAttempts = 0;
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === '/permission') return new Response('[]');
      if (path === '/permission/perm/reply' && init.method === 'POST') {
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
      if (path === '/permission') return Response.json([{ id: 'pending', sessionID: 'root' }]);
      if (path === '/permission/pending/reply' && init.method === 'POST') return Response.json({});
      return Response.json({ id: 'root' });
    });
    const { connect } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      fetchImpl,
    });
    connect();
    await flush();
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/permission/pending/reply')).toBe(true);
  });

  it('accepts existing pending permissions when a session policy is enabled', async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path === '/permission') {
        return parsed.searchParams.get('directory') === '/project'
          ? Response.json([
            { id: 'root-pending', sessionID: 'root' },
            { id: 'other-pending', sessionID: 'other' },
          ])
          : Response.json([]);
      }
      if (path === '/permission/root-pending/reply' && init.method === 'POST') return Response.json({});
      if (path === '/session/other') return Response.json({ id: 'other' });
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({ fetchImpl });

    await runtime.setSessionPolicy('root', true, '/project');

    const replyPaths = fetchImpl.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url]) => new URL(url).pathname);
    expect(replyPaths).toEqual(['/permission/root-pending/reply']);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).searchParams.get('directory') === '/project')).toBe(true);
    expect(await runtime.load()).toEqual({ sessions: { root: true }, revision: 1 });
  });
});
