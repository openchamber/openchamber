import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { QuotaRouteError } from './route-error.js';
import { registerQuotaRoutes } from './routes.js';

const app = (providers) => {
  const server = express();
  registerQuotaRoutes(server, { getQuotaProviders: async () => providers });
  return server;
};

describe('quota routes with extension providers', () => {
  it('lists the extensions\' providers beside the configured ids', async () => {
    const response = await request(app({
      listConfiguredQuotaProviders: async () => ['codex', 'ext-teapot-usage'],
      listExtensionQuotaProviders: () => [{ id: 'ext-teapot-usage', name: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage' }],
    })).get('/api/quota/providers');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ providers: ['codex', 'ext-teapot-usage'], extensions: [{ id: 'ext-teapot-usage', name: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage' }] });
  });

  it('answers an extension\'s malformed answer with its own status and code, and anything else with 500', async () => {
    const malformed = await request(app({
      fetchQuotaForProvider: async () => { throw new QuotaRouteError(502, 'MALFORMED_PROVIDER_RESPONSE', 'Teapot Usage answered something OpenChamber cannot use: not JSON'); },
    })).get('/api/quota/ext-teapot-usage');
    expect(malformed.status).toBe(502);
    expect(malformed.body).toEqual({ code: 'MALFORMED_PROVIDER_RESPONSE', error: 'Teapot Usage answered something OpenChamber cannot use: not JSON' });

    // A built-in's error that happens to carry a status and a code stays 500: only the extension layer's branded error is answered as it is.
    const plain = await request(app({
      fetchQuotaForProvider: async () => { throw Object.assign(new Error('upstream said no'), { status: 401, code: 'UNAUTHORIZED' }); },
    })).get('/api/quota/codex');
    expect(plain.status).toBe(500);
    expect(plain.body).toEqual({ error: 'upstream said no' });
  });
});
