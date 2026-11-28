import { describe, expect, it, vi } from 'bun:test';

import { NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS, registerNotificationRoutes } from './lib/notifications/routes.js';
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
      patch(path, handler) {
        routes.set(`PATCH ${path}`, handler);
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

  it('beats the OpenChamber SSE at the interval the client asks for, held between 15 and 30 s', () => {
    vi.useFakeTimers();
    try {
      const { app, getRoute } = createRouteRegistry();
      registerScheduledTaskRoutes(app, {
        getOpenChamberEventClients: () => new Set(),
        writeSseEvent(res, payload) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
      });
      const handler = getRoute('GET', '/api/openchamber/events');
      const beatsInFiveMinutes = (heartbeat) => {
        const req = createMockRequest();
        req.query = heartbeat === undefined ? {} : { heartbeat };
        const res = createMockResponse();
        handler(req, res);
        vi.advanceTimersByTime(300_000);
        req.emit('close');
        return res.body.split('openchamber:heartbeat').length - 1;
      };

      // No parameter is a client built before it: the old 25 s.
      expect(beatsInFiveMinutes(undefined)).toBe(12);
      expect(beatsInFiveMinutes('25000')).toBe(12);
      expect(beatsInFiveMinutes('30000')).toBe(10);
      expect(beatsInFiveMinutes('15000')).toBe(20);
      expect(beatsInFiveMinutes('120000')).toBe(10);
      expect(beatsInFiveMinutes('1000')).toBe(20);
      expect(beatsInFiveMinutes('junk')).toBe(12);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
