// Registration must be a complete no-op when the platform is disabled
// (OPENCHAMBER_PLATFORM_DATABASE_URL unset): no platform routes appear and the
// rest of the app keeps its exact current behavior.

import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const ENV_VAR = 'OPENCHAMBER_PLATFORM_DATABASE_URL';
const silentLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

describe('platform auth routes when the platform is disabled', () => {
  const originalValue = process.env[ENV_VAR];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = originalValue;
    }
  });

  it('registers nothing and reports disabled', async () => {
    delete process.env[ENV_VAR];
    vi.resetModules();
    const { registerPlatformAuthRoutes } = await import('./routes.js');

    const app = express();
    const result = await registerPlatformAuthRoutes(app, {
      env: {
        OPENCHAMBER_PLATFORM_OIDC_ISSUER: 'https://idp.example.com',
        OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID: 'oc-web',
      },
      logger: silentLogger,
    });
    expect(result).toEqual({ enabled: false });

    // None of the platform routes exist; the app falls through (404) exactly
    // like a server without the platform layer.
    expect((await request(app).get('/auth/login')).status).toBe(404);
    expect((await request(app).get('/auth/callback')).status).toBe(404);
    expect((await request(app).post('/auth/logout')).status).toBe(404);
    expect((await request(app).get('/api/platform/me')).status).toBe(404);
    expect(silentLogger.warn).not.toHaveBeenCalled();
  });
});
