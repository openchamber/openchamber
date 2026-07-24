import { describe, expect, it, vi } from 'bun:test';

import { NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS, registerNotificationRoutes } from './lib/notifications/routes.js';
import { createRequestSecurityRuntime } from './lib/security/request-security.js';
import { registerScheduledTaskRoutes } from './lib/scheduled-tasks/routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(path, handler) {
        routes.set(`GET ${path}`, handler);
      },
      post(path, handler) {
        routes.set(`POST ${path}`, handler);
      },
      put(path, handler) {
        routes.set(`PUT ${path}`, handler);
      },
      delete(path, handler) {
        routes.set(`DELETE ${path}`, handler);
      },
    },
    getRoute(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
};

const createMockRequest = () => {
  const listeners = new Map();

  return {
    headers: {},
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    emit(event) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
  };
};

const createMockResponse = () => {
  const headers = new Map();
  const listeners = new Map();
  let statusCode = 200;
  let body = '';
  let flushed = false;
  let bodyFlushCount = 0;

  return {
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    emit(event) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    flushHeaders() {
      flushed = true;
    },
    flush() {
      bodyFlushCount += 1;
    },
    write(chunk) {
      body += String(chunk);
      return true;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body += JSON.stringify(payload);
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get flushed() {
      return flushed;
    },
    get bodyFlushCount() {
      return bodyFlushCount;
    },
  };
};

describe('local SSE routes', () => {
  it('serves push visibility for the configured UI session cookie', () => {
    const { app, getRoute } = createRouteRegistry();
    const requestSecurity = createRequestSecurityRuntime({
      readSettingsFromDiskMigrated: async () => ({}),
      uiSessionCookieName: 'oc_ui_session_3000',
    });
    const isUiVisible = vi.fn(() => true);

    registerNotificationRoutes(app, {
      getUiSessionTokenFromRequest: requestSecurity.getUiSessionTokenFromRequest,
      isUiVisible,
    });

    const handler = getRoute('GET', '/api/push/visibility');
    const req = createMockRequest();
    req.headers.cookie = 'oc_ui_session_3000=session-token';
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(isUiVisible).toHaveBeenCalledTimes(1);
    expect(isUiVisible).toHaveBeenCalledWith('session-token');
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      visible: true,
    });
  });

  it('serves notification SSE with nginx-safe headers', async () => {
    vi.useFakeTimers();
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();

    try {
      registerNotificationRoutes(app, {
        uiAuthController: {
          ensureSessionToken: async () => 'ui-token',
        },
        getUiSessionTokenFromRequest: () => 'ui-token',
        getUiNotificationClients: () => clients,
        writeSseEvent(res, payload) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
      });

      const handler = getRoute('GET', '/api/notifications/stream');
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.getHeader('content-type')).toContain('text/event-stream');
      expect(res.getHeader('cache-control')).toBe('no-cache, no-transform');
      expect(res.getHeader('connection')).toBe('keep-alive');
      expect(res.getHeader('x-accel-buffering')).toBe('no');
      expect(res.flushed).toBe(true);
      expect(res.body).toContain('openchamber:notification-stream-ready');
      expect(clients.has(res)).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      expect(res.bodyFlushCount).toBe(1);

      vi.advanceTimersByTime(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
      expect(res.body).toContain(':heartbeat\n\n');
      expect(res.bodyFlushCount).toBe(2);

      res.emit('error');
      expect(clients.has(res)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      const bodyAfterClose = res.body;
      vi.advanceTimersByTime(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
      expect(res.body).toBe(bodyAfterClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves OpenChamber SSE with nginx-safe headers', () => {
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();

    registerScheduledTaskRoutes(app, {
      getOpenChamberEventClients: () => clients,
      writeSseEvent(res, payload) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    });

    const handler = getRoute('GET', '/api/openchamber/events');
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/event-stream');
    expect(res.getHeader('cache-control')).toBe('no-cache, no-transform');
    expect(res.getHeader('connection')).toBe('keep-alive');
    expect(res.getHeader('x-accel-buffering')).toBe('no');
    expect(res.flushed).toBe(true);
    expect(res.body).toContain('openchamber:event-stream-ready');
    expect(clients.has(res)).toBe(true);

    req.emit('close');
    expect(clients.has(res)).toBe(false);
  });
});
