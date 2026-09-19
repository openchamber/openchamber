import { describe, expect, it, vi } from 'vitest';
import { createPermissionAutoAcceptRuntime } from './runtime.js';

const createRuntime = ({ stored, openCodeApi: apiOverrides = {}, retryDelaysMs = [0], evaluatePermission, onPermissionReplied } = {}) => {
  let settings = stored ?? { permissionAutoAccept: { sessions: {} } };
  let eventHandler;
  let statusHandler;
  const openCodeApi = {
    getSession: vi.fn(async (sessionID, directory) => ({ id: sessionID, directory })),
    listPendingPermissions: vi.fn(async () => []),
    replyPermission: vi.fn(async () => true),
    ...apiOverrides,
  };
  const runtime = createPermissionAutoAcceptRuntime({
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus(handler) { statusHandler = handler; return () => {}; },
    },
    openCodeApi,
    readSettingsFromDiskMigrated: async () => settings,
    persistSettings: async (changes) => { settings = { ...settings, ...changes }; },
    retryDelaysMs,
    evaluatePermission,
    onPermissionReplied,
  });
  runtime.start();
  return {
    runtime,
    openCodeApi,
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
    const { runtime, openCodeApi } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      openCodeApi: {
        getSession: vi.fn(async () => ({ id: 'child', parentID: 'root', directory: '/project' })),
      },
    });
    await expect(runtime.processPermission({ id: 'perm', sessionID: 'child' }, '/project')).resolves.toBe(true);
    expect(openCodeApi.getSession).toHaveBeenCalledWith('child', '/project', { timeoutMs: 5000 });
    expect(openCodeApi.replyPermission).toHaveBeenCalledWith({
      sessionID: 'child',
      requestID: 'perm',
      directory: '/project',
      reply: 'once',
    }, { timeoutMs: 5000 });
  });

  it('replies to permission events with the authoritative session ID', async () => {
    const { emit, openCodeApi } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { 'session/root': true } } },
    });

    emit({
      type: 'permission.asked',
      properties: { id: 'permission/one', sessionID: 'session/root' },
    });
    await flush();

    expect(openCodeApi.replyPermission).toHaveBeenCalledWith({
      sessionID: 'session/root',
      requestID: 'permission/one',
      directory: '/project',
      reply: 'once',
    }, { timeoutMs: 5000 });
  });

  it('uses session lookup while resolving missing lineage', async () => {
    const getSession = vi.fn(async () => ({ id: 'child', parentID: 'root', directory: '/project' }));
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      openCodeApi: { getSession },
    });

    await expect(runtime.processPermission({ id: 'perm', sessionID: 'child' }, '/project')).resolves.toBe(true);
    expect(getSession).toHaveBeenCalledWith('child', '/project', { timeoutMs: 5000 });
  });

  it('reconciles both global and directory-scoped pending requests', async () => {
    const listPendingPermissions = vi.fn(async (directory) => directory === '/project'
      ? [{ id: 'pending', sessionID: 'root' }]
      : []);
    const { runtime, openCodeApi } = createRuntime({ openCodeApi: { listPendingPermissions } });

    await runtime.setSessionPolicy('root', true, '/project');

    expect(listPendingPermissions).toHaveBeenCalledWith(undefined, { timeoutMs: 5000 });
    expect(listPendingPermissions).toHaveBeenCalledWith('/project', { timeoutMs: 5000 });
    expect(openCodeApi.replyPermission).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'root',
      requestID: 'pending',
      directory: '/project',
    }), { timeoutMs: 5000 });
  });

  it('retries a transient reply failure and deduplicates concurrent events', async () => {
    const replyPermission = vi.fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(true);
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      openCodeApi: { replyPermission },
      retryDelaysMs: [0, 0],
    });
    const permission = { id: 'perm', sessionID: 'root' };
    const first = runtime.processPermission(permission, '/project');
    const second = runtime.processPermission(permission, '/project');
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(replyPermission).toHaveBeenCalledTimes(2);
  });

  it('reconciles pending permissions after reconnect', async () => {
    const { connect, openCodeApi } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      openCodeApi: { listPendingPermissions: vi.fn(async () => [{ id: 'pending', sessionID: 'root' }]) },
    });
    connect();
    await flush();
    expect(openCodeApi.replyPermission).toHaveBeenCalledWith(expect.objectContaining({ requestID: 'pending' }), { timeoutMs: 5000 });
  });

  it('accepts existing pending permissions when a session policy is enabled', async () => {
    const listPendingPermissions = vi.fn(async (directory) => directory === '/project'
      ? [
            { id: 'root-pending', sessionID: 'root' },
            { id: 'other-pending', sessionID: 'other' },
        ]
      : []);
    const { runtime, openCodeApi } = createRuntime({
      openCodeApi: {
        listPendingPermissions,
        getSession: vi.fn(async (sessionID) => ({ id: sessionID })),
      },
    });

    await runtime.setSessionPolicy('root', true, '/project');

    expect(openCodeApi.replyPermission).toHaveBeenCalledTimes(1);
    expect(openCodeApi.replyPermission).toHaveBeenCalledWith(expect.objectContaining({ requestID: 'root-pending' }), { timeoutMs: 5000 });
    expect(listPendingPermissions).toHaveBeenCalledWith('/project', { timeoutMs: 5000 });
    expect(await runtime.load()).toEqual({ sessions: { root: true }, revision: 1 });
  });

  it('leaves a request held by the safety net unanswered and forgets it once replied', async () => {
    const verdicts = { held: { action: 'hold', score: 0.9, kind: 'git_history' }, safe: { action: 'accept', score: 0.1 } };
    const evaluatePermission = vi.fn(async (permission) => verdicts[permission.id]);
    const onPermissionReplied = vi.fn();
    const { runtime, emit, openCodeApi } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
      evaluatePermission,
      onPermissionReplied,
    });
    await runtime.load();

    emit({ type: 'permission.asked', properties: { id: 'held', sessionID: 'root', permission: 'bash', metadata: {} } });
    emit({ type: 'permission.asked', properties: { id: 'safe', sessionID: 'root', permission: 'bash', metadata: {} } });
    await flush();

    expect(openCodeApi.replyPermission).toHaveBeenCalledTimes(1);
    expect(openCodeApi.replyPermission).toHaveBeenCalledWith(
      { sessionID: 'root', requestID: 'safe', directory: '/project', reply: 'once' },
      { timeoutMs: 5000 },
    );
    expect(evaluatePermission).toHaveBeenCalledTimes(2);

    emit({ type: 'permission.replied', properties: { sessionID: 'root', requestID: 'held', reply: 'once' } });
    expect(onPermissionReplied).toHaveBeenCalledWith('held');
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
