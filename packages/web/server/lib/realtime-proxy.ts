import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeader, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Application, Query, Request } from './shared/http-contracts.js';
import type { RawData } from './shared/websocket-contracts.js';

export interface DesktopRuntimeConfig {
  apiBaseUrl?: unknown;
  requestHeaders?: unknown;
}

type RuntimeConfigReader = () => DesktopRuntimeConfig | null;
type ProxyRequest = IncomingMessage & { query?: Query };
type SessionResponse = { setHeader: (name: string, value: OutgoingHttpHeader) => void };

export interface RealtimeProxyOptions {
  app: Application | null;
  server: Server | null;
  getDesktopRuntimeConfig: RuntimeConfigReader | null;
  getUiAuthController?: () => {
    ensureSessionToken?: (req: IncomingMessage, res: SessionResponse) => string | null | Promise<string | null>;
  } | null;
  isRequestOriginAllowed?: (req: IncomingMessage) => boolean | Promise<boolean>;
}

const isHeaderString = (value: unknown): value is string => typeof value === 'string';
const isHeaderRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';

const PROXY_SSE_PATH = '/api/openchamber/realtime-proxy/sse';
const PROXY_WS_PATH = '/api/openchamber/realtime-proxy/ws';

const isAllowedSsePath = (pathname: string) => {
  return pathname === '/api/event'
    || pathname === '/api/global/event'
    || pathname === '/api/openchamber/events'
    || pathname === '/api/notifications/stream';
};

const SPACE_WS_PATH = /^\/api\/spaces\/[0-9a-f]{12}\/(?:terminal\/ws|event\/ws|global\/event\/ws)$/;

const isAllowedWebSocketPath = (pathname: string) => {
  return pathname === '/api/event/ws'
    || pathname === '/api/global/event/ws'
    || pathname === '/api/terminal/ws'
    || SPACE_WS_PATH.test(pathname);
};

const normalizeBaseUrl = (value: string | undefined) => {
  if (value === undefined) return '';
  return value.trim().replace(/\/+$/, '');
};

const sanitizeHeaders = (config: DesktopRuntimeConfig | null) => {
  const headers = config?.requestHeaders;
  if (!isHeaderRecord(headers)) return {};
  const next: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const value = isHeaderString(rawValue) ? rawValue.trim() : '';
    if (!name || !value || /[\r\n:]/.test(name) || /[\r\n]/.test(value)) continue;
    if (name.toLowerCase() === 'authorization') continue;
    next[name] = value;
  }
  return next;
};

const hasHeaders = (headers: Record<string, string>) => Object.keys(headers).length > 0;

const getTargetParam = (req: ProxyRequest) => {
  let raw = isHeaderString(req.query?.url) ? req.query.url : '';
  if (!raw) {
    try {
      raw = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('url') || '';
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

const urlsMatchRuntime = (target: URL, apiBaseUrl: string) => {
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

const protocolMatchesProxyType = (target: URL, type: 'ws' | 'sse') => {
  if (type === 'ws') return target.protocol === 'ws:' || target.protocol === 'wss:';
  return target.protocol === 'http:' || target.protocol === 'https:';
};

const pathMatchesProxyType = (target: URL, type: 'ws' | 'sse') => {
  return type === 'ws' ? isAllowedWebSocketPath(target.pathname) : isAllowedSsePath(target.pathname);
};

const resolveProxyTarget = (req: ProxyRequest, getDesktopRuntimeConfig: RuntimeConfigReader, type: 'ws' | 'sse') => {
  const config = getDesktopRuntimeConfig();
  const requestHeaders = sanitizeHeaders(config);
  const rawApiBaseUrl = config?.apiBaseUrl;
  const apiBaseUrl = normalizeBaseUrl(isHeaderString(rawApiBaseUrl) ? rawApiBaseUrl : undefined);
  const target = getTargetParam(req);
  if (!target || !apiBaseUrl || !hasHeaders(requestHeaders)) return null;
  if (!protocolMatchesProxyType(target, type)) return null;
  if (!pathMatchesProxyType(target, type)) return null;
  if (!urlsMatchRuntime(target, apiBaseUrl)) return null;
  return { target, requestHeaders };
};

const safeHeader = (headers: IncomingHttpHeaders, name: string) => {
  const value = headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.find((item) => isHeaderString(item) && item.trim()) || '';
  return isHeaderString(value) ? value.trim() : '';
};

const buildSseRequestHeaders = (req: Request, requestHeaders: Record<string, string>) => {
  const headers: Record<string, string> = {};
  const accept = safeHeader(req.headers, 'accept');
  const lastEventId = safeHeader(req.headers, 'last-event-id');
  if (accept) headers.Accept = accept;
  if (lastEventId) headers['Last-Event-ID'] = lastEventId;
  return { ...headers, ...requestHeaders };
};

const rejectWebSocketUpgrade = (socket: Duplex, statusCode: number, message: string) => {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

export const buildRealtimeProxySseUrl = (localOrigin: string, targetUrl: string) => {
  const url = new URL(PROXY_SSE_PATH, localOrigin);
  url.searchParams.set('url', targetUrl);
  return url.toString();
};

export const buildRealtimeProxyWsUrl = (localOrigin: string, targetUrl: string) => {
  const url = new URL(PROXY_WS_PATH, localOrigin);
  url.searchParams.set('url', targetUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

export const attachRealtimeProxy = ({ app, server, getDesktopRuntimeConfig, getUiAuthController, isRequestOriginAllowed }: RealtimeProxyOptions) => {
  if (!app || !server || !getDesktopRuntimeConfig) {
    return { stop: () => {} };
  }

  const originAllowed = async (req: IncomingMessage) => {
    if (!isRequestOriginAllowed) return false;
    try {
      return await isRequestOriginAllowed(req);
    } catch {
      return false;
    }
  };

  const ensureAuthenticated = async (req: IncomingMessage, res: SessionResponse | null) => {
    const controller = getUiAuthController ? getUiAuthController() : null;
    if (!controller?.ensureSessionToken) return false;
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

  const wsServer = new WebSocketServer({ noServer: true });

  wsServer.on('connection', (client, request) => {
    const resolved = resolveProxyTarget(request, getDesktopRuntimeConfig, 'ws');
    if (!resolved) {
      client.close(1008, 'Realtime proxy is unavailable');
      return;
    }

    const upstream = new WebSocket(resolved.target.toString(), {
      headers: resolved.requestHeaders,
      origin: `${resolved.target.protocol === 'wss:' ? 'https:' : 'http:'}//${resolved.target.host}`,
    });
    const pending: [RawData, boolean][] = [];

    const flush = () => {
      while (pending.length > 0 && upstream.readyState === WebSocket.OPEN) {
        const frame = pending.shift();
        if (!frame) break;
        const [data, isBinary] = frame;
        upstream.send(data, { binary: isBinary });
      }
    };

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }
      if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push([data, isBinary]);
      }
    });
    upstream.on('open', flush);
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    upstream.on('close', (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code || 1000, reason);
      }
    });
    upstream.on('error', () => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(1011, 'Realtime proxy upstream error');
      }
    });
    client.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
  });

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
