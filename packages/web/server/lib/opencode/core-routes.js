export const registerServerStatusRoutes = (app, dependencies) => {
  const {
    process,
    openchamberVersion,
    runtimeName,
    serverStartedAt,
    gracefulShutdown,
    getHealthSnapshot,
  } = dependencies;

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      ...getHealthSnapshot(),
    });
  });

  app.post('/api/system/shutdown', (_req, res) => {
    res.json({ ok: true });
    gracefulShutdown({ exitProcess: false }).catch((error) => {
      console.error('Shutdown request failed:', error?.message || error);
    });
  });

  app.get('/api/system/info', (_req, res) => {
    res.json({
      openchamberVersion,
      runtime: runtimeName,
      pid: process.pid,
      startedAt: serverStartedAt,
    });
  });
};

export const registerAuthAndAccessRoutes = (app, dependencies) => {
  const {
    tunnelAuthController,
    uiAuthController,
    readSettingsFromDiskMigrated,
    normalizeTunnelSessionTtlMs,
  } = dependencies;

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
      await uiAuthController.requireAuth(req, res, async () => {
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
      await uiAuthController.requireAuth(req, res, async () => {
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
      await uiAuthController.requireAuth(req, res, async () => {
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
      await uiAuthController.requireAuth(req, res, async () => {
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
      await uiAuthController.requireAuth(req, res, async () => {
        await uiAuthController.handleResetAuth(req, res);
      });
    } catch (error) {
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

  app.use('/api', async (req, res, next) => {
    try {
      const requestScope = tunnelAuthController.classifyRequestScope(req);
      if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
        return tunnelAuthController.requireTunnelSession(req, res, next);
      }
      await uiAuthController.requireAuth(req, res, next);
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
  const { express } = dependencies;

  app.use((req, res, next) => {
    if (
      req.path.startsWith('/api/config/agents') ||
      req.path.startsWith('/api/config/commands') ||
      req.path.startsWith('/api/config/mcp') ||
      req.path.startsWith('/api/config/settings') ||
      req.path.startsWith('/api/config/skills') ||
      req.path.startsWith('/api/projects') ||
      req.path.startsWith('/api/fs') ||
      req.path.startsWith('/api/git') ||
      req.path.startsWith('/api/magic-prompts') ||
      req.path.startsWith('/api/prompts') ||
      req.path.startsWith('/api/terminal') ||
      req.path.startsWith('/api/opencode') ||
      req.path.startsWith('/api/push') ||
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
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
};
