import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { RemoteSurfaceClient } from './remoteSurface';
import { RemoteSurfaceInspectorError } from './remoteSurfaceInspector';

const commandSchema = z.object({
  type: z.string(), requestId: z.string().optional(), tabId: z.string().optional(),
  captureId: z.string().optional(), expression: z.string().optional(),
});
const attachmentIdSchema = z.string().min(1).max(128);

class InspectorSocket implements RelayTunnelWebSocket {
  readyState = 1;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(z.string().parse(data));
  }
  close(): void { this.readyState = 3; }
  receive(data: string): void { this.onmessage?.({ data }); }
  commands() { return this.sent.map((data) => commandSchema.parse(JSON.parse(data))); }
}

const attach = async () => {
  const socket = new InspectorSocket();
  const client = new RemoteSurfaceClient({
    directory: '/inspector-fixture', openSocket: () => socket,
    refreshAuthToken: async () => undefined,
    resolveSocketUrl: () => 'ws://fixture/api/browser-surface',
  });
  await client.start();
  socket.receive(JSON.stringify({ type: 'attached',
    session: { id: 'session-1', directory: '/inspector-fixture' },
    tabs: [{ id: 'sc:one' }, { id: 'sc:two' }],
  }));
  socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:one', lease: null,
    attachmentRequestId: socket.commands().at(-1)?.requestId }));
  return { socket, client };
};

const capture = async () => {
  const harness = await attach();
  harness.client.inspector.setOpen(true);
  const requestId = harness.socket.commands().at(-1)?.requestId;
  harness.socket.receive(JSON.stringify({ type: 'inspectorStarted', requestId,
    tabId: 'sc:one', captureId: 'capture-1' }));
  return harness;
};

const log = (id: string) => ({ id, timestamp: 1, level: 'log', text: `Message ${id}`,
  source: '', line: null, truncated: false });
const network = (id: string) => ({ id, timestamp: 1, method: 'GET',
  url: 'https://fixture.test/data', resourceType: 'Fetch', status: null, statusText: '',
  mimeType: '', durationMs: null, encodedBytes: null, state: 'pending', failureText: null,
  fromCache: false });

describe('remote inspector lifecycle', () => {
  test('waits for the selected tab attachment before accepting lease state or starting capture', async () => {
    const { client, socket } = await capture();
    try {
      client.attachTab('sc:two');
      const request = socket.commands().at(-1);
      for (const state of [
        { tabId: 'sc:one' }, { tabId: null }, {}, { tabId: 'sc:two' },
        { tabId: 'sc:two', attachmentRequestId: 'superseded' },
      ]) {
        socket.receive(JSON.stringify({ type: 'state', lease: { actor: 'agent' }, ...state }));
        expect(client.getState().phase).toBe('attaching');
        expect(client.getState().agentControlling).toBe(false);
        expect(client.inspector.getState().tabId).toBeNull();
        expect(client.sendKey({ eventType: 'keydown', key: 'Enter' })).toBe(false);
        expect(client.captureInputScope()()).toBe(false);
      }
      expect(socket.commands().filter((command) => command.type === 'inspectorStart')).toHaveLength(1);
      expect(attachmentIdSchema.safeParse(request?.requestId).success).toBe(true);
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:two', attachmentRequestId: request?.requestId,
        lease: { actor: 'agent' } }));
      expect(client.getState().phase).toBe('attached');
      expect(client.getState().agentControlling).toBe(true);
      expect(socket.commands().at(-1)?.type).toBe('inspectorStart');
      expect(socket.commands().at(-1)?.tabId).toBe('sc:two');
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:two', lease: { actor: 'user' } }));
      expect(client.getState().agentControlling).toBe(false);
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:one', lease: { actor: 'agent' } }));
      expect(client.getState().agentControlling).toBe(false);
    } finally { client.stop(); }
  });

  test('rejects earlier confirmations when reattaching the same tab or switching away and back', async () => {
    const { client, socket } = await attach();
    try {
      const first = socket.commands().at(-1)?.requestId;
      client.attachTab('sc:one');
      const sameTab = socket.commands().at(-1)?.requestId;
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:one', attachmentRequestId: first, lease: null }));
      expect(client.getState().phase).toBe('attaching');
      expect(attachmentIdSchema.safeParse(sameTab).success).toBe(true);
      expect(sameTab).not.toBe(first);
      client.attachTab('sc:two');
      const otherTab = socket.commands().at(-1)?.requestId;
      client.attachTab('sc:one');
      const latest = socket.commands().at(-1)?.requestId;
      for (const confirmation of [
        { tabId: 'sc:one', attachmentRequestId: sameTab },
        { tabId: 'sc:two', attachmentRequestId: otherTab },
        { tabId: 'sc:one' },
      ]) {
        socket.receive(JSON.stringify({ type: 'state', lease: null, ...confirmation }));
        expect(client.getState().phase).toBe('attaching');
      }
      expect(new Set([first, sameTab, otherTab, latest]).size).toBe(4);
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:one', attachmentRequestId: latest, lease: null }));
      expect(client.getState().phase).toBe('attached');
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:one', attachmentRequestId: sameTab, lease: { actor: 'agent' } }));
      expect(client.getState().agentControlling).toBe(false);
    } finally { client.stop(); }
  });

  test('keeps input and capture detached while a new tab is being created', async () => {
    const { client, socket } = await capture();
    try {
      const initial = socket.commands().find((command) => command.type === 'attachTab')?.requestId;
      client.createTab();
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:one', attachmentRequestId: initial, lease: null }));
      expect(client.getState().phase).toBe('attaching');
      expect(client.inspector.getState().tabId).toBeNull();
      expect(client.sendText('stale input')).toBe(false);
      socket.receive(JSON.stringify({ type: 'tabs', tabs: [{ id: 'sc:new' }], activeTabId: 'sc:new' }));
      const requestId = socket.commands().at(-1)?.requestId;
      expect(attachmentIdSchema.safeParse(requestId).success).toBe(true);
      expect(requestId).not.toBe(initial);
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:new', attachmentRequestId: requestId, lease: null }));
      expect(client.getState().phase).toBe('attached');
      expect(socket.commands().at(-1)?.tabId).toBe('sc:new');
    } finally { client.stop(); }
  });

  test('requires a fresh confirmation before enabling the fallback after a missing tab', async () => {
    const { client, socket } = await capture();
    try {
      client.attachTab('sc:two');
      const failedRequest = socket.commands().at(-1)?.requestId;
      socket.receive(JSON.stringify({ type: 'error', code: 'TAB_NOT_FOUND', message: 'Tab is gone' }));
      const fallback = socket.commands().at(-1);
      expect(fallback?.type).toBe('attachTab');
      expect(fallback?.tabId).toBe('sc:one');
      expect(attachmentIdSchema.safeParse(fallback?.requestId).success).toBe(true);
      expect(fallback?.requestId).not.toBe(failedRequest);
      expect(client.getState().phase).toBe('attaching');
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:two', attachmentRequestId: failedRequest, lease: null }));
      expect(client.getState().phase).toBe('attaching');
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:one', attachmentRequestId: fallback?.requestId, lease: null }));
      expect(client.getState().phase).toBe('attached');
      expect(socket.commands().at(-1)?.type).toBe('inspectorStart');
    } finally { client.stop(); }
  });

  test('ignores an older session join while waiting for the explicitly requested session', async () => {
    const { client, socket } = await capture();
    try {
      client.attachSession('session-a');
      client.attachSession('session-b');
      const commandCount = socket.commands().length;
      socket.receive(JSON.stringify({ type: 'attached', session: { id: 'session-a', directory: '/inspector-fixture' },
        tabs: [{ id: 'sc:old-session' }] }));
      expect(client.getState().session).toBeNull();
      expect(client.getState().activeTabId).toBeNull();
      expect(client.getState().phase).toBe('attaching');
      expect(client.inspector.getState().tabId).toBeNull();
      expect(socket.commands()).toHaveLength(commandCount);
      socket.receive(JSON.stringify({ type: 'attached', session: { id: 'session-b', directory: '/inspector-fixture' },
        tabs: [{ id: 'sc:current-session' }] }));
      const requestId = socket.commands().at(-1)?.requestId;
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:current-session', attachmentRequestId: requestId, lease: null }));
      expect(client.getState().phase).toBe('attached');
      expect(client.getState().session?.id).toBe('session-b');
      client.createSession();
      socket.receive(JSON.stringify({ type: 'created', session: { id: 'session-created', directory: '/inspector-fixture' },
        tabs: [{ id: 'sc:created-session' }] }));
      expect(client.getState().session?.id).toBe('session-created');
      expect(socket.commands().at(-1)?.tabId).toBe('sc:created-session');
    } finally { client.stop(); }
  });

  test('does not let a superseded session creation replace an explicit session attachment', async () => {
    const { client, socket } = await capture();
    try {
      client.createSession();
      client.attachSession('session-b');
      const commandCount = socket.commands().length;
      socket.receive(JSON.stringify({ type: 'created', session: { id: 'session-created', directory: '/inspector-fixture' },
        tabs: [{ id: 'sc:superseded' }] }));
      expect(client.getState().session).toBeNull();
      expect(client.getState().activeTabId).toBeNull();
      expect(socket.commands()).toHaveLength(commandCount);
      socket.receive(JSON.stringify({ type: 'attached', session: { id: 'session-b', directory: '/inspector-fixture' },
        tabs: [{ id: 'sc:current' }] }));
      expect(client.getState().session?.id).toBe('session-b');
      const requestId = socket.commands().at(-1)?.requestId;
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:current', attachmentRequestId: requestId, lease: null }));
      client.createSession();
      const creatingCount = socket.commands().length;
      socket.receive(JSON.stringify({ type: 'attached', session: { id: 'session-b', directory: '/inspector-fixture' },
        tabs: [{ id: 'sc:current' }] }));
      expect(client.getState().phase).toBe('attaching');
      expect(socket.commands()).toHaveLength(creatingCount);
      socket.receive(JSON.stringify({ type: 'created', session: { id: 'session-new', directory: '/inspector-fixture' },
        tabs: [{ id: 'sc:new' }] }));
      expect(client.getState().session?.id).toBe('session-new');
    } finally { client.stop(); }
  });

  test('starts capture only when the attached viewer opens the inspector', async () => {
    // Given an attached viewer with no open inspector.
    const { client, socket } = await attach();
    try {
      expect(socket.commands().some((command) => command.type === 'inspectorStart')).toBe(false);
      // When the viewer opens the inspector.
      client.inspector.setOpen(true);
      // Then capture starts for exactly the attached tab.
      expect(socket.commands().at(-1)?.type).toBe('inspectorStart');
      expect(socket.commands().at(-1)?.tabId).toBe('sc:one');
      expect(client.inspector.getState().phase).toBe('starting');
    } finally { client.stop(); }
  });

  test('discards capture and cancels evaluation when the viewer switches tabs', async () => {
    const { client, socket } = await capture();
    const evaluation = client.inspector.evaluate('document.title');
    const outcome = evaluation.then(() => 'resolved',
      (error) => error instanceof RemoteSurfaceInspectorError ? error.code : 'other');
    const requestId = socket.commands().at(-1)?.requestId;
    try {
      client.attachTab('sc:two');

      expect(await outcome).toBe('CANCELLED');
      expect(socket.commands().some((command) => command.type === 'inspectorStop'
        && command.tabId === 'sc:one' && command.captureId === 'capture-1')).toBe(true);
      socket.receive(JSON.stringify({ type: 'inspectorEvaluated', tabId: 'sc:one',
        captureId: 'capture-1', requestId, text: 'old document', isError: false, truncated: false }));
      expect(client.inspector.getState().captureId).toBeNull();
      expect(client.inspector.getState().tabId).toBeNull();
      expect(client.inspector.getState().console).toHaveLength(0);
      socket.receive(JSON.stringify({ type: 'state', tabId: 'sc:two', lease: null,
        attachmentRequestId: socket.commands().filter((command) => command.type === 'attachTab').at(-1)?.requestId }));
      expect(socket.commands().at(-1)?.type).toBe('inspectorStart');
      expect(socket.commands().at(-1)?.tabId).toBe('sc:two');
    } finally { client.stop(); }
  });

  test('cancels pending startup when the panel closes before capture is acknowledged', async () => {
    const { client, socket } = await attach();
    client.inspector.setOpen(true);
    const requestId = socket.commands().at(-1)?.requestId;
    try {
      client.inspector.setOpen(false);

      expect(socket.commands().at(-1)?.type).toBe('inspectorStop');
      expect(socket.commands().at(-1)?.tabId).toBe('sc:one');
      socket.receive(JSON.stringify({ type: 'inspectorStarted', tabId: 'sc:one',
        captureId: 'late-capture', requestId }));
      expect(client.inspector.getState().phase).toBe('closed');
      expect(client.inspector.getState().captureId).toBeNull();
      expect(client.inspector.getState().open).toBe(false);
    } finally { client.stop(); }
  });

  test('publishes console batches without notifying viewport subscribers', async () => {
    const { client, socket } = await capture();
    let viewportNotifications = 0;
    let inspectorNotifications = 0;
    client.subscribe(() => { viewportNotifications += 1; });
    client.inspector.subscribe(() => { inspectorNotifications += 1; });
    try {
      socket.receive(JSON.stringify({ type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture-1',
        console: [log('first')], network: [], droppedConsole: 0, droppedNetwork: 0 }));

      expect(viewportNotifications).toBe(0);
      expect(inspectorNotifications).toBe(1);
      expect(client.inspector.getState().console[0]?.text).toBe('Message first');
    } finally { client.stop(); }
  });

  test('retains the last valid capture when an event is malformed or belongs to another capture', async () => {
    const { client, socket } = await capture();
    try {
      socket.receive(JSON.stringify({ type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture-1',
        console: [log('first')], network: [], droppedConsole: 0, droppedNetwork: 0 }));
      const before = client.inspector.getState();

      for (const captureId of ['capture-1', 'foreign']) socket.receive(JSON.stringify({
        type: 'inspectorEvents', tabId: 'sc:one', captureId,
        console: [captureId === 'foreign' ? log('foreign') : { ...log('bad'), level: 'invalid' }],
        network: [], droppedConsole: 0, droppedNetwork: 0,
      }));

      expect(client.inspector.getState()).toBe(before);
    } finally { client.stop(); }
  });

  test('updates a network row in place when the response completes', async () => {
    const { client, socket } = await capture();
    try {
      socket.receive(JSON.stringify({ type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture-1',
        console: [], network: [network('request')], droppedConsole: 0, droppedNetwork: 0 }));

      socket.receive(JSON.stringify({ type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture-1',
        console: [], network: [{ ...network('request'), status: 200, state: 'complete', durationMs: 42 }],
        droppedConsole: 0, droppedNetwork: 0 }));

      expect(client.inspector.getState().network).toHaveLength(1);
      expect(client.inspector.getState().network[0]?.status).toBe(200);
      expect(client.inspector.getState().network[0]?.state).toBe('complete');
      expect(client.inspector.getState().network[0]?.durationMs).toBe(42);
    } finally { client.stop(); }
  });

  test('caps console rows during a thousand-message burst and reports dropped entries', async () => {
    const { client, socket } = await capture();
    try {
      for (let offset = 0; offset < 1000; offset += 25) socket.receive(JSON.stringify({
        type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture-1', network: [],
        console: Array.from({ length: 25 }, (_, index) => log(String(offset + index))),
        droppedConsole: 0, droppedNetwork: 0,
      }));

      expect(client.inspector.getState().console).toHaveLength(300);
      expect(client.inspector.getState().console.at(-1)?.id).toBe('999');
      expect(client.inspector.getState().droppedConsole).toBe(700);
    } finally { client.stop(); }
  });

  test('returns evaluation results only for the correlated request', async () => {
    const { client, socket } = await capture();
    const evaluation = client.inspector.evaluate('({ count: 42 })');
    const requestId = socket.commands().at(-1)?.requestId;
    try {
      socket.receive(JSON.stringify({ type: 'inspectorEvaluated', tabId: 'sc:one', captureId: 'capture-1',
        requestId, text: '{count: 42}', isError: false, truncated: false }));

      const result = await evaluation;
      expect(result.text).toBe('{count: 42}');
      expect(result.isError).toBe(false);
    } finally { client.stop(); }
  });

  test('clears only the requested stream after the server acknowledges the clear', async () => {
    const { client, socket } = await capture();
    socket.receive(JSON.stringify({ type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture-1',
      console: [log('first')], network: [network('request')], droppedConsole: 0, droppedNetwork: 0 }));
    client.inspector.clear('console');
    const requestId = socket.commands().at(-1)?.requestId;
    try {
      socket.receive(JSON.stringify({ type: 'inspectorCleared', tabId: 'sc:one', captureId: 'capture-1',
        requestId, scope: 'console' }));

      expect(client.inspector.getState().console).toHaveLength(0);
      expect(client.inspector.getState().network).toHaveLength(1);
    } finally { client.stop(); }
  });

  test('cancels evaluation when the attached page begins navigating', async () => {
    const { client, socket } = await capture();
    const evaluation = client.inspector.evaluate('delayedValue');
    const requestId = socket.commands().at(-1)?.requestId;
    const outcome = evaluation.then(() => 'resolved',
      (error) => error instanceof RemoteSurfaceInspectorError ? error.code : 'other');
    try {
      socket.receive(JSON.stringify({ type: 'navigation', tabId: 'sc:one',
        url: 'https://fixture.test/next', title: 'Next', canGoBack: true, canGoForward: false, isLoading: true }));
      socket.receive(JSON.stringify({ type: 'inspectorEvaluated', tabId: 'sc:one', captureId: 'capture-1',
        requestId, text: 'old page', isError: false, truncated: false }));

      expect(await outcome).toBe('CANCELLED');
      expect(client.inspector.getState().captureId).toBe('capture-1');
    } finally { client.stop(); }
  });
});
