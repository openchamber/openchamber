import React from 'react';
import { act, useEffect, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';
import { z } from 'zod';

import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { RemoteSurfaceClient } from './remoteSurface';

class FakeSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];
  closeCount = 0;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(String(data));
  }

  close(code = 1000, reason = ''): void {
    this.closeCount += 1;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(payload: { readonly type: 'hello' }): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const Harness = ({ client }: { readonly client: RemoteSurfaceClient }) => {
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  useEffect(() => {
    void client.start();
    return () => client.stop();
  }, [client]);
  return <output data-phase={state.phase} />;
};

test('survives StrictMode setup-cleanup-setup with only the latest socket', async () => {
  const dom = new Window({ url: 'http://localhost/' });
  const domGlobals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    Event: dom.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previousGlobals = Object.keys(domGlobals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  Object.assign(globalThis, domGlobals);

  const sockets: FakeSocket[] = [];
  const authResolvers: Array<() => void> = [];
  const client = new RemoteSurfaceClient({
    directory: '/project',
    refreshAuthToken: () => new Promise<void>((resolve) => authResolvers.push(resolve)),
    resolveSocketUrl: () => 'ws://runtime/api/browser-surface?directory=%2Fproject',
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);

  try {
    await act(async () => {
      root.render(
        <React.StrictMode>
          <Harness client={client} />
        </React.StrictMode>,
      );
      await Promise.resolve();
    });

    expect(authResolvers).toHaveLength(2);
    authResolvers[1]?.();
    await act(async () => Promise.resolve());
    expect(sockets).toHaveLength(1);

    const currentSocket = sockets[0];
    if (!currentSocket) throw new Error('Expected the current socket');
    await act(async () => {
      currentSocket.open();
      currentSocket.message({ type: 'hello' });
    });
    expect(currentSocket.sent.map((message) => JSON.parse(message))).toEqual([{ type: 'list' }]);

    authResolvers[0]?.();
    await act(async () => Promise.resolve());
    expect(sockets).toHaveLength(1);

    await act(async () => {
      currentSocket.onmessage?.({
        data: JSON.stringify({
          type: 'attached',
          session: { id: 'session-1', directory: '/project' },
          tabs: [{ id: 'sc:target-1' }],
        }),
      });
      const { requestId } = z.object({ type: z.literal('attachTab'), requestId: z.string() })
        .parse(JSON.parse(currentSocket.sent.at(-1) ?? 'null'));
      currentSocket.onmessage?.({ data: JSON.stringify({ type: 'state', tabId: 'sc:target-1',
        attachmentRequestId: requestId, lease: { actor: 'user' } }) });
    });
    expect(host.querySelector('output')?.getAttribute('data-phase')).toBe('attached');
    expect(client.getState().activeTabId).toBe('sc:target-1');

    await act(async () => root.unmount());
    expect(currentSocket.closeCount).toBe(1);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

for (const transition of ['restart', 'reconnect'] as const) {
  test(`keeps a pending frame ACK on its original connection after ${transition}`, async () => {
    // Given a real client whose first frame is still rendering.
    const sockets: FakeSocket[] = [];
    const reconnects: Array<() => void> = [];
    const pendingRenders: Array<() => void> = [];
    const renderedSequences: number[] = [];
    const client = new RemoteSurfaceClient({
      directory: '/project',
      refreshAuthToken: async () => undefined,
      resolveSocketUrl: () => 'ws://runtime/api/browser-surface?directory=%2Fproject',
      openSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      schedule: (callback) => { reconnects.push(callback); },
    });
    client.setFrameHandler((header) => {
      renderedSequences.push(header.frameSeq);
      if (header.frameSeq === 1) {
        return new Promise<void>((resolve) => { pendingRenders.push(resolve); });
      }
    });
    const receiveFrame = (socket: FakeSocket, frameSeq: number): void => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'frame', frameSeq, streamGen: 1, tabId: 'sc:target',
          width: 320, height: 180, scale: 1,
        }),
      });
      socket.onmessage?.({ data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer });
    };

    try {
      await client.start();
      const previousSocket = sockets[0];
      if (!previousSocket) throw new Error('Expected the original socket');
      previousSocket.open();
      receiveFrame(previousSocket, 1);
      await Promise.resolve();
      expect(pendingRenders).toHaveLength(1);
      expect(previousSocket.sent).toEqual([]);

      // When a fresh connection receives a frame before the old render completes.
      if (transition === 'restart') {
        client.stop();
        await client.start();
      } else {
        previousSocket.close(1006, 'connection lost');
        expect(reconnects).toHaveLength(1);
        reconnects[0]?.();
        await Promise.resolve();
      }
      const currentSocket = sockets[1];
      if (!currentSocket) throw new Error('Expected a replacement socket');
      currentSocket.open();
      receiveFrame(currentSocket, 2);
      await Promise.resolve();
      await Promise.resolve();

      // Then the new stream progresses independently, and late work stays stale.
      expect(renderedSequences).toEqual([1, 2]);
      expect(currentSocket.sent).toEqual([JSON.stringify({ type: 'frameAck', frameSeq: 2 })]);
      pendingRenders[0]?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(previousSocket.sent).toEqual([]);
      expect(currentSocket.sent).toEqual([JSON.stringify({ type: 'frameAck', frameSeq: 2 })]);
    } finally {
      client.stop();
    }
  });
}
