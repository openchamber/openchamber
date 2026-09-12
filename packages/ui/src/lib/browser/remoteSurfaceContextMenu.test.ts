import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { RemoteSurfaceClient } from './remoteSurface';
import { RemoteSurfaceContextMenu } from './remoteSurfaceContextMenu';

type ServerEvent =
  | { readonly type: 'attached'; readonly session: { readonly id: string; readonly directory: string };
    readonly tabs: readonly { readonly id: string; readonly url?: string }[] }
  | { readonly type: 'state'; readonly tabId: string; readonly attachmentRequestId: string;
    readonly lease: { readonly actor: 'user' }; readonly controlling: boolean }
  | { readonly type: 'contextMenuResult'; readonly requestId: string; readonly tabId: string;
    readonly attachmentRequestId: string; readonly status: string };

class ContextSocket implements RelayTunnelWebSocket {
  readyState = 1;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string | ArrayBuffer | ArrayBufferView): void { this.sent.push(String(data)); }
  close(): void { this.readyState = 3; }
  receive(data: ServerEvent): void { this.onmessage?.({ data: JSON.stringify(data) }); }
}

const requestSchema = z.object({
  type: z.literal('contextMenu'), requestId: z.string(), tabId: z.string(),
  attachmentRequestId: z.string(), x: z.number(), y: z.number(),
});
const clients: RemoteSurfaceClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.stop(); });

const attachedClient = async () => {
  const socket = new ContextSocket();
  const client = new RemoteSurfaceClient({ directory: '/project', sessionId: 'session',
    refreshAuthToken: async () => undefined, resolveSocketUrl: () => 'ws://runtime/api/browser-surface',
    openSocket: () => socket });
  clients.push(client);
  await client.start();
  socket.receive({ type: 'attached', session: { id: 'session', directory: '/project' },
    tabs: [{ id: 'sc:one', url: 'https://example.test' }, { id: 'sc:two' }] });
  const attachment = z.object({ requestId: z.string() }).parse(JSON.parse(socket.sent.at(-1) ?? 'null'));
  socket.receive({ type: 'state', tabId: 'sc:one', attachmentRequestId: attachment.requestId,
    lease: { actor: 'user' }, controlling: true });
  socket.sent.length = 0;
  return { client, socket };
};

describe('remote context menu exchange', () => {
  for (const status of ['menu', 'page-handled', 'unavailable'] as const) {
    test(`returns ${status} only for the current correlated attachment`, async () => {
      // Given a completed page attachment and one context request.
      const { client, socket } = await attachedClient();
      const result = client.contextMenu.request({ x: 120, y: 80 });
      const request = requestSchema.parse(JSON.parse(socket.sent.at(-1) ?? 'null'));
      let resolved = false;
      void result.then(() => { resolved = true; });
      socket.receive({ ...request, type: 'contextMenuResult', attachmentRequestId: 'old', status: 'menu' });
      await Promise.resolve();
      expect(resolved).toBe(false);
      // When the server replies with the matching identity.
      socket.receive({ ...request, type: 'contextMenuResult', status });
      // Then the server decision is preserved without a guessed fallback.
      expect(await result).toBe(status);
      expect(socket.sent).toHaveLength(1);
    });
  }

  for (const change of ['tab', 'navigation', 'disconnect', 'dismissal'] as const) {
    test(`discards a delayed menu after ${change}`, async () => {
      // Given one in-flight menu request.
      const { client, socket } = await attachedClient();
      const result = client.contextMenu.request({ x: 120, y: 80 });
      const request = requestSchema.parse(JSON.parse(socket.sent.at(-1) ?? 'null'));
      // When its input scope changes before the reply.
      switch (change) {
        case 'tab': client.attachTab('sc:two'); break;
        case 'navigation': client.navigate('https://example.test/next'); break;
        case 'disconnect': client.stop(); break;
        case 'dismissal': client.contextMenu.cancel(); break;
      }
      socket.receive({ ...request, type: 'contextMenuResult', status: 'menu' });
      // Then the old request cannot open a menu in the new scope.
      expect(await result).toBe('cancelled');
    });
  }

  test('cancels the previous request when a later click supersedes it', async () => {
    // Given two successive context clicks on the same page.
    const { client, socket } = await attachedClient();
    const first = client.contextMenu.request({ x: 1, y: 2 });
    const old = requestSchema.parse(JSON.parse(socket.sent.at(-1) ?? 'null'));
    const second = client.contextMenu.request({ x: 3, y: 4 });
    const current = requestSchema.parse(JSON.parse(socket.sent.at(-1) ?? 'null'));
    // When replies arrive out of order.
    socket.receive({ ...old, type: 'contextMenuResult', status: 'menu' });
    socket.receive({ ...current, type: 'contextMenuResult', status: 'page-handled' });
    // Then only the last click owns a decision.
    expect(await first).toBe('cancelled');
    expect(await second).toBe('page-handled');
  });

  test('keeps malformed server status from opening a fallback menu', async () => {
    const { client, socket } = await attachedClient();
    const result = client.contextMenu.request({ x: 1, y: 2 });
    const request = requestSchema.parse(JSON.parse(socket.sent.at(-1) ?? 'null'));
    let resolved = false;
    void result.then(() => { resolved = true; });

    socket.receive({ ...request, type: 'contextMenuResult', status: 'invalid' });
    await Promise.resolve();

    expect(resolved).toBe(false);
    client.contextMenu.cancel();
    expect(await result).toBe('cancelled');
  });

  test('reports unavailable after a response deadline without assuming a menu', async () => {
    const exchange = new RemoteSurfaceContextMenu(() => true, 0);
    exchange.setAttachment({ tabId: 'sc:page', attachmentRequestId: 'attachment' });

    const result = await exchange.request({ x: 1, y: 2 });

    expect(result).toBe('unavailable');
  });

  test('does not dispatch after its client stops', async () => {
    const { client, socket } = await attachedClient();
    client.stop();

    const result = await client.contextMenu.request({ x: 1, y: 2 });

    expect(result).toBe('unavailable');
    expect(socket.sent).toEqual([]);
  });
});
