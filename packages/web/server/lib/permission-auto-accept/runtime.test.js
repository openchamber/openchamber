import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPermissionAutoAcceptRuntime, registerPermissionAutoAcceptRoutes } from './runtime.js';
import express from 'express';
import { createGlobalUiEventBroadcaster } from '../event-stream/runtime.js';
import { createNotificationEmitterRuntime } from '../notifications/emitter-runtime.js';

const stops = [];
const reviewState = (revision, permissions = []) => ({ dispositionVersion: 1, instanceId: expect.any(String), revision, permissions });
const lease = (permissionId, phase = 'reviewing', remainingMs = expect.any(Number)) => ({ permissionId, phase, remainingMs });
const manual = (permissionId = 'p') => lease(permissionId, 'manual', 0);
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const createRuntime = ({ stored, fetchImpl, retryDelaysMs = [0], evaluatePermission, onPermissionReplied, resolveLegacyEnabledMode, now, reviewTimeoutMs, broadcastGlobalUiEvent = vi.fn(), broadcastPermissionReviewEvent = vi.fn() } = {}) => {
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
    broadcastGlobalUiEvent,
    broadcastPermissionReviewEvent,
    now,
    reviewTimeoutMs,
  });
  const stop = runtime.start();
  stops.push(stop);
  return {
    runtime,
    stop,
    reviewEvents: () => broadcastPermissionReviewEvent.mock.calls.map(([event]) => event.properties),
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
      review: reviewState(0),
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
    // The reconcile chain reads settings and response bodies, so its length in
    // microtasks is not fixed; wait for the reply instead of counting ticks.
    await vi.waitFor(() => {
      expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/api/session/root/permission/pending/reply')).toBe(true);
    });
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
    expect(await runtime.load()).toMatchObject({ sessions: { root: true }, modes: { root: 'auto' }, revision: 1, review: { permissions: [lease('root-pending', 'answered'), manual('other-pending')] } });
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

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('server permission disposition lookup', () => {
  const permission = { id: 'lookup', sessionID: 'root', action: 'bash', resources: ['echo test'] };
  const requests = [{ id: permission.id, sessionID: permission.sessionID, directory: '/project' }];

  it('serves the batch disposition contract and rejects malformed identifiers over HTTP', async () => {
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: 'ask' } } },
      fetchImpl: async (url) => Response.json(String(url).endsWith('/permission/lookup') ? { data: permission } : []),
    });
    const app = express();
    app.use(express.json());
    registerPermissionAutoAcceptRoutes(app, runtime);
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/permission-auto-accept/dispositions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
    });
    try {
      const response = await post({ requests });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(reviewState(1, [manual('lookup')]));
      expect((await post({ requests: [{ id: 'lookup' }] })).status).toBe(400);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('resolves an initially unknown Ask request without calling or waiting for Jev', async () => {
    const evaluatePermission = vi.fn(() => new Promise(() => {}));
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: 'ask' } } }, evaluatePermission,
      fetchImpl: async (url) => Response.json(String(url).endsWith('/permission/lookup') ? { data: permission } : []),
    });
    expect(runtime.snapshot().review.permissions).toEqual([]);
    expect((await runtime.dispositions(requests)).permissions).toEqual([manual('lookup')]);
    expect(evaluatePermission).not.toHaveBeenCalled();
  });

  it('returns review disposition while classification remains unresolved', async () => {
    let finish;
    const evaluation = new Promise((resolve) => { finish = resolve; });
    const evaluatePermission = vi.fn(() => evaluation);
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: 'safety' } } }, evaluatePermission,
      fetchImpl: async (url) => Response.json(String(url).endsWith('/permission/lookup') ? { data: permission } : []),
    });
    const snapshot = await runtime.dispositions(requests);
    expect(snapshot.permissions[0].permissionId).toBe('lookup');
    expect(snapshot.permissions[0].remainingMs).toBeGreaterThan(0);
    finish({ action: 'hold' });
    await runtime.processPermission(permission);
    expect((await runtime.dispositions(requests)).permissions).toEqual([manual('lookup')]);
    expect(evaluatePermission).toHaveBeenCalledTimes(1);
  });

  it.each(['hold', 'unavailable', 'error'])('retains %s before pending and in reload snapshots', async (result) => {
    const evaluatePermission = vi.fn(async () => {
      if (result === 'error') throw new Error('classifier failed');
      return { action: 'hold', skipped: result === 'unavailable' ? 'unavailable' : undefined };
    });
    const { runtime } = createRuntime({ stored: { permissionAutoAccept: { sessions: { root: 'safety' } } }, evaluatePermission });
    await runtime.processPermission(permission);
    expect((await runtime.load()).review.permissions).toEqual([manual('lookup')]);
    expect((await runtime.dispositions(requests)).permissions).toEqual([manual('lookup')]);
    expect(evaluatePermission).toHaveBeenCalledTimes(1);
  });

  it('distinguishes authoritative missing from a failed pending read', async () => {
    let status = 503;
    const { runtime } = createRuntime({ fetchImpl: async (url) => String(url).endsWith('/permission/lookup') ? new Response(null, { status }) : Response.json([]) });
    await expect(runtime.dispositions(requests)).rejects.toThrow('503');
    expect(runtime.snapshot().review.permissions).toEqual([]);
    status = 404;
    expect((await runtime.dispositions(requests)).permissions).toEqual([lease('lookup', 'answered')]);
  });
});

describe('server permission review visibility', () => {
  const stored = { permissionAutoAccept: { sessions: { root: 'safety' } } };
  const permission = { id: 'p', sessionID: 'root' };

  it('requires an explicit review broadcaster instead of falling back to notifications', () => {
    expect(() => createPermissionAutoAcceptRuntime({ broadcastGlobalUiEvent: vi.fn() }))
      .toThrow('broadcastPermissionReviewEvent is required');
  });

  it.each(['hold', 'accept'])('delivers deferred review %s on control SSE and policy on notification SSE', async (action) => {
    const controlEvents = [];
    const notificationEvents = [];
    const wsFrames = [];
    const { writeSseEvent } = createNotificationEmitterRuntime({});
    // Production has separate SSE client sets and one shared WebSocket set.
    const controlClients = new Set([{ write: (text) => controlEvents.push(JSON.parse(text.slice(6).trim())) }]);
    const notificationClients = new Set([{ write: (text) => notificationEvents.push(JSON.parse(text.slice(6).trim())) }]);
    const wsClients = new Set([{ readyState: 1, send: (text) => wsFrames.push(JSON.parse(text)) }]);
    const evaluation = deferred();
    const { runtime } = createRuntime({
      stored,
      now: () => 100,
      evaluatePermission: () => evaluation.promise,
      broadcastGlobalUiEvent: createGlobalUiEventBroadcaster({ sseClients: notificationClients, wsClients, writeSseEvent }),
      broadcastPermissionReviewEvent: createGlobalUiEventBroadcaster({ sseClients: controlClients, wsClients, writeSseEvent }),
    });
    const task = runtime.processPermission(permission);
    const admitting = { type: 'openchamber:permission-review.updated', properties: reviewState(1, [lease('p', 'admitting', 25000)]) };
    await flush();
    const started = {
      type: 'openchamber:permission-review.updated',
      properties: reviewState(2, [lease('p', 'reviewing', 25000)]),
    };
    expect(controlEvents).toEqual([admitting, started]);
    expect(notificationEvents).toEqual([]);

    const policy = await runtime.setSessionPolicy('other', 'ask');
    const updated = { type: 'openchamber:permission-auto-accept.updated', properties: policy };
    expect(notificationEvents).toEqual([updated]);
    expect(policy).toMatchObject({ modes: { root: 'safety', other: 'ask' }, revision: 1 });
    expect(controlEvents).toEqual([admitting, started]);

    evaluation.resolve({ action });
    await expect(task).resolves.toBe(true);
    const ended = { type: 'openchamber:permission-review.updated', properties: reviewState(3, action === 'accept' ? [lease('p', 'answered', 25000)] : [manual()]) };
    expect(controlEvents).toEqual([admitting, started, ended]);
    expect(notificationEvents).toEqual([updated]);
    expect(wsFrames).toEqual([admitting, started, updated, ended].map((payload) => ({ type: 'event', directory: 'global', payload })));
    await expect(runtime.isPermissionAutoAnswered('root', undefined, 'p')).resolves.toBe(action === 'accept');
  });

  it.each([
    ['hold', { action: 'hold' }],
    ['unavailable', { action: 'hold', unavailable: true }],
    ['classifier timeout', { action: 'hold', skipped: 'timed out' }],
    ['no verdict', null],
  ])('admits before evaluating, then exposes on %s', async (_scenario, verdict) => {
    const evaluation = deferred();
    const { runtime, reviewEvents } = createRuntime({ stored, evaluatePermission: () => evaluation.promise, now: () => 100 });
    const task = runtime.processPermission(permission);
    await flush();
    expect((await runtime.load()).review).toEqual(reviewState(2, [lease('p', 'reviewing', 25000)]));
    evaluation.resolve(verdict);
    await expect(task).resolves.toBe(true);
    expect(reviewEvents()).toEqual([
      reviewState(1, [lease('p', 'admitting', 25000)]),
      reviewState(2, [lease('p', 'reviewing', 25000)]),
      reviewState(3, [manual()]),
    ]);
    await expect(runtime.isPermissionAutoAnswered('root', undefined, 'p')).resolves.toBe(false);
  });

  it('exposes classifier errors, including 404, without retrying or claiming a reply', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evaluation = deferred();
    const evaluatePermission = vi.fn(() => evaluation.promise);
    const { runtime, reviewEvents } = createRuntime({ stored, evaluatePermission, retryDelaysMs: [0, 0, 0] });
    const task = runtime.processPermission(permission);
    await flush();
    evaluation.reject(Object.assign(new Error('provider missing'), { status: 404 }));
    await expect(task).resolves.toBe(false);
    expect(evaluatePermission).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[permission-auto-accept] permission processing failed', {
      permissionId: 'p', sessionId: 'root', status: 404, message: 'Upstream returned HTTP 404',
    });
    expect(reviewEvents().at(-1)).toEqual(reviewState(3, [manual()]));
    await expect(runtime.isPermissionAutoAnswered('root', undefined, 'p')).resolves.toBe(false);
  });

  it('keeps one lease through reply retries and answered settlement', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reply = deferred();
    let attempts = 0;
    const evaluatePermission = vi.fn(async () => ({ action: 'accept' }));
    const fetchImpl = vi.fn(async (_url, init) => {
      if (init.method !== 'POST') return Response.json([]);
      attempts += 1;
      return attempts === 1 ? new Response('', { status: 503 }) : reply.promise;
    });
    const { runtime, reviewEvents } = createRuntime({ stored, evaluatePermission, fetchImpl, retryDelaysMs: [0, 0] });
    const task = runtime.processPermission(permission);
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(reviewEvents()).toHaveLength(2);
    expect(runtime.snapshot().review.permissions.map((entry) => entry.permissionId)).toEqual(['p']);
    reply.resolve(Response.json({}));
    await expect(task).resolves.toBe(true);
    expect(evaluatePermission).toHaveBeenCalledTimes(1);
    expect(reviewEvents().at(-1)).toEqual(reviewState(3, [lease('p', 'answered')]));
  });

  it('clears review when automatic reply retries are exhausted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (_url, init) => init.method === 'POST' ? new Response('', { status: 503 }) : Response.json([]));
    const { runtime, reviewEvents } = createRuntime({ stored, evaluatePermission: async () => ({ action: 'accept' }), fetchImpl, retryDelaysMs: [0, 0, 0] });
    await expect(runtime.processPermission(permission)).resolves.toBe(false);
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(3);
    expect(reviewEvents()).toHaveLength(3);
    expect(runtime.snapshot().review).toEqual(reviewState(3, [manual()]));
  });

  it('deduplicates one request while complete snapshots retain concurrent reviews', async () => {
    const first = deferred();
    const second = deferred();
    const evaluatePermission = vi.fn((request) => request.id === 'p' ? first.promise : second.promise);
    const { runtime, reviewEvents } = createRuntime({ stored, evaluatePermission, now: () => 100 });
    const task = runtime.processPermission(permission);
    expect(runtime.processPermission(permission)).toBe(task);
    const other = runtime.processPermission({ id: 'q', sessionID: 'root' });
    await flush();
    expect(evaluatePermission).toHaveBeenCalledTimes(2);
    expect(reviewEvents().at(-1)).toEqual(reviewState(4, [lease('p', 'reviewing', 25000), lease('q', 'reviewing', 25000)]));
    first.resolve({ action: 'hold' });
    await task;
    expect(reviewEvents().at(-1)).toEqual(reviewState(5, [lease('q', 'reviewing', 25000), manual()]));
    second.resolve({ action: 'hold' });
    await other;
    expect(runtime.snapshot().review).toEqual(reviewState(6, [manual(), manual('q')]));
  });

  it.each(['manual reply', 'stop', 'lease expiry'])('clears %s and ignores a late accept verdict', async (ending) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evaluation = deferred();
    const fetchImpl = vi.fn(async () => Response.json([]));
    const { runtime, emit, stop, reviewEvents } = createRuntime({ stored, fetchImpl, evaluatePermission: () => evaluation.promise, reviewTimeoutMs: 100 });
    const task = runtime.processPermission(permission);
    await flush();
    if (ending === 'manual reply') emit({ type: 'permission.replied', properties: { requestID: 'p' } });
    if (ending === 'stop') stop();
    if (ending === 'lease expiry') await vi.advanceTimersByTimeAsync(100);
    await task;
    expect(runtime.snapshot().review).toEqual(reviewState(3, ending === 'manual reply' ? [lease('p', 'answered')] : [manual()]));
    evaluation.resolve({ action: 'accept' });
    await flush();
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    expect(reviewEvents()).toHaveLength(3);
    if (ending === 'manual reply') await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('decreases the remaining lease on reads without renewing it', async () => {
    const evaluation = deferred();
    let at = 100;
    const { runtime } = createRuntime({ stored, evaluatePermission: () => evaluation.promise, now: () => at });
    const task = runtime.processPermission(permission);
    await flush();
    at += 4000;
    expect((await runtime.load()).review).toEqual(reviewState(2, [lease('p', 'reviewing', 21000)]));
    at += 4000;
    expect(runtime.snapshot().review.permissions[0].remainingMs).toBe(17000);
    evaluation.resolve({ action: 'hold' });
    await task;
  });

  it('clears a manual reply during an automatic reply attempt without retrying its late failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reply = deferred();
    const fetchImpl = vi.fn(async (_url, init) => init.method === 'POST' ? reply.promise : Response.json([]));
    const { runtime, emit, reviewEvents } = createRuntime({ stored, fetchImpl, evaluatePermission: async () => ({ action: 'accept' }), retryDelaysMs: [0, 0] });
    const task = runtime.processPermission(permission);
    await flush();
    expect(runtime.snapshot().review.permissions).toHaveLength(1);
    emit({ type: 'permission.replied', properties: { requestID: 'p' } });
    await task;
    reply.resolve(new Response('', { status: 503 }));
    await flush();
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(reviewEvents().at(-1)).toEqual(reviewState(3, [lease('p', 'answered')]));
  });

  it('suppresses notifications when its reply event beats the deferred POST response', async () => {
    const reply = deferred();
    const evaluatePermission = vi.fn(async () => ({ action: 'accept' }));
    const fetchImpl = vi.fn(async (_url, init) => init.method === 'POST' ? reply.promise : Response.json([]));
    const { runtime, emit, reviewEvents } = createRuntime({ stored, fetchImpl, evaluatePermission, retryDelaysMs: [0, 0, 0] });
    const task = runtime.processPermission(permission);
    await flush();
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    const notification = runtime.isPermissionAutoAnswered('root', undefined, 'p');
    emit({ type: 'permission.replied', properties: { requestID: 'p', sessionID: 'root' } });
    await expect(task).resolves.toBe(true);
    await expect(notification).resolves.toBe(true);
    expect(runtime.snapshot().review).toEqual(reviewState(3, [lease('p', 'answered')]));
    reply.resolve(Response.json({}));
    await flush();
    await expect(runtime.isPermissionAutoAnswered('root', undefined, 'p')).resolves.toBe(true);
    expect(evaluatePermission).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(reviewEvents()).toHaveLength(3);
  });

  it('cancels retry backoff timers when stopped', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (_url, init) => init.method === 'POST' ? new Response('', { status: 503 }) : Response.json([]));
    const { runtime, stop } = createRuntime({ stored, fetchImpl, evaluatePermission: async () => ({ action: 'accept' }), retryDelaysMs: [0, 1000] });
    const task = runtime.processPermission(permission);
    await flush();
    expect(vi.getTimerCount()).toBe(2);
    stop();
    await task;
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.snapshot().review).toEqual(reviewState(3, [manual()]));
    await expect(runtime.processPermission({ id: 'after-stop', sessionID: 'root' })).resolves.toBe(false);
  });

  it('settles admission when manually answered during policy resolution', async () => {
    const evaluatePermission = vi.fn(async () => ({ action: 'accept' }));
    const { runtime, emit, reviewEvents } = createRuntime({ stored, evaluatePermission });
    const task = runtime.processPermission(permission);
    emit({ type: 'permission.replied', properties: { requestID: 'p' } });
    await task;
    await flush();
    expect(evaluatePermission).not.toHaveBeenCalled();
    expect(reviewEvents()).toEqual([reviewState(1, [lease('p', 'admitting')]), reviewState(2, [lease('p', 'answered')])]);
  });

  it('releases admission for ask and missing evaluator, and retains an automatic answer', async () => {
    for (const mode of ['ask', 'auto', 'safety']) {
      const { runtime, reviewEvents } = createRuntime({ stored: { permissionAutoAccept: { sessions: { root: mode } } } });
      await runtime.processPermission(permission);
      expect(reviewEvents()).toHaveLength(2);
      expect(runtime.snapshot().review).toEqual(reviewState(2, mode === 'auto' ? [lease('p', 'answered')] : [manual()]));
    }
  });

  it('rejects an accept past its deadline before the expiry timer runs', async () => {
    const evaluation = deferred();
    let at = 100;
    const fetchImpl = vi.fn(async () => Response.json([]));
    const { runtime, reviewEvents } = createRuntime({ stored, fetchImpl, evaluatePermission: () => evaluation.promise, now: () => at });
    const task = runtime.processPermission(permission);
    await flush();
    at += 25000;
    expect(runtime.snapshot().review.permissions).toEqual([]);
    // Only the injected monotonic clock advanced, not the timer scheduler.
    evaluation.resolve({ action: 'accept' });
    await task;
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    expect(reviewEvents().at(-1)).toEqual(reviewState(3, [manual()]));
    await expect(runtime.isPermissionAutoAnswered('root', undefined, 'p')).resolves.toBe(false);
  });

  it('leaves an auto request pending when its final policy read becomes safety without a verdict', async () => {
    const evaluatePermission = vi.fn(async () => ({ action: 'accept' }));
    const fetchImpl = vi.fn(async () => Response.json([]));
    const { runtime } = createRuntime({ stored: { permissionAutoAccept: { sessions: { root: 'auto' } } }, fetchImpl, evaluatePermission });
    await runtime.load();
    const task = runtime.processPermission(permission);
    // Finish the initial mode lookup's load/write awaits. The policy write
    // then commits while the final pre-POST lookup waits for pending writes.
    await Promise.resolve();
    await Promise.resolve();
    await runtime.setSessionPolicy('root', 'safety');
    await task;
    expect(evaluatePermission).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    await expect(runtime.isPermissionAutoAnswered('root', undefined, 'p')).resolves.toBe(false);
  });

  it.each(['root', 'child'])('cancels %s review after parent policy becomes ask while preserving an explicitly safe sibling', async (sessionID) => {
    const evaluation = deferred();
    const siblingEvaluation = deferred();
    const fetchImpl = vi.fn(async () => Response.json([]));
    const evaluatePermission = vi.fn((request) => request.id === 'p' ? evaluation.promise : siblingEvaluation.promise);
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: 'safety', sibling: 'safety' } } },
      evaluatePermission,
      fetchImpl,
    });
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'sibling', parentID: 'root' } } });
    const task = runtime.processPermission({ id: 'p', sessionID }, '/project');
    const sibling = runtime.processPermission({ id: 'q', sessionID: 'sibling' }, '/project');
    await flush();
    expect(runtime.snapshot().review.permissions).toHaveLength(2);
    const updated = await runtime.setSessionPolicy('root', 'ask', '/project');
    expect(updated.review.permissions).toEqual([lease('q'), manual()]);
    // Policy update settles the affected operation before its evaluator returns.
    await task;
    evaluation.resolve({ action: 'accept' });
    await flush();
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    expect(runtime.snapshot().review.permissions).toEqual([lease('q'), manual()]);
    siblingEvaluation.resolve({ action: 'accept' });
    await sibling;
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST').map(([url]) => new URL(url).pathname)).toEqual(['/api/session/sibling/permission/q/reply']);
    expect(evaluatePermission).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().review.permissions).toEqual([lease('q', 'answered'), manual()]);
  });
});
