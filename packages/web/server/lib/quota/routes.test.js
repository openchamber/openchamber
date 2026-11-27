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

describe('stored Work Status account usage', () => {
  const accountUsage = (opts = '') => request(app({})).get(`/api/quota/accounts/usage?providers=codex,claude${opts}`);
  const oauth = (id, integrationID, methodID, { active = false, expires = 0, access = `fixture-${id}` } = {}) => ({
    id, integrationID, active, label: `Account ${id}`,
    value: { type: 'oauth', methodID, access, expires, refresh: 'fixture-private-refresh', metadata: { accountID: id, private: 'fixture-private-meta' } },
  });
  const configure = (list) => configureOpenCodeCredentials({
    list,
    create: () => { throw new Error('Account reads must not create credentials'); },
    remove: () => { throw new Error('Account reads must not remove credentials'); },
  });
  const codex = (percent, account) => Response.json({
    plan_type: 'pro', account_id: account, email: 'fixture-private-email',
    rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: percent } },
  });
  const accountsById = (response) => {
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return Object.fromEntries(response.body.accounts.map((account) => [account.id, account]));
  };

  afterEach(() => {
    configureOpenCodeCredentials(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses each stored login directly and never assigns a CLI or Claude home reading to a different row', async () => {
    const rows = [
      oauth('legacy-primary', 'openai', 'chatgpt-browser', { active: true }),
      oauth('legacy-parked', 'openai', 'chatgpt-headless'),
      oauth('token-sharing', 'openai', 'chatgpt-token-sharing'),
      oauth('direct-claude', 'anthropic', 'oauth', { active: true }),
      oauth('direct-claude-parked', 'anthropic', 'oauth'),
      ...['external-current', 'external-parked'].map((id) => ({
        id, integrationID: 'claude-agent', label: `Account ${id}`, active: id === 'external-current',
        value: { type: 'external', methodID: 'claude-login', metadata: { private: 'fixture-private-home' } },
      })),
      oauth('wrong-account', 'openai', 'chatgpt-browser'),
      oauth('missing-login', 'anthropic', 'oauth', { access: '' }),
    ];
    configure(async () => rows);
    const upstream = vi.fn(async (url, init) => {
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
      const headers = new Headers(init.headers);
      switch (headers.get('authorization')) {
        case 'Bearer fixture-legacy-primary':
          expect(headers.get('chatgpt-account-id')).toBe('legacy-primary');
          return codex(17, 'legacy-primary');
        case 'Bearer fixture-legacy-parked':
          expect(headers.get('chatgpt-account-id')).toBe('legacy-parked');
          return codex(61, 'legacy-parked');
        case 'Bearer fixture-wrong-account':
          return codex(99, 'some-other-account');
        case 'Bearer fixture-direct-claude':
          expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
          return Response.json({ five_hour: { utilization: 44 }, private: 'fixture-private-provider-payload' });
        case 'Bearer fixture-direct-claude-parked':
          expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
          return Response.json({ five_hour: { utilization: 72 } });
        default:
          throw new Error('Unexpected credential sent upstream');
      }
    });
    vi.stubGlobal('fetch', upstream);
    const response = await accountUsage();
    const byId = accountsById(response);
    expect(Object.keys(byId)).toHaveLength(rows.length);
    expect(byId['legacy-primary']).toMatchObject({ providerId: 'codex', integrationId: 'openai', label: 'Account legacy-primary', status: 'fresh', reading: { planLabel: 'pro', usage: { windows: { '5h': { usedPercent: 17 } } } } });
    expect(byId['legacy-parked'].reading.usage.windows['5h'].usedPercent).toBe(61);
    expect(byId['direct-claude']).toMatchObject({ providerId: 'claude', status: 'fresh', reading: { planLabel: null, usage: { windows: { '5h': { usedPercent: 44 } } } } });
    expect(byId['direct-claude-parked'].reading.usage.windows['5h'].usedPercent).toBe(72);
    for (const id of ['token-sharing', 'external-current', 'external-parked', 'wrong-account']) {
      expect(byId[id]).toMatchObject({ status: 'unsupported', reading: null });
    }
    expect(byId['missing-login']).toMatchObject({ status: 'missing', reading: null });
    expect(response.text).not.toMatch(/fixture-private|"access"|"refresh"|"value"|"metadata"/);
    expect(upstream).toHaveBeenCalledTimes(5);
    expect((await request(app({})).get('/api/quota/accounts/usage?providers=claude')).body.accounts.every(({ providerId }) => providerId === 'claude')).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(5);
  });

  it('keeps each last reading through expiry and an unrelated upstream failure', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const rows = [
      oauth('soon-expired', 'openai', 'chatgpt-browser', { expires: now + 1000 }),
      oauth('outage-claude', 'anthropic', 'oauth'),
      oauth('healthy', 'openai', 'chatgpt-browser'),
    ];
    configure(async () => rows);
    const upstream = vi.fn(async (_url, init) => {
      if (init.headers.Authorization === 'Bearer fixture-outage-claude') {
        return Date.now() === now ? Response.json({ five_hour: { utilization: 73 } }) : new Response(null, { status: 503 });
      }
      return codex(Date.now() === now ? 21 : 39);
    });
    vi.stubGlobal('fetch', upstream);
    const before = accountsById(await accountUsage());
    clock.mockReturnValue(now + 2000);
    const after = accountsById(await accountUsage('&refresh=1'));
    expect(after['soon-expired']).toMatchObject({ status: 'expired', reading: before['soon-expired'].reading });
    expect(after['outage-claude']).toMatchObject({ status: 'transient', reading: before['outage-claude'].reading });
    expect(after['outage-claude']).not.toHaveProperty('retryAt');
    expect(after.healthy).toMatchObject({ status: 'fresh', reading: { fetchedAt: now + 2000, usage: { windows: { '5h': { usedPercent: 39 } } } } });
    expect(upstream).toHaveBeenCalledTimes(5);
  });

  it('reports the cooldown deadline and keeps it fixed when asked to refresh early', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const codexRetryAt = now + 1000 + 2 * 60 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    configure(async () => [
      oauth('cooldown', 'anthropic', 'oauth'),
      oauth('codex-cooldown', 'openai', 'chatgpt-browser'),
      oauth('unknown-cooldown', 'anthropic', 'oauth'),
    ]);
    const upstream = vi.fn(async (_url, init) => {
      const token = new Headers(init.headers).get('authorization');
      if (Date.now() === now + 1000) {
        const retryAfter = token === 'Bearer fixture-codex-cooldown' ? new Date(codexRetryAt).toUTCString()
          : token === 'Bearer fixture-unknown-cooldown' ? '2099 GMT' : '60';
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': retryAfter },
        });
      }
      return token === 'Bearer fixture-codex-cooldown' ? codex(17) :
        Response.json({ five_hour: { utilization: Date.now() === now ? 44 : 52 } });
    });
    vi.stubGlobal('fetch', upstream);
    const before = accountsById(await accountUsage()).cooldown;
    clock.mockReturnValue(now + 1000);
    const limited = accountsById(await accountUsage('&refresh=1'));
    expect(limited.cooldown).toMatchObject({ status: 'cooldown', retryAt: now + 61_000, reading: before.reading });
    expect(limited['codex-cooldown']).toMatchObject({ status: 'cooldown', retryAt: codexRetryAt });
    expect(limited['unknown-cooldown']).toMatchObject({ status: 'cooldown' });
    expect(limited['unknown-cooldown']).not.toHaveProperty('retryAt');
    clock.mockReturnValue(now + 60_999);
    expect(accountsById(await accountUsage('&refresh=1'))).toEqual(limited);
    expect(upstream).toHaveBeenCalledTimes(6);
    clock.mockReturnValue(now + 61_000);
    const recovered = accountsById(await accountUsage('&refresh=1')).cooldown;
    expect(recovered).toMatchObject({ status: 'fresh', reading: { fetchedAt: now + 61_000, usage: { windows: { '5h': { usedPercent: 52 } } } } });
    expect(recovered).not.toHaveProperty('retryAt');
  });

  it('coalesces a pending login read and discards a previous reading if the same ID is replaced', async () => {
    let entry = oauth('rotating-id', 'openai', 'chatgpt-headless');
    const list = vi.fn(async () => [entry]);
    configure(list);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const upstream = vi.fn(async (_url, init) => {
      if (init.headers.Authorization === 'Bearer fixture-rotating-id') {
        await gate;
        return codex(28, 'rotating-id');
      }
      return new Response(null, { status: 503 });
    });
    vi.stubGlobal('fetch', upstream);
    const first = accountUsage().then(accountsById);
    try {
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
      const second = accountUsage('&refresh=1').then(accountsById);
      await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
      release();
      expect(await first).toEqual(await second);
    } finally {
      release();
    }
    expect(upstream).toHaveBeenCalledTimes(1);
    entry = oauth('rotating-id', 'openai', 'chatgpt-headless', { access: 'fixture-replacement' });
    expect(accountsById(await accountUsage())['rotating-id']).toMatchObject({ status: 'transient', reading: null });
    upstream.mockResolvedValueOnce(codex(67, 'rotating-id'));
    expect(accountsById(await accountUsage('&refresh=1'))['rotating-id']).toMatchObject({
      status: 'fresh', reading: { usage: { windows: { '5h': { usedPercent: 67 } } } },
    });
  });

  it('reports an inventory outage as a failed request and omits upstream error details', async () => {
    configure(async () => { throw new Error('fixture-private-inventory'); });
    const response = await accountUsage();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: 'ACCOUNT_USAGE_UNAVAILABLE' });
  });

  it.each([
    ['windows', { rate_limit: { primary_window: {} } }, { limits: {} }],
    ['balances', { credits: { balance: 'unknown' } }, { spend: { enabled: true, used: { amount_minor: 'unknown' } } }],
  ])('keeps earlier readings when a successful response has invalid %s', async (caseId, codexPayload, claudePayload) => {
    const rows = [oauth(`codex-bad-${caseId}`, 'openai', 'chatgpt-browser'), oauth(`claude-bad-${caseId}`, 'anthropic', 'oauth')];
    configure(async () => rows);
    let malformed = false;
    vi.stubGlobal('fetch', async (url) => url.startsWith('https://api.anthropic.com')
      ? Response.json(malformed ? claudePayload : { five_hour: { utilization: 22 } })
      : malformed ? Response.json(codexPayload) : codex(33));
    const before = accountsById(await accountUsage());
    malformed = true;
    const after = accountsById(await accountUsage('&refresh=1'));
    for (const { id } of rows) expect(after[id]).toMatchObject({ status: 'transient', reading: before[id].reading });
  });
});

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
