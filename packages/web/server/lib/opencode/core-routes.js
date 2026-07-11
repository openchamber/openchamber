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

const getRequestPathname = (req) => {
  const rawUrl = req?.originalUrl || req?.url || '';
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return '';
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

const getQueryParam = (req, name) => {
  const rawUrl = req?.originalUrl || req?.url || '';
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return '';
  try {
    return new URL(rawUrl, 'http://localhost').searchParams.get(name)?.trim() || '';
  } catch {
    return '';
  }
};

const getCookieValue = (req, name) => {
  const cookieHeader = req?.headers?.cookie;
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return '';
  for (const segment of cookieHeader.split(';')) {
    const [rawName, ...rawValueParts] = segment.split('=');
    if (rawName?.trim() !== name) continue;
    return rawValueParts.join('=').trim();
  }
  return '';
};

const hasPreviewProxyCredential = (req) => {
  if (!getRequestPathname(req).startsWith('/api/preview/proxy/')) return false;
  return Boolean(getQueryParam(req, 'oc_preview_token') || getCookieValue(req, 'oc_preview_token'));
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
    tunnelAuthController = null,
    uiAuthController = null,
  } = dependencies;

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
      'realtime.sse.v1',
      'realtime.websocket.global-events.v1',
      'terminal.websocket.v1',
    ],
  };

  const isDevShutdownAllowed = () => {
    // Dev-only escape hatch: allow terminating the whole dev process group.
    // This should never be enabled in production runtimes.
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

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      openchamberVersion,
      runtime: runtimeName,
      compatibility,
      ...getHealthSnapshot(),
    });
  });

  app.get('/api/version', (_req, res) => {
    res.json({
      status: 'ok',
      openchamberVersion,
      runtime: runtimeName,
      startedAt: serverStartedAt,
      compatibility,
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

    // Terminate the entire dev process group so `bun run dev` leaves no orphans.
    // We still run graceful shutdown to clean up OpenCode, terminals, websockets.
    try {
      const rawPreviewUrls = Array.isArray(req.body?.previewUrls) ? req.body.previewUrls : [];
      const previewPorts = Array.from(new Set(
        rawPreviewUrls
          .map((value) => parseLoopbackPort(value))
          .filter((port) => typeof port === 'number')
      ));
      // Attempt to stop preview servers that may have daemonized away from the PTY.
      // This is dev-only and limited to loopback ports supplied by the UI.
      await Promise.all(previewPorts.map((port) => killListenPort(port)));

      const pgid = await resolveProcessGroupId(process.pid);
      const ppid = typeof process.ppid === 'number' ? process.ppid : null;
      const parentPgid = ppid ? await resolveProcessGroupId(ppid) : null;

      // Kick off shutdown cleanup first.
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

      // Ensure the server process itself exits even if the group kill fails.
      setTimeout(() => {
        try {
          process.exit(0);
        } catch {
        }
      }, 2500).unref?.();
    } catch (error) {
      console.error('Dev shutdown request failed:', error?.message || error);
      // As a last resort, exit.
      try {
        process.exit(0);
      } catch {
      }
    }
  });

  app.get('/api/system/info', (_req, res) => {
    res.json({
      openchamberVersion,
      runtime: runtimeName,
      pid: process.pid,
      startedAt: serverStartedAt,
    });
  });

  // Allocates a best-effort free TCP port hint on 127.0.0.1.
  // Another process can still claim it before the preview server binds.
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
    // Returns the relay pairing candidate ({ type:'relay', relayUrl, serverId,
    // hostEncPubJwk, priority }) when the host relay is enabled, else null.
    // Injected lazily because the relay service is constructed after these routes.
    getRelayPairingCandidate = async () => null,
    // Re-evaluate the relay lifecycle after pairing/device changes.
    reconcileRelay = async () => {},
    // Returns { local, lan, relayAvailable } — the direct transport URLs the
    // server can actually be reached on (LAN derived from the server bind, not
    // the UI origin), for the create-device dialog.
    getPairingTransports = () => ({ local: null, lan: null, relayAvailable: true }),
    // Display name a paired device shows for THIS server (issuing machine's
    // hostname), distinct from the per-device pairing label typed by the operator.
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
    // Do not use req.ip here: Express rewrites it from X-Forwarded-For when
    // trust proxy is enabled, and redeem is unauthenticated before this limit.
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

  // `preferredServerUrl` is the caller-supplied externally reachable URL (the
  // desktop UI reaches its own server over loopback, so the request origin is not
  // scannable — it passes the LAN URL instead). Falls back to the request origin
  // for remote callers where the Host header IS the reachable address.
  //
  // `includeRelay` is the per-link transport choice from the create-link dialog:
  //   true  → add the relay candidate, enabling the relay host on demand;
  //   false → direct only, never relay;
  //   undefined → legacy: advertise relay only if it is already enabled.
  // `includeDirect === false` produces a relay-only link (no direct candidate).
  const pairingServerCandidates = async (req, { preferredServerUrl, includeRelay, includeDirect = true } = {}) => {
    const candidates = [];
    if (includeDirect) {
      const direct = normalizeCandidateUrl(preferredServerUrl) || requestOrigin(req);
      if (direct) {
        let type = 'lan';
        try {
          const parsed = new URL(direct);
          type = parsed.protocol === 'https:' ? 'tunnel' : 'lan';
        } catch {
        }
        candidates.push({ type, url: direct, priority: 10 });
      }
    }
    // The client races candidates and falls back to relay only if the direct URL
    // is unreachable (relay carries a higher priority number).
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

  const requireApiAuth = async (req, res, next) => {
    // Preview proxy requests carry a target-scoped capability token that the
    // preview proxy validates against the registered target id/TTL. Let those
    // requests reach that stricter check instead of failing the global UI auth
    // gate when the short-lived browser URL auth token expires.
    if (hasPreviewProxyCredential(req)) {
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
        // The desktop shell's local client is the trusted operator of this
        // server; it manages devices just like a browser UI session. Every
        // other client token is scoped to its own record.
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
        // The desktop shell's local client manages every device; other client
        // tokens may only revoke themselves.
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
      void reconcileRelay();
      res.json(result);
    });
  });

  app.delete('/api/client-auth/clients', async (req, res, next) => {
    await runWithClientManagementAuth(req, res, next, async (authContext) => {
      if (authContext.type === 'client') {
        const actingClient = await clientRecordFromAuthContext(authContext);
        // Purging revoked devices is a whole-server management action; only the
        // trusted desktop shell client (or a UI session) may do it.
        if (actingClient?.clientKind !== 'desktop-local') {
          return res.status(403).json({ purged: 0, error: 'Client tokens cannot purge revoked devices' });
        }
      }
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

  // Direct transports the server can be reached on (for the create-device dialog).
  app.get('/api/client-auth/pairing/transports', async (req, res, next) => {
    await runWithClientCreateAuth(req, res, next, async () => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(getPairingTransports(req));
    });
  });

  // Pending pairing sessions (link created, device not yet connected) for the
  // "pending devices" list. Secrets are never included.
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
      // The session became a device: relay demand may have moved from the pending
      // session to the paired device (or a non-relay redeem may drop it).
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

  app.post('/api/config/reload', async (_req, res) => {
    try {
      console.log('[Server] Manual configuration reload requested');

      await refreshOpenCodeAfterConfigChange('manual configuration reload');

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
  const { express, verboseRequestLogs = false } = dependencies;

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/behavior')) {
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > 1024 * 1024) {
        return res.status(413).json({ error: 'Content exceeds maximum size of 1048576 bytes' });
      }
      express.json({ limit: '1mb' })(req, res, next);
    } else if (
      req.path.startsWith('/api/config/agents') ||
      req.path.startsWith('/api/config/commands') ||
      req.path.startsWith('/api/config/mcp') ||
      req.path.startsWith('/api/config/snippets') ||
      req.path.startsWith('/api/config/settings') ||
      req.path.startsWith('/api/config/skills') ||
      req.path.startsWith('/api/config/plugins') ||
      req.path.startsWith('/api/projects') ||
      req.path.startsWith('/api/fs') ||
      req.path.startsWith('/api/git') ||
      req.path.startsWith('/api/magic-prompts') ||
      req.path.startsWith('/api/prompts') ||
      req.path.startsWith('/api/terminal') ||
      req.path.startsWith('/api/opencode') ||
      req.path.startsWith('/api/push') ||
      req.path.startsWith('/api/notifications') ||
      req.path.startsWith('/api/session-folders') ||
      req.path.startsWith('/api/small-model') ||
      req.path.startsWith('/api/text') ||
      req.path.startsWith('/api/voice') ||
      req.path.startsWith('/api/tts') ||
      req.path.startsWith('/api/openchamber/tunnel')
    ) {
      express.json({ limit: '50mb' })(req, res, next);
    } else if (req.path.startsWith('/api')) {
      next();
    } else {
      express.json({ limit: '50mb' })(req, res, next);
    }
  });

  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.use((req, _res, next) => {
    if (verboseRequestLogs) {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    }
    next();
  });
};
