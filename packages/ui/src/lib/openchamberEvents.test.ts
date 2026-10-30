import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { adoptRelayTunnel, deactivateRelayTunnel } from './relay/runtime-tunnel';
import type { RelayTunnelClient } from './relay/tunnel-client';
import { setRuntimeBearerToken, setRuntimeExtraHeaders } from './runtime-auth';

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

describe('openchamber events', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    Object.defineProperty(globalThis, 'window', {
      value: Object.assign(new EventTarget(), { location: new URL('http://runtime.test') }),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, configurable: true, writable: true });
  });

  afterEach(() => {
    deactivateRelayTunnel();
    setRuntimeBearerToken(null);
    setRuntimeExtraHeaders(null);
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'EventSource');
  });

  test('does not open the server-only event stream in VS Code', async () => {
    Object.defineProperty(window, '__VSCODE_CONFIG__', {
      value: { workspaceFolder: 'C:/repo', workspaceFolders: [] },
      configurable: true,
    });
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const unsubscribe = subscribeOpenchamberEvents(() => undefined);
    try {
      expect(MockEventSource.instances).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  test('native mobile sends proxy headers on the HTTP event stream and aborts on unsubscribe', async () => {
    Object.assign(window, { Capacitor: { isNativePlatform: () => true } });
    setRuntimeExtraHeaders({ 'X-Proxy': 'fixture-secret' });
    setRuntimeBearerToken('fixture-token');
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamSignal: AbortSignal | null | undefined;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get('X-Proxy')).toBe('fixture-secret');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token');
      streamSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          init?.signal?.addEventListener('abort', () => value.error(new DOMException('Aborted', 'AbortError')), { once: true });
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: string[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => events.push(event.type));
    try {
      for (let i = 0; i < 20 && !controller; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(MockEventSource.instances).toHaveLength(0);
      expect(controller).toBeDefined();
      controller?.enqueue(new TextEncoder().encode('data: {"type":"openchamber:event-stream-ready"}\n\n'));
      for (let i = 0; i < 20 && !events.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(['event-stream-ready']);
    } finally {
      unsubscribe();
      fetchSpy.mockRestore();
    }
    expect(streamSignal?.aborted).toBe(true);
  });

  test('desktop browser-capable events cross the active relay as streamed HTTP, not native EventSource', async () => {
    Object.defineProperty(window, '__OPENCHAMBER_ELECTRON__', { value: true, configurable: true });
    const requests: Array<{ path: string; authorization: string | null; signal: AbortSignal | undefined }> = [];
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const tunnel: RelayTunnelClient = {
      async fetch(input, init) {
        requests.push({
          path: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
          signal: init?.signal ?? undefined,
        });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      },
      openWebSocket() { throw new Error('SSE must not open a socket'); },
      getStatus: () => ({ state: 'connected' }),
      subscribeStatus: () => () => undefined,
      retry: () => undefined,
      close: () => undefined,
    };
    adoptRelayTunnel({ relayUrl: 'wss://relay.test', serverId: 'fixture', hostEncPubJwk: {} }, tunnel);
    setRuntimeBearerToken('fixture-token');
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: string[] = [];
    const browserRequests: Array<{ requestId: string; action: string }> = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      events.push(event.type);
      if (event.type === 'browser-control-request') {
        browserRequests.push({ requestId: event.requestId, action: event.action });
      }
    });
    try {
      for (let i = 0; i < 20 && requests.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      // A native EventSource cannot reach this tunnel: its mock has no forwarding path.
      expect(MockEventSource.instances).toHaveLength(0);
      expect(requests).toHaveLength(1);
      expect(requests[0].path).toBe('/api/openchamber/events?browser=1');
      expect(requests[0].authorization).toBe('Bearer fixture-token');
      streamController?.enqueue(encoder.encode('data: {"type":"openchamber:event-stream-ready"}\n\n'));
      streamController?.enqueue(encoder.encode('data: {"type":"openchamber:browser-control-'));
      // A complete browser request can be split across arbitrary transport chunks.
      streamController?.enqueue(encoder.encode('request","properties":{"requestId":"req-1","action":"browser.open","parameters":{}}}\n\n'));
      for (let i = 0; i < 20 && events.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(['event-stream-ready', 'browser-control-request']);
      expect(browserRequests).toEqual([{ requestId: 'req-1', action: 'browser.open' }]);
    } finally {
      unsubscribe();
    }
    expect(requests[0].signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['event-stream-ready', 'browser-control-request']);
  });

  test('declares browser control on the stream only from a driving host', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');

    const webUnsubscribe = subscribeOpenchamberEvents(() => undefined);
    try {
      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0].url).not.toContain('browser=1');
    } finally {
      webUnsubscribe();
    }

    Object.assign(window, { __OPENCHAMBER_ELECTRON__: true });
    const drivingUnsubscribe = subscribeOpenchamberEvents(() => undefined);
    try {
      expect(MockEventSource.instances).toHaveLength(2);
      expect(MockEventSource.instances[1].url).toContain('browser=1');
    } finally {
      drivingUnsubscribe();
    }
  });

  test('preserves scheduled task dispatch and legacy outcome statuses', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const statuses: string[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'scheduled-task-ran') statuses.push(event.status);
    });
    try {
      for (const status of ['running', 'sent', 'success', 'error']) {
        MockEventSource.instances[0].onmessage?.({
          data: JSON.stringify({
            type: 'openchamber:scheduled-task-ran',
            properties: { projectId: 'project_1', taskId: 'task_1', ranAt: 123, status },
          }),
        });
      }
      expect(statuses).toEqual(['running', 'sent', 'success', 'error']);
    } finally {
      unsubscribe();
    }
  });

  test('dispatches externally created session events', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => events.push(event));
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:session-created',
        properties: {
          sessionId: 'ses_123',
          directory: '/repo/worktrees/research',
          projectId: 'project_1',
          createdAt: 123,
          promptDispatched: true,
          dispatchedAsCommand: false,
        },
      }),
    });

    expect(events).toEqual([
      {
        type: 'session-created',
        sessionId: 'ses_123',
        directory: '/repo/worktrees/research',
        projectId: 'project_1',
        createdAt: 123,
        promptDispatched: true,
        dispatchedAsCommand: false,
      },
    ]);
    unsubscribe();
  });

  test('a connected control SSE stream clears delivered queues without reconnecting or polling', async () => {
    const { subscribeMessageQueueSync } = await import('@/sync/message-queue-sync');
    const { getRuntimeKey } = await import('./runtime-switch');
    const { useMessageQueueStore, createMessageQueueTarget, getMessageQueueKey } = await import('@/stores/messageQueueStore');
    const runtimeKey = getRuntimeKey();
    const target = createMessageQueueTarget('session-sse', '/repo', runtimeKey);
    if (!target) throw new Error('Missing queue target');
    useMessageQueueStore.getState().resetForRuntimeSwitch(runtimeKey);
    useMessageQueueStore.setState({ queuedMessages: {}, sendingIds: {} });
    const originalFetch = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
      if (url.pathname === '/api/message-queue') reads += 1;
      return Response.json({ revision: 1, sessions: [] });
    }, originalFetch);
    const unsubscribe = subscribeMessageQueueSync(runtimeKey);
    const source = MockEventSource.instances[0];
    try {
      source.onmessage?.({ data: JSON.stringify({ type: 'openchamber:event-stream-ready', properties: {} }) });
      await useMessageQueueStore.getState().hydrate();
      expect(reads).toBe(1);
      const session = { sessionId: target.sessionId, directory: target.directory, sendingId: 'q1', items: [{ id: 'q1', content: 'queued', text: 'queued', createdAt: 1, attachments: [], sendConfig: { providerID: 'p', modelID: 'm' } }] };
      source.onmessage?.({ data: JSON.stringify({ type: 'openchamber:message-queue.updated', properties: { revision: 2, session } }) });
      const key = getMessageQueueKey(target);
      expect(useMessageQueueStore.getState().queuedMessages[key]).toHaveLength(1);
      source.onmessage?.({ data: JSON.stringify({ type: 'openchamber:message-queue.updated', properties: { revision: 3, session: { ...session, items: [], sendingId: null } } }) });
      expect(useMessageQueueStore.getState().queuedMessages[key]).toBeUndefined();
      expect(useMessageQueueStore.getState().sendingIds[key]).toBeUndefined();
      expect(reads).toBe(1);
      expect(MockEventSource.instances).toHaveLength(1);
      unsubscribe();
      source.onmessage?.({ data: JSON.stringify({ type: 'openchamber:message-queue.updated', properties: { revision: 4, session } }) });
      expect(useMessageQueueStore.getState().queuedMessages[key]).toBeUndefined();
    } finally {
      unsubscribe();
      globalThis.fetch = originalFetch;
    }
  });

  test('the control SSE stream carries permission modes and requests left for the user, and rereads the modes on connect and when a space reconnects', async () => {
    // The permission store's imports read localStorage once a window exists.
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
      configurable: true,
    });
    const { subscribePermissionPolicySync } = await import('@/sync/permission-mode-sync');
    const { getRuntimeKey } = await import('./runtime-switch');
    const { usePermissionStore } = await import('@/stores/permissionStore');
    const waitFor = async (done: () => boolean) => {
      for (let i = 0; i < 50 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(done()).toBe(true);
    };
    usePermissionStore.getState().reset();
    const originalFetch = globalThis.fetch;
    let reads = 0;
    const spaceReads: string[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
      if (url.pathname !== '/api/permission-auto-accept') return new Response(null, { status: 404 });
      const directory = new Headers(input instanceof Request ? input.headers : init?.headers).get('x-opencode-directory');
      if (directory) {
        spaceReads.push(decodeURIComponent(directory));
        return Response.json({ sessions: {}, modes: {}, revision: 1 });
      }
      reads += 1;
      return Response.json({ sessions: { ses_1: true }, modes: { ses_1: 'auto' }, revision: 1 });
    }, originalFetch);
    const applied: Array<{ type: string; permissionId?: string }> = [];
    const unsubscribe = subscribePermissionPolicySync(getRuntimeKey(), (event) => {
      applied.push(event.type === 'openchamber.permission-left-for-user'
        ? { type: event.type, permissionId: event.properties.permissionId }
        : { type: event.type });
      if (event.type === 'openchamber.permission-auto-accept') {
        usePermissionStore.getState().applySnapshot({ modes: event.properties.modes ?? {}, revision: event.properties.revision });
      }
    });
    const source = MockEventSource.instances[0];
    const send = (data: string) => source.onmessage?.({ data });
    try {
      send(JSON.stringify({ type: 'openchamber:event-stream-ready', properties: {} }));
      await waitFor(() => usePermissionStore.getState().getSessionMode('ses_1') === 'auto');
      expect(reads).toBe(1);

      // Another window switched the session to Ask.
      send(JSON.stringify({ type: 'openchamber:permission-auto-accept.updated', properties: { sessions: { ses_1: false }, modes: { ses_1: 'ask' }, revision: 2 } }));
      expect(usePermissionStore.getState().getSessionMode('ses_1')).toBe('ask');

      send(JSON.stringify({ type: 'openchamber:permission-auto-accept.left-for-user', properties: { permissionId: 'per_1', sessionId: 'ses_1', directory: '/repo' } }));
      send(JSON.stringify({ type: 'openchamber:permission-auto-accept.left-for-user', properties: { sessionId: 'ses_1', directory: '/repo' } }));
      expect(applied).toEqual([
        { type: 'openchamber.permission-auto-accept' },
        { type: 'openchamber.permission-left-for-user', permissionId: 'per_1' },
      ]);

      // A reconnect reads the modes again: a change made during the gap was never announced here.
      send(JSON.stringify({ type: 'openchamber:event-stream-ready', properties: {} }));
      await waitFor(() => reads === 2);

      // The host follows a space's modes again: that space's modes are read from it.
      send(JSON.stringify({ type: 'openchamber:space-permission-stream', properties: { spaceId: '0123456789ab', status: 'connected' } }));
      await waitFor(() => spaceReads.length === 1);
      expect(spaceReads).toEqual(['/spaces/0123456789ab']);

      unsubscribe();
      send(JSON.stringify({ type: 'openchamber:permission-auto-accept.left-for-user', properties: { permissionId: 'per_2', sessionId: 'ses_1', directory: '/repo' } }));
      expect(applied).toHaveLength(2);
    } finally {
      unsubscribe();
      globalThis.fetch = originalFetch;
      usePermissionStore.getState().reset();
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  test('an expired session stops the stream from reconnecting until the user logs in', async () => {
    const { useAuthSessionStore } = await import('./runtime-auth-expiry');
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const unsubscribe = subscribeOpenchamberEvents(() => undefined);
    try {
      expect(MockEventSource.instances).toHaveLength(1);
      useAuthSessionStore.getState().markExpired();
      MockEventSource.instances[0].onerror?.();
      // The first reconnect would come after one second.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(MockEventSource.instances).toHaveLength(1);

      useAuthSessionStore.getState().markAuthenticated();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(MockEventSource.instances).toHaveLength(2);
    } finally {
      unsubscribe();
      useAuthSessionStore.getState().markAuthenticated();
    }
  });

  test('a stream left while waiting for the login does not reconnect after it', async () => {
    const { useAuthSessionStore } = await import('./runtime-auth-expiry');
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const unsubscribe = subscribeOpenchamberEvents(() => undefined);
    try {
      useAuthSessionStore.getState().markExpired();
      MockEventSource.instances[0].onerror?.();
      unsubscribe();
      useAuthSessionStore.getState().markAuthenticated();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(MockEventSource.instances).toHaveLength(1);
    } finally {
      unsubscribe();
      useAuthSessionStore.getState().markAuthenticated();
    }
  });

  test('dispatches worktree topology changes', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => events.push(event));
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:worktree-changed',
        properties: { directories: ['/repo', '/repo-linked'], at: 456 },
      }),
    });
    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:worktree-changed',
        properties: { directories: [], at: 789 },
      }),
    });

    expect(events).toEqual([
      { type: 'worktree-changed', directories: ['/repo', '/repo-linked'], changedAt: 456 },
    ]);
    unsubscribe();
  });

  test('dispatches a project-context invalidation only with a valid owner id', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const owners: string[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'project-context-changed') owners.push(event.projectId);
    });
    try {
      for (const properties of [{ projectId: 'path_chats' }, {}, { projectId: '' }, { projectId: 42 }]) {
        MockEventSource.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'openchamber:project-context-changed', properties }),
        });
      }
      expect(owners).toEqual(['path_chats']);
    } finally {
      unsubscribe();
    }
  });

  test('dispatches a chat-folder change only with its stored revision', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const revisions: number[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'session-folders-changed') revisions.push(event.updatedAt);
    });
    try {
      for (const properties of [{ updatedAt: 42 }, {}, { updatedAt: 'later' }]) {
        MockEventSource.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'openchamber:session-folders-changed', properties }),
        });
      }
      expect(revisions).toEqual([42]);
    } finally {
      unsubscribe();
    }
  });

  test('dispatches an agent file-open request and drops one without a path', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => events.push(event));
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:file-open-request',
        properties: { path: '/repo/out/report.csv', directory: '/repo', sessionId: null },
      }),
    });
    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:file-open-request',
        properties: { directory: '/repo', sessionId: 'ses_1' },
      }),
    });

    expect(events).toEqual([
      { type: 'file-open-request', path: '/repo/out/report.csv', directory: '/repo', sessionId: null },
    ]);
    unsubscribe();
  });

  test('dispatches an agent plan-open request and drops one without a plan id', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => events.push(event));
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:plan-open-request',
        properties: { projectId: 'path_repo', planId: 'p1', title: 'Plan', directory: '/repo', sessionId: 'ses_1' },
      }),
    });
    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:plan-open-request',
        properties: { projectId: 'path_repo', title: 'Plan', directory: '/repo', sessionId: null },
      }),
    });

    expect(events).toEqual([
      { type: 'plan-open-request', projectId: 'path_repo', planId: 'p1', title: 'Plan', directory: '/repo', sessionId: 'ses_1' },
    ]);
    unsubscribe();
  });
});
