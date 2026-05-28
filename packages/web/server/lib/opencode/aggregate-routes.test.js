import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { registerAggregateRoutes } from './aggregate-routes.js';

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
        error: s.errorMessage,
      }));
    }),
    getServer: mock((id) => servers.get(id) || null),
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
        error: null,
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

    test('returns 501 when url is provided (remote not implemented)', async () => {
      const res = await request(app)
        .post('/api/servers')
        .send({ id: 's1', label: 'My Remote', type: 'remote-url', url: 'http://remote.example.com' })
        .expect(501);
      expect(res.body.error).toContain('not yet implemented');
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
});
