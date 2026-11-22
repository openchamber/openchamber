import { WebSocket, WebSocketServer } from 'ws';

const PROXY_SSE_PATH = '/api/openchamber/realtime-proxy/sse';
const PROXY_WS_PATH = '/api/openchamber/realtime-proxy/ws';
/** A handshake that has not completed by now is not going to (dev-tunnel precedent). */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Bytes one client may queue while its upstream is still connecting. The cap
 * holds at least one largest legitimate client frame (the 1 MiB maxPayload
 * below): a smaller cap dropped a single at-cap frame with 1013 "queue is
 * full" whenever it raced the upstream handshake (#1394). */
const MAX_PENDING_BYTES = 1024 * 1024;
/** A peer further behind than this after connect is closed as too slow (event-stream precedent). */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/**
 * Largest single WebSocket frame the proxy accepts from a client. ws
 * assembles a whole message before 'message' fires, so without an explicit
 * maxPayload one frame up to the ws default of 100 MiB was assembled and
 * forwarded whole, bypassing the post-assembly caps above (#1109). Sized
 * above the dictation 512 KiB legitimate-audio-frame precedent and far
 * below the 100 MiB default. Under Node the ws layer refuses an oversized
 * frame (close 1009) before assembly; under Bun the bundled ws does not
 * enforce maxPayload, so the message handler below ALSO checks the
 * assembled size and drops the pair before the frame is forwarded or
 * queued (dev-tunnel #1082 precedent). Either way no oversized frame is
 * ever forwarded.
 */
export const REALTIME_PROXY_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Largest single WebSocket frame the proxy accepts from its upstream
 * (#1249). The upstream direction carries OpenCode event and terminal
 * payloads, which legitimately exceed the client-direction cap above, so
 * this bound is larger: it equals MAX_BUFFERED_BYTES, the most the pair
 * would ever hold for a peer that stopped draining — a larger single
 * frame could never be forwarded without tripping that too-slow close,
 * so it is refused at assembly instead (dev-tunnel MAX_FRAME_BYTES
 * precedent). Under Node the ws layer refuses an oversized frame (close
 * 1009) before assembly; under Bun the bundled ws does not enforce
 * maxPayload, so the upstream message handler ALSO checks the assembled
 * size and drops the pair before the frame is forwarded. Either way no
 * oversized upstream frame is ever forwarded.
 */
export const REALTIME_PROXY_UPSTREAM_WS_MAX_PAYLOAD_BYTES = MAX_BUFFERED_BYTES;

const isAllowedSsePath = (pathname) => {
  return pathname === '/api/event'
    || pathname === '/api/global/event'
    || pathname === '/api/openchamber/events'
    || pathname === '/api/notifications/stream';
};

// The same three sockets of an isolated space, under `/api/spaces/<id>/`, matched by shape.
const SPACE_WS_PATH = /^\/api\/spaces\/[0-9a-f]{12}\/(?:terminal\/ws|event\/ws|global\/event\/ws)$/;

const isAllowedWebSocketPath = (pathname) => {
  return pathname === '/api/event/ws'
    || pathname === '/api/global/event/ws'
    || pathname === '/api/terminal/ws'
    || SPACE_WS_PATH.test(pathname);
};

const normalizeBaseUrl = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
};

const sanitizeHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return {};
  const next = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!name || !value || /[\r\n:]/.test(name) || /[\r\n]/.test(value)) continue;
    if (name.toLowerCase() === 'authorization') continue;
    next[name] = value;
  }
  return next;
};

const hasHeaders = (headers) => Object.keys(headers).length > 0;

const getTargetParam = (req) => {
  // A repeated url parameter is ambiguous: never silently select its
  // first value (#2324; the resolveDirectoryQuery precedent in the git
  // routes). Express surfaces a repeat as an array; the raw-URL fallback
  // below counts the values instead of taking the first.
  if (Array.isArray(req.query?.url)) return null;
  let raw = typeof req.query?.url === 'string' ? req.query.url : '';
  if (!raw) {
    try {
      const values = new URL(req.url || '/', 'http://127.0.0.1').searchParams.getAll('url');
      if (values.length > 1) return null;
      raw = values[0] || '';
    } catch {
      raw = '';
    }
  }
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const urlsMatchRuntime = (target, apiBaseUrl) => {
  const base = normalizeBaseUrl(apiBaseUrl);
  if (!base) return false;
  try {
    const baseUrl = new URL(base);
    const targetForCompare = new URL(target.toString());
    if (targetForCompare.protocol === 'ws:') targetForCompare.protocol = 'http:';
    if (targetForCompare.protocol === 'wss:') targetForCompare.protocol = 'https:';
    return targetForCompare.origin === baseUrl.origin;
  } catch {
    return false;
  }
};

const protocolMatchesProxyType = (target, type) => {
  if (type === 'ws') return target.protocol === 'ws:' || target.protocol === 'wss:';
  return target.protocol === 'http:' || target.protocol === 'https:';
};

const pathMatchesProxyType = (target, type) => {
  return type === 'ws' ? isAllowedWebSocketPath(target.pathname) : isAllowedSsePath(target.pathname);
};

const resolveProxyTarget = (req, getDesktopRuntimeConfig, type) => {
  const config = typeof getDesktopRuntimeConfig === 'function' ? getDesktopRuntimeConfig() : null;
  const requestHeaders = sanitizeHeaders(config?.requestHeaders);
  const apiBaseUrl = normalizeBaseUrl(config?.apiBaseUrl);
  const target = getTargetParam(req);
  if (!target || !apiBaseUrl || !hasHeaders(requestHeaders)) return null;
  if (!protocolMatchesProxyType(target, type)) return null;
  if (!pathMatchesProxyType(target, type)) return null;
  if (!urlsMatchRuntime(target, apiBaseUrl)) return null;
  return { target, requestHeaders };
};

const safeHeader = (headers, name) => {
  const value = headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.find((item) => typeof item === 'string' && item.trim()) || '';
  return typeof value === 'string' ? value.trim() : '';
};

const buildSseRequestHeaders = (req, requestHeaders) => {
  const headers = {};
  const accept = safeHeader(req.headers, 'accept');
  const lastEventId = safeHeader(req.headers, 'last-event-id');
  if (accept) headers.Accept = accept;
  if (lastEventId) headers['Last-Event-ID'] = lastEventId;
  return { ...headers, ...requestHeaders };
};

const rejectWebSocketUpgrade = (socket, statusCode, message) => {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

export const buildRealtimeProxySseUrl = (localOrigin, targetUrl) => {
  const url = new URL(PROXY_SSE_PATH, localOrigin);
  url.searchParams.set('url', targetUrl);
  return url.toString();
};

export const buildRealtimeProxyWsUrl = (localOrigin, targetUrl) => {
  const url = new URL(PROXY_WS_PATH, localOrigin);
  url.searchParams.set('url', targetUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

export const attachRealtimeProxy = ({ app, server, getDesktopRuntimeConfig, getUiAuthController, isRequestOriginAllowed, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS, maxPendingBytes = MAX_PENDING_BYTES, maxBufferedBytes = MAX_BUFFERED_BYTES }) => {
  if (!app || !server || typeof getDesktopRuntimeConfig !== 'function') {
    return { stop: () => {} };
  }

  const originAllowed = async (req) => {
    if (typeof isRequestOriginAllowed !== 'function') return false;
    try {
      return await isRequestOriginAllowed(req);
    } catch {
      return false;
    }
  };

  const ensureAuthenticated = async (req, res) => {
    const controller = typeof getUiAuthController === 'function' ? getUiAuthController() : null;
    if (typeof controller?.ensureSessionToken !== 'function') return false;
    const response = res || { setHeader: () => {} };
    const token = await controller.ensureSessionToken(req, response);
    return Boolean(token);
  };

  app.get(PROXY_SSE_PATH, async (req, res) => {
    if (!await ensureAuthenticated(req, res)) {
      res.status(401).json({ error: 'UI authentication required' });
      return;
    }
    if (!await originAllowed(req)) {
      res.status(403).json({ error: 'Realtime proxy origin is not allowed' });
      return;
    }
    const resolved = resolveProxyTarget(req, getDesktopRuntimeConfig, 'sse');
    if (!resolved) {
      res.status(404).json({ error: 'Realtime proxy is unavailable' });
      return;
    }

    const abort = new AbortController();
    req.on('close', () => abort.abort());
    try {
      const response = await fetch(resolved.target.toString(), {
        headers: buildSseRequestHeaders(req, resolved.requestHeaders),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        res.status(response.status || 502).end();
        return;
      }

      res.status(response.status);
      res.setHeader('Content-Type', response.headers.get('content-type') || 'text/event-stream');
      res.setHeader('Cache-Control', response.headers.get('cache-control') || 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      for await (const chunk of response.body) {
        if (abort.signal.aborted) break;
        res.write(chunk);
      }
      res.end();
    } catch (error) {
      if (!abort.signal.aborted && !res.headersSent) {
        res.status(502).json({ error: error instanceof Error ? error.message : 'Realtime proxy failed' });
      } else if (!res.destroyed) {
        res.end();
      }
    }
  });

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: REALTIME_PROXY_WS_MAX_PAYLOAD_BYTES });

  wsServer.on('connection', (client, request) => {
    const resolved = resolveProxyTarget(request, getDesktopRuntimeConfig, 'ws');
    if (!resolved) {
      client.close(1008, 'Realtime proxy is unavailable');
      return;
    }

    const upstream = new WebSocket(resolved.target.toString(), {
      headers: resolved.requestHeaders,
      // ws does not send Origin by default; protected upstreams require it.
      origin: `${resolved.target.protocol === 'wss:' ? 'https:' : 'http:'}//${resolved.target.host}`,
      // A wedged remote must fail the pair, not hold it open forever.
      handshakeTimeout: handshakeTimeoutMs,
      // Bound upstream frames at assembly (#1249); the message handler
      // below re-checks because maxPayload is not enforced everywhere.
      maxPayload: REALTIME_PROXY_UPSTREAM_WS_MAX_PAYLOAD_BYTES,
    });

    // The ws handshake timeout is not honoured on every runtime this
    // server runs on, so the bound is also kept here (dev-tunnel keeps its
    // own timer for the same reason): expiry kills the attempt and fails
    // the client instead of leaving its session open on a dead remote.
    const handshakeTimer = setTimeout(() => {
      try { upstream.terminate(); } catch { /* already gone */ }
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        try { client.close(1011, 'Realtime proxy upstream handshake timed out'); } catch { /* already closing */ }
      }
    }, handshakeTimeoutMs);
    upstream.once('open', () => clearTimeout(handshakeTimer));
    upstream.once('error', () => clearTimeout(handshakeTimer));
    upstream.once('close', () => clearTimeout(handshakeTimer));
    client.once('close', () => clearTimeout(handshakeTimer));
    const pending = [];
    let pendingBytes = 0;

    const closePair = (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        try { client.close(code, reason); } catch { /* already closing */ }
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        try { upstream.close(); } catch { /* already closing */ }
      }
    };

    // Forwarding ignores how far behind the receiving peer is falling;
    // past the bound the pair is closed instead of buffering without limit.
    // The amount is read before the send: after a send it still holds the
    // frame just queued plus its header bytes, so a single at-cap frame
    // would always trip a bound equal to the frame cap (#1394).
    const closeIfPeerTooSlow = (peer, bufferedAmountBeforeSend) => {
      if (bufferedAmountBeforeSend <= maxBufferedBytes) return;
      closePair(1013, 'Realtime proxy peer is too slow');
    };

    const flush = () => {
      while (pending.length > 0 && upstream.readyState === WebSocket.OPEN) {
        const [data, isBinary] = pending.shift();
        upstream.send(data, { binary: isBinary });
      }
      pendingBytes = 0;
    };

    client.on('message', (data, isBinary) => {
      // Per-frame bound (#1109): maxPayload alone is not enforced by the
      // bundled ws under every runtime (Bun delivers the oversized message
      // whole), so refuse it here — before it is forwarded or queued —
      // with the same 1009 the ws layer would have used.
      if (data.length > REALTIME_PROXY_WS_MAX_PAYLOAD_BYTES) {
        closePair(1009, 'Realtime proxy frame too large');
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        const bufferedAmountBeforeSend = upstream.bufferedAmount;
        upstream.send(data, { binary: isBinary });
        closeIfPeerTooSlow(upstream, bufferedAmountBeforeSend);
        return;
      }
      if (upstream.readyState === WebSocket.CONNECTING) {
        pendingBytes += data.length;
        if (pendingBytes > maxPendingBytes) {
          // The handshake is stalled and the queue is full: drop the pair
          // rather than hold every byte until the remote recovers, and
          // never flush what was queued.
          pending.length = 0;
          pendingBytes = 0;
          try { upstream.terminate(); } catch { /* already gone */ }
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            try { client.close(1013, 'Realtime proxy queue is full'); } catch { /* already closing */ }
          }
          return;
        }
        pending.push([data, isBinary]);
      }
    });
    upstream.on('open', flush);
    upstream.on('message', (data, isBinary) => {
      // Per-frame bound (#1249): maxPayload alone is not enforced by the
      // bundled ws under every runtime (Bun delivers the oversized message
      // whole), so refuse it here — before it is forwarded — with the
      // same 1009 the ws layer would have used.
      if (data.length > REALTIME_PROXY_UPSTREAM_WS_MAX_PAYLOAD_BYTES) {
        closePair(1009, 'Realtime proxy upstream frame too large');
        return;
      }
      if (client.readyState === WebSocket.OPEN) {
        const bufferedAmountBeforeSend = client.bufferedAmount;
        client.send(data, { binary: isBinary });
        closeIfPeerTooSlow(client, bufferedAmountBeforeSend);
      }
    });
    upstream.on('close', (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code || 1000, reason);
      }
    });
    upstream.on('error', (error) => {
      // Where the ws layer DOES enforce the upstream maxPayload (Node),
      // the refusal surfaces here as a RangeError instead of a 'message'
      // event; the pair still closes with the same 1009 (#1249).
      if (error instanceof RangeError && /max payload/i.test(error.message)) {
        closePair(1009, 'Realtime proxy upstream frame too large');
        return;
      }
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(1011, 'Realtime proxy upstream error');
      }
    });
    client.on('error', (error) => {
      // Where the ws layer DOES enforce the client maxPayload (Node), the
      // refusal surfaces here as a RangeError instead of a 'message' event;
      // the pair still closes with the same 1009 (#1394, client-direction
      // counterpart of the upstream handler above). Without this handler
      // the RangeError escapes as an uncaught exception.
      if (error instanceof RangeError && /max payload/i.test(error.message)) {
        closePair(1009, 'Realtime proxy frame too large');
        return;
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        try { upstream.close(); } catch { /* already closing */ }
      }
    });
    client.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
  });

  const upgradeHandler = (req, socket, head) => {
    const pathname = (() => {
      try { return new URL(req.url || '/', 'http://127.0.0.1').pathname; } catch { return ''; }
    })();
    if (pathname !== PROXY_WS_PATH) return;
    void ensureAuthenticated(req, null).then((authenticated) => {
      if (!authenticated) {
        rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      void originAllowed(req).then((allowed) => {
        if (!allowed) {
          rejectWebSocketUpgrade(socket, 403, 'Forbidden');
          return;
        }
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      }).catch(() => {
        rejectWebSocketUpgrade(socket, 403, 'Forbidden');
      });
    }).catch(() => {
      rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
    });
  };

  server.on('upgrade', upgradeHandler);
  return {
    stop: () => {
      server.off('upgrade', upgradeHandler);
      wsServer.close();
    },
  };
};
