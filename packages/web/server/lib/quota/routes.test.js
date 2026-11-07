import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOpenCodeCredentials } from '../opencode/auth.js';
import { attachExtensionQuotaProvider, detachExtensionQuotaProvider } from './extension-registry.js';
import { QuotaRouteError } from './route-error.js';
import { registerQuotaRoutes } from './routes.js';

const app = (providers) => {
  const server = express();
  registerQuotaRoutes(server, { getQuotaProviders: async () => providers });
  return server;
};

describe('quota routes with extension providers', () => {
  it('lists the extensions\' providers from memory, without the quota module or OpenCode', async () => {
    attachExtensionQuotaProvider({ providerId: 'ext-teapot-usage', providerName: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage' });
    try {
      const server = express();
      const getQuotaProviders = vi.fn(async () => { throw new Error('OpenCode is not connected yet'); });
      registerQuotaRoutes(server, { getQuotaProviders });
      const response = await request(server).get('/api/quota/extensions');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ extensions: [{ id: 'ext-teapot-usage', name: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage' }] });
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
