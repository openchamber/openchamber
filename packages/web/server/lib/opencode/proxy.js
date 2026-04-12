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
  const getBackendRuntime = (backendId) => backendRegistry.getRuntime(backendId);

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

  const forwardMergedSseRequest = async (req, res) => {
    const abortController = new AbortController();
    const closeUpstream = () => abortController.abort();
    let upstream = null;
    let reader = null;
    let removeCodexClient = null;

    req.on('close', closeUpstream);

    try {
      const requestUrl = typeof req.originalUrl === 'string' && req.originalUrl.length > 0
        ? req.originalUrl
        : (typeof req.url === 'string' ? req.url : '');
      const upstreamPath = requestUrl.startsWith('/api') ? requestUrl.slice(4) || '/' : requestUrl;
      const parsed = new URL(requestUrl, 'http://127.0.0.1');
      const directory = typeof parsed.searchParams.get('directory') === 'string'
        ? parsed.searchParams.get('directory')
        : null;

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true);
      }

      const codexRuntime = backendRegistry.getRuntime('codex');
      removeCodexClient = codexRuntime?.addEventClient?.(res, parsed.pathname === '/api/event' ? directory : null) || null;

      // Only connect to OpenCode upstream if it is available
      if (backendRegistry.isBackendAvailable('opencode')) {
        const headers = collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders());
        headers.accept ??= 'text/event-stream';
        headers['cache-control'] ??= 'no-cache';

        upstream = await fetch(buildOpenCodeUrl(upstreamPath, ''), {
          method: 'GET',
          headers,
          signal: abortController.signal,
        });

        const contentType = upstream.headers.get('content-type') || 'text/event-stream';
        const isEventStream = contentType.toLowerCase().includes('text/event-stream');
        if (!upstream.body || !isEventStream) {
          if (!res.headersSent) {
            res.status(upstream.status);
          }
          res.end(await upstream.text().catch(() => ''));
          return;
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
      } else {
        // No OpenCode upstream; keep connection open for non-OpenCode event clients
        await new Promise((resolve) => {
          req.on('close', resolve);
        });
      }
    } catch (error) {
      if (!isAbortError(error)) {
        console.error('[proxy] Merged SSE proxy error:', error?.message ?? error);
      }
    } finally {
      req.off('close', closeUpstream);
      try {
        removeCodexClient?.();
      } catch {
      }
      try {
        if (reader) {
          await reader.cancel();
          reader.releaseLock();
        } else if (upstream?.body && !upstream.body.locked) {
          await upstream.body.cancel();
        }
      } catch {
      }
      res.end();
    }
  };

  // Ensure API prefix is detected before proxying
  app.use('/api', (_req, _res, next) => {
    ensureOpenCodeApiPrefix();
    next();
  });

  // Readiness gate — return 503 while OpenCode is starting/restarting.
  // Skipped entirely when OpenCode backend is not active.
  app.use('/api', (req, res, next) => {
    if (
      req.path.startsWith('/themes/custom') ||
      req.path.startsWith('/push') ||
      req.path.startsWith('/config/agents') ||
      req.path.startsWith('/config/opencode-resolution') ||
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/config/reload' ||
      req.path === '/health' ||
      req.path.startsWith('/openchamber') ||
      req.path.startsWith('/session')
    ) {
      return next();
    }

    // When OpenCode is not available, skip the readiness gate entirely
    if (!backendRegistry.isBackendAvailable('opencode')) {
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

      // When OpenCode is not available, skip to the main handler which
      // already returns non-OpenCode sessions only.
      if (!backendRegistry.isBackendAvailable('opencode')) return next();

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

        const codexRuntimeWin = backendRegistry.getRuntime('codex');
        const codexSessions = codexRuntimeWin?.listSessions ? await codexRuntimeWin.listSessions({
          directory: typeof req.query?.directory === 'string' ? req.query.directory : undefined,
          archived: false,
        }) : [];
        const merged = mergeSessionLists([...globalSessions, ...extraSessions], codexSessions);
        console.log(`[SessionMerge] ${globalSessions.length} global + ${extraSessions.length} extra = ${merged.length} total`);
        return res.json(sessionBindingsRuntime.annotateSessions(merged));
      } catch (error) {
        console.log(`[SessionMerge] Error: ${error.message}, falling through`);
        next();
      }
    });
  }

  app.get('/api/global/event', forwardMergedSseRequest);
  app.get('/api/event', forwardMergedSseRequest);

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

  const mergeSessionLists = (primarySessions, extraSessions = []) => {
    const merged = [];
    const seen = new Set();

    for (const session of [...primarySessions, ...extraSessions]) {
      const id = session && typeof session.id === 'string' ? session.id : '';
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      merged.push(session);
    }

    merged.sort((a, b) => {
      const aTime = Number(a?.time?.updated ?? a?.time_updated ?? a?.time?.created ?? 0);
      const bTime = Number(b?.time?.updated ?? b?.time_updated ?? b?.time?.created ?? 0);
      return bTime - aTime;
    });

    return merged;
  };

  const collectNonOpenCodeSessions = async (req) => {
    const codexRt = backendRegistry.getRuntime('codex');
    return codexRt?.listSessions ? await codexRt.listSessions({
      directory: typeof req.query?.directory === 'string' ? req.query.directory : undefined,
      archived: false,
      roots: req.query?.roots !== 'false',
      limit: typeof req.query?.limit === 'string' ? Number(req.query.limit) : undefined,
    }) : [];
  };

  app.get('/api/session', async (req, res, next) => {
    const rawUrl = req.originalUrl || req.url || '';
    if (process.platform === 'win32' && !rawUrl.includes('directory=')) {
      return next();
    }

    // When OpenCode is not available, only return non-OpenCode sessions
    if (!backendRegistry.isBackendAvailable('opencode')) {
      try {
        const sessions = await collectNonOpenCodeSessions(req);
        return res.status(200).json(sessionBindingsRuntime.annotateSessions(sessions));
      } catch (error) {
        console.error('[proxy] Failed to list non-OpenCode sessions:', error?.message ?? error);
        return res.status(200).json([]);
      }
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
      const opencodeSessions = Array.isArray(payload) ? payload : [];
      const codexSessions = await collectNonOpenCodeSessions(req);
      writeJsonResponse(res, response, sessionBindingsRuntime.annotateSessions(mergeSessionLists(opencodeSessions, codexSessions)));
    } catch (error) {
      console.error('[proxy] Failed to annotate session list:', error?.message ?? error);
      try {
        const codexSessions = await collectNonOpenCodeSessions(req);
        return res.status(200).json(sessionBindingsRuntime.annotateSessions(codexSessions));
      } catch {
      }
      next();
    }
  });

  const collectNonOpenCodeStatuses = async (req) => {
    const codexRt = backendRegistry.getRuntime('codex');
    return codexRt?.getStatusSnapshot ? await codexRt.getStatusSnapshot({
      directory: typeof req.query?.directory === 'string' ? req.query.directory : undefined,
    }) : {};
  };

  app.get('/api/session/status', async (req, res, next) => {
    // When OpenCode is not available, only return non-OpenCode statuses
    if (!backendRegistry.isBackendAvailable('opencode')) {
      try {
        return res.status(200).json(await collectNonOpenCodeStatuses(req));
      } catch (error) {
        console.error('[proxy] Failed to get non-OpenCode session status:', error?.message ?? error);
        return res.status(200).json({});
      }
    }

    try {
      const response = await fetch(buildOpenCodeUrl((req.originalUrl || req.url || '').replace(/^\/api/, '') || '/session/status', ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders()),
        },
        signal: AbortSignal.timeout(10000),
      });
      const payload = await readJsonResponse(response);
      const baseStatuses = payload && typeof payload === 'object' ? payload : {};
      const codexStatuses = await collectNonOpenCodeStatuses(req);
      writeJsonResponse(res, response, {
        ...baseStatuses,
        ...codexStatuses,
      });
    } catch (error) {
      console.error('[proxy] Failed to merge session status:', error?.message ?? error);
      try {
        return res.status(200).json(await collectNonOpenCodeStatuses(req));
      } catch {
      }
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
      const runtime = getBackendRuntime(backendId);
      if (!runtime?.createSession) {
        return sendUnsupportedBackendResponse(res, backendId);
      }
      const payload = await runtime.createSession({
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

      const binding = await sessionBindingsRuntime.getEffectiveBinding(sessionId);
      if (!binding) {
        return next();
      }

      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackendResponse(res, binding.backendId);
      }

      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.promptAsync) {
        return sendUnsupportedBackendResponse(res, binding.backendId);
      }

      await runtime.promptAsync({
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

  // Body parser helper — the global JSON parser skips /api routes that are
  // normally proxied to OpenCode, so we parse inline for our intercepted routes.
  const parseJsonBody = (req) => new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') {
      return resolve(req.body);
    }
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });

  app.post('/api/session/:sessionId/revert', async (req, res, next) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      if (!sessionId) {
        return next();
      }

      const binding = await sessionBindingsRuntime.getEffectiveBinding(sessionId);
      if (!binding || binding.backendId !== 'codex') {
        return next(); // let OpenCode handle non-Codex sessions
      }

      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.revertSession) {
        return next();
      }

      const body = await parseJsonBody(req);
      const result = await runtime.revertSession({
        sessionID: binding.backendSessionId,
        messageID: body.messageID || body.partID,
      });

      return res.json(result);
    } catch (error) {
      console.error('[proxy] Failed to revert session:', error?.message ?? error);
      return res.status(400).json({ error: error?.message || 'Revert failed' });
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

      const binding = await sessionBindingsRuntime.getEffectiveBinding(sessionId);
      if (!binding) {
        return next();
      }

      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackendResponse(res, binding.backendId);
      }

      const requestUrl = typeof req.originalUrl === 'string' && req.originalUrl.length > 0
        ? req.originalUrl
        : (typeof req.url === 'string' ? req.url : '');

      if (binding.backendId === 'codex') {
        const parsed = new URL(requestUrl, 'http://127.0.0.1');
        const encodedSessionId = encodeURIComponent(sessionId);
        const suffix = parsed.pathname.startsWith(`/api/session/${encodedSessionId}`)
          ? parsed.pathname.slice(`/api/session/${encodedSessionId}`.length)
          : '';

        const codexRuntimeDetail = backendRegistry.getRuntime('codex');
        if (req.method === 'GET' && (suffix === '' || suffix === '/')) {
          const payload = await codexRuntimeDetail.getSession({
            sessionID: binding.backendSessionId,
          });
          if (!payload) {
            return res.status(404).json({ error: 'Session not found' });
          }
          return res.status(200).json(sessionBindingsRuntime.annotateSession(payload));
        }

        if (req.method === 'GET' && (suffix === '/message' || suffix === '/messages')) {
          const payload = await codexRuntimeDetail.getMessages({
            sessionID: binding.backendSessionId,
            limit: typeof req.query?.limit === 'string' ? Number(req.query.limit) : undefined,
            before: typeof req.query?.before === 'string' ? req.query.before : undefined,
          });
          return res.status(200).json(payload);
        }

        if (req.method === 'DELETE' && (suffix === '' || suffix === '/')) {
          const ok = await codexRuntimeDetail.deleteSession({
            sessionID: binding.backendSessionId,
          });
          if (ok) {
            await sessionBindingsRuntime.removeBinding(sessionId);
          }
          return res.status(ok ? 200 : 404).json(ok);
        }

        return res.status(501).json({
          error: `Session route "${suffix || '/'}" is not supported for backend "${binding.backendId}"`,
          backendId: binding.backendId,
          code: 'BACKEND_UNSUPPORTED',
        });
      }
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

  // --- Permission / Question routing for non-OpenCode backends ---
  // These handlers intercept permission and question replies that belong to
  // the Codex backend (or any future backend that manages its own
  // approval/question flow) before they fall through to the generic OpenCode
  // proxy.

  // Merge permission list from all backends.
  app.get('/api/permission', async (req, res, next) => {
    try {
      const codexRt = backendRegistry.getRuntime('codex');
      const codexPermissions = codexRt?.listPendingPermissions?.() ?? [];
      if (codexPermissions.length === 0) {
        return next(); // nothing to merge, let OpenCode handle it
      }

      // Fetch OpenCode permissions via upstream proxy
      let opencodePermissions = [];
      try {
        const target = resolveProxyTarget();
        if (target) {
          const authHeaders = getOpenCodeAuthHeaders();
          const url = new URL('/permission', target);
          if (req.query.directory) {
            url.searchParams.set('directory', String(req.query.directory));
          }
          const upstream = await fetch(url.toString(), {
            headers: {
              accept: 'application/json',
              ...(authHeaders.Authorization ? { Authorization: authHeaders.Authorization } : {}),
            },
          });
          if (upstream.ok) {
            opencodePermissions = await upstream.json();
            if (!Array.isArray(opencodePermissions)) {
              opencodePermissions = opencodePermissions?.data ?? [];
            }
          }
        }
      } catch {
        // OpenCode may not be available — that's fine
      }

      const merged = [...(Array.isArray(opencodePermissions) ? opencodePermissions : []), ...codexPermissions];
      return res.json(merged);
    } catch (error) {
      console.error('[proxy] permission list merge error:', error?.message ?? error);
      next();
    }
  });

  // Merge question list from all backends.
  app.get('/api/question', async (req, res, next) => {
    try {
      const codexRt = backendRegistry.getRuntime('codex');
      const codexQuestions = codexRt?.listPendingQuestions?.() ?? [];
      if (codexQuestions.length === 0) {
        return next();
      }

      let opencodeQuestions = [];
      try {
        const target = resolveProxyTarget();
        if (target) {
          const authHeaders = getOpenCodeAuthHeaders();
          const url = new URL('/question', target);
          if (req.query.directory) {
            url.searchParams.set('directory', String(req.query.directory));
          }
          const upstream = await fetch(url.toString(), {
            headers: {
              accept: 'application/json',
              ...(authHeaders.Authorization ? { Authorization: authHeaders.Authorization } : {}),
            },
          });
          if (upstream.ok) {
            opencodeQuestions = await upstream.json();
            if (!Array.isArray(opencodeQuestions)) {
              opencodeQuestions = opencodeQuestions?.data ?? [];
            }
          }
        }
      } catch {
        // OpenCode may not be available
      }

      const merged = [...(Array.isArray(opencodeQuestions) ? opencodeQuestions : []), ...codexQuestions];
      return res.json(merged);
    } catch (error) {
      console.error('[proxy] question list merge error:', error?.message ?? error);
      next();
    }
  });

  app.post('/api/permission/:requestID/reply', async (req, res, next) => {
    try {
      const requestID = req.params.requestID;
      if (!requestID) {
        return next();
      }
      const codexRt = backendRegistry.getRuntime('codex');
      if (codexRt?.hasPermissionRequest?.(requestID)) {
        const body = await parseJsonBody(req);
        const reply = body.reply || 'reject';
        const ok = codexRt.replyToPermission(requestID, reply);
        return res.json(ok);
      }
      next();
    } catch (error) {
      console.error('[proxy] permission reply routing error:', error?.message ?? error);
      next();
    }
  });

  app.post('/api/question/:requestID/reply', async (req, res, next) => {
    try {
      const requestID = req.params.requestID;
      if (!requestID) {
        return next();
      }
      const codexRt = backendRegistry.getRuntime('codex');
      if (codexRt?.hasQuestionRequest?.(requestID)) {
        const body = await parseJsonBody(req);
        const answers = body.answers || [];
        const ok = codexRt.replyToQuestion(requestID, answers);
        return res.json(ok);
      }
      next();
    } catch (error) {
      console.error('[proxy] question reply routing error:', error?.message ?? error);
      next();
    }
  });

  app.post('/api/question/:requestID/reject', async (req, res, next) => {
    try {
      const requestID = req.params.requestID;
      if (!requestID) {
        return next();
      }
      const codexRt = backendRegistry.getRuntime('codex');
      if (codexRt?.hasQuestionRequest?.(requestID)) {
        const ok = codexRt.rejectQuestion(requestID);
        return res.json(ok);
      }
      next();
    } catch (error) {
      console.error('[proxy] question reject routing error:', error?.message ?? error);
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
