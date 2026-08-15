/**
 * Local end of the dev-server tunnel.
 *
 * Binds a loopback listener on this machine and pipes every connection to a
 * dev server on the OpenChamber host. The point of binding a real local port —
 * rather than serving the remote page under a path on some other origin — is
 * that the page then has its own origin at the root of its own host. Absolute
 * URLs resolve, cookies scope correctly, HMR sockets connect, and nothing has
 * to be rewritten.
 *
 * Lives in the web package because it needs a WebSocket client, which this
 * package already depends on; the desktop shell drives it over IPC.
 */
import net from 'node:net';
import { WebSocket } from 'ws';

/**
 * What one connection may buffer while its WebSocket is still connecting.
 *
 * Enough for a request with generous headers, far short of a body worth
 * holding: a local process could otherwise keep writing into a stalled
 * handshake and grow the desktop app's memory without limit.
 */
const MAX_PENDING_BYTES = 256 * 1024;
/** A handshake that has not completed by now is not going to. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

const toWebSocketUrl = (baseUrl, port) => {
  const parsed = new URL('/api/dev-tunnel', baseUrl);
  // WHATWG URL silently ignores a protocol assignment that crosses from a
  // non-special scheme (custom app protocols, relay-virtual URLs) to `ws:`.
  // Without this check the stale scheme survives into `new WebSocket(...)`,
  // which then throws inside the connection handler and takes the whole
  // process down; rejecting here fails the open() call cleanly instead.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`The remote base URL must be http(s); got "${parsed.protocol}"`);
  }
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.searchParams.set('port', String(port));
  return parsed.toString();
};

export const createDevTunnelClient = ({
  logger = console,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  maxPendingBytes = MAX_PENDING_BYTES,
} = {}) => {
  /** Keyed by `${baseUrl}|${remotePort}` so repeat opens reuse one listener. */
  const tunnels = new Map();

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
    /**
     * Opens (or reuses) a tunnel and resolves with the local port to browse.
     * Rejects if the listener cannot bind; per-connection failures close only
     * that connection, so one failed request cannot take the tunnel down.
     */
    async open({ baseUrl, port, headers = {} }) {
      const remotePort = Number.parseInt(String(port), 10);
      if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
        throw new Error('A valid remote port is required');
      }
      const base = String(baseUrl || '').trim();
      if (!base) throw new Error('A remote base URL is required');

      const key = `${base}|${remotePort}`;
      const existing = tunnels.get(key);
      if (existing) return { localPort: existing.localPort, reused: true };

      const target = toWebSocketUrl(base, remotePort);
      const sockets = new Set();

      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        sockets.add(socket);

        // A synchronous throw here would be an uncaught exception in the
        // connection handler and crash the process; one bad connection must
        // fail alone.
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
          // The local end was held back while there was nowhere to put its
          // bytes; there is somewhere now.
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
          // Bytes can arrive before the WebSocket handshake completes; buffering
          // them is what keeps the first HTTP request intact. The buffer is
          // bounded, and the local end is paused rather than trusted to stop.
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

      tunnels.set(key, { server, sockets, localPort, remotePort, baseUrl: base });
      return { localPort, reused: false };
    },

    close({ baseUrl, port }) {
      return closeTunnel(`${String(baseUrl || '').trim()}|${Number.parseInt(String(port), 10)}`);
    },

    /** Closes every tunnel; used when the desktop switches runtime or quits. */
    closeAll() {
      for (const key of [...tunnels.keys()]) closeTunnel(key);
    },

    list() {
      return [...tunnels.values()].map(({ localPort, remotePort, baseUrl }) => ({ localPort, remotePort, baseUrl }));
    },
  };
};
