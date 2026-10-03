import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { adoptRelayTunnel, deactivateRelayTunnel } from './relay/runtime-tunnel';
import type { RelayTunnelClient } from './relay/tunnel-client';
import { setRuntimeBearerToken } from './runtime-auth';

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
});
