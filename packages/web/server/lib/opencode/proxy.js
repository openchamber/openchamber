import { createProxyMiddleware } from 'http-proxy-middleware';

import {
  applyForwardProxyResponseHeaders,
  collectForwardProxyHeaders,
  shouldForwardProxyResponseHeader,
} from '../../proxy-headers.js';

export const registerOpenCodeProxy = (app, deps) => {
  const {
    fs,
    os,
    path,
    OPEN_CODE_READY_GRACE_MS,
    getRuntime,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    backendRegistry,
    sessionBindingsRuntime,
    openCodeBackendRuntime,
    readSettingsFromDiskMigrated,
  } = deps;

  if (app.get('opencodeProxyConfigured')) {
    return;
  }

  const runtime = getRuntime();
  if (runtime.openCodePort) {
    console.log(`Setting up proxy to OpenCode on port ${runtime.openCodePort}`);
  } else {
    console.log('Setting up OpenCode API gate (OpenCode not started yet)');
  }
  app.set('opencodeProxyConfigured', true);

  const isAbortError = (error) => error?.name === 'AbortError';
  const FALLBACK_PROXY_TARGET = 'http://127.0.0.1:3902';

  const normalizeProxyTarget = (candidate) => {
    if (typeof candidate !== 'string') {
      return null;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.replace(/\/+$/, '');
  };

  // Keep generic proxy requests on the same upstream base URL that health checks
  // and direct fetch helpers use. This avoids split-brain state where /health
  // succeeds against an external host but /api/* still proxies to 127.0.0.1.
  const resolveProxyTarget = () => {
    try {
      const resolved = normalizeProxyTarget(buildOpenCodeUrl('/', ''));
      if (resolved) {
        return resolved;
      }
    } catch {
    }

    const runtimeState = getRuntime();
    const externalBase = normalizeProxyTarget(runtimeState.openCodeBaseUrl);
    if (externalBase) {
      return externalBase;
    }

    if (runtimeState.openCodePort) {
      return `http://localhost:${runtimeState.openCodePort}`;
    }

    return FALLBACK_PROXY_TARGET;
  };

  const forwardSseRequest = async (req, res) => {
    const abortController = new AbortController();
    const closeUpstream = () => abortController.abort();
    let upstream = null;
    let reader = null;

    req.on('close', closeUpstream);

    try {
      const requestUrl = typeof req.originalUrl === 'string' && req.originalUrl.length > 0
        ? req.originalUrl
        : (typeof req.url === 'string' ? req.url : '');
      const upstreamPath = requestUrl.startsWith('/api') ? requestUrl.slice(4) || '/' : requestUrl;
      const headers = collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders());
      headers.accept ??= 'text/event-stream';
      headers['cache-control'] ??= 'no-cache';

      upstream = await fetch(buildOpenCodeUrl(upstreamPath, ''), {
        method: 'GET',
        headers,
        signal: abortController.signal,
      });

      res.status(upstream.status);
      applyForwardProxyResponseHeaders(upstream.headers, res);

      const contentType = upstream.headers.get('content-type') || 'text/event-stream';
      const isEventStream = contentType.toLowerCase().includes('text/event-stream');

      if (!upstream.body) {
        res.end(await upstream.text().catch(() => ''));
        return;
      }

      if (!isEventStream) {
        res.end(await upstream.text());
        return;
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      // Disable TCP Nagle's algorithm so small SSE chunks are sent immediately
      // instead of being buffered up to ~200ms by the TCP stack.
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true);
      }

      reader = upstream.body.getReader();
      while (!abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.length > 0) {
          res.write(value);
        }
      }

      res.end();
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      console.error('[proxy] OpenCode SSE proxy error:', error?.message ?? error);
      if (!res.headersSent) {
        res.status(503).json({ error: 'OpenCode service unavailable' });
      } else {
        res.end();
      }
    } finally {
      req.off('close', closeUpstream);
      try {
        if (reader) {
          await reader.cancel();
          reader.releaseLock();
        } else if (upstream?.body && !upstream.body.locked) {
          await upstream.body.cancel();
        }
      } catch {
      }
    }
  };

  // Ensure API prefix is detected before proxying
  app.use('/api', (_req, _res, next) => {
    ensureOpenCodeApiPrefix();
    next();
  });

  // Readiness gate — return 503 while OpenCode is starting/restarting
  app.use('/api', (req, res, next) => {
    if (
      req.path.startsWith('/themes/custom') ||
      req.path.startsWith('/push') ||
      req.path.startsWith('/config/agents') ||
      req.path.startsWith('/config/opencode-resolution') ||
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/config/reload' ||
      req.path === '/health'
    ) {
      return next();
    }

    const runtimeState = getRuntime();
    const waitElapsed = runtimeState.openCodeNotReadySince === 0 ? 0 : Date.now() - runtimeState.openCodeNotReadySince;
    const stillWaiting =
      (!runtimeState.isOpenCodeReady && (runtimeState.openCodeNotReadySince === 0 || waitElapsed < OPEN_CODE_READY_GRACE_MS)) ||
      runtimeState.isRestartingOpenCode ||
      !runtimeState.openCodePort;

    if (stillWaiting) {
      return res.status(503).json({
        error: 'OpenCode is restarting',
        restarting: true,
      });
    }

    next();
  });

  // Windows: session merge for cross-directory session listing
  if (process.platform === 'win32') {
    app.get('/api/session', async (req, res, next) => {
      const rawUrl = req.originalUrl || req.url || '';
      if (rawUrl.includes('directory=')) return next();

      try {
        const authHeaders = getOpenCodeAuthHeaders();
        const fetchOpts = {
          method: 'GET',
          headers: { Accept: 'application/json', ...authHeaders },
          signal: AbortSignal.timeout(10000),
        };
        const globalRes = await fetch(buildOpenCodeUrl('/session', ''), fetchOpts);
        const globalPayload = globalRes.ok ? await globalRes.json().catch(() => []) : [];
        const globalSessions = Array.isArray(globalPayload) ? globalPayload : [];

        const settingsPath = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
        let projectDirs = [];
        try {
          const settingsRaw = fs.readFileSync(settingsPath, 'utf8');
          const settings = JSON.parse(settingsRaw);
          projectDirs = (settings.projects || [])
            .map((project) => (typeof project?.path === 'string' ? project.path.trim() : ''))
            .filter(Boolean);
        } catch {
        }

        const seen = new Set(
          globalSessions
            .map((session) => (session && typeof session.id === 'string' ? session.id : null))
            .filter((id) => typeof id === 'string')
        );
        const extraSessions = [];
        for (const dir of projectDirs) {
          const candidates = Array.from(new Set([
            dir,
            dir.replace(/\\/g, '/'),
            dir.replace(/\//g, '\\'),
          ]));
          for (const candidateDir of candidates) {
            const encoded = encodeURIComponent(candidateDir);
            try {
              const dirRes = await fetch(buildOpenCodeUrl(`/session?directory=${encoded}`, ''), fetchOpts);
              if (dirRes.ok) {
                const dirPayload = await dirRes.json().catch(() => []);
                const dirSessions = Array.isArray(dirPayload) ? dirPayload : [];
                for (const session of dirSessions) {
                  const id = session && typeof session.id === 'string' ? session.id : null;
                  if (id && !seen.has(id)) {
                    seen.add(id);
                    extraSessions.push(session);
                  }
                }
              }
            } catch {
            }
          }
        }

        const merged = [...globalSessions, ...extraSessions];
        merged.sort((a, b) => {
          const aTime = a && typeof a.time_updated === 'number' ? a.time_updated : 0;
          const bTime = b && typeof b.time_updated === 'number' ? b.time_updated : 0;
          return bTime - aTime;
        });
        console.log(`[SessionMerge] ${globalSessions.length} global + ${extraSessions.length} extra = ${merged.length} total`);
        return res.json(sessionBindingsRuntime.annotateSessions(merged));
      } catch (error) {
        console.log(`[SessionMerge] Error: ${error.message}, falling through`);
        next();
      }
    });
  }

  app.get('/api/global/event', forwardSseRequest);
  app.get('/api/event', forwardSseRequest);

  const sendUnsupportedBackendResponse = (res, backendId) => {
    res.status(501).json({
      error: `Backend "${backendId}" is not available yet`,
      backendId,
      code: 'BACKEND_UNSUPPORTED',
    });
  };

  const resolveRequestedBackendId = async (req) => {
    const bodyBackendId = typeof req.body?.backendId === 'string' ? req.body.backendId.trim() : '';
    if (bodyBackendId) {
      return bodyBackendId;
    }
    const settings = await readSettingsFromDiskMigrated();
    const settingsBackend = typeof settings?.defaultBackend === 'string' ? settings.defaultBackend.trim() : '';
    return settingsBackend || await backendRegistry.getDefaultBackendId();
  };

  const encodeJsonBody = (body) => {
    if (body == null) {
      return undefined;
    }
    if (typeof body === 'string') {
      return body;
    }
    return JSON.stringify(body);
  };

  const sanitizeCreateBody = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return body;
    }
    const next = { ...body };
    delete next.backendId;
    return next;
  };

  const mutateSessionPath = (requestUrl, currentSessionId, nextSessionId) => {
    if (!currentSessionId || currentSessionId === nextSessionId) {
      return requestUrl;
    }
    const escapedCurrent = encodeURIComponent(currentSessionId);
    const escapedNext = encodeURIComponent(nextSessionId);
    return requestUrl.replace(`/session/${escapedCurrent}`, `/session/${escapedNext}`);
  };

  const readJsonResponse = async (response) => {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return null;
    }
    return response.json().catch(() => null);
  };

  const writeJsonResponse = (res, response, payload) => {
    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (shouldForwardProxyResponseHeader(key)) {
        res.setHeader(key, value);
      }
    }
    res.json(payload);
  };

  app.get('/api/session', async (req, res, next) => {
    const rawUrl = req.originalUrl || req.url || '';
    if (process.platform === 'win32' && !rawUrl.includes('directory=')) {
      return next();
    }

    try {
      const response = await fetch(buildOpenCodeUrl(rawUrl.replace(/^\/api/, '') || '/session', ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders()),
        },
        signal: AbortSignal.timeout(10000),
      });
      const payload = await readJsonResponse(response);
      if (!Array.isArray(payload)) {
        res.status(response.status);
        res.end(await response.text().catch(() => ''));
        return;
      }
      writeJsonResponse(res, response, sessionBindingsRuntime.annotateSessions(payload));
    } catch (error) {
      console.error('[proxy] Failed to annotate session list:', error?.message ?? error);
      next();
    }
  });

  app.post('/api/session', async (req, res) => {
    try {
      const backendId = await resolveRequestedBackendId(req);
      if (!backendRegistry.isBackendSelectable(backendId)) {
        return sendUnsupportedBackendResponse(res, backendId);
      }

      const createBody = sanitizeCreateBody(req.body);
      const payload = await openCodeBackendRuntime.createSession({
        directory: typeof req.query?.directory === 'string' ? req.query.directory : undefined,
        title: typeof createBody?.title === 'string' ? createBody.title : undefined,
        parentID: typeof createBody?.parentID === 'string' ? createBody.parentID : undefined,
      });

      if (payload && typeof payload === 'object' && typeof payload.id === 'string' && payload.id.trim().length > 0) {
        await sessionBindingsRuntime.upsertBinding({
          sessionId: payload.id,
          backendId,
          backendSessionId: payload.id,
          directory: typeof payload.directory === 'string' ? payload.directory : null,
        });
      }

      res.status(200).json(sessionBindingsRuntime.annotateSession(payload));
    } catch (error) {
      console.error('[proxy] Failed to create session:', error?.message ?? error);
      const message = error?.body?.error || error?.message || 'Failed to create session';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/session/:sessionId/prompt_async', async (req, res, next) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      if (!sessionId) {
        return next();
      }

      const binding = sessionBindingsRuntime.getEffectiveBindingSync(sessionId);
      if (!binding) {
        return next();
      }

      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackendResponse(res, binding.backendId);
      }

      await openCodeBackendRuntime.promptAsync({
        sessionID: binding.backendSessionId,
        directory: typeof req.query?.directory === 'string' ? req.query.directory : binding.directory,
        messageID: typeof req.body?.messageID === 'string' ? req.body.messageID : undefined,
        model: req.body?.model,
        agent: typeof req.body?.agent === 'string' ? req.body.agent : undefined,
        variant: typeof req.body?.variant === 'string' ? req.body.variant : undefined,
        format: req.body?.format,
        parts: Array.isArray(req.body?.parts) ? req.body.parts : undefined,
      });

      return res.status(204).end();
    } catch (error) {
      console.error('[proxy] Failed to prompt session asynchronously:', error?.message ?? error);
      const message = error?.body?.error || error?.message || 'Failed to send message';
      return res.status(400).json({ error: message });
    }
  });

  const RESERVED_SESSION_PATHS = new Set([
    '/api/session',
    '/api/session/status',
    '/api/global/event',
    '/api/event',
  ]);

  app.use(/^\/api\/session\/([^/]+)(?:\/.*)?$/, async (req, res, next) => {
    if (RESERVED_SESSION_PATHS.has(req.path)) {
      return next();
    }

    try {
      const sessionId = typeof req.params?.[0] === 'string' ? decodeURIComponent(req.params[0]) : '';
      if (!sessionId) {
        return next();
      }

      const binding = sessionBindingsRuntime.getEffectiveBindingSync(sessionId);
      if (!binding) {
        return next();
      }

      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackendResponse(res, binding.backendId);
      }

      const requestUrl = typeof req.originalUrl === 'string' && req.originalUrl.length > 0
        ? req.originalUrl
        : (typeof req.url === 'string' ? req.url : '');
      const upstreamPath = mutateSessionPath(requestUrl.replace(/^\/api/, '') || '/', sessionId, binding.backendSessionId);
      const response = await fetch(buildOpenCodeUrl(upstreamPath, ''), {
        method: req.method,
        headers: {
          ...collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders()),
          ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { 'Content-Type': 'application/json' }),
        },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : encodeJsonBody(req.body),
      });

      const payload = await readJsonResponse(response);
      if (payload == null) {
        res.status(response.status);
        applyForwardProxyResponseHeaders(response.headers, res);
        res.end(await response.text().catch(() => ''));
        return;
      }

      const normalizedPayload = Array.isArray(payload)
        ? sessionBindingsRuntime.annotateSessions(payload)
        : sessionBindingsRuntime.annotateSession(payload);

      if (response.ok && req.method === 'DELETE') {
        await sessionBindingsRuntime.removeBinding(sessionId);
      }

      if (
        response.ok &&
        req.method === 'POST' &&
        typeof normalizedPayload === 'object' &&
        normalizedPayload &&
        typeof normalizedPayload.id === 'string' &&
        normalizedPayload.id.trim().length > 0 &&
        normalizedPayload.id !== sessionId
      ) {
        await sessionBindingsRuntime.upsertBinding({
          sessionId: normalizedPayload.id,
          backendId: binding.backendId,
          backendSessionId: normalizedPayload.id,
          directory: typeof normalizedPayload.directory === 'string' ? normalizedPayload.directory : binding.directory,
        });
      }

      writeJsonResponse(res, response, normalizedPayload);
    } catch (error) {
      console.error('[proxy] Failed to route session request:', error?.message ?? error);
      next();
    }
  });

  // Generic proxy for non-SSE OpenCode API routes.
  const apiProxy = createProxyMiddleware({
    target: resolveProxyTarget(),
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
    // Dynamic target — port can change after restart
    router: () => resolveProxyTarget(),
    on: {
      proxyReq: (proxyReq) => {
        // Inject OpenCode auth headers
        const authHeaders = getOpenCodeAuthHeaders();
        if (authHeaders.Authorization) {
          proxyReq.setHeader('Authorization', authHeaders.Authorization);
        }

        // Defensive: request identity encoding from upstream OpenCode.
        // This avoids compressed-body/header mismatches in multi-proxy setups.
        proxyReq.setHeader('accept-encoding', 'identity');
      },
      proxyRes: (proxyRes) => {
        for (const key of Object.keys(proxyRes.headers || {})) {
          if (!shouldForwardProxyResponseHeader(key)) {
            delete proxyRes.headers[key];
          }
        }
      },
      error: (err, _req, res) => {
        console.error('[proxy] OpenCode proxy error:', err.message);
        if (res && !res.headersSent && typeof res.status === 'function') {
          res.status(503).json({ error: 'OpenCode service unavailable' });
        }
      },
    },
  });

  app.use('/api', apiProxy);
};
