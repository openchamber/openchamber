import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTunnelAuth } from '../tunnels/tunnel-auth.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerAuthAndAccessRoutes } from './core-routes.js';
import { registerFreePortRoute } from './free-port-route.js';

const disposers = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()();
});

// The route as bootstrap-runtime assembles it: the real /api gate of a
// password-protected server, then the free-port route with the gate it returns.
const createPasswordProtectedServer = () => {
  const uiAuthController = createUiAuth({ password: 'secret' });
  disposers.push(() => uiAuthController.dispose());
  const requireAuth = vi.spyOn(uiAuthController, 'requireAuth');
  const app = express();
  app.use(express.json());
  const { requireApiAuth } = registerAuthAndAccessRoutes(app, {
    express,
    tunnelAuthController: createTunnelAuth(),
    uiAuthController,
    readSettingsFromDiskMigrated: async () => ({}),
    normalizeTunnelSessionTtlMs: (value) => value,
  });
  registerFreePortRoute({ app, requireAuth: requireApiAuth });
  return { app, requireAuth };
};

describe('free-port route', () => {
  it('refuses a request without a session', async () => {
    const { app } = createPasswordProtectedServer();

    const response = await request(app).get('/api/system/free-port').expect(401);
    expect(response.body).toEqual({ error: 'UI authentication required', locked: true });
  });

  it('answers a signed-in session with a free loopback port after one auth check', async () => {
    const { app, requireAuth } = createPasswordProtectedServer();
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    disposers.push(() => server.close());
    const origin = `http://127.0.0.1:${server.address().port}`;
    const login = await request(origin).post('/auth/session').send({ password: 'secret' }).expect(200);
    const cookie = login.headers['set-cookie'].map((entry) => entry.split(';', 1)[0]).join('; ');
    requireAuth.mockClear();

    const response = await request(origin).get('/api/system/free-port').set('Cookie', cookie).expect(200);
    expect(response.body.port).toBeGreaterThan(0);
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });

  // Express routes these to the same handler: case-insensitive paths, a
  // trailing slash, and HEAD for a GET route.
  const routedVariants = [
    ['GET', '/api/system/free-port/'],
    ['GET', '/API/SYSTEM/FREE-PORT'],
    ['HEAD', '/api/system/free-port'],
  ];

  it.each(routedVariants)('refuses %s %s without a session', async (method, path) => {
    const { app } = createPasswordProtectedServer();

    await request(app)[method.toLowerCase()](path).expect(401);
  });

  it.each(routedVariants)('checks auth once for a signed-in %s %s', async (method, path) => {
    const { app, requireAuth } = createPasswordProtectedServer();
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    disposers.push(() => server.close());
    const origin = `http://127.0.0.1:${server.address().port}`;
    const login = await request(origin).post('/auth/session').send({ password: 'secret' }).expect(200);
    const cookie = login.headers['set-cookie'].map((entry) => entry.split(';', 1)[0]).join('; ');
    requireAuth.mockClear();

    await request(origin)[method.toLowerCase()](path).set('Cookie', cookie).expect(200);
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });

  it('still gates a path Express does not route to free-port', async () => {
    const { app } = createPasswordProtectedServer();

    await request(app).get('/api/system/free-port//').expect(401);
    await request(app).post('/api/system/free-port').expect(401);
  });
});
