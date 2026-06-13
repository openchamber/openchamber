import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from './core-routes.js';

describe('core-routes', () => {
  it('should call gracefulShutdown with exitProcess: true on /api/system/shutdown', async () => {
    const app = express();
    let shutdownOpts = null;
    const dependencies = {
      gracefulShutdown: vi.fn(async (opts) => {
        shutdownOpts = opts;
      }),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app).post('/api/system/shutdown');

    expect(dependencies.gracefulShutdown).toHaveBeenCalled();
    expect(shutdownOpts).toEqual({ exitProcess: true });
  });

  it('should require UI auth before /api/system/shutdown when auth is configured', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Unauthorized' })),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(401, { error: 'Unauthorized' });

    expect(dependencies.uiAuthController.requireAuth).toHaveBeenCalledTimes(1);
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('should allow authenticated /api/system/shutdown requests', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, _res, next) => next()),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(200, { ok: true });

    expect(dependencies.uiAuthController.requireAuth).toHaveBeenCalledTimes(1);
    expect(dependencies.gracefulShutdown).toHaveBeenCalledWith({ exitProcess: true });
  });

  it('should require tunnel auth for tunneled /api/system/shutdown requests', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'tunnel',
        requireTunnelSession: vi.fn((_req, res) => res.status(401).json({ error: 'Tunnel auth required' })),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, _res, next) => next()),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(401, { error: 'Tunnel auth required' });

    expect(dependencies.tunnelAuthController.requireTunnelSession).toHaveBeenCalledTimes(1);
    expect(dependencies.uiAuthController.requireAuth).not.toHaveBeenCalled();
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('should parse JSON bodies for snippet config routes', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/config/snippets/example', (req, res) => {
      res.json({ body: req.body });
    });

    const response = await request(app)
      .post('/api/config/snippets/example')
      .send({ content: 'Snippet body' })
      .expect(200);

    expect(response.body).toEqual({ body: { content: 'Snippet body' } });
  });

  it('should require API auth before probing loopback preview URLs', async () => {
    const app = express();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth: (_req, res) => res.status(401).json({ error: 'Unauthorized' }),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    try {
      await request(app)
        .post('/api/system/probe-url')
        .send({ url: 'http://127.0.0.1:5173/' })
        .expect(401);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should probe loopback preview URLs and return ok: true for status codes 200-599', async () => {
    const app = express();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth: (_req, _res, next) => next(),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    try {
      const testCases = [
        { status: 200, expectedOk: true },
        { status: 302, expectedOk: true },
        { status: 404, expectedOk: true },
        { status: 500, expectedOk: true },
        { status: 600, expectedOk: false },
      ];

      for (const { status, expectedOk } of testCases) {
        fetchMock.mockResolvedValueOnce({
          status,
          ok: status >= 200 && status < 300,
        });

        const response = await request(app)
          .post('/api/system/probe-url')
          .send({ url: 'http://127.0.0.1:5173/' })
          .expect(200);

        expect(response.body).toEqual({ ok: expectedOk, status });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should let preview proxy credentials reach preview proxy validation', async () => {
    const app = express();
    const requireAuth = vi.fn((_req, res) => res.status(401).type('text/plain').send('Authentication required'));

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth,
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    app.use('/api/preview/proxy', (_req, res) => res.json({ reached: true }));

    await request(app)
      .get('/api/preview/proxy/abc123/?oc_preview_token=preview-secret')
      .expect(200, { reached: true });

    await request(app)
      .get('/api/preview/proxy/abc123/')
      .set('Cookie', 'oc_preview_token=preview-secret')
      .expect(200, { reached: true });

    await request(app)
      .get('/api/preview/proxy/abc123/')
      .expect(401, 'Authentication required');

    expect(requireAuth).toHaveBeenCalledTimes(1);
  });
});

describe('client auth routes', () => {
  const createDependencies = (options = {}) => {
    const clients = [];
    const requireAuth = vi.fn((_req, _res, next) => next());
    const requireSessionAuth = vi.fn((_req, _res, next) => next());
    const resolveAuthContext = vi.fn(options.resolveAuthContext || (async () => ({ type: 'session' })));
    return {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        getTunnelSessionFromRequest: () => null,
        clearTunnelSessionCookie: () => {},
        requireTunnelSession: (_req, _res, next) => next(),
      },
      uiAuthController: {
        handleSessionStatus: (_req, res) => res.json({ authenticated: true }),
        handleSessionCreate: (_req, res) => res.json({ authenticated: true }),
        handlePasskeyStatus: (_req, res) => res.json({ enabled: false }),
        handlePasskeyAuthenticationOptions: (_req, res) => res.json({}),
        handlePasskeyAuthenticationVerify: (_req, res) => res.json({ authenticated: true }),
        requireAuth,
        requireSessionAuth,
        resolveAuthContext,
        handlePasskeyRegistrationOptions: (_req, res) => res.json({}),
        handlePasskeyRegistrationVerify: (_req, res) => res.json({}),
        handlePasskeyList: (_req, res) => res.json({ passkeys: [] }),
        handlePasskeyRevoke: (_req, res) => res.json({ revoked: true }),
        handleResetAuth: (_req, res) => res.json({ cleared: true }),
      },
      remoteClientAuthRuntime: {
        listClients: async () => clients,
        createClient: async ({ label, clientKind }) => {
          const client = {
            id: `client-${clients.length + 1}`,
            label: label || 'Remote client',
            createdAt: 'now',
            lastUsedAt: null,
            revokedAt: null,
            clientKind: clientKind || null,
          };
          clients.push(client);
          return { client, token: 'oc_client_secret' };
        },
        revokeClient: async (id) => {
          const client = clients.find((entry) => entry.id === id);
          if (!client) return { revoked: false };
          client.revokedAt = 'revoked';
          return { revoked: true, client };
        },
        purgeRevokedClients: async () => {
          const before = clients.length;
          for (let index = clients.length - 1; index >= 0; index -= 1) {
            if (clients[index].revokedAt) clients.splice(index, 1);
          }
          return { purged: before - clients.length };
        },
      },
      readSettingsFromDiskMigrated: async () => ({}),
      normalizeTunnelSessionTtlMs: () => 1000,
      testHooks: { clients, requireAuth, requireSessionAuth, resolveAuthContext },
    };
  };

  it('creates, lists, and revokes remote client tokens', async () => {
    const app = express();
    const dependencies = createDependencies();
    registerAuthAndAccessRoutes(app, dependencies);

    const created = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Laptop' });
    expect(created.status).toBe(201);
    expect(created.body.token).toBe('oc_client_secret');
    expect(created.headers['cache-control']).toBe('no-store');

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toHaveLength(1);
    expect(listed.body.clients[0]).not.toHaveProperty('token');

    const revoked = await request(app).delete('/api/client-auth/clients/client-1');
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);

    const purged = await request(app).delete('/api/client-auth/clients');
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toBe(1);

    const listedAfterPurge = await request(app).get('/api/client-auth/clients');
    expect(listedAfterPurge.body.clients).toHaveLength(0);
    expect(dependencies.testHooks.requireSessionAuth).toHaveBeenCalled();
    expect(dependencies.testHooks.requireAuth).not.toHaveBeenCalled();
  });

  it('allows client credentials to list and revoke only the authenticated client', async () => {
    const app = express();
    let authContext = { type: 'session' };
    const dependencies = createDependencies({
      resolveAuthContext: async () => authContext,
    });
    registerAuthAndAccessRoutes(app, dependencies);

    const current = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'OpenChamber Desktop', clientKind: 'desktop-local' });
    const other = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Other device' });

    authContext = { type: 'client', clientId: current.body.client.id, client: current.body.client };

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toEqual([current.body.client]);

    const denied = await request(app).delete(`/api/client-auth/clients/${other.body.client.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body.revoked).toBe(false);

    const revoked = await request(app).delete(`/api/client-auth/clients/${current.body.client.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(revoked.body.client.id).toBe(current.body.client.id);
  });

  it('requires UI-session auth for passkey registration management routes', async () => {
    const app = express();
    const dependencies = createDependencies();
    registerAuthAndAccessRoutes(app, dependencies);

    await request(app).post('/auth/passkey/register/options').expect(200);
    await request(app).post('/auth/passkey/register/verify').expect(200);

    expect(dependencies.testHooks.requireSessionAuth).toHaveBeenCalledTimes(2);
    expect(dependencies.testHooks.requireAuth).not.toHaveBeenCalled();
  });
});
