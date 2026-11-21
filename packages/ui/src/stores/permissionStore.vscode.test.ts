import { beforeEach, describe, expect, test } from 'bun:test';
import { directoryEnvironment } from './test-support/directoryEnvironment';

const environment = directoryEnvironment({ vscode: true, home: '/home/test' });
let reconcileDirectory: string | undefined;
let reconcileShouldFail = false;
const replies: string[] = [];
let requestId = 0;
environment.respond(async (url, init) => {
  if (url.pathname.startsWith('/api/permission-auto-accept/')) {
    const body = JSON.parse(String(init?.body));
    return Response.json({ sessions: { root: body.enabled === true } });
  }
  if (url.pathname === '/api/permission/request') {
    reconcileDirectory = decodeURIComponent(new Headers(init?.headers).get('x-opencode-directory') ?? '');
    if (reconcileShouldFail) throw new Error('offline');
    return Response.json({ data: [{
      id: `permission-${requestId}`, sessionID: 'root', permission: 'bash', patterns: ['echo hello'], metadata: {}, always: [],
    }] });
  }
  if (url.pathname.startsWith('/api/session/root/permission/')) {
    replies.push(url.pathname);
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/home/test', chatsRoot: '/home/test/chats' });
  if (url.pathname === '/api/location' || url.pathname === '/api/session') return Response.json({}, { status: 401 });
  throw new Error(`Unexpected request: ${url}`);
});
const { opencodeClient } = await import('@/lib/opencode/client');
const { useConfigStore } = await import('./useConfigStore');
const { usePermissionStore } = await import('./permissionStore');

describe('permission store VS Code policy', () => {
  beforeEach(() => {
    reconcileDirectory = undefined;
    reconcileShouldFail = false;
    requestId += 1;
    replies.length = 0;
    opencodeClient.setDirectory('/repo');
    useConfigStore.setState({ isConnected: true });
    usePermissionStore.getState().reset();
  });

  test('reconciles existing pending requests after enabling auto-accept', async () => {
    await usePermissionStore.getState().setSessionMode('root', 'auto');
    await environment.settle();
    expect(usePermissionStore.getState().modes).toEqual({ root: 'auto' });
    expect(reconcileDirectory).toBe('/repo');
    expect(replies).toEqual([`/api/session/root/permission/permission-${requestId}/reply`]);
  });

  test('does not reconcile when disabling auto-accept', async () => {
    await usePermissionStore.getState().setSessionMode('root', 'ask');
    await environment.settle();
    expect(reconcileDirectory).toBeUndefined();
    expect(replies).toEqual([]);
  });

  test('keeps a persisted toggle successful when pending reconciliation fails', async () => {
    reconcileShouldFail = true;
    await usePermissionStore.getState().setSessionMode('root', 'auto');
    await environment.settle();
    expect(reconcileDirectory).toBe('/repo');
    expect(usePermissionStore.getState().modes).toEqual({ root: 'auto' });
  });
});
