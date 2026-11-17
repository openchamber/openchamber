import net from 'node:net';
import { WebSocket } from 'ws';

const MAX_PENDING_BYTES = 256 * 1024;
const HANDSHAKE_TIMEOUT_MS = 15_000;

const SPACE_ID = /^[0-9a-f]{12}$/;

const toWebSocketUrl = (baseUrl, port, spaceId) => {
  const parsed = new URL('/api/dev-tunnel', baseUrl);
  // external: https://url.spec.whatwg.org/#url-scheme-state Protocol assignment cannot cross from a non-special app scheme to ws; reject before opening a connection.
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
} = {}) => {
  const tunnels = new Map();
  const tunnelKey = (baseUrl, remotePort, spaceId) => `${baseUrl}|${spaceId ?? ''}|${remotePort}`;

  const closeTunnel = (key) => {
    const tunnel = tunnels.get(key);
    if (!tunnel) return false;
    tunnels.delete(key);
    for (const socket of tunnel.sockets) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    try { tunnel.server.close(); } catch { /* already closing */ }
    return true;
  };

  return {
    async open({ baseUrl, port, headers = {}, spaceId = null }) {
      const remotePort = Number.parseInt(String(port), 10);
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
      const sockets = new Set();

      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        sockets.add(socket);

        let upstream;
        try {
          upstream = new WebSocket(target, { headers, perMessageDeflate: false });
        } catch (error) {
          logger.warn?.(`[dev-tunnel] failed to dial upstream for port ${remotePort}: ${error?.message || error}`);
          sockets.delete(socket);
          try { socket.destroy(); } catch { /* already gone */ }
          return;
        }
        upstream.binaryType = 'nodebuffer';
        let pendingWrites = [];
        let pendingBytes = 0;

        const handshakeTimer = setTimeout(() => {
          logger.warn?.(`[dev-tunnel] handshake timed out for port ${remotePort}`);
          teardown();
        }, handshakeTimeoutMs);

        function teardown() {
          clearTimeout(handshakeTimer);
          pendingWrites = [];
          pendingBytes = 0;
          sockets.delete(socket);
          try { socket.destroy(); } catch { /* already gone */ }
          try { upstream.close(); } catch { /* already closing */ }
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
          socket.write(data);
        });
        upstream.on('error', (error) => {
          logger.warn?.(`[dev-tunnel] upstream failed for port ${remotePort}: ${error?.message || error}`);
          teardown();
        });
        upstream.on('close', teardown);

        socket.on('data', (chunk) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(chunk);
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

      const localPort = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          const address = server.address();
          if (!address || typeof address === 'string') {
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

    close({ baseUrl, port, spaceId = null }) {
      return closeTunnel(tunnelKey(String(baseUrl || '').trim(), Number.parseInt(String(port), 10), spaceId));
    },

    closeAll() {
      for (const key of [...tunnels.keys()]) closeTunnel(key);
    },

    list() {
      return [...tunnels.values()].map(({ localPort, remotePort, baseUrl, spaceId }) => ({ localPort, remotePort, baseUrl, spaceId }));
    },
  };
};
