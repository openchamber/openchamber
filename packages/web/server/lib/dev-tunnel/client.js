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
/**
 * What one piping direction may run ahead of a stalled peer after connect.
 * Past this the producer is paused until the peer drains, matching the host
 * end's existing rule in runtime.js: without it a fast producer against a
 * slow consumer buffers the whole stream in this process's memory.
 */
const MAX_BUFFERED_BYTES = 1_000_000;
/** A handshake that has not completed by now is not going to. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

const SPACE_ID = /^[0-9a-f]{12}$/;

/**
 * The host's own tunnel, or the one of an isolated space on that host: a
 * tunnel that names the space's root as its `directory` is forwarded by the
 * host to the server inside the space, which dials the port on its own
 * loopback, the space's.
 */
const toWebSocketUrl = (baseUrl, port, spaceId) => {
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
  if (spaceId) parsed.searchParams.set('directory', `/spaces/${spaceId}`);
  return parsed.toString();
};

export const createDevTunnelClient = ({
  logger = console,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  maxPendingBytes = MAX_PENDING_BYTES,
} = {}) => {
  /** Keyed by base URL, space and remote port, so repeat opens reuse one listener. */
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
    /**
     * Opens (or reuses) a tunnel and resolves with the local port to browse.
     * Rejects if the listener cannot bind; per-connection failures close only
     * that connection, so one failed request cannot take the tunnel down.
     */
    async open({ baseUrl, port, headers = {}, spaceId = null }) {
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
      const sockets = new Set();

      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        sockets.add(socket);

        // A synchronous throw here would be an uncaught exception in the
        // connection handler and crash the process; one bad connection must
        // fail alone.
        let upstream;
        try {
          // maxPayload matches the host end's frame bound (#1082): the host
          // forwards dev-server socket reads, whose chunks are far below
          // MAX_BUFFERED_BYTES, so a larger single frame is never legitimate
          // tunnel traffic — refuse it instead of assembling it whole.
          upstream = new WebSocket(target, { headers, perMessageDeflate: false, maxPayload: MAX_BUFFERED_BYTES });
        } catch (error) {
          logger.warn?.(`[dev-tunnel] failed to dial upstream for port ${remotePort}: ${error?.message || error}`);
          sockets.delete(socket);
          try { socket.destroy(); } catch { /* already gone */ }
          return;
        }
        upstream.binaryType = 'nodebuffer';
        let pendingWrites = [];
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
          // Bytes can arrive before the WebSocket handshake completes; buffering
          // them is what keeps the first HTTP request intact. The buffer is
          // bounded, and the local end is paused rather than trusted to stop.
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
      const rawPort = String(port).trim();
      const remotePort = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
      return closeTunnel(tunnelKey(String(baseUrl || '').trim(), remotePort, spaceId));
    },

    /** Closes every tunnel; used when the desktop switches runtime or quits. */
    closeAll() {
      for (const key of [...tunnels.keys()]) closeTunnel(key);
    },

    list() {
      return [...tunnels.values()].map(({ localPort, remotePort, baseUrl, spaceId }) => ({ localPort, remotePort, baseUrl, spaceId }));
    },
  };
};
