import { describe, expect, test } from 'bun:test';

import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';

import { SurfaceClient, type SurfaceConnectionState, type SurfaceControlState, type SurfaceFrame } from './surface-client';

class FakeSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: RelayTunnelWebSocket['onmessage'] = null;
  onerror: (() => void) | null = null;
  onclose: RelayTunnelWebSocket['onclose'] = null;
  sent: string[] = [];

  open(): void { this.readyState = 1; this.onopen?.(); }
  text(message: object): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  binary(bytes: Uint8Array): void { this.onmessage?.({ data: bytes.slice().buffer }); }
  send(data: string | ArrayBuffer | ArrayBufferView): void { this.sent.push(String(data)); }
  close(): void { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const createClient = () => {
  const sockets: FakeSocket[] = [];
  const frames: SurfaceFrame[] = [];
  const controls: SurfaceControlState[] = [];
  const connections: SurfaceConnectionState[] = [];
  const clipboard: Array<{ id: string; text: string }> = [];
  let cleared = 0;
  const client = new SurfaceClient('sim', {
    onFrame: (frame) => frames.push(frame),
    onControl: (state) => controls.push(state),
    onConnection: (state) => connections.push(state),
    onClipboard: (id, text) => clipboard.push({ id, text }),
  }, {
    refreshAuth: async () => 'token',
    clearUrlAuthToken: () => { cleared += 1; },
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    isPaused: () => false,
    onWake: () => () => undefined,
  });
  return { client, sockets, frames, controls, connections, clipboard, clearedCount: () => cleared };
};

describe('surface client', () => {
  test('pairs a frame header with the binary that follows and acknowledges on request', async () => {
    const { client, sockets, frames, connections } = createClient();
    client.start();
    await tick();
    const socket = sockets[0];
    socket.open();
    expect(connections).toEqual([{ status: 'connecting' }, { status: 'open' }]);

    socket.text({ type: 'hello', viewerId: 'v1' });
    socket.text({ type: 'frame', seq: 3, width: 320, height: 200, mime: 'image/png', bytes: 3, agentActive: true, title: 'Home' });
    expect(frames).toHaveLength(0);
    socket.binary(new Uint8Array([1, 2, 3]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ seq: 3, width: 320, height: 200, mime: 'image/png', agentActive: true, title: 'Home' });
    expect(new Uint8Array(frames[0].bytes)).toEqual(new Uint8Array([1, 2, 3]));

    // A stray binary with no header is dropped, not paired with an old one.
    socket.binary(new Uint8Array([9]));
    expect(frames).toHaveLength(1);

    client.ack(3);
    expect(socket.sent).toEqual([JSON.stringify({ type: 'ack', seq: 3 })]);
    client.dispose();
  });

  test('mirrors control, clipboard, and input; ignores messages that are not the contract', async () => {
    const { client, sockets, controls, clipboard } = createClient();
    client.start();
    await tick();
    const socket = sockets[0];
    socket.open();
    socket.text({ type: 'control', controller: 'user', mine: true });
    socket.text({ type: 'clipboard', id: 'c1', text: 'hello' });
    socket.text({ type: 'control', controller: 'bogus', mine: true });
    socket.onmessage?.({ data: 'not json' });
    expect(controls).toEqual([{ controller: 'user', mine: true }]);
    expect(clipboard).toEqual([{ id: 'c1', text: 'hello' }]);

    const key = { type: 'key' as const, action: 'down' as const, key: 'a', code: 'KeyA', modifiers: { alt: false, ctrl: false, meta: false, shift: false } };
    expect(client.sendInput([key])).toBe(true);
    expect(client.sendInput([])).toBe(false);
    client.release();
    client.resize(800, 600);
    client.requestClipboard('c2');
    expect(socket.sent.map((raw) => JSON.parse(raw).type)).toEqual(['input', 'release', 'resize', 'clipboard-read']);
    client.dispose();
  });

  test('an ended session stops reconnecting until the user retries; a refused open clears the URL token', async () => {
    const { client, sockets, connections, clearedCount } = createClient();
    client.start();
    await tick();
    sockets[0].open();
    sockets[0].text({ type: 'ended', reason: 'service-stopped' });
    expect(connections.at(-1)).toEqual({ status: 'ended', reason: 'service-stopped' });
    sockets[0].close();
    await tick();
    expect(sockets).toHaveLength(1);

    client.retry();
    await tick();
    expect(sockets).toHaveLength(2);
    expect(connections.at(-1)).toEqual({ status: 'connecting' });
    // Closed before it ever opened: the token is dropped and a reconnect is scheduled.
    sockets[1].close();
    expect(clearedCount()).toBe(1);
    expect(connections.at(-1)).toEqual({ status: 'reconnecting', attempt: 1 });
    client.dispose();
  });
});
