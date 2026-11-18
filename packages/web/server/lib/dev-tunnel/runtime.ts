import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';
import type { DevTunnelRuntimeOptions } from './contracts.js';

const DEV_TUNNEL_WS_PATH = '/api/dev-tunnel';
const MAX_CONCURRENT_SOCKETS = 64;
const CONNECT_TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];
const MAX_PENDING_BYTES = 256 * 1024;

const isOriginHeader = (value: unknown): value is string => typeof value === 'string';
const hasErrorMessage = (value: unknown): value is { message?: unknown } => value != null;

const parseRequestedPort = (url: string | undefined) => {
  try {
    const parsed = new URL(String(url || ''), 'http://localhost');
    if (parsed.pathname !== DEV_TUNNEL_WS_PATH) return null;
    const port = Number.parseInt(parsed.searchParams.get('port') || '', 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
};

export const isDevTunnelPath = (url: string | undefined) => {
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
}: DevTunnelRuntimeOptions) {
  const wsServer = new WebSocketServer<Buffer>({ noServer: true });
  let openSockets = 0;

  const isAllowedPort = async (port: number) => {
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
    let upstream: net.Socket;
    let connected = false;
    let pendingWrites: Buffer[] = [];
    let pendingBytes = 0;

    let settled = false;
    const teardown = () => {
      if (settled) return;
      settled = true;
      openSockets -= 1;
      clearTimeout(connectTimer);
      pendingWrites = [];
      try { upstream?.destroy(); } catch { void 0; }
      try { socket.close(); } catch { void 0; }
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

    const dial = (hostIndex: number) => {
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
      candidate.once('error', (error: NodeJS.ErrnoException) => {
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

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isDevTunnelPath(req.url)) return;
    const port = parseRequestedPort(req.url);
    const refuse = (status: number, reason: string) => {
      logger.warn?.(`[dev-tunnel] refused port ${port ?? 'unknown'}: ${reason}`);
      rejectWebSocketUpgrade(socket, status, reason);
    };
    void (async () => {
      try {
        if (isOpaqueOriginRequest(req)) {
          refuse(403, 'Invalid origin');
          return;
        }
        if (!uiAuthController?.enabled && !await isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed)) {
          refuse(403, 'Invalid origin');
          return;
        }
        if (uiAuthController?.enabled) {
          const auth = await uiAuthController.resolveAuthContext(req, null, { allowUrlToken: true });
          if (!auth) {
            refuse(401, 'UI authentication required');
            return;
          }
          const hasOrigin = isOriginHeader(req.headers?.origin) && req.headers.origin.trim() !== '';
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
        logger.warn?.(`[dev-tunnel] upgrade for port ${port ?? 'unknown'} failed: ${hasErrorMessage(error) && error.message || error}`);
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
