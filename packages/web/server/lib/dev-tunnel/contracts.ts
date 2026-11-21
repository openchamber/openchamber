import type { Server, OutgoingHttpHeaders } from 'node:http';
import type { Server as TcpServer, Socket } from 'node:net';
import type { DevServerDiscoveryResult } from '../dev-servers/routes.js';
import type { RequestOriginChecker, createRequestSecurityRuntime } from '../security/request-security.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';

export interface DevTunnelLogger {
  warn?: (message: string) => void;
}

export interface DevTunnelRuntimeOptions {
  server: Pick<Server, 'on' | 'off'>;
  discoverDevServers: () => Promise<DevServerDiscoveryResult | null | undefined>;
  uiAuthController?: Pick<ReturnType<typeof createUiAuth>, 'enabled' | 'resolveAuthContext'> | null;
  isRequestOriginAllowed: RequestOriginChecker;
  rejectWebSocketUpgrade: ReturnType<typeof createRequestSecurityRuntime>['rejectWebSocketUpgrade'];
  logger?: DevTunnelLogger;
}

export interface DevTunnelClientOptions {
  logger?: DevTunnelLogger;
  handshakeTimeoutMs?: number;
  maxPendingBytes?: number;
}

export interface DevTunnelTarget {
  baseUrl: string;
  port: number | string;
  spaceId?: string | null;
}

export interface DevTunnelOpenOptions extends DevTunnelTarget {
  headers?: OutgoingHttpHeaders;
}

export interface DevTunnelInfo {
  localPort: number;
  remotePort: number;
  baseUrl: string;
  spaceId: string | null;
}

export interface DevTunnel extends DevTunnelInfo {
  server: TcpServer;
  sockets: Set<Socket>;
}

export interface DevTunnelOpenResult {
  localPort: number;
  reused: boolean;
}
