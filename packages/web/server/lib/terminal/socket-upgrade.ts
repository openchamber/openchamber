import { TERMINAL_WS_PATH, parseRequestPathname } from './terminal-ws-protocol.js';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RequestOriginChecker } from '../security/request-security.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type { createTunnelAuth } from '../tunnels/tunnel-auth.js';
import type { WebSocketServer as TerminalWebSocketServer } from '../shared/websocket-contracts.js';

const hasErrorFields = (value: unknown): value is { message?: unknown; code?: unknown } => value != null;

export interface TerminalSocketUpgradeOptions {
  getWebSocketServer: () => TerminalWebSocketServer | null;
  uiAuthController?: Pick<ReturnType<typeof createUiAuth>, 'enabled' | 'ensureSessionToken'> | null | undefined;
  tunnelAuthController?: Pick<ReturnType<typeof createTunnelAuth>, 'classifyRequestScope' | 'getActiveTunnelOrigin' | 'getTunnelSessionFromRequest' | 'bindTunnelSession'> | undefined;
  isRequestOriginAllowed: RequestOriginChecker;
  rejectWebSocketUpgrade(socket: Duplex, code: number, reason: string): void;
  logger?: { warn?: typeof console.warn } | undefined;
}

export const createTerminalSocketUpgradeHandler = ({
  getWebSocketServer,
  uiAuthController,
  tunnelAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  logger = console,
}: TerminalSocketUpgradeOptions) => {
  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (parseRequestPathname(req.url) !== TERMINAL_WS_PATH) return;
    const tunnelScope = () => Boolean(tunnelAuthController && tunnelAuthController.classifyRequestScope(req) !== 'local');
    let lane: 'credential' | 'local' | 'tunnel' = 'credential';
    const logUpgradeFailure = ({ error }: { error: unknown }) => {
      logger.warn?.(`[terminal] websocket upgrade failed: ${(hasErrorFields(error) && error.message) || error}`);
    };
    const accept = () => {
      const acceptingServer = getWebSocketServer();
      if (!acceptingServer) { rejectWebSocketUpgrade(socket, 500, 'Terminal WebSocket unavailable'); return; }
      try {
        if (socket.destroyed) return;
        const needsTunnelSession = lane === 'tunnel';
        if (lane !== 'credential' && needsTunnelSession !== tunnelScope()) { rejectWebSocketUpgrade(socket, 401, 'Authentication changed'); return; }
        if (needsTunnelSession && req.headers.origin !== tunnelAuthController?.getActiveTunnelOrigin()) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return;
        }
        if (needsTunnelSession && !tunnelAuthController?.getTunnelSessionFromRequest(req)) {
          rejectWebSocketUpgrade(socket, 401, 'Tunnel authentication required'); return;
        }
        acceptingServer.handleUpgrade(req, socket, head, (ws) => {
          if (needsTunnelSession && tunnelAuthController) {
            const release = tunnelAuthController.bindTunnelSession(req, () => ws.terminate());
            if (!release) { ws.terminate(); return; }
            ws.once('close', release);
          }
          acceptingServer.emit('connection', ws, req);
        });
      } catch (error) {
        logUpgradeFailure({ error });
        socket.destroy();
      }
    };
    const checkOrigin = () => {
      void isRequestOriginAllowed(req).then((allowed) => {
        if (allowed) accept();
        else rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
      }).catch((error) => { logUpgradeFailure({ error }); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); });
    };
    if (isOpaqueOriginRequest(req)) { rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return; }
    const admitTunnelSession = () => { lane = 'tunnel'; checkOrigin(); };
    if (!uiAuthController?.enabled) {
      if (tunnelScope()) { admitTunnelSession(); return; }
      lane = 'local';
      void isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed).then((allowed) => {
        if (allowed) accept();
        else rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
      }).catch((error) => { logUpgradeFailure({ error }); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); });
      return;
    }
    try {
      const result = uiAuthController.ensureSessionToken(req, null);
      const admit = (sessionToken: string | null) => {
        if (sessionToken) checkOrigin();
        else if (tunnelScope()) admitTunnelSession();
        else rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
      };
      if (!(result instanceof Promise)) { admit(result); return; }
      void result.then((sessionToken) => {
        admit(sessionToken);
      }).catch((error) => { logUpgradeFailure({ error }); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); });
    } catch (error) { logUpgradeFailure({ error }); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
  };
  return upgradeHandler;
};
