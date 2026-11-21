import { buildExternalManualRestartResponse } from '../opencode/config-mutation-response.js';
import { ThemeImportStorageError } from '../appearance/theme-runtime.js';
import { registerThemeCatalogRoutes } from '../appearance/theme-catalog.js';
import { collectLocalFileDiagnostics } from '../diagnostics/local-files.js';
import { serverDiagnosticJournal } from '../diagnostics/server-journal.js';
import { getBearerTokenFromRequest } from '../ui-auth/ui-auth.js';
import { candidateUrlType, isLocalOnlyCandidateSet, isLoopbackCandidateUrl, normalizeCandidateUrl } from '../client-auth/pairing-candidates.js';
import { isBoolean, isString } from '../shared/object-guards.js';
import type { AddressInfo, Server } from 'node:net';
import type { Application, ExpressFactory, NextFunction, Request, RequestHandler, Response } from '../shared/http-contracts.js';
import type { DiagnosticJournal, OpenCodeLoad } from '../diagnostics/contracts.js';
import type { AuthContext, createUiAuth } from '../ui-auth/ui-auth.js';
import type { createTunnelAuth } from '../tunnels/tunnel-auth.js';
import type { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import type { createClientPairingRuntime } from '../client-auth/pairing.js';
import type { ClientInput, PairingInput, RedemptionInput } from '../client-auth/contracts.js';
import type { RelayPairingCandidate } from '../relay/service.js';
import type { TunnelRoutesDependencies } from '../tunnels/routes.js';
import type { createThemeRuntime } from '../appearance/theme-runtime.js';
import type { createClientPushAccess } from '../notifications/client-push-access.js';
import type { createOpenCodeLifecycleRuntime } from '../opencode/lifecycle.js';

type UiAuthController = ReturnType<typeof createUiAuth>;
type TunnelAuthController = ReturnType<typeof createTunnelAuth>;
type ManagementAuthContext = Pick<AuthContext, 'type' | 'client' | 'clientId'>;
type ThemeRuntime = ReturnType<typeof createThemeRuntime>;

export interface RequestAuthorizationDependencies {
  tunnelAuthController: TunnelAuthController | null;
  uiAuthController: UiAuthController | null;
}

export interface ServerStatusDependencies {
  express: ExpressFactory;
  process: NodeJS.Process;
  openchamberVersion: string;
  runtimeName: string;
  serverStartedAt: string;
  gracefulShutdown: (options: { exitProcess: boolean }) => Promise<void>;
  getHealthSnapshot: () => object;
  getServerPort?: () => number | null;
  getTunnelUrl?: () => string | null;
  getServerId?: () => Promise<string | null>;
  tunnelAuthController?: TunnelAuthController | null;
  uiAuthController?: UiAuthController | null;
  readOpenCodeLoad?: (() => Promise<OpenCodeLoad>) | null;
}

export interface DirectPairingCandidate {
  type: 'lan' | 'tunnel';
  url: string;
  priority: number;
}

export interface AuthAndAccessDependencies {
  express: ExpressFactory;
  tunnelAuthController: TunnelAuthController;
  uiAuthController: UiAuthController;
  remoteClientAuthRuntime: ReturnType<typeof createRemoteClientAuthRuntime>;
  clientPairingRuntime: ReturnType<typeof createClientPairingRuntime>;
  readSettingsFromDiskMigrated: TunnelRoutesDependencies['readSettingsFromDiskMigrated'];
  normalizeTunnelSessionTtlMs: TunnelRoutesDependencies['normalizeTunnelSessionTtlMs'];
  getRelayPairingCandidate?: (options: { ensureEnabled: boolean }) => RelayPairingCandidate | null | Promise<RelayPairingCandidate | null>;
  reconcileRelay?: () => Promise<void>;
  removeClientPushDevices?: ReturnType<typeof createClientPushAccess>['removeDevicesOfClients'];
  getPairingTransports?: (req: Request) => { local: string | null; lan: string | null; relayAvailable: boolean };
  getDirectCandidateUrls?: (req: Request) => string[];
  getServerId?: () => Promise<string | null>;
  getServerLabel?: () => string;
}

export interface SettingsUtilityDependencies {
  readCustomThemesFromDisk: ThemeRuntime['readCustomThemesFromDisk'];
  saveImportedTheme: ThemeRuntime['saveImportedTheme'];
  deleteImportedTheme: ThemeRuntime['deleteImportedTheme'];
  refreshOpenCodeAfterConfigChange: ReturnType<typeof createOpenCodeLifecycleRuntime>['refreshOpenCodeAfterConfigChange'];
  clientReloadDelayMs: number;
}

export interface CommonRequestDependencies {
  express: ExpressFactory;
  verboseRequestLogs?: boolean;
  skipBodyParsing?: (req: Request) => boolean;
}

interface RouteInput extends ClientInput, PairingInput, RedemptionInput {
  previewUrls?: unknown;
  pairingId?: unknown;
  serverUrl?: unknown;
  includeRelay?: unknown;
  includeDirect?: unknown;
  url?: unknown;
  theme?: unknown;
}

interface ServerIdentity {
  serverId?: string;
}

interface ServerInfo {
  openchamberVersion: string;
  runtime: string;
  pid: number;
  startedAt: string;
  port?: number | null;
  tunnelUrl?: string | null;
}

const hasRouteInput = (value: unknown): value is RouteInput => value != null;
const readBody = (req: Request) => hasRouteInput(req.body) ? req.body : undefined;
const hasErrorDetails = (value: unknown): value is { message?: unknown; statusCode?: unknown } => value != null;
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isAddressInfo = (value: ReturnType<Server['address']>): value is AddressInfo => Boolean(value) && typeof value === 'object';

export const registerHttpResponseDiagnostics = (app: Application, journal: DiagnosticJournal = serverDiagnosticJournal) => {
  app.use((req, res, next) => {
    res.once('finish', () => {
      journal.recordHttpResponse(req.method, req.path, res.statusCode);
    });
    next();
  });
};

const parseLoopbackUrl = (rawUrl: RouteInput['url']) => {
  if (!isString(rawUrl)) {
    return null;
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const host = url.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '0.0.0.0') {
    return null;
  }

  return url;
};

export const isRequestAuthorized = async (req: Request, res: Response, { tunnelAuthController, uiAuthController }: RequestAuthorizationDependencies) => {
  const scope = tunnelAuthController?.classifyRequestScope?.(req);
  if (scope === 'tunnel' || scope === 'unknown-public') {
    return Boolean(tunnelAuthController?.getTunnelSessionFromRequest(req));
  }
  if (!uiAuthController) return false;
  return Boolean(await uiAuthController.resolveAuthContext(req, res, { allowUrlToken: false }));
};

export const registerServerStatusRoutes = (app: Application, dependencies: ServerStatusDependencies) => {
  const {
    express,
    process,
    openchamberVersion,
    runtimeName,
    serverStartedAt,
    gracefulShutdown,
    getHealthSnapshot,
    getServerPort = () => null,
    getTunnelUrl = () => null,
    getServerId = async () => null,
    tunnelAuthController = null,
    uiAuthController = null,
    readOpenCodeLoad = null,
  } = dependencies;

  let cachedServerId: string | null = null;
  const resolveServerId = async () => {
    if (cachedServerId) return cachedServerId;
    try {
      const value = await getServerId();
      cachedServerId = value && value.trim() ? value.trim() : null;
    } catch {
      cachedServerId = null;
    }
    return cachedServerId;
  };

  const allocateLoopbackPort = async () => {
    const net = await import('node:net');
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        try {
          const address = server.address();
          const port = isAddressInfo(address) ? address.port : 0;
          server.close(() => {
            resolve(port);
          });
        } catch (error) {
          try {
            server.close();
          } catch {
            void 0;
          }
          reject(error);
        }
      });
    });
  };

  const compatibility = {
    apiVersion: 1,
    minClientApiVersion: 1,
    capabilities: [
      'api.health.v1',
      'api.runtime-url.v1',
      'api.raw-file.v1',
      'api.notifications.emit.v1',
      'realtime.sse.v1',
      'realtime.websocket.global-events.v1',
      'terminal.websocket.v1',
      'api.message-part-shells.v1',
    ],
  };

  const isDevShutdownAllowed = () => {
    return process.env.OPENCHAMBER_DEV_SHUTDOWN === 'true';
  };

  const isSameOriginRequest = (req: Request) => {
    const rawOrigin = req.get('origin');
    const rawHost = req.get('host');
    if (!rawOrigin || !rawHost) {
      return false;
    }
    try {
      const origin = new URL(String(rawOrigin));
      return origin.host === rawHost;
    } catch {
      return false;
    }
  };

  const resolveProcessGroupId = async (pid: number | null) => {
    if (!pid || !Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    if (process.platform === 'win32') {
      return null;
    }

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const result = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)]);
      const raw = String(result.stdout || '').trim();
      const pgid = Number.parseInt(raw, 10);
      return Number.isFinite(pgid) && pgid > 0 ? pgid : null;
    } catch {
      return null;
    }
  };

  const parseLoopbackPort = (rawUrl: RouteInput['previewUrls']) => {
    if (!isString(rawUrl)) {
      return null;
    }
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    const host = url.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '0.0.0.0') {
      return null;
    }
    const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return null;
    }
    return port;
  };

  const killListenPort = async (port: number) => {
    if (!Number.isFinite(port) || port <= 0) {
      return;
    }
    if (process.platform === 'win32') {
      return;
    }

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const result = await execFileAsync('lsof', ['-nP', '-t', `-iTCP:${Math.trunc(port)}`, '-sTCP:LISTEN'], {
        timeout: 2500,
      });
      const pids = String(result.stdout || '')
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);

      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          void 0;
        }
      }
      if (pids.length > 0) {
        setTimeout(() => {
          for (const pid of pids) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              void 0;
            }
          }
        }, 1200).unref?.();
      }
    } catch {
      void 0;
    }
  };

  app.get('/health', async (_req, res) => {
    const serverId = await resolveServerId();
    const identity: ServerIdentity = {};
    if (serverId) identity.serverId = serverId;
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      openchamberVersion,
      runtime: runtimeName,
      compatibility,
      ...identity,
      ...getHealthSnapshot(),
    });
  });

  const requireLocalDiagnostics: RequestHandler = (req, res, next) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '')
      || req.headers['x-openchamber-relay-connection']
      || (tunnelAuthController?.classifyRequestScope && tunnelAuthController.classifyRequestScope(req) !== 'local')) {
      res.status(403).json({ error: 'Local diagnostics require a loopback connection' });
      return;
    }
    if (uiAuthController?.requireAuth) return uiAuthController.requireAuth(req, res, next);
    next();
  };

  app.get('/api/diagnostics/local-files', requireLocalDiagnostics, async (_req, res) => {
    try {
      const webPort = getServerPort();
      res.json(await collectLocalFileDiagnostics(webPort === null ? {} : { webPort }));
    } catch {
      res.status(500).json({ error: 'Diagnostics unavailable' });
    }
  });

  app.get('/api/diagnostics/opencode-load', requireLocalDiagnostics, async (_req, res) => {
    if (!readOpenCodeLoad) {
      res.status(404).json({ error: 'Diagnostics unavailable' });
      return;
    }
    try {
      res.json(await readOpenCodeLoad());
    } catch {
      res.status(500).json({ error: 'Diagnostics unavailable' });
    }
  });

  app.get('/api/version', async (_req, res) => {
    const serverId = await resolveServerId();
    const identity: ServerIdentity = {};
    if (serverId) identity.serverId = serverId;
    res.json({
      status: 'ok',
      openchamberVersion,
      runtime: runtimeName,
      startedAt: serverStartedAt,
      compatibility,
      ...identity,
    });
  });

  const requireShutdownAuth: RequestHandler = async (req, res, next) => {
    if (!uiAuthController) {
      return next();
    }
    const requestScope = tunnelAuthController?.classifyRequestScope
      ? tunnelAuthController.classifyRequestScope(req)
      : 'local';
    if (
      (requestScope === 'tunnel' || requestScope === 'unknown-public')
      && tunnelAuthController?.requireTunnelSession
    ) {
      return tunnelAuthController.requireTunnelSession(req, res, next);
    }
    return uiAuthController.requireAuth(req, res, next);
  };

  app.post('/api/system/shutdown', async (req, res, next) => {
    try {
      await requireShutdownAuth(req, res, () => {
        res.json({ ok: true });
        gracefulShutdown({ exitProcess: true }).catch((error) => {
          console.error('Shutdown request failed:', error?.message || error);
        });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/system/dev-shutdown', express.json({ limit: '64kb' }), async (req, res) => {
    if (!isDevShutdownAllowed()) {
      return res.status(403).json({ ok: false, error: 'Dev shutdown is disabled' });
    }
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ ok: false, error: 'Invalid origin' });
    }

    res.json({ ok: true });

    try {
      const previewUrls = readBody(req)?.previewUrls;
      const rawPreviewUrls = Array.isArray(previewUrls) ? previewUrls : [];
      const previewPorts = Array.from(new Set(
        rawPreviewUrls
          .map((value: RouteInput['previewUrls']) => parseLoopbackPort(value))
          .filter(isNumber)
      ));
      await Promise.all(previewPorts.map((port) => killListenPort(port)));

      const pgid = await resolveProcessGroupId(process.pid);
      const ppid = process.ppid;
      const parentPgid = ppid ? await resolveProcessGroupId(ppid) : null;

      void gracefulShutdown({ exitProcess: false });

      const pgidsToKill = Array.from(new Set([pgid, parentPgid].filter((id): id is number => Boolean(id))));
      for (const id of pgidsToKill) {
        try {
          process.kill(-id, 'SIGTERM');
        } catch {
          void 0;
        }
      }

      setTimeout(() => {
        for (const id of pgidsToKill) {
          try {
            process.kill(-id, 'SIGKILL');
          } catch {
            void 0;
          }
        }
      }, 1500).unref?.();

      setTimeout(() => {
        try {
          process.exit(0);
        } catch {
          void 0;
        }
      }, 2500).unref?.();
    } catch (error) {
      console.error('Dev shutdown request failed:', (hasErrorDetails(error) && error.message) || error);
      try {
        process.exit(0);
      } catch {
        void 0;
      }
    }
  });

  app.get('/api/system/info', async (req, res) => {
    const info: ServerInfo = {
      openchamberVersion,
      runtime: runtimeName,
      pid: process.pid,
      startedAt: serverStartedAt,
    };
    if (await isRequestAuthorized(req, res, { tunnelAuthController, uiAuthController }).catch(() => false)) {
      info.port = getServerPort();
      info.tunnelUrl = getTunnelUrl();
    }
    res.json(info);
  });

  app.get('/api/system/free-port', async (_req, res) => {
    try {
      const port = await allocateLoopbackPort();
      if (!Number.isFinite(port) || port <= 0) {
        return res.status(500).json({ error: 'Failed to allocate port' });
      }
      return res.json({ port });
    } catch (error) {
      return res.status(500).json({ error: (hasErrorDetails(error) && error.message) || 'Failed to allocate port' });
    }
  });

};

export const registerAuthAndAccessRoutes = (app: Application, dependencies: AuthAndAccessDependencies) => {
  const {
    express,
    tunnelAuthController,
    uiAuthController,
    remoteClientAuthRuntime,
    clientPairingRuntime,
    readSettingsFromDiskMigrated,
    normalizeTunnelSessionTtlMs,
    getRelayPairingCandidate = async () => null,
    reconcileRelay = async () => {},
    removeClientPushDevices = async () => {},
    getPairingTransports = () => ({ local: null, lan: null, relayAvailable: true }),
    getDirectCandidateUrls = () => [],
    getServerId = async () => null,
    getServerLabel = () => 'OpenChamber',
  } = dependencies;
  const PAIRING_REDEEM_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
  const PAIRING_REDEEM_RATE_LIMIT_MAX_ATTEMPTS = 10;
  const pairingRedeemAttempts = new Map<string, { count: number; firstAttemptAt: number }>();

  const runWithUiAuth = async (req: Request, res: Response, next: NextFunction, handler: () => Promise<void | Response>, options: { sessionOnly?: boolean } = {}) => {
    try {
      const requireAuth = options.sessionOnly === true && uiAuthController.requireSessionAuth
        ? uiAuthController.requireSessionAuth
        : uiAuthController.requireAuth;
      await requireAuth(req, res, async () => {
        await handler();
      });
    } catch (error) {
      next(error);
    }
  };

  const runWithClientManagementAuth = async (req: Request, res: Response, next: NextFunction, handler: (context: ManagementAuthContext) => Promise<void | Response>) => {
    try {
      if (uiAuthController.resolveAuthContext) {
        const context = await uiAuthController.resolveAuthContext(req, res, {
          allowClientAuth: true,
          allowUrlToken: false,
        });
        if (context?.type === 'session' || context?.type === 'client') {
          await handler(context);
          return;
        }
      }

      await runWithUiAuth(req, res, next, async () => {
        await handler({ type: 'session' });
      }, { sessionOnly: true });
    } catch (error) {
      next(error);
    }
  };

  const runWithClientCreateAuth = async (req: Request, res: Response, next: NextFunction, handler: (context: ManagementAuthContext) => Promise<void | Response>) => {
    try {
      if (uiAuthController.resolveAuthContext) {
        const context = await uiAuthController.resolveAuthContext(req, res, {
          allowClientAuth: true,
          allowUrlToken: false,
        });
        if (context?.type === 'session') {
          await handler(context);
          return;
        }
        if (context?.type === 'client') {
          const client = await clientRecordFromAuthContext(context);
          if (client?.clientKind === 'desktop-local') {
            await handler({ ...context, client });
            return;
          }
          return res.status(403).json({ error: 'Client tokens cannot create remote clients' });
        }
      }

      await runWithUiAuth(req, res, next, async () => {
        await handler({ type: 'session' });
      }, { sessionOnly: true });
    } catch (error) {
      next(error);
    }
  };

  const clientIdFromAuthContext = (context: ManagementAuthContext) => {
    const raw = context?.client?.id || context?.clientId;
    return raw && raw.length > 0 ? raw : null;
  };

  const clientRecordFromAuthContext = async (context: ManagementAuthContext) => {
    if (context?.client) {
      return context.client;
    }
    const clientId = clientIdFromAuthContext(context);
    if (!clientId) return null;
    const clients = await remoteClientAuthRuntime.listClients();
    return clients.find((client) => client.id === clientId) || null;
  };

  const requestOrigin = (req: Request) => {
    const forwardedProto = isString(req.headers?.['x-forwarded-proto'])
      ? req.headers['x-forwarded-proto'].split(',')[0]?.trim()
      : '';
    const protocol = forwardedProto || (req.socket && 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http');
    const host = isString(req.headers?.host) ? req.headers.host.trim() : '';
    if (!host) return null;
    return `${protocol}://${host}`;
  };

  const requestIp = (req: Request) => {
    return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  };

  const pairingIdFromRequest = (req: Request) => {
    const pairingId = readBody(req)?.pairingId;
    const raw = isString(pairingId) ? pairingId.trim() : '';
    return raw || 'missing';
  };

  const checkPairingRedeemRateLimit = (req: Request): {
    remaining: number;
    reset: number;
  } & ({ allowed: true } | { allowed: false; retryAfter: number }) => {
    const now = Date.now();
    const key = `${requestIp(req)}:${pairingIdFromRequest(req)}`;
    for (const [entryKey, entry] of pairingRedeemAttempts.entries()) {
      if (!entry || now - entry.firstAttemptAt >= PAIRING_REDEEM_RATE_LIMIT_WINDOW_MS) {
        pairingRedeemAttempts.delete(entryKey);
      }
    }
    const entry = pairingRedeemAttempts.get(key);
    if (!entry) {
      pairingRedeemAttempts.set(key, { count: 1, firstAttemptAt: now });
      return { allowed: true, remaining: PAIRING_REDEEM_RATE_LIMIT_MAX_ATTEMPTS - 1, reset: Math.ceil((now + PAIRING_REDEEM_RATE_LIMIT_WINDOW_MS) / 1000) };
    }
    const reset = Math.ceil((entry.firstAttemptAt + PAIRING_REDEEM_RATE_LIMIT_WINDOW_MS) / 1000);
    if (entry.count >= PAIRING_REDEEM_RATE_LIMIT_MAX_ATTEMPTS) {
      return {
        allowed: false,
        remaining: 0,
        reset,
        retryAfter: Math.max(1, Math.ceil((entry.firstAttemptAt + PAIRING_REDEEM_RATE_LIMIT_WINDOW_MS - now) / 1000)),
      };
    }
    entry.count += 1;
    return { allowed: true, remaining: PAIRING_REDEEM_RATE_LIMIT_MAX_ATTEMPTS - entry.count, reset };
  };

  const clearPairingRedeemRateLimit = (req: Request) => {
    pairingRedeemAttempts.delete(`${requestIp(req)}:${pairingIdFromRequest(req)}`);
  };

  const pairingServerCandidates = async (req: Request, { preferredServerUrl, includeRelay, includeDirect = true }: {
    preferredServerUrl?: RouteInput['serverUrl'];
    includeRelay?: boolean | undefined;
    includeDirect?: boolean;
  } = {}) => {
    const candidates: (DirectPairingCandidate | RelayPairingCandidate)[] = [];
    if (includeDirect) {
      const preferred = normalizeCandidateUrl(preferredServerUrl);
      const origin = normalizeCandidateUrl(requestOrigin(req));
      const direct = preferred || origin;
      if (direct) {
        candidates.push({ type: candidateUrlType(direct), url: direct, priority: 10 });
      }
      if (origin && direct && origin !== direct && !isLoopbackCandidateUrl(origin)) {
        candidates.push({ type: candidateUrlType(origin), url: origin, priority: 20 });
      }
    }
    if (includeRelay !== false) {
      try {
        const relayCandidate = await getRelayPairingCandidate({ ensureEnabled: includeRelay === true });
        if (relayCandidate) candidates.push(relayCandidate);
      } catch {
        void 0;
      }
    }
    return candidates;
  };

  const sendPairingRedeemError = (res: Response, error: { statusCode?: unknown }) => {
    const statusCode = isNumber(error?.statusCode) ? error.statusCode : 400;
    res.status(statusCode).json({ error: 'Invalid or expired pairing session' });
  };

  const selfAuthenticatedApiPaths = new Set(['/api/git/repository-credential']);

  const isGuestOauthCallback = (req: Request) => (
    req.method === 'GET'
    && /^\/(?:guests\/[a-z][a-z0-9-]*|tracker\/ext-[a-z][a-z0-9-]*)\/oauth\/callback$/.test(req.path || '')
  );

  const isMcpOauthCallback = (req: Request) => (
    req.method === 'GET'
    && /^\/mcp\/oauth\/[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\/callback$/.test(req.path || '')
  );

  const isFilePreviewRead = (req: Request) => (
    req.method === 'GET'
    && /^\/fs\/preview\/[^/]+\/./.test(req.path || '')
  );

  const isGuestFrameFileRead = (req: Request) => (
    req.method === 'GET'
    && /^\/guest-files\/[^/]+\/./.test(req.path || '')
  );

  const requireApiAuth: RequestHandler = async (req, res, next) => {
    const pathname = (req.originalUrl || '').split('?', 1).join('');
    if (selfAuthenticatedApiPaths.has(pathname)) return next();
    if (isGuestOauthCallback(req) || isMcpOauthCallback(req) || isFilePreviewRead(req) || isGuestFrameFileRead(req)) {
      return next();
    }
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return tunnelAuthController.requireTunnelSession(req, res, next);
    }
    return uiAuthController.requireAuth(req, res, next);
  };

  app.get('/auth/session', async (req, res) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      const tunnelSession = tunnelAuthController.getTunnelSessionFromRequest(req);
      if (tunnelSession) {
        return res.json({ authenticated: true, scope: 'tunnel' });
      }
      tunnelAuthController.clearTunnelSessionCookie(req, res);
      return res.status(401).json({ authenticated: false, locked: true, tunnelLocked: true });
    }

    try {
      await uiAuthController.handleSessionStatus(req, res);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/auth/session', (req, res) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Password login is disabled for tunnel scope', tunnelLocked: true });
    }
    return uiAuthController.handleSessionCreate(req, res);
  });

  app.post('/auth/url-token', async (req, res, next) => {
    try {
      await uiAuthController.handleUrlAuthToken(req, res);
    } catch (error) {
      next(error);
    }
  });

  app.get('/auth/passkey/status', (req, res) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.json({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null, tunnelLocked: true });
    }
    return uiAuthController.handlePasskeyStatus(req, res);
  });

  app.post('/auth/passkey/authenticate/options', (req, res) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Passkey login is disabled for tunnel scope', tunnelLocked: true });
    }
    return uiAuthController.handlePasskeyAuthenticationOptions(req, res);
  });

  app.post('/auth/passkey/authenticate/verify', (req, res) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Passkey login is disabled for tunnel scope', tunnelLocked: true });
    }
    return uiAuthController.handlePasskeyAuthenticationVerify(req, res);
  });

  app.post('/auth/passkey/register/options', async (req, res, next) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Passkey setup is disabled for tunnel scope', tunnelLocked: true });
    }
    try {
      await uiAuthController.requireSessionAuth(req, res, async () => {
        await uiAuthController.handlePasskeyRegistrationOptions(req, res);
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/passkey/register/verify', async (req, res, next) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Passkey setup is disabled for tunnel scope', tunnelLocked: true });
    }
    try {
      await uiAuthController.requireSessionAuth(req, res, async () => {
        await uiAuthController.handlePasskeyRegistrationVerify(req, res);
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/passkeys', async (req, res, next) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Passkey management is disabled for tunnel scope', tunnelLocked: true });
    }
    try {
      await uiAuthController.requireSessionAuth(req, res, async () => {
        await uiAuthController.handlePasskeyList(req, res);
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/passkeys/:id', async (req, res, next) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Passkey management is disabled for tunnel scope', tunnelLocked: true });
    }
    try {
      await uiAuthController.requireSessionAuth(req, res, async () => {
        await uiAuthController.handlePasskeyRevoke(req, res);
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/passkeys/:id', express.json({ limit: '8kb' }), async (req, res, next) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Passkey management is disabled for tunnel scope', tunnelLocked: true });
    }
    try {
      await uiAuthController.requireSessionAuth(req, res, async () => {
        if (!uiAuthController.handlePasskeyRename) {
          throw new TypeError('uiAuthController.handlePasskeyRename is not a function');
        }
        await uiAuthController.handlePasskeyRename(req, res);
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/reset', async (req, res, next) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Global sign-out is disabled for tunnel scope', tunnelLocked: true });
    }
    try {
      await uiAuthController.requireSessionAuth(req, res, async () => {
        await uiAuthController.handleResetAuth(req, res);
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/client-auth/clients', async (req, res, next) => {
    await runWithClientManagementAuth(req, res, next, async (authContext) => {
      if (authContext.type === 'client') {
        const client = await clientRecordFromAuthContext(authContext);
        if (client?.clientKind !== 'desktop-local') {
          return res.json({ clients: client ? [client] : [] });
        }
      }
      const clients = await remoteClientAuthRuntime.listClients();
      res.json({ clients });
    });
  });

  app.post('/api/client-auth/clients', express.json({ limit: '64kb' }), async (req, res, next) => {
    await runWithClientCreateAuth(req, res, next, async () => {
      const result = await remoteClientAuthRuntime.createClient({
        label: readBody(req)?.label,
        clientKind: readBody(req)?.clientKind,
        dedupeKey: readBody(req)?.dedupeKey,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(result);
    });
  });

  app.delete<unknown, { id: string }>('/api/client-auth/clients/:id', async (req, res, next) => {
    await runWithClientManagementAuth(req, res, next, async (authContext) => {
      if (authContext.type === 'client') {
        const actingClient = await clientRecordFromAuthContext(authContext);
        if (actingClient?.clientKind !== 'desktop-local') {
          const clientId = clientIdFromAuthContext(authContext);
          if (!clientId || clientId !== req.params?.id) {
            return res.status(403).json({ revoked: false, error: 'Client tokens can only revoke themselves' });
          }
        }
      }
      const result = await remoteClientAuthRuntime.revokeClient(req.params?.id);
      if (!result.revoked) {
        return res.status(404).json({ revoked: false, error: 'Client not found' });
      }
      await removeClientPushDevices([req.params.id]).catch((error) => {
        console.warn('Failed to remove push registrations of a revoked client:', error?.message ?? error);
      });
      void reconcileRelay();
      res.json(result);
    });
  });

  app.delete('/api/client-auth/clients', async (req, res, next) => {
    await runWithClientManagementAuth(req, res, next, async (authContext) => {
      if (authContext.type === 'client') {
        const actingClient = await clientRecordFromAuthContext(authContext);
        if (actingClient?.clientKind !== 'desktop-local') {
          return res.status(403).json({ purged: 0, error: 'Client tokens cannot purge revoked devices' });
        }
      }
      const clients = await remoteClientAuthRuntime.listClients();
      await removeClientPushDevices(clients.filter((client) => client.revokedAt).map((client) => client.id));
      const result = await remoteClientAuthRuntime.purgeRevokedClients();
      void reconcileRelay();
      res.json(result);
    });
  });

  app.post('/api/client-auth/pairing/sessions', express.json({ limit: '64kb' }), async (req, res, next) => {
    await runWithClientCreateAuth(req, res, next, async (authContext) => {
      const includeRelay = readBody(req)?.includeRelay;
      const candidates = await pairingServerCandidates(req, {
        preferredServerUrl: readBody(req)?.serverUrl,
        includeRelay: isBoolean(includeRelay) ? includeRelay : undefined,
        includeDirect: readBody(req)?.includeDirect !== false,
      });
      const usesRelay = candidates.some((candidate) => candidate.type === 'relay');
      const result = await clientPairingRuntime.createPairingSession({
        label: readBody(req)?.label,
        allowedClientKinds: readBody(req)?.allowedClientKinds,
        createdByClientId: clientIdFromAuthContext(authContext),
        usesRelay,
        localOnly: isLocalOnlyCandidateSet(candidates),
      });
      void reconcileRelay();
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        ...result,
        server: { label: getServerLabel(), candidates },
      });
    });
  });

  app.get('/api/client-auth/connection/candidates', async (req, res, next) => {
    await runWithClientManagementAuth(req, res, next, async (authContext) => {
      const candidates: (DirectPairingCandidate | RelayPairingCandidate)[] = [];
      const directUrls = (() => {
        try {
          const urls = getDirectCandidateUrls(req);
          return Array.isArray(urls) ? urls : [];
        } catch {
          return [];
        }
      })();
      for (const url of directUrls) {
        const normalized = normalizeCandidateUrl(url);
        if (normalized) candidates.push({ type: 'lan', url: normalized, priority: 10 });
      }
      const bearerToken = getBearerTokenFromRequest(req);
      const bearerClient = bearerToken ? await remoteClientAuthRuntime.authenticateBearerToken(bearerToken, req) : null;
      const actingClient = bearerClient?.client ?? (authContext.type === 'client' ? await clientRecordFromAuthContext(authContext) : null);
      if (actingClient?.localOnly !== true) {
        try {
          const relayCandidate = await getRelayPairingCandidate({ ensureEnabled: false });
          if (relayCandidate) candidates.push(relayCandidate);
        } catch {
          void 0;
        }
      }
      let serverId = null;
      try {
        const value = await getServerId();
        serverId = value && value.trim() ? value.trim() : null;
      } catch {
        serverId = null;
      }
      res.setHeader('Cache-Control', 'no-store');
      const identity: ServerIdentity = {};
      if (serverId) identity.serverId = serverId;
      res.json({ label: getServerLabel(), ...identity, candidates });
    });
  });

  app.get('/api/client-auth/pairing/transports', async (req, res, next) => {
    await runWithClientCreateAuth(req, res, next, async () => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(getPairingTransports(req));
    });
  });

  app.get('/api/client-auth/pairing/sessions', async (req, res, next) => {
    await runWithClientCreateAuth(req, res, next, async () => {
      const pending = await clientPairingRuntime.listPendingSessions();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ pending });
    });
  });

  app.delete('/api/client-auth/pairing/sessions/:id', async (req, res, next) => {
    await runWithClientCreateAuth(req, res, next, async () => {
      const result = await clientPairingRuntime.cancelPairingSession(req.params?.id);
      if (!result.cancelled) {
        return res.status(404).json({ cancelled: false, error: 'Pairing session not found' });
      }
      void reconcileRelay();
      res.json(result);
    });
  });

  app.post('/api/client-auth/pairing/redeem', express.json({ limit: '64kb' }), async (req, res, next) => {
    try {
      const rateLimit = checkPairingRedeemRateLimit(req);
      res.setHeader('X-RateLimit-Limit', PAIRING_REDEEM_RATE_LIMIT_MAX_ATTEMPTS);
      res.setHeader('X-RateLimit-Remaining', rateLimit.remaining);
      res.setHeader('X-RateLimit-Reset', rateLimit.reset);
      if (!rateLimit.allowed) {
        res.setHeader('Retry-After', rateLimit.retryAfter);
        return res.status(429).json({ error: 'Invalid or expired pairing session' });
      }
      const result = await clientPairingRuntime.redeemPairingSession({
        pairingId: readBody(req)?.pairingId,
        secret: readBody(req)?.secret,
        clientLabel: readBody(req)?.clientLabel,
        clientKind: readBody(req)?.clientKind,
        deviceName: readBody(req)?.deviceName,
        devicePlatform: readBody(req)?.devicePlatform,
        deviceModel: readBody(req)?.deviceModel,
        appVersion: readBody(req)?.appVersion,
        dedupeKey: readBody(req)?.dedupeKey,
      });
      clearPairingRedeemRateLimit(req);
      if (result.replacedClientIds?.length) {
        await removeClientPushDevices(result.replacedClientIds).catch((error) => {
          console.warn('Failed to remove push registrations of a replaced client:', error?.message ?? error);
        });
      }
      void reconcileRelay();
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        server: {
          label: getServerLabel(),
          url: requestOrigin(req),
          fingerprint: result.pairing?.fingerprint || null,
        },
        client: result.client,
        clientToken: result.token,
      });
    } catch (error) {
      if (hasErrorDetails(error) && error.message === 'Invalid or expired pairing session') {
        sendPairingRedeemError(res, error);
        return;
      }
      next(error);
    }
  });

  app.get('/connect', async (req, res) => {
    try {
      const token = isString(req.query?.t) ? req.query.t : '';
      const settings = await readSettingsFromDiskMigrated();
      const tunnelSessionTtlMs = normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);

      const exchange = tunnelAuthController.exchangeBootstrapToken({
        req,
        res,
        token,
        sessionTtlMs: tunnelSessionTtlMs,
      });

      res.setHeader('Cache-Control', 'no-store');

      if (!exchange.ok) {
        if (exchange.reason === 'rate-limited') {
          res.setHeader('Retry-After', String(exchange.retryAfter || 60));
          return res.status(429).type('text/plain').send('Too many attempts. Please try again later.');
        }
        return res.status(401).type('text/plain').send('Connection link is invalid or expired.');
      }

      return res.redirect(302, '/');
    } catch {
      return res.status(500).type('text/plain').send('Failed to process connect request.');
    }
  });

  app.post('/api/system/probe-url', express.json({ limit: '16kb' }), async (req, res, next) => {
    try {
      await requireApiAuth(req, res, async () => {
        const url = parseLoopbackUrl(readBody(req)?.url);
        if (!url) {
          return res.status(400).json({ ok: false, error: 'Invalid loopback URL' });
        }

        try {
          const response = await fetch(url.toString(), {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(1500),
          });
          return res.json({ ok: response.status >= 200 && response.status < 600, status: response.status });
        } catch (error) {
          return res.json({ ok: false, error: (hasErrorDetails(error) && error.message) || 'Probe failed' });
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', async (req, res, next) => {
    try {
      await requireApiAuth(req, res, next);
    } catch (err) {
      next(err);
    }
  });
};

export const registerSettingsUtilityRoutes = (app: Application, dependencies: SettingsUtilityDependencies) => {
  const {
    readCustomThemesFromDisk,
    saveImportedTheme,
    deleteImportedTheme,
    refreshOpenCodeAfterConfigChange,
    clientReloadDelayMs,
  } = dependencies;

  app.get('/api/config/themes', async (_req, res) => {
    try {
      const customThemes = await readCustomThemesFromDisk();
      res.json({ themes: customThemes });
    } catch (error) {
      console.error('Failed to load custom themes:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load custom themes' });
    }
  });

  app.post('/api/config/themes', async (req, res) => {
    try {
      const theme = await saveImportedTheme(readBody(req)?.theme);
      res.status(201).json({ theme });
    } catch (error) {
      if (error instanceof ThemeImportStorageError) {
        res.status(error.status).json({ error: error.code });
        return;
      }
      console.error('[themes] Failed to save imported theme');
      res.status(500).json({ error: 'save' });
    }
  });

  registerThemeCatalogRoutes(app);
  app.delete('/api/config/themes/:id', async (req, res) => {
    try {
      await deleteImportedTheme(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(error instanceof ThemeImportStorageError ? error.status : 500).json({ error: 'delete' });
    }
  });

  app.post('/api/config/reload', async (_req, res) => {
    try {
      console.log('[Server] Manual configuration reload requested');

      const refreshResult = await refreshOpenCodeAfterConfigChange('manual configuration reload');

      if (refreshResult?.external) {
        return res.json(buildExternalManualRestartResponse(
          'Configuration is saved on disk. Restart your connected OpenCode server to apply the changes.',
        ));
      }

      res.json({
        success: true,
        requiresReload: true,
        message: 'Configuration reloaded successfully. Refreshing interface…',
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error('[Server] Failed to reload configuration:', error);
      const response = res.status(500);
      if (!hasErrorDetails(error)) {
        throw new TypeError(`Cannot read properties of ${error} (reading 'message')`);
      }
      response.json({
        error: error.message || 'Failed to reload configuration',
        success: false,
      });
    }
  });
};

export const registerCommonRequestMiddleware = (app: Application, dependencies: CommonRequestDependencies) => {
  const { express, verboseRequestLogs = false, skipBodyParsing = () => false } = dependencies;

  app.use((req, res, next) => {
    if (skipBodyParsing(req)) {
      next();
    } else if (req.path === '/api/config/themes' || req.path.startsWith('/api/config/themes/')) {
      express.json({ limit: '1mb' })(req, res, next);
    } else if (req.path.startsWith('/api/behavior')) {
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > 1024 * 1024) {
        return res.status(413).json({ error: 'Content exceeds maximum size of 1048576 bytes' });
      }
      express.json({ limit: '1mb' })(req, res, next);
    } else if (req.path.startsWith('/api/source-control')) {
      express.json({ limit: '256kb' })(req, res, next);
    } else if (
      req.path.startsWith('/api/config/agents') ||
      req.path.startsWith('/api/config/commands') ||
      req.path.startsWith('/api/config/mcp') ||
      req.path.startsWith('/api/config/snippets') ||
      req.path.startsWith('/api/config/settings') ||
      req.path.startsWith('/api/config/skills') ||
      req.path === '/api/config/skill-switch' ||
      req.path.startsWith('/api/config/plugins') ||
      req.path.startsWith('/api/config/websearch') ||
      req.path.startsWith('/api/config/warming') ||
      req.path === '/api/config/compaction' ||
      req.path.startsWith('/api/session-warming') ||
      req.path.startsWith('/api/projects') ||
      req.path.startsWith('/api/fs') ||
      req.path.startsWith('/api/git') ||
      req.path.startsWith('/api/magic-prompts') ||
      req.path.startsWith('/api/prompts') ||
      req.path.startsWith('/api/terminal') ||
      req.path.startsWith('/api/opencode') ||
      req.path === '/api/openchamber/directory' ||
      req.path.startsWith('/api/push') ||
      req.path.startsWith('/api/notifications') ||
      req.path.startsWith('/api/permission-auto-accept') ||
      req.path.startsWith('/api/message-queue') ||
      req.path.startsWith('/api/auto-review') ||
      req.path.startsWith('/api/provider') ||
      req.path.startsWith('/api/session-folders') ||
      req.path.startsWith('/api/small-model') ||
      req.path.startsWith('/api/walkthrough') ||
      req.path.startsWith('/api/goals') ||
      req.path.startsWith('/api/text') ||
      req.path.startsWith('/api/voice') ||
      req.path.startsWith('/api/environment') ||
      req.path.startsWith('/api/tts') ||
      req.path.startsWith('/api/openchamber/tunnel') ||
      req.path.startsWith('/api/openchamber/spaces')
    ) {
      express.json({ limit: '50mb' })(req, res, next);
    } else if (req.path.startsWith('/api')) {
      next();
    } else {
      express.json({ limit: '50mb' })(req, res, next);
    }
  });

  const urlencoded = express.urlencoded({ extended: true, limit: '50mb' });
  app.use((req, res, next) => {
    if (skipBodyParsing(req)) {
      next();
      return;
    }
    urlencoded(req, res, next);
  });

  app.use((req, _res, next) => {
    if (verboseRequestLogs) {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    }
    next();
  });
};
