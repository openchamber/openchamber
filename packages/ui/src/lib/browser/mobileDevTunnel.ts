/**
 * Capacitor's local TCP listener for a remote dev-server preview.
 *
 * The iframe owns the HTTP origin and its WebSocket connections. Native code
 * only accepts loopback TCP bytes; this trusted renderer carries each stream
 * over the same authenticated dev-tunnel socket used by desktop, including
 * through the active end-to-end encrypted relay.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { z } from 'zod';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connect'), id: z.string(), connectionId: z.string() }),
  z.object({ type: z.literal('data'), id: z.string(), connectionId: z.string(), data: z.string().max(60_000) }),
  z.object({ type: z.literal('close'), id: z.string(), connectionId: z.string() }),
  // The listener itself is gone without a stop: iOS reclaims listening sockets
  // of a suspended app.
  z.object({ type: z.literal('stopped'), id: z.string() }),
]);

type Event = z.input<typeof eventSchema>;

interface MobileTunnelPlugin {
  start(options: { id: string }): Promise<{ localPort: number }>;
  stop(options: { id: string }): Promise<void>;
  ready(options: { id: string; connectionId: string }): Promise<void>;
  ack(options: { id: string; connectionId: string }): Promise<void>;
  send(options: { id: string; connectionId: string; data: string }): Promise<void>;
  close(options: { id: string; connectionId: string }): Promise<void>;
  isolatesFrames(): Promise<{ value: boolean }>;
  addListener(event: 'tunnelEvent', handler: (event: Event) => void): Promise<PluginListenerHandle>;
}

type Connection = { socket: RelayTunnelWebSocket | null; pendingBytes: number; writes: Promise<void> };
type Tunnel = { id: string; path: string; connections: Map<string, Connection>; onStopped: () => void };

const plugin = registerPlugin<MobileTunnelPlugin>('MobileDevTunnel');
const tunnels = new Map<string, Tunnel>();
let listener: Promise<PluginListenerHandle> | null = null;
/** Bumped by every close-all, so an open that started before it gives up. */
let generation = 0;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

const encode = (data: ArrayBuffer | string): string => {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new TextEncoder().encode(data);
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(result);
};

const closeConnection = (tunnel: Tunnel, id: string): void => {
  const connection = tunnel.connections.get(id);
  if (!connection) return;
  tunnel.connections.delete(id);
  connection.socket?.close();
  void plugin.close({ id: tunnel.id, connectionId: id }).catch(() => undefined);
};

const handleEvent = (raw: Event): void => {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return;
  const event = parsed.data;
  const tunnel = tunnels.get(event.id);
  if (!tunnel) return;
  if (event.type === 'stopped') {
    for (const connectionId of tunnel.connections.keys()) closeConnection(tunnel, connectionId);
    tunnels.delete(tunnel.id);
    tunnel.onStopped();
    return;
  }
  const connectionId = event.connectionId;
  if (event.type === 'close') {
    closeConnection(tunnel, connectionId);
    return;
  }
  if (event.type === 'data') {
    const connection = tunnel.connections.get(connectionId);
    if (!connection?.socket || connection.socket.readyState !== 1) {
      closeConnection(tunnel, connectionId);
      return;
    }
    try {
      const bytes = Uint8Array.from(atob(event.data), (value) => value.charCodeAt(0));
      connection.socket.send(bytes.buffer);
      void plugin.ack({ id: tunnel.id, connectionId }).catch(() => closeConnection(tunnel, connectionId));
    } catch {
      closeConnection(tunnel, connectionId);
    }
    return;
  }

  if (tunnel.connections.has(connectionId) || tunnel.connections.size >= 64) {
    void plugin.close({ id: tunnel.id, connectionId }).catch(() => undefined);
    return;
  }
  const connection: Connection = { socket: null, pendingBytes: 0, writes: Promise.resolve() };
  tunnel.connections.set(connectionId, connection);
  void (async () => {
    await refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl());
    if (tunnels.get(tunnel.id) !== tunnel || tunnel.connections.get(connectionId) !== connection) return;
    const socket = openRuntimeWebSocket(getRuntimeUrlResolver().websocket(tunnel.path));
    connection.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      void plugin.ready({ id: tunnel.id, connectionId }).catch(() => closeConnection(tunnel, connectionId));
    };
    socket.onmessage = (message) => {
      const data = message.data instanceof ArrayBuffer ? message.data : new TextEncoder().encode(message.data).buffer;
      connection.pendingBytes += data.byteLength;
      if (connection.pendingBytes > MAX_PENDING_BYTES) {
        closeConnection(tunnel, connectionId);
        return;
      }
      connection.writes = connection.writes.then(async () => {
        if (tunnel.connections.get(connectionId) !== connection) return;
        await plugin.send({ id: tunnel.id, connectionId, data: encode(data) });
      }).catch(() => closeConnection(tunnel, connectionId)).finally(() => {
        connection.pendingBytes -= data.byteLength;
      });
    };
    // The dev server's last bytes can still be queued for the native socket,
    // and a response that ends with the connection would lose its tail.
    const closeAfterWrites = () => void connection.writes.then(() => closeConnection(tunnel, connectionId));
    socket.onerror = closeAfterWrites;
    socket.onclose = closeAfterWrites;
  })().catch(() => closeConnection(tunnel, connectionId));
};

/**
 * Opens a phone-local listener for one remote dev-server port. `onStopped` runs
 * when the system takes the listener away, so the caller stops handing out its
 * port.
 */
export const openMobileDevTunnel = async (path: string, onStopped: () => void): Promise<number> => {
  const opened = generation;
  if (!listener) {
    listener = plugin.addListener('tunnelEvent', handleEvent).catch(() => {
      listener = null;
      throw new Error('Native dev-server bridge unavailable');
    });
  }
  await listener;
  // A runtime switch while the bridge attached must not leave a listener behind.
  if (opened !== generation) throw new Error('Runtime changed');
  const id = crypto.randomUUID();
  const tunnel: Tunnel = { id, path, connections: new Map(), onStopped };
  tunnels.set(id, tunnel);
  try {
    const result = await plugin.start({ id });
    if (tunnels.get(id) !== tunnel || !Number.isInteger(result.localPort) || result.localPort <= 0 || result.localPort > 65535) {
      throw new Error('Invalid native dev tunnel listener');
    }
    return result.localPort;
  } catch (error) {
    tunnels.delete(id);
    void plugin.stop({ id }).catch(() => undefined);
    throw error;
  }
};

/**
 * Whether native plugins are closed to the preview's frame. Android's Capacitor
 * opens them to every frame on an old WebView; the preview then shows no pages.
 */
export const previewFramesIsolated = (): Promise<boolean> => (
  plugin.isolatesFrames().then((result) => result.value === true, () => false)
);

export const closeMobileDevTunnels = (): void => {
  generation += 1;
  for (const tunnel of tunnels.values()) {
    for (const connectionId of tunnel.connections.keys()) closeConnection(tunnel, connectionId);
    void plugin.stop({ id: tunnel.id }).catch(() => undefined);
  }
  tunnels.clear();
};
