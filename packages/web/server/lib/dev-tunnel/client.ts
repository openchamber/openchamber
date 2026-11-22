import net from 'node:net';
import { WebSocket } from 'ws';
import type { WebSocket as TunnelWebSocket } from '../shared/websocket-contracts.js';
import type { DevTunnel, DevTunnelClientOptions, DevTunnelInfo, DevTunnelOpenOptions, DevTunnelOpenResult, DevTunnelTarget } from './contracts.js';

const MAX_PENDING_BYTES = 256 * 1024;
/**
 * What one piping direction may run ahead of a stalled peer after connect.
 * Past this the producer is paused until the peer drains, matching the host
 * end's existing rule in runtime.js: without it a fast producer against a
 * slow consumer buffers the whole stream in this process's memory.
 */
const MAX_BUFFERED_BYTES = 1_000_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

const SPACE_ID = /^[0-9a-f]{12}$/;

const hasErrorMessage = (value: unknown): value is { message?: unknown } => value != null;
const isPipeAddress = (value: net.AddressInfo | string): value is string => typeof value === 'string';

const toWebSocketUrl = (baseUrl: string, port: number, spaceId: string | null) => {
  const parsed = new URL('/api/dev-tunnel', baseUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`The remote base URL must be http(s); got "${parsed.protocol}"`);
  }
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.searchParams.set('port', String(port));
  if (spaceId) parsed.searchParams.set('directory', `/spaces/${spaceId}`);
  return parsed.toString();
};

export const createDevTunnelClient = ({
  logger = console,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  maxPendingBytes = MAX_PENDING_BYTES,
}: DevTunnelClientOptions = {}) => {
  const tunnels = new Map<string, DevTunnel>();
  const tunnelKey = (baseUrl: string, remotePort: number, spaceId: string | null) => `${baseUrl}|${spaceId ?? ''}|${remotePort}`;

  const closeTunnel = (key: string) => {
    const tunnel = tunnels.get(key);
    if (!tunnel) return false;
    tunnels.delete(key);
    for (const socket of tunnel.sockets) {
      try { socket.destroy(); } catch { void 0; }
    }
    try { tunnel.server.close(); } catch { void 0; }
    return true;
  };

  return {
    async open({ baseUrl, port, headers = {}, spaceId = null }: DevTunnelOpenOptions): Promise<DevTunnelOpenResult> {
      const rawPort = String(port).trim();
      const remotePort = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
      if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
        throw new Error('A valid remote port is required');
      }
      const base = String(baseUrl || '').trim();
      if (!base) throw new Error('A remote base URL is required');
      if (spaceId !== null && !SPACE_ID.test(String(spaceId))) throw new Error('A valid space id is required');

      const key = tunnelKey(base, remotePort, spaceId);
      const existing = tunnels.get(key);
      if (existing) return { localPort: existing.localPort, reused: true };

      const target = toWebSocketUrl(base, remotePort, spaceId);
      const sockets = new Set<net.Socket>();

      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        sockets.add(socket);

        let upstream: TunnelWebSocket<Buffer>;
        try {
          // maxPayload matches the host end's frame bound (#1082): the host
          // forwards dev-server socket reads, whose chunks are far below
          // MAX_BUFFERED_BYTES, so a larger single frame is never legitimate
          // tunnel traffic — refuse it instead of assembling it whole.
          upstream = new WebSocket(target, { headers, perMessageDeflate: false, maxPayload: MAX_BUFFERED_BYTES });
        } catch (error) {
          logger.warn?.(`[dev-tunnel] failed to dial upstream for port ${remotePort}: ${hasErrorMessage(error) && error.message || error}`);
          sockets.delete(socket);
          try { socket.destroy(); } catch { void 0; }
          return;
        }
        upstream.binaryType = 'nodebuffer';
        let pendingWrites: Buffer[] = [];
        let pendingBytes = 0;
        let waitingForLocalDrain = false;
        let waitingForUpstreamDrain = false;

        const handshakeTimer = setTimeout(() => {
          logger.warn?.(`[dev-tunnel] handshake timed out for port ${remotePort}`);
          teardown();
        }, handshakeTimeoutMs);

        function teardown() {
          clearTimeout(handshakeTimer);
          pendingWrites = [];
          pendingBytes = 0;
          sockets.delete(socket);
          try { socket.destroy(); } catch { void 0; }
          try { upstream.close(); } catch { void 0; }
        }

        upstream.on('open', () => {
          clearTimeout(handshakeTimer);
          for (const chunk of pendingWrites) upstream.send(chunk);
          pendingWrites = [];
          pendingBytes = 0;
          socket.resume();
        });
        upstream.on('message', (data) => {
          if (socket.destroyed) return;
          if (!socket.write(data) && !waitingForLocalDrain) {
            // The local consumer is behind: stop the WebSocket reads until
            // the socket drains instead of buffering the stream in memory.
            waitingForLocalDrain = true;
            upstream.pause();
            socket.once('drain', () => {
              waitingForLocalDrain = false;
              upstream.resume();
            });
          }
        });
        upstream.on('error', (error) => {
          logger.warn?.(`[dev-tunnel] upstream failed for port ${remotePort}: ${error?.message || error}`);
          teardown();
        });
        upstream.on('close', teardown);

        socket.on('data', (chunk) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(chunk);
            if (upstream.bufferedAmount > MAX_BUFFERED_BYTES && !waitingForUpstreamDrain) {
              // The host is behind: stop reading the local end while the
              // WebSocket drains, the mirror of the guard above.
              waitingForUpstreamDrain = true;
              socket.pause();
              const resume = () => {
                if (socket.destroyed || upstream.readyState !== WebSocket.OPEN) return;
                if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) {
                  setTimeout(resume, 20);
                  return;
                }
                waitingForUpstreamDrain = false;
                socket.resume();
              };
              setTimeout(resume, 20);
            }
            return;
          }
          if (upstream.readyState !== WebSocket.CONNECTING) return;

          pendingWrites.push(chunk);
          pendingBytes += chunk.length;
          if (pendingBytes > maxPendingBytes) {
            logger.warn?.(`[dev-tunnel] dropped a connection that buffered too much for port ${remotePort}`);
            teardown();
            return;
          }
          socket.pause();
        });
        socket.on('error', teardown);
        socket.on('close', teardown);
      });

      const localPort = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          const address = server.address();
          if (!address || isPipeAddress(address)) {
            reject(new Error('Failed to bind a local tunnel port'));
            return;
          }
          resolve(address.port);
        });
      });

      server.on('error', (error) => {
        logger.warn?.(`[dev-tunnel] listener error for port ${remotePort}: ${error?.message || error}`);
      });

      tunnels.set(key, { server, sockets, localPort, remotePort, baseUrl: base, spaceId });
      return { localPort, reused: false };
    },

    close({ baseUrl, port, spaceId = null }: DevTunnelTarget) {
      const rawPort = String(port).trim();
      const remotePort = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
      return closeTunnel(tunnelKey(String(baseUrl || '').trim(), remotePort, spaceId));
    },

    closeAll() {
      for (const key of [...tunnels.keys()]) closeTunnel(key);
    },

    list(): DevTunnelInfo[] {
      return [...tunnels.values()].map(({ localPort, remotePort, baseUrl, spaceId }) => ({ localPort, remotePort, baseUrl, spaceId }));
    },
  };
};
