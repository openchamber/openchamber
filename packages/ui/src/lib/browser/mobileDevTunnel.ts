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
]);

type Event = z.input<typeof eventSchema>;

interface MobileTunnelPlugin {
  start(options: { id: string }): Promise<{ localPort: number }>;
  stop(options: { id: string }): Promise<void>;
  ready(options: { id: string; connectionId: string }): Promise<void>;
  ack(options: { id: string; connectionId: string }): Promise<void>;
  send(options: { id: string; connectionId: string; data: string }): Promise<void>;
  close(options: { id: string; connectionId: string }): Promise<void>;
  addListener(event: 'tunnelEvent', handler: (event: Event) => void): Promise<PluginListenerHandle>;
}

type Connection = { socket: RelayTunnelWebSocket | null; pendingBytes: number; writes: Promise<void> };
type Tunnel = { id: string; path: string; connections: Map<string, Connection> };

const plugin = registerPlugin<MobileTunnelPlugin>('MobileDevTunnel');
const tunnels = new Map<string, Tunnel>();
let listener: Promise<PluginListenerHandle> | null = null;
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
    socket.onerror = () => closeConnection(tunnel, connectionId);
    socket.onclose = () => closeConnection(tunnel, connectionId);
  })().catch(() => closeConnection(tunnel, connectionId));
};

export const openMobileDevTunnel = async (path: string): Promise<number> => {
  if (!listener) {
    listener = plugin.addListener('tunnelEvent', handleEvent).catch(() => {
      listener = null;
      throw new Error('Native dev-server bridge unavailable');
    });
  }
  await listener;
  const id = crypto.randomUUID();
  const tunnel: Tunnel = { id, path, connections: new Map() };
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

export const closeMobileDevTunnels = (): void => {
  for (const tunnel of tunnels.values()) {
    for (const connectionId of tunnel.connections.keys()) closeConnection(tunnel, connectionId);
    void plugin.stop({ id: tunnel.id }).catch(() => undefined);
  }
  tunnels.clear();
};
