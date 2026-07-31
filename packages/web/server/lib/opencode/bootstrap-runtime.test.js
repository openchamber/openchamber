import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createBootstrapRuntime } from './bootstrap-runtime.js';
import { registerCommonRequestMiddleware, registerServerStatusRoutes } from './core-routes.js';

const createSessionRuntime = () => {
  const noop = vi.fn();
  return {
    getSessionActivitySnapshot: noop,
    getSessionStateSnapshot: noop,
    getSessionAttentionSnapshot: noop,
    getSessionState: noop,
    getSessionAttentionState: noop,
    markSessionViewed: noop,
    markSessionUnviewed: noop,
    markUserMessageSent: noop,
  };
};

describe('bootstrap runtime production wiring', () => {
  it('parses restart shutdown bodies before the route handler runs', async () => {
    const app = express();
    const gracefulShutdown = vi.fn(async () => {});
    const bootstrap = createBootstrapRuntime({
      createUiAuth: () => ({ enabled: false }),
      registerServerStatusRoutes,
      registerCommonRequestMiddleware,
      registerAuthAndAccessRoutes: () => {},
      registerTtsRoutes: () => {},
      registerNotificationRoutes: () => {},
      registerOpenChamberRoutes: () => {},
      registerAgentToolRoutes: () => {},
      express,
    });

    bootstrap.setupBaseRoutes(app, {
      process,
      openchamberVersion: 'test',
      runtimeName: 'test',
      serverStartedAt: new Date().toISOString(),
      gracefulShutdown,
      getHealthSnapshot: () => ({ status: 'ok' }),
      sessionRuntime: createSessionRuntime(),
    });

    await request(app)
      .post('/api/system/shutdown')
      .send({ mode: 'restart' })
      .expect(200, { ok: true });

    expect(gracefulShutdown).toHaveBeenCalledWith({ exitProcess: true, mode: 'restart' });
  });
});
