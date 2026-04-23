import { describe, expect, it } from 'bun:test';

import { registerNotificationRoutes } from './lib/notifications/routes.js';
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
  let statusCode = 200;
  let body = '';
  let flushed = false;

  return {
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    flushHeaders() {
      flushed = true;
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
  };
};

describe('local SSE routes', () => {
  it('serves notification SSE with nginx-safe headers', async () => {
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();

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

    req.emit('close');
    expect(clients.has(res)).toBe(false);
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
