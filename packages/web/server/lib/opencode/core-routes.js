import { buildExternalManualRestartResponse } from './config-mutation-response.js';
import { ThemeImportStorageError } from './theme-runtime.js';
import { registerThemeCatalogRoutes } from './theme-catalog.js';
import { collectLocalFileDiagnostics } from '../diagnostics/local-files.js';
import { serverDiagnosticJournal } from '../diagnostics/server-journal.js';

export const registerHttpResponseDiagnostics = (app, journal = serverDiagnosticJournal) => {
  app.use((req, res, next) => {
    res.once('finish', () => {
      journal.recordHttpResponse(req.method, req.path, res.statusCode);
    });
    next();
  });
};

const parseLoopbackUrl = (rawUrl) => {
  if (typeof rawUrl !== 'string') {
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

export const isRequestAuthorized = async (req, res, { tunnelAuthController, uiAuthController }) => {
  const scope = tunnelAuthController?.classifyRequestScope?.(req);
  if (scope === 'tunnel' || scope === 'unknown-public') {
    return Boolean(tunnelAuthController.getTunnelSessionFromRequest(req));
  }
  if (!uiAuthController) return false;
  return Boolean(await uiAuthController.resolveAuthContext(req, res, { allowUrlToken: false }));
};

export const registerServerStatusRoutes = (app, dependencies) => {
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

  let cachedServerId = null;
  const resolveServerId = async () => {
    if (cachedServerId) return cachedServerId;
    try {
      const value = await getServerId();
      cachedServerId = typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
      cachedServerId = null;
    }
    return cachedServerId;
  };

  const allocateLoopbackPort = async () => {
    const net = await import('node:net');
    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        try {
          const address = server.address();
          const port = address && typeof address === 'object' ? address.port : 0;
          server.close(() => {
            resolve(port);
          });
        } catch (error) {
          try {
            server.close();
          } catch {
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

  const isSameOriginRequest = (req) => {
    const rawOrigin = typeof req.get === 'function' ? req.get('origin') : '';
    const rawHost = typeof req.get === 'function' ? req.get('host') : '';
    if (!rawOrigin || !rawHost) {
      return false;
    }
    try {
      const origin = new URL(rawOrigin);
      return origin.host === rawHost;
    } catch {
      return false;
    }
  };

  const resolveProcessGroupId = async (pid) => {
    if (!pid || typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
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

  const parseLoopbackPort = (rawUrl) => {
    if (typeof rawUrl !== 'string') {
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

  const killListenPort = async (port) => {
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
        }
      }
      if (pids.length > 0) {
        setTimeout(() => {
          for (const pid of pids) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
            }
          }
        }, 1200).unref?.();
      }
    } catch {
      // ignore (no lsof, no permission, etc.)
    }
  };

  app.get('/health', async (_req, res) => {
    const serverId = await resolveServerId();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      openchamberVersion,
      runtime: runtimeName,
      compatibility,
      ...(serverId ? { serverId } : {}),
      ...getHealthSnapshot(),
    });
  });

  const requireLocalDiagnostics = (req, res, next) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)
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
      res.json(await collectLocalFileDiagnostics({ webPort: getServerPort() }));
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
    res.json({
      status: 'ok',
      openchamberVersion,
      runtime: runtimeName,
      startedAt: serverStartedAt,
      compatibility,
      ...(serverId ? { serverId } : {}),
    });
  });

  const requireShutdownAuth = async (req, res, next) => {
    if (!uiAuthController || typeof uiAuthController.requireAuth !== 'function') {
      return next();
    }
    const requestScope = typeof tunnelAuthController?.classifyRequestScope === 'function'
      ? tunnelAuthController.classifyRequestScope(req)
      : 'local';
    if (
      (requestScope === 'tunnel' || requestScope === 'unknown-public')
      && typeof tunnelAuthController?.requireTunnelSession === 'function'
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
      const rawPreviewUrls = Array.isArray(req.body?.previewUrls) ? req.body.previewUrls : [];
      const previewPorts = Array.from(new Set(
        rawPreviewUrls
          .map((value) => parseLoopbackPort(value))
          .filter((port) => typeof port === 'number')
      ));
      await Promise.all(previewPorts.map((port) => killListenPort(port)));

      const pgid = await resolveProcessGroupId(process.pid);
      const ppid = typeof process.ppid === 'number' ? process.ppid : null;
      const parentPgid = ppid ? await resolveProcessGroupId(ppid) : null;

      void gracefulShutdown({ exitProcess: false });

      const pgidsToKill = Array.from(new Set([pgid, parentPgid].filter(Boolean)));
      for (const id of pgidsToKill) {
        try {
          process.kill(-id, 'SIGTERM');
        } catch {
        }
      }

      setTimeout(() => {
        for (const id of pgidsToKill) {
          try {
            process.kill(-id, 'SIGKILL');
          } catch {
          }
        }
      }, 1500).unref?.();

      setTimeout(() => {
        try {
          process.exit(0);
        } catch {
        }
      }, 2500).unref?.();
    } catch (error) {
      console.error('Dev shutdown request failed:', error?.message || error);
      try {
        process.exit(0);
      } catch {
      }
    }
  });

  app.get('/api/system/info', async (req, res) => {
    const info = {
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
      return res.status(500).json({ error: (error && error.message) || 'Failed to allocate port' });
    }
  });

};

export const registerAuthAndAccessRoutes = (app, dependencies) => {
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
  const pairingRedeemAttempts = new Map();

  const runWithUiAuth = async (req, res, next, handler, options = {}) => {
    try {
      const requireAuth = options.sessionOnly === true && typeof uiAuthController.requireSessionAuth === 'function'
        ? uiAuthController.requireSessionAuth
        : uiAuthController.requireAuth;
      await requireAuth(req, res, async () => {
        await handler();
      });
    } catch (error) {
      next(error);
    }
  };

  const runWithClientManagementAuth = async (req, res, next, handler) => {
    try {
      if (typeof uiAuthController.resolveAuthContext === 'function') {
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

  const runWithClientCreateAuth = async (req, res, next, handler) => {
    try {
      if (typeof uiAuthController.resolveAuthContext === 'function') {
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

  const clientIdFromAuthContext = (context) => {
    const raw = context?.client?.id || context?.clientId;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

  const clientRecordFromAuthContext = async (context) => {
    if (context?.client && typeof context.client === 'object') {
      return context.client;
    }
    const clientId = clientIdFromAuthContext(context);
    if (!clientId) return null;
    const clients = await remoteClientAuthRuntime.listClients();
    return clients.find((client) => client.id === clientId) || null;
  };

  const requestOrigin = (req) => {
    const forwardedProto = typeof req.headers?.['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0].trim()
      : '';
    const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
    const host = typeof req.headers?.host === 'string' ? req.headers.host.trim() : '';
    if (!host) return null;
    return `${protocol}://${host}`;
  };

  const requestIp = (req) => {
    return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  };

  const pairingIdFromRequest = (req) => {
    const raw = typeof req.body?.pairingId === 'string' ? req.body.pairingId.trim() : '';
    return raw || 'missing';
  };

  const checkPairingRedeemRateLimit = (req) => {
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

  const clearPairingRedeemRateLimit = (req) => {
    pairingRedeemAttempts.delete(`${requestIp(req)}:${pairingIdFromRequest(req)}`);
  };

  const normalizeCandidateUrl = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      parsed.hash = '';
      parsed.search = '';
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return null;
    }
  };

  const candidateUrlType = (url) => {
    try {
      return new URL(url).protocol === 'https:' ? 'tunnel' : 'lan';
    } catch {
      return 'lan';
    }
  };

  const isLoopbackCandidateUrl = (url) => {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    } catch {
      return true;
    }
  };

  const pairingServerCandidates = async (req, { preferredServerUrl, includeRelay, includeDirect = true } = {}) => {
    const candidates = [];
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
        // A relay enable/status failure must not break direct pairing.
      }
    }
    return candidates;
  };

  const sendPairingRedeemError = (res, error) => {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 400;
    res.status(statusCode).json({ error: 'Invalid or expired pairing session' });
  };

  const selfAuthenticatedApiPaths = new Set(['/api/git/repository-credential']);

  const isGuestOauthCallback = (req) => (
    req.method === 'GET'
    && /^\/(?:guests\/[a-z][a-z0-9-]*|tracker\/ext-[a-z][a-z0-9-]*)\/oauth\/callback$/.test(req.path || '')
  );

  const isMcpOauthCallback = (req) => (
    req.method === 'GET'
    && /^\/mcp\/oauth\/[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\/callback$/.test(req.path || '')
  );

  const isFilePreviewRead = (req) => (
    req.method === 'GET'
    && /^\/fs\/preview\/[^/]+\/./.test(req.path || '')
  );

  const isGuestFrameFileRead = (req) => (
    req.method === 'GET'
    && /^\/guest-files\/[^/]+\/./.test(req.path || '')
  );

  const requireApiAuth = async (req, res, next) => {
    const pathname = (req.originalUrl || '').split('?')[0];
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
        label: req.body?.label,
        clientKind: req.body?.clientKind,
        dedupeKey: req.body?.dedupeKey,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(result);
    });
  });

  app.delete('/api/client-auth/clients/:id', async (req, res, next) => {
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
      const candidates = await pairingServerCandidates(req, {
        preferredServerUrl: req.body?.serverUrl,
        includeRelay: typeof req.body?.includeRelay === 'boolean' ? req.body.includeRelay : undefined,
        includeDirect: req.body?.includeDirect !== false,
      });
      const usesRelay = candidates.some((candidate) => candidate.type === 'relay');
      const result = await clientPairingRuntime.createPairingSession({
        label: req.body?.label,
        allowedClientKinds: req.body?.allowedClientKinds,
        createdByClientId: clientIdFromAuthContext(authContext),
        usesRelay,
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
    await runWithClientManagementAuth(req, res, next, async () => {
      const candidates = [];
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
      try {
        const relayCandidate = await getRelayPairingCandidate({ ensureEnabled: false });
        if (relayCandidate) candidates.push(relayCandidate);
      } catch {
        // Relay status failure must not break the direct-candidate refresh.
      }
      let serverId = null;
      try {
        const value = await getServerId();
        serverId = typeof value === 'string' && value.trim() ? value.trim() : null;
      } catch {
        serverId = null;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ label: getServerLabel(), ...(serverId ? { serverId } : {}), candidates });
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
        pairingId: req.body?.pairingId,
        secret: req.body?.secret,
        clientLabel: req.body?.clientLabel,
        clientKind: req.body?.clientKind,
        deviceName: req.body?.deviceName,
        devicePlatform: req.body?.devicePlatform,
        deviceModel: req.body?.deviceModel,
        appVersion: req.body?.appVersion,
        dedupeKey: req.body?.dedupeKey,
      });
      clearPairingRedeemRateLimit(req);
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
      if (error?.message === 'Invalid or expired pairing session') {
        sendPairingRedeemError(res, error);
        return;
      }
      next(error);
    }
  });

  app.get('/connect', async (req, res) => {
    try {
      const token = typeof req.query?.t === 'string' ? req.query.t : '';
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
        const url = parseLoopbackUrl(req.body?.url);
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
          return res.json({ ok: false, error: error?.message || 'Probe failed' });
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

export const registerSettingsUtilityRoutes = (app, dependencies) => {
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
      const theme = await saveImportedTheme(req.body?.theme);
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
      res.status(500).json({
        error: error.message || 'Failed to reload configuration',
        success: false,
      });
    }
  });
};

export const registerCommonRequestMiddleware = (app, dependencies) => {
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
