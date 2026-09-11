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
    const upstream = net.connect({ host: '127.0.0.1', port });
    upstream.setNoDelay(true);

    let settled = false;
    const teardown = () => {
      if (settled) return;
      settled = true;
      openSockets -= 1;
      try { upstream.destroy(); } catch { /* already gone */ }
      try { socket.close(); } catch { /* already closing */ }
    };

    const connectTimer = setTimeout(() => {
      if (!upstream.connecting) return;
      logger.warn?.(`[dev-tunnel] timed out connecting to 127.0.0.1:${port}`);
      teardown();
    }, CONNECT_TIMEOUT_MS);

    upstream.on('connect', () => clearTimeout(connectTimer));
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
    upstream.on('error', () => { clearTimeout(connectTimer); teardown(); });
    upstream.on('close', () => { clearTimeout(connectTimer); teardown(); });

    socket.on('message', (data) => {
      if (upstream.destroyed) return;
      upstream.write(data);
    });
    socket.on('close', teardown);
    socket.on('error', teardown);
  });

  const upgradeHandler = (req, socket, head) => {
    if (!isDevTunnelPath(req.url)) return;
    void (async () => {
      try {
        if (uiAuthController?.enabled) {
          const auth = await uiAuthController.resolveAuthContext(req, null, { allowUrlToken: true });
          if (!auth) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }
          const hasOrigin = typeof req.headers?.origin === 'string' && req.headers.origin.trim() !== '';
          if (hasOrigin) {
            if (!await isRequestOriginAllowed(req)) {
              rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
              return;
            }
          } else if (auth.type !== 'client') {
            rejectWebSocketUpgrade(socket, 403, 'Client authentication required');
            return;
          }
        }

        const port = parseRequestedPort(req.url);
        if (port === null) {
          rejectWebSocketUpgrade(socket, 400, 'Invalid port');
          return;
        }
        if (openSockets >= MAX_CONCURRENT_SOCKETS) {
          rejectWebSocketUpgrade(socket, 503, 'Too many tunnel connections');
          return;
        }
        if (!await isAllowedPort(port)) {
          // Says which port, because the alternative is an empty response in
          // the panel with nothing anywhere explaining why.
          logger.warn?.(`[dev-tunnel] refused port ${port}: not reported by dev-server discovery`);
          rejectWebSocketUpgrade(socket, 403, 'That port is not an available dev server');
          return;
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
      } catch {
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
