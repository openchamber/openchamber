import { describe, expect, it, vi } from 'vitest';
import { createPermissionAutoAcceptRuntime } from './runtime.js';

const createRuntime = ({ stored, fetchImpl, retryDelaysMs = [0] } = {}) => {
  let settings = stored ?? { permissionAutoAccept: { default: false, sessions: {} } };
  let eventHandler;
  let statusHandler;
  const broadcasts = [];
  const persistCalls = [];
  const runtime = createPermissionAutoAcceptRuntime({
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus(handler) { statusHandler = handler; return () => {}; },
    },
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSettingsFromDiskMigrated: async () => settings,
    persistSettings: async (changes) => { persistCalls.push(changes); settings = { ...settings, ...changes }; },
    broadcastGlobalUiEvent: (event) => { broadcasts.push(event); },
    fetchImpl: fetchImpl ?? vi.fn(async () => new Response('[]')),
    retryDelaysMs,
  });
  runtime.start();
  return {
    runtime,
    getSettings: () => settings,
    getBroadcasts: () => broadcasts,
    getPersistCalls: () => persistCalls,
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
      default: false,
      sessions: { root: true },
    });
  });

  it('fails closed to a false global default when the stored value is missing or malformed', async () => {
    const missing = createRuntime({ stored: { permissionAutoAccept: { sessions: { root: true } } } });
    await expect(missing.runtime.load()).resolves.toEqual({
      default: false,
      sessions: { root: true },
    });

    const malformed = createRuntime({ stored: { permissionAutoAccept: { default: 'yes', sessions: {} } } });
    await expect(malformed.runtime.load()).resolves.toEqual({
      default: false,
      sessions: {},
    });
  });

  it('uses nearest explicit ancestor policy for subagents', async () => {
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { default: false, sessions: { root: true, child: false } } },
    });
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'grandchild', parentID: 'child' } } });
    await expect(runtime.isSessionAutoAccepting('grandchild', '/project')).resolves.toBe(false);
    await runtime.setSessionPolicy('child', true);
    await expect(runtime.isSessionAutoAccepting('grandchild', '/project')).resolves.toBe(true);
  });

  it('applies the global default after a fully resolved lineage with no explicit overrides', async () => {
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { default: true, sessions: {} } },
    });
    emit({ type: 'session.created', properties: { info: { id: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root' } } } );

    await expect(runtime.isSessionAutoAccepting('root', '/project')).resolves.toBe(true);
    await expect(runtime.isSessionAutoAccepting('child', '/project')).resolves.toBe(true);
  });

  it('lets an explicit child disable override a true global default', async () => {
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { default: true, sessions: { child: false } } },
    });
    emit({ type: 'session.created', properties: { info: { id: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root' } } });

    await expect(runtime.isSessionAutoAccepting('child', '/project')).resolves.toBe(false);
  });

  it('lets an explicit child enable override a false global default', async () => {
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { default: false, sessions: { child: true } } },
    });
    emit({ type: 'session.created', properties: { info: { id: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'grandchild', parentID: 'child' } } });

    await expect(runtime.isSessionAutoAccepting('child', '/project')).resolves.toBe(true);
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
      stored: { permissionAutoAccept: { default: false, sessions: { root: true } } },
      fetchImpl,
    });
    await expect(runtime.processPermission({ id: 'perm', sessionID: 'child' }, '/project')).resolves.toBe(true);
    expect(fetchImpl.mock.calls.some(([url, init]) => new URL(url).pathname === '/permission/perm/reply' && init.method === 'POST')).toBe(true);
  });

  it('fails closed when the lineage cannot be loaded even if the global default is enabled', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/permission') return new Response('[]');
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { default: true, sessions: {} } },
      fetchImpl,
    });

    await expect(runtime.processPermission({ id: 'perm', sessionID: 'missing' }, '/project')).resolves.toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/permission/perm/reply')).toBe(false);
  });

  it('fails closed under a true global default when session detail returns invalid JSON', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/permission') return Response.json([]);
      if (path === '/session/root') return new Response('{not-json', { status: 200 });
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { default: true, sessions: {} } },
      fetchImpl,
    });

    await expect(runtime.processPermission({ id: 'perm-invalid-json', sessionID: 'root' }, '/project')).resolves.toBe(false);
  });

  it('fails closed under a true global default when session detail returns null', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/permission') return Response.json([]);
      if (path === '/session/root') return Response.json(null);
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { default: true, sessions: {} } },
      fetchImpl,
    });

    await expect(runtime.processPermission({ id: 'perm-null', sessionID: 'root' }, '/project')).resolves.toBe(false);
  });

  it('fails closed under a true global default when session detail returns an empty object', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/permission') return Response.json([]);
      if (path === '/session/root') return Response.json({});
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { default: true, sessions: {} } },
      fetchImpl,
    });

    await expect(runtime.processPermission({ id: 'perm-empty-object', sessionID: 'root' }, '/project')).resolves.toBe(false);
  });

  it('fails closed under a true global default when session detail returns a mismatched id', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/permission') return Response.json([]);
      if (path === '/session/root') return Response.json({ id: 'other', directory: '/project' });
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { default: true, sessions: {} } },
      fetchImpl,
    });

    await expect(runtime.processPermission({ id: 'perm-mismatched-id', sessionID: 'root' }, '/project')).resolves.toBe(false);
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
      stored: { permissionAutoAccept: { default: false, sessions: { root: true } } },
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
      stored: { permissionAutoAccept: { default: false, sessions: { root: true } } },
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
    expect(await runtime.load()).toEqual({ default: false, sessions: { root: true } });
  });

  it('accepts existing pending permissions when the global default is enabled', async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path === '/experimental/session') {
        return Response.json([{ id: 'root', directory: '/project', time: { updated: 10 } }]);
      }
      if (path === '/permission') {
        return parsed.searchParams.get('directory') === '/project'
          ? Response.json([{ id: 'root-pending', sessionID: 'root' }])
          : Response.json([]);
      }
      if (path === '/permission/root-pending/reply' && init.method === 'POST') return Response.json({});
      if (path === '/session/root') return Response.json({ id: 'root', directory: '/project' });
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({ fetchImpl });

    await runtime.setDefaultPolicy(true);

    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/experimental/session')).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/permission/root-pending/reply')).toBe(true);
    expect(await runtime.load()).toEqual({ default: true, sessions: {} });
  });

  it('reconciles pending permissions in uncached directories when the global default is enabled', async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path === '/experimental/session') {
        return Response.json([{ id: 'uncached-root', directory: '/uncached', time: { updated: 10 } }]);
      }
      if (path === '/permission') {
        return parsed.searchParams.get('directory') === '/uncached'
          ? Response.json([{ id: 'uncached-pending', sessionID: 'uncached-root' }])
          : Response.json([]);
      }
      if (path === '/session/uncached-root') return Response.json({ id: 'uncached-root', directory: '/uncached' });
      if (path === '/permission/uncached-pending/reply' && init.method === 'POST') return Response.json({});
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({ fetchImpl });

    await runtime.setDefaultPolicy(true);

    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).searchParams.get('directory') === '/uncached')).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/permission/uncached-pending/reply')).toBe(true);
  });

  it('reconciles uncached directories from every experimental-session page when the first page uses x-next-cursor', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `page-one-${index}`,
      directory: '/page-one',
      time: { updated: 1000 - index },
    }));
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path === '/experimental/session') {
        if (!parsed.searchParams.has('cursor')) {
          return new Response(JSON.stringify(firstPage), {
            status: 200,
            headers: { 'x-next-cursor': '500' },
          });
        }
        return Response.json([{ id: 'page-two-root', directory: '/page-two', time: { updated: 10 } }]);
      }
      if (path === '/permission') {
        const directory = parsed.searchParams.get('directory');
        if (directory === '/page-one') return Response.json([{ id: 'page-one-pending', sessionID: 'page-one-0' }]);
        if (directory === '/page-two') return Response.json([{ id: 'page-two-pending', sessionID: 'page-two-root' }]);
        return Response.json([]);
      }
      if (path === '/session/page-one-0') return Response.json({ id: 'page-one-0', directory: '/page-one' });
      if (path === '/session/page-two-root') return Response.json({ id: 'page-two-root', directory: '/page-two' });
      if (path === '/permission/page-one-pending/reply' && init.method === 'POST') return Response.json({});
      if (path === '/permission/page-two-pending/reply' && init.method === 'POST') return Response.json({});
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({ fetchImpl });

    await runtime.setDefaultPolicy(true);

    expect(fetchImpl.mock.calls.some(([url]) => {
      const parsed = new URL(url);
      return parsed.pathname === '/experimental/session' && parsed.searchParams.get('cursor') === '500';
    })).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).searchParams.get('directory') === '/page-one')).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).searchParams.get('directory') === '/page-two')).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/permission/page-one-pending/reply')).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/permission/page-two-pending/reply')).toBe(true);
  });

  it('falls back to the last session updated time when x-next-cursor is missing', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `cursor-fallback-${index}`,
      directory: '/cursor-fallback',
      time: { updated: 500 - index },
    }));
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path === '/experimental/session') {
        if (!parsed.searchParams.has('cursor')) {
          return Response.json(firstPage);
        }
        return Response.json([{ id: 'cursor-fallback-second', directory: '/cursor-second', time: { updated: 1 } }]);
      }
      if (path === '/permission') {
        const directory = parsed.searchParams.get('directory');
        if (directory === '/cursor-second') return Response.json([{ id: 'cursor-second-pending', sessionID: 'cursor-fallback-second' }]);
        return Response.json([]);
      }
      if (path === '/session/cursor-fallback-second') return Response.json({ id: 'cursor-fallback-second', directory: '/cursor-second' });
      if (path === '/permission/cursor-second-pending/reply' && init.method === 'POST') return Response.json({});
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({ fetchImpl });

    await runtime.setDefaultPolicy(true);

    expect(fetchImpl.mock.calls.some(([url]) => {
      const parsed = new URL(url);
      return parsed.pathname === '/experimental/session' && parsed.searchParams.get('cursor') === '1';
    })).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/permission/cursor-second-pending/reply')).toBe(true);
  });

  it('keeps final default false when a slow enable starts before a later disable', async () => {
    let releaseEnablePreflight;
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/experimental/session') {
        await new Promise((resolve) => {
          releaseEnablePreflight = resolve;
        });
        return Response.json([{ id: 'root', directory: '/project', time: { updated: 10 } }]);
      }
      if (parsed.pathname === '/permission') return Response.json([]);
      return new Response('', { status: 404 });
    });
    const { runtime, getSettings, getBroadcasts } = createRuntime({ fetchImpl });
    await flush();
    fetchImpl.mockClear();

    const enablePromise = runtime.setDefaultPolicy(true);
    await flush();
    const disablePromise = runtime.setDefaultPolicy(false);
    releaseEnablePreflight();

    const [enableResult, disableResult] = await Promise.all([enablePromise, disablePromise]);

    expect(enableResult).toEqual({ default: true, sessions: {} });
    expect(disableResult).toEqual({ default: false, sessions: {} });
    expect(getSettings()).toEqual({ permissionAutoAccept: { default: false, sessions: {} } });
    expect(getBroadcasts().at(-1)?.properties).toEqual({ default: false, sessions: {} });
  });

  it('rejects before persisting or reconciling when the second experimental-session page fails', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `fail-page-${index}`,
      directory: '/fail-page',
      time: { updated: 900 - index },
    }));
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/experimental/session') {
        if (!parsed.searchParams.has('cursor')) {
          return new Response(JSON.stringify(firstPage), {
            status: 200,
            headers: { 'x-next-cursor': '400' },
          });
        }
        return new Response('', { status: 503 });
      }
      if (parsed.pathname === '/permission') return Response.json([{ id: 'should-not-fetch', sessionID: 'fail-page-0' }]);
      return new Response('', { status: 404 });
    });
    const { runtime, getBroadcasts, getPersistCalls, getSettings } = createRuntime({ fetchImpl });
    await flush();
    fetchImpl.mockClear();

    await expect(runtime.setDefaultPolicy(true)).rejects.toThrow();

    expect(getSettings()).toEqual({ permissionAutoAccept: { default: false, sessions: {} } });
    expect(getPersistCalls()).toEqual([]);
    expect(getBroadcasts()).toEqual([]);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/permission')).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname.includes('/reply'))).toBe(false);
  });

  it('recovers the write queue after an enable preflight failure', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/experimental/session') {
        return new Response('', { status: 503 });
      }
      if (parsed.pathname === '/permission') return Response.json([]);
      return new Response('', { status: 404 });
    });
    const { runtime, getBroadcasts, getPersistCalls, getSettings } = createRuntime({
      stored: { permissionAutoAccept: { default: true, sessions: {} } },
      fetchImpl,
    });
    await flush();
    fetchImpl.mockClear();

    await expect(runtime.setDefaultPolicy(true)).rejects.toThrow();
    const disableResult = await runtime.setDefaultPolicy(false);

    expect(disableResult).toEqual({ default: false, sessions: {} });
    expect(getSettings()).toEqual({ permissionAutoAccept: { default: false, sessions: {} } });
    expect(getPersistCalls()).toEqual([{ permissionAutoAccept: { default: false, sessions: {} } }]);
    expect(getBroadcasts()).toEqual([
      {
        type: 'openchamber:permission-auto-accept.updated',
        properties: { default: false, sessions: {} },
      },
    ]);
  });

  it('rejects before persisting or reconciling when the second experimental-session page is malformed', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `malformed-page-${index}`,
      directory: '/malformed-page',
      time: { updated: 700 - index },
    }));
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/experimental/session') {
        if (!parsed.searchParams.has('cursor')) {
          return new Response(JSON.stringify(firstPage), {
            status: 200,
            headers: { 'x-next-cursor': '300' },
          });
        }
        return Response.json([{}]);
      }
      if (parsed.pathname === '/permission') return Response.json([{ id: 'should-not-fetch', sessionID: 'malformed-page-0' }]);
      return new Response('', { status: 404 });
    });
    const { runtime, getBroadcasts, getPersistCalls, getSettings } = createRuntime({ fetchImpl });
    await flush();
    fetchImpl.mockClear();

    await expect(runtime.setDefaultPolicy(true)).rejects.toThrow();

    expect(getSettings()).toEqual({ permissionAutoAccept: { default: false, sessions: {} } });
    expect(getPersistCalls()).toEqual([]);
    expect(getBroadcasts()).toEqual([]);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/permission')).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname.includes('/reply'))).toBe(false);
  });

  it('does not reconcile pending permissions when the global default is disabled', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (new URL(url).pathname === '/permission') return Response.json([{ id: 'pending', sessionID: 'root' }]);
      return Response.json({ id: 'root' });
    });
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { default: true, sessions: {} } },
      fetchImpl,
    });

    await flush();
    fetchImpl.mockClear();
    await runtime.setDefaultPolicy(false);

    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/permission')).toBe(false);
  });
});
