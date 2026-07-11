// OpenCode proxy for Daytona sandboxes.
//
// Routes requests from the frontend to the OpenCode instance running inside
// each sandbox. Implements SSE forwarding, message posting, and generic
// OpenCode API proxying. Follows the pattern from opencode/proxy.js adapted
// for multi-sandbox routing.

import { createProxyMiddleware } from 'http-proxy-middleware';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Register Daytona sandbox OpenCode proxy routes.
 *
 * @param {import('express').Application} app - Express application instance.
 * @param {{
 *   daytonaService: ReturnType<typeof import('./service.js').createDaytonaService>,
 *   logger?: Pick<Console, 'log' | 'warn' | 'error'>,
 * }} dependencies
 */
export const registerDaytonaProxyRoutes = (app, { daytonaService, logger = console }) => {
  const { registry, monitor } = daytonaService;

  /**
   * Middleware to resolve the sandbox entry from the sessionId param.
   * Attaches the entry to req.daytonaSandbox for downstream handlers.
   */
  const resolveSandbox = (req, res, next) => {
    const { sessionId } = req.params;
    const entry = registry.get(sessionId);

    if (!entry) {
      return res.status(404).json({ error: 'No sandbox found for this session' });
    }

    req.daytonaSandbox = entry;
    // Reset activity on every proxy request
    monitor.resetTimer(sessionId);
    next();
  };

  // GET /api/daytona/sandbox/:sessionId/event - SSE forwarder from sandbox OpenCode.
  app.get('/api/daytona/sandbox/:sessionId/event', resolveSandbox, async (req, res) => {
    const { daytonaSandbox } = req;
    const abortController = new AbortController();
    let upstream = null;
    let reader = null;

    const closeUpstream = () => abortController.abort();
    req.on('close', closeUpstream);

    try {
      const upstreamUrl = `${daytonaSandbox.openCodeUrl}/event`;

      upstream = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          'cache-control': 'no-cache',
        },
        signal: abortController.signal,
      });

      if (!upstream.ok) {
        if (!res.headersSent) {
          res.status(upstream.status).json({ error: 'Upstream sandbox OpenCode returned an error' });
        }
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true);
      }

      if (!upstream.body) {
        res.end();
        return;
      }

      reader = upstream.body.getReader();
      while (!abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          const flushed = res.write(value);
          if (flushed === false) {
            await new Promise((resolve) => res.once('drain', resolve));
          }
        }
      }

      res.end();
    } catch (error) {
      if (error?.name === 'AbortError') return;
      logger.error(`[Daytona Proxy] SSE proxy error for session ${daytonaSandbox.sessionId}: ${error?.message ?? error}`);
      if (!res.headersSent) {
        res.status(503).json({ error: 'Sandbox OpenCode service unavailable' });
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
        // Ignore cleanup errors
      }
    }
  });

  // POST /api/daytona/sandbox/:sessionId/message - Message forwarder to sandbox OpenCode.
  app.post('/api/daytona/sandbox/:sessionId/message', resolveSandbox, async (req, res) => {
    const { daytonaSandbox } = req;

    try {
      const upstreamUrl = `${daytonaSandbox.openCodeUrl}/message`;

      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(req.body),
      });

      const contentType = upstream.headers.get('content-type') || 'application/json';
      res.status(upstream.status);
      res.setHeader('content-type', contentType);

      const bodyText = await upstream.text();
      res.end(bodyText);
    } catch (error) {
      logger.error(`[Daytona Proxy] Message proxy error for session ${daytonaSandbox.sessionId}: ${error?.message ?? error}`);
      if (!res.headersSent) {
        res.status(503).json({ error: 'Sandbox OpenCode service unavailable' });
      }
    }
  });

  // ALL /api/daytona/sandbox/:sessionId/opencode/* - Generic OpenCode API proxy.
  // Uses http-proxy-middleware for pass-through proxying of any OpenCode API call.
  app.use('/api/daytona/sandbox/:sessionId/opencode', resolveSandbox, (req, res, next) => {
    const { daytonaSandbox } = req;
    const target = daytonaSandbox.openCodeUrl;

    // Create a per-request proxy since each sandbox has a different target.
    const proxy = createProxyMiddleware({
      target,
      changeOrigin: true,
      pathRewrite: (_path, proxyReq) => {
        // Strip the prefix to get the path OpenCode expects.
        // e.g. /api/daytona/sandbox/abc123/opencode/session -> /session
        const prefix = `/api/daytona/sandbox/${daytonaSandbox.sessionId}/opencode`;
        const rewritten = proxyReq.originalUrl?.replace(prefix, '') || '/';
        return rewritten;
      },
      on: {
        proxyReq: (proxyReq, clientReq) => {
          // Replay parsed body for JSON requests
          if (clientReq.body && typeof clientReq.body === 'object' && Object.keys(clientReq.body).length > 0) {
            const bodyData = JSON.stringify(clientReq.body);
            proxyReq.setHeader('content-type', 'application/json');
            proxyReq.setHeader('content-length', Buffer.byteLength(bodyData).toString());
            proxyReq.write(bodyData);
          }
        },
        error: (err, _req, proxyRes) => {
          logger.error(`[Daytona Proxy] Generic proxy error for session ${daytonaSandbox.sessionId}: ${err?.message ?? err}`);
          if (proxyRes && !proxyRes.headersSent && typeof proxyRes.status === 'function') {
            proxyRes.status(503).json({ error: 'Sandbox OpenCode service unavailable' });
          }
        },
      },
    });

    proxy(req, res, next);
  });
};

const DAYTONA_WS_PATH_PREFIX = '/api/daytona/sandbox/';
const DAYTONA_WS_PATH_SUFFIX = '/ws';

/**
 * Attach a WebSocket upgrade handler to the HTTP server for proxying
 * WebSocket connections to OpenCode inside Daytona sandboxes.
 *
 * @param {import('http').Server} server - The HTTP server instance.
 * @param {{
 *   daytonaService: ReturnType<typeof import('./service.js').createDaytonaService>,
 *   logger?: Pick<Console, 'log' | 'warn' | 'error'>,
 * }} dependencies
 * @returns {{ shutdown: () => void }}
 */
export const attachDaytonaWsProxy = (server, { daytonaService, logger = console }) => {
  const { registry, monitor } = daytonaService;

  const wss = new WebSocketServer({ noServer: true });

  const parseSessionIdFromUrl = (url) => {
    if (!url || !url.startsWith(DAYTONA_WS_PATH_PREFIX)) return null;
    const rest = url.slice(DAYTONA_WS_PATH_PREFIX.length);
    // rest should be "<sessionId>/ws" or "<sessionId>/ws?..."
    const slashIdx = rest.indexOf('/');
    if (slashIdx < 0) return null;
    const sessionId = rest.slice(0, slashIdx);
    const remainder = rest.slice(slashIdx);
    if (remainder === DAYTONA_WS_PATH_SUFFIX || remainder.startsWith(DAYTONA_WS_PATH_SUFFIX + '?')) {
      return sessionId;
    }
    return null;
  };

  const upgradeHandler = (req, socket, head) => {
    const url = req.url || '';
    const sessionId = parseSessionIdFromUrl(url);
    if (!sessionId) return; // Not a Daytona WS path, let other handlers handle it

    const entry = registry.get(sessionId);
    if (!entry) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    monitor.resetTimer(sessionId);

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      // Connect to the OpenCode WebSocket inside the sandbox
      const upstreamWsUrl = entry.openCodeUrl.replace(/^http/, 'ws') + '/ws';
      let upstream = null;

      try {
        upstream = new WebSocket(upstreamWsUrl);
      } catch (error) {
        logger.error(`[Daytona WS] Failed to connect upstream for session ${sessionId}: ${error?.message ?? error}`);
        clientWs.close(1011, 'Upstream connection failed');
        return;
      }

      upstream.on('open', () => {
        logger.log(`[Daytona WS] Upstream connected for session ${sessionId}`);
      });

      upstream.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data);
        }
      });

      upstream.on('close', (code, reason) => {
        if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
          clientWs.close(code || 1000, reason || '');
        }
      });

      upstream.on('error', (error) => {
        logger.error(`[Daytona WS] Upstream error for session ${sessionId}: ${error?.message ?? error}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1011, 'Upstream error');
        }
      });

      clientWs.on('message', (data) => {
        monitor.resetTimer(sessionId);
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data);
        }
      });

      clientWs.on('close', () => {
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          upstream.close();
        }
      });

      clientWs.on('error', (error) => {
        logger.error(`[Daytona WS] Client error for session ${sessionId}: ${error?.message ?? error}`);
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.close();
        }
      });
    });
  };

  server.on('upgrade', upgradeHandler);

  const shutdown = () => {
    server.removeListener('upgrade', upgradeHandler);
    wss.close();
  };

  return { shutdown };
};
