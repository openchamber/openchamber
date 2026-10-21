import http from 'node:http';

import { describe, expect, it } from 'vitest';

import { createUpstreamReadSignal, registerOpenCodeProxy } from './proxy.js';

/**
 * A response double for the session routes. `close` is what a finished
 * response and a client that hung up both produce, and the two differ in
 * `writableEnded`: a finished response has ended, a client that went away
 * never got one.
 */
const createResponseDouble = () => {
  const listeners = new Map();
  const response = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(payload) {
      response.body = payload;
      response.headersSent = true;
      response.writableEnded = true;
      return response;
    },
    setHeader(name, value) {
      response.headers[name] = value;
    },
    end(text) {
      response.body = text;
      response.headersSent = true;
      response.writableEnded = true;
    },
    once(event, handler) {
      listeners.set(event, handler);
      return response;
    },
    off(event, handler) {
      if (listeners.get(event) === handler) listeners.delete(event);
      return response;
    },
    emit(event) {
      listeners.get(event)?.();
    },
    listenerCount(event) {
      return listeners.has(event) ? 1 : 0;
    },
  };
  return response;
};

const createRequestDouble = (url = '/api/session', headers = {}) => ({
  method: 'GET',
  headers,
  originalUrl: url,
  url,
  get: (name) => headers[String(name).toLowerCase()],
  on: () => undefined,
  off: () => undefined,
});

/**
 * An app that keeps the route handlers instead of dropping them, so a test
 * can call the session routes the way Express would.
 */
const createRecordingApp = () => {
  const routes = new Map();
  return {
    routes,
    get: (path, handler) => {
      if (typeof handler === 'function') routes.set(path, handler);
    },
    set: () => {},
    use: () => {},
    post: () => {},
    put: () => {},
    patch: () => {},
    delete: () => {},
    all: () => {},
  };
};

const createStubDeps = (baseUrl, { realpath, getArchivedSessions, getStoredSessionMetadata } = {}) => ({
  fs: { promises: { realpath: realpath ?? (async (value) => value) } },
  os: {},
  path: {},
  OPEN_CODE_READY_GRACE_MS: 0,
  LONG_REQUEST_TIMEOUT_MS: 1_000,
  // A short bound so the test does not wait out the production 10s.
  SESSION_UPSTREAM_TIMEOUT_MS: 200,
  getRuntime: () => ({ openCodePort: null, openCodeBaseUrl: baseUrl }),
  getOpenCodeAuthHeaders: () => ({}),
  buildOpenCodeUrl: (pathname) => `${baseUrl}${pathname}`,
  ensureOpenCodeApiPrefix: (pathname) => pathname,
  getArchivedSessions,
  getStoredSessionMetadata,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createUpstreamReadSignal', () => {
  it('ends the read when it takes longer than the timeout', async () => {
    const signal = createUpstreamReadSignal({ timeoutMs: 20 });

    await delay(60);

    expect(signal.aborted).toBe(true);
    // The timeout and a client that hung up have to stay distinguishable:
    // the timeout is a 504 for the caller, a hangup has nobody to answer.
    expect(signal.reason?.name).toBe('TimeoutError');
  });

  it('ends the read when the client goes away mid-request', () => {
    const res = createResponseDouble();
    const signal = createUpstreamReadSignal({ res, timeoutMs: 10_000 });

    res.emit('close');

    expect(signal.aborted).toBe(true);
    expect(signal.reason?.name).toBe('AbortError');
  });

  it('leaves a finished response alone', () => {
    const res = createResponseDouble();
    const signal = createUpstreamReadSignal({ res, timeoutMs: 10_000 });

    // A response that ended normally closes too, and must not cancel the read.
    res.writableEnded = true;
    res.emit('close');

    expect(signal.aborted).toBe(false);
  });

  it('ends the read when the response was already gone', () => {
    const res = createResponseDouble();
    res.destroyed = true;

    const signal = createUpstreamReadSignal({ res, timeoutMs: 10_000 });

    expect(signal.aborted).toBe(true);
    expect(signal.reason?.name).toBe('AbortError');
  });

  it('stops listening for the client once the read ended', () => {
    const res = createResponseDouble();
    const signal = createUpstreamReadSignal({ res, timeoutMs: 10_000 });

    expect(res.listenerCount('close')).toBe(1);

    res.emit('close');

    expect(signal.aborted).toBe(true);
    // The listener is gone, so a later close cannot abort twice.
    expect(res.listenerCount('close')).toBe(0);
  });
});

describe('session routes bound their upstream read', () => {
  const withUpstream = async (run) => {
    const hits = [];
    // An upstream that accepts the connection and never answers.
    const upstream = http.createServer((req) => {
      hits.push(req.url);
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    try {
      await run(baseUrl, hits);
    } finally {
      upstream.close();
      upstream.closeAllConnections?.();
    }
  };

  it('answers 504 instead of waiting forever when OpenCode does not answer', async () => {
    await withUpstream(async (baseUrl) => {
      const app = createRecordingApp();
      registerOpenCodeProxy(app, createStubDeps(baseUrl));
      const handler = app.routes.get('/api/session');
      expect(handler).toBeTypeOf('function');

      const res = createResponseDouble();
      const started = Date.now();
      await handler(createRequestDouble('/api/session'), res, () => {});

      expect(res.statusCode).toBe(504);
      expect(res.body).toEqual({ error: 'OpenCode upstream timed out' });
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  }, 30_000);

  it('answers 504 for a session detail read that never arrives', async () => {
    await withUpstream(async (baseUrl) => {
      const app = createRecordingApp();
      // The detail route only intercepts when an overlay reader is present.
      registerOpenCodeProxy(
        app,
        createStubDeps(baseUrl, { getArchivedSessions: async () => null, getStoredSessionMetadata: async () => null }),
      );
      const handler = app.routes.get('/api/session/:sessionID');
      expect(handler).toBeTypeOf('function');

      const res = createResponseDouble();
      await handler(createRequestDouble('/api/session/ses_1'), res, () => {});

      expect(res.statusCode).toBe(504);
      expect(res.body).toEqual({ error: 'OpenCode upstream timed out' });
    });
  }, 30_000);

  it('answers 504 for a session message page that never arrives', async () => {
    await withUpstream(async (baseUrl) => {
      const app = createRecordingApp();
      registerOpenCodeProxy(app, createStubDeps(baseUrl));
      const handler = app.routes.get('/api/session/:sessionID/message');
      expect(handler).toBeTypeOf('function');

      const res = createResponseDouble();
      await handler(
        // The shelled message route only handles the request when the client
        // asks for shelled parts; without the header it falls through to the
        // generic proxy.
        createRequestDouble('/api/session/ses_1/message', { 'x-openchamber-part-shells': 'v1' }),
        res,
        () => {},
      );

      expect(res.statusCode).toBe(504);
      expect(res.body).toEqual({ error: 'OpenCode upstream timed out' });
    });
  }, 30_000);

  it('answers 503 when the upstream fails for another reason', async () => {
    // Nothing is listening on this port, so the upstream read is refused.
    const app = createRecordingApp();
    registerOpenCodeProxy(app, createStubDeps('http://127.0.0.1:1'));
    const handler = app.routes.get('/api/session');
    expect(handler).toBeTypeOf('function');

    const res = createResponseDouble();
    await handler(createRequestDouble('/api/session'), res, () => {});

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'OpenCode service unavailable' });
  }, 30_000);

  it('stops waiting on the upstream read when the client hangs up', async () => {
    await withUpstream(async (baseUrl) => {
      const app = createRecordingApp();
      registerOpenCodeProxy(app, createStubDeps(baseUrl));
      const handler = app.routes.get('/api/session');
      expect(handler).toBeTypeOf('function');

      const res = createResponseDouble();
      const pending = handler(createRequestDouble('/api/session'), res, () => {});

      // The client goes away while OpenCode is still thinking.
      await delay(20);
      res.emit('close');
      await pending;

      // Nobody is left to answer, so the route stays silent.
      expect(res.statusCode).toBeNull();
      expect(res.body).toBeNull();
    });
  }, 30_000);

  it('does not start an upstream read when the client hangs up while the path is prepared', async () => {
    await withUpstream(async (baseUrl, hits) => {
      const app = createRecordingApp();
      registerOpenCodeProxy(
        app,
        createStubDeps(baseUrl, {
          // The path canonicalization waits on a realpath, so the client can
          // hang up before the read would have started.
          realpath: async (value) => {
            await delay(150);
            return value;
          },
        }),
      );
      const handler = app.routes.get('/api/session');
      expect(handler).toBeTypeOf('function');

      const res = createResponseDouble();
      const pending = handler(createRequestDouble('/api/session?directory=/delayed'), res, () => {});

      await delay(30);
      res.emit('close');
      await pending;

      expect(hits).toEqual([]);
      expect(res.statusCode).toBeNull();
    });
  }, 30_000);

  it('does not start an upstream read when the response was already gone', async () => {
    await withUpstream(async (baseUrl, hits) => {
      const app = createRecordingApp();
      registerOpenCodeProxy(app, createStubDeps(baseUrl));
      const handler = app.routes.get('/api/session');
      expect(handler).toBeTypeOf('function');

      const res = createResponseDouble();
      res.destroyed = true;
      await handler(createRequestDouble('/api/session'), res, () => {});

      expect(hits).toEqual([]);
      expect(res.statusCode).toBeNull();
    });
  }, 30_000);
});
