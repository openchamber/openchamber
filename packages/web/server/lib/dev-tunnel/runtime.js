/**
 * Raw byte tunnel to a dev server running on the OpenChamber host.
 *
 * This is what lets a desktop client preview a dev server that lives on another
 * machine without rewriting anything. The client binds its own local port and
 * pipes it here; the page is then served from a real origin at the root of its
 * own host, so absolute URLs, cookies, HMR sockets, and DevTools all behave
 * exactly as they do locally. No HTML is inspected or modified.
 *
 * Security posture: the reachable set is the same list dev-server discovery
 * offers the user, not "any loopback port". Without that restriction an
 * authenticated client could dial arbitrary local services on the host —
 * databases, admin panels, the OpenCode API — through this socket.
 *
 * Authentication differs from the browser-facing sockets on purpose. Those
 * demand an allowed `Origin`, which is a CSRF defence: a hostile page can make
 * a browser open a WebSocket carrying the user's ambient cookies, and the
 * origin is what exposes it. This tunnel's client is the desktop shell, not a
 * browser, and it authenticates with an explicit bearer token. So:
 *
 * - With an `Origin` header, the request came from a browser context and the
 *   usual origin check applies unchanged.
 * - With no `Origin`, the request must carry client-token auth or a short-lived
 *   URL token. The URL-token case is used only by the trusted renderer through
 *   the E2EE relay; the UI-auth allowlist limits it to this exact path.
 */
import net from 'node:net';
import { WebSocketServer } from 'ws';

const DEV_TUNNEL_WS_PATH = '/api/dev-tunnel';
/** One page load opens many sockets; the cap is per host, not per page. */
const MAX_CONCURRENT_SOCKETS = 64;
const CONNECT_TIMEOUT_MS = 5_000;
/**
 * Discovery offers a port bound to either loopback family, and `localhost`
 * resolves to `::1` first on many systems, so a dev server started with its
 * defaults may listen on IPv6 only. Dialing just `127.0.0.1` refused every
 * connection to such a server while the panel listed it as available.
 */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];
/** Bytes the page may send before the dev server connection is up. */
const MAX_PENDING_BYTES = 256 * 1024;

const parseRequestedPort = (url) => {
  try {
    const parsed = new URL(String(url || ''), 'http://localhost');
    if (parsed.pathname !== DEV_TUNNEL_WS_PATH) return null;
    const port = Number.parseInt(parsed.searchParams.get('port') || '', 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
};

export const isDevTunnelPath = (url) => {
  try {
    return new URL(String(url || ''), 'http://localhost').pathname === DEV_TUNNEL_WS_PATH;
  } catch {
    return false;
  }
};

export function createDevTunnelRuntime({
  server,
  discoverDevServers,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  logger = console,
}) {
  const wsServer = new WebSocketServer({ noServer: true });
  let openSockets = 0;

  /**
   * A port is reachable only while discovery still reports it. Re-checked on
   * every upgrade rather than cached, so a dev server that stops listening
   * stops being reachable.
   */
  const isAllowedPort = async (port) => {
    const result = await discoverDevServers();
    if (!result?.ok) return false;
    return result.servers.some((entry) => entry.port === port);
  };

  wsServer.on('connection', (socket, req) => {
    const port = parseRequestedPort(req.url);
    if (port === null) {
      socket.close(1008, 'Invalid port');
      return;
    }

    openSockets += 1;
    let upstream = null;
    let connected = false;
    let pendingWrites = [];
    let pendingBytes = 0;

    let settled = false;
    const teardown = () => {
      if (settled) return;
      settled = true;
      openSockets -= 1;
      clearTimeout(connectTimer);
      pendingWrites = [];
      try { upstream?.destroy(); } catch { /* already gone */ }
      try { socket.close(); } catch { /* already closing */ }
    };

    const connectTimer = setTimeout(() => {
      if (connected) return;
      logger.warn?.(`[dev-tunnel] timed out connecting to loopback port ${port}`);
      teardown();
    }, CONNECT_TIMEOUT_MS);

    const pipeUpstream = () => {
      upstream.on('data', (chunk) => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(chunk);
        // Stop reading from the dev server while the socket drains, otherwise a
        // fast response against a slow client buffers the whole body in memory.
        if (socket.bufferedAmount > 1_000_000) {
          upstream.pause();
          const resume = () => {
            if (socket.bufferedAmount > 1_000_000) {
              setTimeout(resume, 20);
              return;
            }
            upstream.resume();
          };
          setTimeout(resume, 20);
        }
      });
      upstream.on('error', teardown);
      upstream.on('close', teardown);
    };

    const dial = (hostIndex) => {
      const host = LOOPBACK_HOSTS[hostIndex];
      const candidate = net.connect({ host, port });
      upstream = candidate;
      candidate.setNoDelay(true);
      candidate.once('connect', () => {
        if (settled) return;
        connected = true;
        clearTimeout(connectTimer);
        candidate.removeAllListeners('error');
        pipeUpstream();
        for (const chunk of pendingWrites) candidate.write(chunk);
        pendingWrites = [];
        pendingBytes = 0;
      });
      candidate.once('error', (error) => {
        candidate.destroy();
        if (settled) return;
        if (hostIndex + 1 < LOOPBACK_HOSTS.length) {
          dial(hostIndex + 1);
          return;
        }
        logger.warn?.(`[dev-tunnel] could not connect to port ${port} on ${LOOPBACK_HOSTS.join(' or ')}: ${error?.code || error?.message || error}`);
        teardown();
      });
    };
    dial(0);

    socket.on('message', (data) => {
      if (settled) return;
      if (connected) {
        upstream.write(data);
        return;
      }
      pendingWrites.push(data);
      pendingBytes += data.length;
      if (pendingBytes > MAX_PENDING_BYTES) {
        logger.warn?.(`[dev-tunnel] dropped a connection that buffered too much before port ${port} answered`);
        teardown();
      }
    });
    socket.on('close', teardown);
    socket.on('error', teardown);
  });

  const upgradeHandler = (req, socket, head) => {
    if (!isDevTunnelPath(req.url)) return;
    const port = parseRequestedPort(req.url);
    // Every refusal is logged with its reason: the desktop only sees its local
    // connection close, which the panel cannot tell apart from a dev server
    // that is still starting. Never logs the URL, which may carry a token.
    const refuse = (status, reason) => {
      logger.warn?.(`[dev-tunnel] refused port ${port ?? 'unknown'}: ${reason}`);
      rejectWebSocketUpgrade(socket, status, reason);
    };
    void (async () => {
      try {
        if (uiAuthController?.enabled) {
          const auth = await uiAuthController.resolveAuthContext(req, null, { allowUrlToken: true });
          if (!auth) {
            refuse(401, 'UI authentication required');
            return;
          }
          const hasOrigin = typeof req.headers?.origin === 'string' && req.headers.origin.trim() !== '';
          if (hasOrigin) {
            if (!await isRequestOriginAllowed(req)) {
              refuse(403, 'Invalid origin');
              return;
            }
          } else if (auth.type !== 'client') {
            refuse(403, 'Client authentication required');
            return;
          }
        }

        if (port === null) {
          refuse(400, 'Invalid port');
          return;
        }
        if (openSockets >= MAX_CONCURRENT_SOCKETS) {
          refuse(503, 'Too many tunnel connections');
          return;
        }
        if (!await isAllowedPort(port)) {
          refuse(403, 'That port is not an available dev server');
          return;
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
      } catch (error) {
        logger.warn?.(`[dev-tunnel] upgrade for port ${port ?? 'unknown'} failed: ${error?.message || error}`);
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    })();
  };

  server.on('upgrade', upgradeHandler);

  return {
    path: DEV_TUNNEL_WS_PATH,
    get openSocketCount() {
      return openSockets;
    },
    dispose() {
      server.off('upgrade', upgradeHandler);
      wsServer.close();
    },
  };
}
