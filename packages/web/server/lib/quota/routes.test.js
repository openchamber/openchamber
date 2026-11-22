import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { registerQuotaRoutes } from './routes.js';
import { configureOpenCodeCredentials } from '../opencode/auth.js';
import { attachExtensionQuotaProvider, detachExtensionQuotaProvider } from './extension-registry.js';
import { QuotaRouteError } from './route-error.js';


const result = (overrides = {}) => ({
  providerId: 'codex',
  providerName: 'Codex',
  ok: true,
  configured: true,
  usage: { windows: {} },
  fetchedAt: 123,
  ...overrides,
});

const createApp = (quotaProviders) => {
  const app = express();
  registerQuotaRoutes(app, { getQuotaProviders: async () => quotaProviders });
  return app;
};

describe('GET /api/quota/:providerId', () => {
  it('returns every per-credential result for a multi-credential provider', async () => {
    const fetchQuotaForProvider = vi.fn(async () => result());
    const app = createApp({
      fetchQuotaForProvider,
      fetchQuotaForProviderInstances: async () => [
        result({ credentialId: 'cred_main', credentialLabel: 'Main', credentialActive: true, accountLabel: 'main@example.com' }),
        result({ credentialId: 'cred_second', credentialLabel: 'Second', credentialActive: false, accountLabel: 'second@example.com' }),
      ],
    });

    const response = await request(app).get('/api/quota/codex');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toMatchObject({ credentialId: 'cred_main', credentialLabel: 'Main', credentialActive: true, accountLabel: 'main@example.com' });
    expect(response.body[1]).toMatchObject({ credentialId: 'cred_second', credentialLabel: 'Second', credentialActive: false });
    expect(fetchQuotaForProvider).not.toHaveBeenCalled();
  });

  it('keeps the single-object shape when only one credential answers', async () => {
    const app = createApp({
      fetchQuotaForProvider: async () => result(),
      fetchQuotaForProviderInstances: async () => [result({ credentialId: 'cred_main', credentialLabel: 'Main' })],
    });

    const response = await request(app).get('/api/quota/codex');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(false);
    expect(response.body).toMatchObject({ providerId: 'codex', credentialLabel: 'Main' });
  });

  it('falls back to the single-result fetch when the module has no per-credential entry point', async () => {
    const app = createApp({
      fetchQuotaForProvider: async () => result({ providerName: 'Fallback' }),
    });

    const response = await request(app).get('/api/quota/codex');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ providerId: 'codex', providerName: 'Fallback' });
  });
});

describe('prototype provider ids on the credential routes', () => {
  const app = createApp({ fetchQuotaForProvider: async () => result() });

  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
    'answers 404 UNSUPPORTED_PROVIDER for %s on every credential route',
    async (providerId) => {
      const read = await request(app).get(`/api/quota/credentials/${providerId}`);
      expect(read.status).toBe(404);
      expect(read.body).toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });

      const write = await request(app).put(`/api/quota/credentials/${providerId}`).send({ usageToken: 'x' });
      expect(write.status).toBe(404);
      expect(write.body).toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });

      const validate = await request(app).post(`/api/quota/credentials/${providerId}/validate`);
      expect(validate.status).toBe(404);
      expect(validate.body).toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });

      const remove = await request(app).delete(`/api/quota/credentials/${providerId}`);
      expect(remove.status).toBe(404);
      expect(remove.body).toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    },
  );
});

// ---- upstream tests ----

const app = (providers) => {
  const server = express();
  registerQuotaRoutes(server, { getQuotaProviders: async () => providers });
  return server;
};

describe('quota routes with extension providers', () => {
  it('lists the extensions\' providers from memory, without the quota module or OpenCode', async () => {
    attachExtensionQuotaProvider({ providerId: 'ext-teapot-usage', providerName: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage', providers: ['teapot'] });
    try {
      const server = express();
      const getQuotaProviders = vi.fn(async () => { throw new Error('OpenCode is not connected yet'); });
      registerQuotaRoutes(server, { getQuotaProviders });
      const response = await request(server).get('/api/quota/extensions');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ extensions: [{ id: 'ext-teapot-usage', name: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage', providers: ['teapot'] }] });
      expect(getQuotaProviders).not.toHaveBeenCalled();
    } finally {
      detachExtensionQuotaProvider('ext-teapot-usage');
    }
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

describe('managed credential dictionary boundary', () => {
  it.each([
    ['missing-provider', 404, 'UNSUPPORTED_PROVIDER', 'Unsupported credential provider'],
    ['constructor', 404, 'UNSUPPORTED_PROVIDER', 'Unsupported credential provider'],
    ['__proto__', 404, 'UNSUPPORTED_PROVIDER', 'Unsupported credential provider'],
  ])('answers 404 for %s, which is not a credential provider', async (providerId, status, code, error) => {
    const server = app({});
    server.use((cause, _req, res, _next) => {
      res.status(500).json({ code: cause.name, error: cause.message });
    });

    const response = await request(server)
      .put(`/api/quota/credentials/${providerId}`)
      .send({ usageToken: 'test-token' });

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code, error });
  });
});

describe('z.ai gift reset activation route', () => {
  beforeEach(() => {
    configureOpenCodeCredentials({ list: async () => [{
      id: 'test-zai', integrationID: 'zai-coding-plan', label: 'default', active: true,
      value: { type: 'key', key: 'test-token' },
    }] });
  });

  afterEach(() => {
    configureOpenCodeCredentials(null);
    vi.unstubAllGlobals();
  });

  const activate = async (body) => {
    const upstream = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 200, msg: 'success', data: 1, success: true }),
    });
    vi.stubGlobal('fetch', upstream);
    const response = await request(app({})).post('/api/quota/zai-coding-plan/gift-reset/use').send(body);
    return { response, upstream };
  };

  it('sends GLOBAL upstream when the record carried no grantType', async () => {
    const { response, upstream } = await activate({ recordId: 462029, resetType: 'FIVE_HOUR' });

    expect(response.status).toBe(200);
    expect(JSON.parse(upstream.mock.calls[0][1].body).grantType).toBe('GLOBAL');
  });

  it('sends the record grantType upstream unchanged', async () => {
    const { response, upstream } = await activate({ recordId: 462029, resetType: 'WEEK', grantType: 'ACTIVITY' });

    expect(response.status).toBe(200);
    expect(JSON.parse(upstream.mock.calls[0][1].body).grantType).toBe('ACTIVITY');
  });

  it.each([[''], ['   '], [null], [7]])('answers 400 without calling upstream for grantType %j', async (grantType) => {
    const { response, upstream } = await activate({ recordId: 462029, resetType: 'WEEK', grantType });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_REQUEST');
    expect(upstream).not.toHaveBeenCalled();
  });
});
