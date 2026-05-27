import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { registerAggregateRoutes } from './aggregate-routes.js';

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: (opts) => ({
    baseUrl: opts?.baseUrl,
    health: { check: async () => true },
    session: { list: async () => [] },
  }),
}));

function createMockServerManager() {
  const servers = new Map();

  return {
    servers,
    listServers: mock(() => {
      return [...servers.values()].map((s) => ({
        id: s.id,
        label: s.label,
        type: s.type,
        status: s.status,
        url: s.url,
        errorMessage: s.errorMessage,
      }));
    }),
    getServer: mock((id) => servers.get(id) || null),
    getClient: mock((id) => servers.get(id)?.client ?? null),
    removeServer: mock((id) => {
      servers.delete(id);
    }),
    registerServer: mock((config) => {
      const existing = servers.get(config.id);
      if (existing) {
        if (config.client) {
          existing.client = config.client;
          existing.status = 'connecting';
          existing.errorMessage = null;
        } else {
          existing.refCount = (existing.refCount || 1) + 1;
        }
        return existing;
      }
      const entry = {
        id: config.id,
        label: config.label,
        type: config.type || 'remote-url',
        url: config.url || null,
        status: 'connecting',
        client: config.client || null,
        refCount: 1,
        errorMessage: null,
      };
      servers.set(config.id, entry);
      return entry;
    }),
    probeServer: mock(async (id) => {
      const s = servers.get(id);
      if (!s || !s.client?.health?.check) return false;
      return s.client.health.check();
    }),
    getGlobalSessions: mock(async (opts) => {
      const results = [];
      for (const s of servers.values()) {
        if (s.client?.session?.list) {
          const sessions = await s.client.session.list(opts);
          results.push(...sessions.map((sess) => ({ ...sess, serverId: s.id })));
        }
      }
      return { sessions: results, errors: [] };
    }),
  };
}

function createMockSseFanIn() {
  return {
    subscribeServer: mock(() => {}),
    unsubscribeServer: mock(() => {}),
  };
}

function createApp(serverManager, sseFanIn) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerAggregateRoutes(router, serverManager, sseFanIn);
  app.use(router);
  return app;
}

describe('aggregate-routes', () => {
  let serverManager;
  let sseFanIn;
  let app;

  beforeEach(() => {
    serverManager = createMockServerManager();
    sseFanIn = createMockSseFanIn();
    app = createApp(serverManager, sseFanIn);
  });

  describe('GET /api/servers', () => {
    test('returns server list', async () => {
      serverManager.registerServer({ id: 's1', label: 'Server 1', type: 'remote-url', url: 'http://a.com' });
      serverManager.registerServer({ id: 's2', label: 'Server 2', type: 'ssh', url: 'ssh://b.com' });

      const res = await request(app).get('/api/servers').expect(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toEqual({
        id: 's1',
        label: 'Server 1',
        type: 'remote-url',
        status: 'connecting',
        url: 'http://a.com',
        errorMessage: null,
      });
    });

    test('returns empty array when no servers', async () => {
      const res = await request(app).get('/api/servers').expect(200);
      expect(res.body).toEqual([]);
    });

    test('handles listServers error', async () => {
      serverManager.listServers = mock(() => { throw new Error('boom'); });
      const res = await request(app).get('/api/servers').expect(500);
      expect(res.body).toEqual({ error: 'boom' });
    });
  });

  describe('DELETE /api/servers/:serverId', () => {
    test('removes non-local server', async () => {
      serverManager.registerServer({ id: 's1', label: 'S1' });

      const res = await request(app).delete('/api/servers/s1').expect(200);
      expect(res.body).toEqual({ ok: true });
      expect(serverManager.removeServer).toHaveBeenCalledWith('s1');
    });

    test('returns 400 for local', async () => {
      const res = await request(app).delete('/api/servers/local').expect(400);
      expect(res.body).toEqual({ error: 'Cannot remove local server' });
    });

    test('returns 404 for non-existent server', async () => {
      const res = await request(app).delete('/api/servers/nonexistent').expect(404);
      expect(res.body.error).toContain('not found');
    });

    test('unsubscribes from SSE fan-in on removal', async () => {
      serverManager.registerServer({ id: 's1', label: 'S1' });

      await request(app).delete('/api/servers/s1').expect(200);
      expect(sseFanIn.unsubscribeServer).toHaveBeenCalledWith('s1');
    });

    test('handles removeServer error', async () => {
      serverManager.getServer = mock(() => ({ id: 's1' }));
      serverManager.removeServer = mock(() => { throw new Error('cleanup failed'); });

      const res = await request(app).delete('/api/servers/s1').expect(500);
      expect(res.body.error).toContain('cleanup failed');
    });
  });

  describe('GET /api/servers/:serverId/health', () => {
    test('returns health status for existing server', async () => {
      serverManager.registerServer({
        id: 's1',
        label: 'S1',
        client: { health: { check: mock(async () => true) } },
      });

      const res = await request(app).get('/api/servers/s1/health').expect(200);
      expect(res.body).toEqual({ serverId: 's1', healthy: true });
    });

    test('returns unhealthy for failing server', async () => {
      serverManager.registerServer({
        id: 's1',
        label: 'S1',
        client: { health: { check: mock(async () => false) } },
      });

      const res = await request(app).get('/api/servers/s1/health').expect(200);
      expect(res.body.healthy).toBe(false);
    });

    test('returns 404 for non-existent server', async () => {
      const res = await request(app).get('/api/servers/nonexistent/health').expect(404);
      expect(res.body.error).toContain('not found');
    });

    test('handles probeServer error', async () => {
      serverManager.registerServer({ id: 's1', label: 'S1' });
      serverManager.probeServer = mock(async () => { throw new Error('probe failed'); });

      const res = await request(app).get('/api/servers/s1/health').expect(500);
      expect(res.body.error).toContain('probe failed');
    });
  });

  describe('GET /api/servers/all/sessions', () => {
    test('returns aggregated sessions', async () => {
      serverManager.registerServer({
        id: 's1',
        label: 'S1',
        type: 'remote-url',
        client: { session: { list: mock(async () => [{ id: 'sess1', title: 'Hello' }]) } },
      });
      serverManager.registerServer({
        id: 's2',
        label: 'S2',
        type: 'remote-url',
        client: { session: { list: mock(async () => [{ id: 'sess2', title: 'World' }]) } },
      });

      const res = await request(app).get('/api/servers/all/sessions').expect(200);
      expect(res.body.sessions).toHaveLength(2);
      expect(res.body.sessions[0]).toEqual({ id: 'sess1', title: 'Hello', serverId: 's1' });
      expect(res.body.sessions[1]).toEqual({ id: 'sess2', title: 'World', serverId: 's2' });
      expect(res.body.errors).toEqual([]);
    });

    test('passes archived query parameter', async () => {
      const listFn = mock(async () => []);
      serverManager.registerServer({
        id: 's1',
        label: 'S1',
        type: 'remote-url',
        client: { session: { list: listFn } },
      });

      await request(app).get('/api/servers/all/sessions?archived=true').expect(200);
      expect(listFn).toHaveBeenCalledWith({ archived: true });
    });

    test('handles getGlobalSessions error', async () => {
      serverManager.getGlobalSessions = mock(async () => { throw new Error('aggregation failed'); });

      const res = await request(app).get('/api/servers/all/sessions').expect(500);
      expect(res.body.error).toContain('aggregation failed');
    });
  });

  describe('POST /api/servers', () => {
    test('validates id is required', async () => {
      const res = await request(app)
        .post('/api/servers')
        .send({ label: 'My Server', type: 'remote-url', url: 'http://example.com' })
        .expect(400);
      expect(res.body.error).toContain('id');
    });

    test('validates label is required', async () => {
      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', type: 'remote-url', url: 'http://example.com' })
        .expect(400);
      expect(res.body.error).toContain('label');
    });

    test('validates type is one of allowed values', async () => {
      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'My Server', type: 'invalid-type', url: 'http://example.com' })
        .expect(400);
      expect(res.body.error).toContain('type');
    });

    test('accepts valid types: local, ssh, remote-url', async () => {
      serverManager.registerServer({ id: 's1', label: 'S1', type: 'remote-url', url: 'http://a.com' });
      serverManager.getServer = mock((id) => {
        if (id === 's1') return { id: 's1', status: 'disconnected', url: 'http://a.com' };
        return null;
      });

      await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'S1', type: 'ssh' })
        .expect(200);
    });

    test('validates url must be a string', async () => {
      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'My Server', type: 'remote-url', url: 12345 })
        .expect(400);
      expect(res.body.error).toContain('url');
    });

    test('rejects local re-registration via API', async () => {
      const res = await request(app)
        .post('/api/servers')
        .send({ id: 'local', label: 'Local', type: 'local', url: 'http://localhost' })
        .expect(400);
      expect(res.body.error).toContain('Cannot re-register local server via API');
    });

    test('registers new server with url successfully', async () => {
      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'My Remote', type: 'remote-url', url: 'http://remote.example.com' })
        .expect(200);
      expect(res.body.id).toBe('s1');
      expect(res.body.status).toBe('connecting');
      expect(sseFanIn.subscribeServer).toHaveBeenCalledWith('s1');
    });

    test('returns 500 when SDK import fails', async () => {
      mock.module('@opencode-ai/sdk/v2', () => ({
        createOpencodeClient: () => { throw new Error('SDK not available'); },
      }));

      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'My Remote', type: 'remote-url', url: 'http://remote.example.com' })
        .expect(500);
      expect(res.body.error).toContain('initialize remote server');

      mock.module('@opencode-ai/sdk/v2', () => ({
        createOpencodeClient: (opts) => ({
          baseUrl: opts?.baseUrl,
          health: { check: async () => true },
          session: { list: async () => [] },
        }),
      }));
    });

    test('returns 502 when health check fails', async () => {
      mock.module('@opencode-ai/sdk/v2', () => ({
        createOpencodeClient: () => ({
          health: { check: async () => { throw new Error('Connection refused'); } },
        }),
      }));

      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'My Remote', type: 'remote-url', url: 'http://dead.example.com' })
        .expect(502);
      expect(res.body.error).toContain('not reachable');

      mock.module('@opencode-ai/sdk/v2', () => ({
        createOpencodeClient: (opts) => ({
          baseUrl: opts?.baseUrl,
          health: { check: async () => true },
          session: { list: async () => [] },
        }),
      }));
    });

    test('returns 400 when url is missing for new server', async () => {
      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'My Server', type: 'remote-url' })
        .expect(400);
      expect(res.body.error).toContain('url');
    });

    test('handles reconnect of disconnected server', async () => {
      serverManager.registerServer({ id: 's1', label: 'S1', type: 'remote-url', url: 'http://old.example.com' });
      serverManager.getServer = mock((id) => {
        if (id === 's1') return { id: 's1', status: 'disconnected', url: 'http://old.example.com' };
        return null;
      });

      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'S1 Updated', type: 'ssh' })
        .expect(200);

      expect(res.body.id).toBe('s1');
      expect(res.body.status).toBe('connecting');
      expect(sseFanIn.subscribeServer).toHaveBeenCalledWith('s1');
    });

    test('handle default type for missing type field', async () => {
      serverManager.registerServer({ id: 's1', label: 'S1', type: 'remote-url', url: 'http://a.com' });
      serverManager.getServer = mock((id) => {
        if (id === 's1') return { id: 's1', status: 'disconnected', url: 'http://a.com' };
        return null;
      });

      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'S1' })
        .expect(200);

      // default type remote-url is in VALID_TYPES so it should pass
      expect(res.body.id).toBe('s1');
    });

    test('trims id and preserves existing entry', async () => {
      serverManager.registerServer({ id: 's1', label: 'S1', type: 'remote-url', url: 'http://a.com' });
      serverManager.getServer = mock((id) => {
        if (id === 's1') return { id: 's1', status: 'disconnected', url: 'http://a.com' };
        return null;
      });

      const res = await request(app)
        .post('/api/servers')
        .send({ id: '  s1  ', label: 'Trimmed', type: 'ssh' })
        .expect(200);

      expect(res.body.id).toBe('s1');
    });

    test('rolls back on SSE subscription failure', async () => {
      serverManager.registerServer({ id: 's1', label: 'S1', type: 'remote-url', url: 'http://a.com' });
      sseFanIn.subscribeServer = mock(() => { throw new Error('subscribe failed'); });
      serverManager.getServer = mock(() => ({ id: 's1', status: 'disconnected', url: 'http://a.com' }));

      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'S1', type: 'ssh' })
        .expect(500);

      expect(res.body.error).toContain('SSE subscription failed');
      expect(serverManager.removeServer).toHaveBeenCalledWith('s1');
    });

    test('handles empty body', async () => {
      const res = await request(app)
        .post('/api/servers')
        .send({})
        .expect(400);
      expect(res.body.error).toContain('id');
    });
  });

  describe('Proxy forwarding', () => {
    let originalFetch

    beforeEach(() => {
      originalFetch = globalThis.fetch
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    test('forwards POST body to upstream server', async () => {
      let capturedBody = null
      let capturedMethod = null
      let capturedUrl = null
      globalThis.fetch = mock(async (url, init) => {
        capturedUrl = url
        capturedMethod = init.method
        capturedBody = init.body ? Buffer.from(init.body).toString() : null
        return new Response(JSON.stringify({ upstream: true }), {
          status: 201,
          headers: { 'content-type': 'application/json', 'x-custom': 'forwarded' },
        })
      })

      serverManager.registerServer({
        id: 'remote-1',
        label: 'Remote',
        type: 'remote-url',
        url: 'http://upstream.example.com',
        client: { health: { check: mock(async () => true) } },
      })

      const res = await request(app)
        .post('/api/servers/remote-1/proxy/session/send')
        .set('x-request-id', '123')
        .send({ message: 'hello test' })
        .expect(201)

      expect(res.body).toEqual({ upstream: true })
      expect(res.headers['x-custom']).toBe('forwarded')
      expect(capturedMethod).toBe('POST')
      expect(JSON.parse(capturedBody)).toEqual({ message: 'hello test' })
      expect(capturedUrl).toBe('http://upstream.example.com/session/send')
    })

    test('forwards GET request with query string to upstream', async () => {
      let capturedUrl = null
      globalThis.fetch = mock(async (url) => {
        capturedUrl = url
        return new Response(JSON.stringify([{ id: 's1' }]), {
          headers: { 'content-type': 'application/json' },
        })
      })

      serverManager.registerServer({
        id: 'remote-2',
        label: 'Remote 2',
        type: 'remote-url',
        url: 'http://upstream.example.com',
        client: { health: { check: mock(async () => true) } },
      })

      const res = await request(app)
        .get('/api/servers/remote-2/proxy/session/list?limit=10')
        .expect(200)

      expect(res.body).toEqual([{ id: 's1' }])
      expect(capturedUrl).toBe('http://upstream.example.com/session/list?limit=10')
    })

    test('returns 404 for unknown server', async () => {
      const res = await request(app)
        .get('/api/servers/nonexistent/proxy/session/list')
        .expect(404)
      expect(res.body.error).toContain('not found')
    })

    test('returns 502 for server without client', async () => {
      serverManager.registerServer({
        id: 'no-client',
        label: 'No Client',
        type: 'remote-url',
        url: 'http://localhost:9999',
      })

      const res = await request(app)
        .get('/api/servers/no-client/proxy/session/list')
        .expect(502)
      expect(res.body.error).toContain('No client available')
    })

    test('returns 502 when upstream is unreachable', async () => {
      globalThis.fetch = mock(async () => {
        throw new Error('Connection refused')
      })

      serverManager.registerServer({
        id: 'dead-server',
        label: 'Dead',
        type: 'remote-url',
        url: 'http://127.0.0.1:19999',
        client: { health: { check: mock(async () => true) } },
      })

      const res = await request(app)
        .get('/api/servers/dead-server/proxy/session/list')
        .expect(502)
      expect(res.body.error).toContain('Proxy to')
    })

    test('forwards upstream error status codes', async () => {
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify({ error: 'session not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      })

      serverManager.registerServer({
        id: 'remote-3',
        label: 'Remote 3',
        type: 'remote-url',
        url: 'http://upstream.example.com',
        client: { health: { check: mock(async () => true) } },
      })

      const res = await request(app)
        .get('/api/servers/remote-3/proxy/session/get?sessionID=bad')
        .expect(404)

      expect(res.body).toEqual({ error: 'session not found' })
    })
  });
});
